const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'wedding_planner',
    password: '2004', // TU CONTRASEÑA
    port: 5432,
});

// --- Rutas Básicas ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

// --- RUTA DE REGISTRO (SIN CAMBIOS) ---
app.post('/register', async (req, res) => {
    // ... (Tu código de registro que ya funciona está perfecto)
    const { nombre, correo, contrasena, presupuesto, codigo_pareja_input, colores } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const checkMail = await client.query('SELECT id_usuario FROM usuario WHERE correo = $1', [correo]);
        if (checkMail.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'El correo ya está registrado.' });
        }
        let codigoFinal;
        if (codigo_pareja_input && codigo_pareja_input.trim() !== "") {
            const codigoInput = codigo_pareja_input.trim().toUpperCase();
            const checkCodigo = await client.query('SELECT count(*) as total FROM usuario WHERE codigo_pareja = $1', [codigoInput]);
            const totalUsuarios = parseInt(checkCodigo.rows[0].total);
            if (totalUsuarios === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'El código ingresado no existe.' });
            }
            if (totalUsuarios >= 2) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Ese código ya tiene 2 personas.' });
            }
            codigoFinal = codigoInput;
        } else {
            codigoFinal = Math.random().toString(36).substring(2, 8).toUpperCase();
        }
        const saltRounds = 10;
        const hashContrasena = await bcrypt.hash(contrasena, saltRounds);
        const coloresString = colores ? colores.join(',') : '';
        const query = `
            INSERT INTO usuario(nombre, correo, contrasena, presupuesto_estimado, codigo_pareja, colores_preferidos) 
            VALUES($1, $2, $3, $4, $5, $6) 
            RETURNING id_usuario, codigo_pareja`;
        const result = await client.query(query, [nombre, correo, hashContrasena, presupuesto || 0, codigoFinal, coloresString]);
        await client.query('COMMIT');
        res.status(201).json({ message: '¡Registro exitoso!', codigo: result.rows[0].codigo_pareja });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor' });
    } finally {
        client.release();
    }
});

// --- RUTA DE LOGIN (SIN CAMBIOS) ---
app.post('/login', async (req, res) => {
    // ... (Tu código de login que ya funciona está perfecto)
    const { correo, contrasena } = req.body;
    try {
        const query = 'SELECT id_usuario, nombre, contrasena, presupuesto_estimado, codigo_pareja FROM usuario WHERE correo = $1';
        const result = await pool.query(query, [correo]);
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Correo no encontrado' });
        }
        const usuario = result.rows[0];
        const match = await bcrypt.compare(contrasena, usuario.contrasena);
        if (match) {
            res.status(200).json({ 
                success: true, 
                message: 'Login correcto',
                usuario: {
                    id: usuario.id_usuario,
                    nombre: usuario.nombre,
                    presupuesto: usuario.presupuesto_estimado,
                    codigo: usuario.codigo_pareja
                }
            });
        } else {
            res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno' });
    }
});

// --- GUARDAR IMAGEN (ARREGLADO EL ERROR DE FECHA) ---
app.post('/guardar-imagen', async (req, res) => {
    const { id_usuario, url_imagen, descripcion } = req.body;
    try {
        // Ahora la tabla ya tiene fecha_guardado (se llena sola con DEFAULT)
        const query = 'INSERT INTO imagenes_guardadas (id_usuario, url_imagen, descripcion) VALUES ($1, $2, $3) RETURNING id_imagen';
        await pool.query(query, [id_usuario, url_imagen, descripcion]);
        res.json({ success: true, message: 'Imagen guardada' });
    } catch (error) {
        console.error('Error al guardar imagen:', error);
        res.status(500).json({ success: false, message: 'Error al guardar' });
    }
});

// --- RUTA DE PERFIL (MODIFICADA) ---
// Ahora la llamamos con el ID y devuelve TODOS los datos necesarios
app.get('/perfil-completo/:id', async (req, res) => {
    const idUsuario = req.params.id;

    if (!idUsuario) {
        return res.status(400).json({ success: false, message: 'Falta ID de usuario' });
    }

    try {
        // 1. Obtener mis datos (Nombre, presupuesto, código)
        const userQuery = 'SELECT nombre, presupuesto_estimado, codigo_pareja FROM usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }
        
        const miPerfil = userRes.rows[0];
        const miCodigo = miPerfil.codigo_pareja;

        // 2. Buscar a mi pareja
        let nombrePareja = null;
        if (miCodigo) {
            const parejaQuery = 'SELECT nombre FROM usuario WHERE codigo_pareja = $1 AND id_usuario != $2';
            const parejaRes = await pool.query(parejaQuery, [miCodigo, idUsuario]);
            if (parejaRes.rows.length > 0) {
                nombrePareja = parejaRes.rows[0].nombre;
            }
        }

        // 3. Buscar imágenes compartidas
        let imagenes = [];
        if (miCodigo) {
            const imagenesQuery = `
                SELECT i.id_imagen, i.url_imagen, i.descripcion, u.nombre as guardado_por
                FROM imagenes_guardadas i
                JOIN usuario u ON i.id_usuario = u.id_usuario
                WHERE u.codigo_pareja = $1 ORDER BY i.fecha_guardado DESC
            `;
            const imgRes = await pool.query(imagenesQuery, [miCodigo]);
            imagenes = imgRes.rows;
        } else {
             // Si no tengo pareja, traigo solo mis fotos
            const soloMisFotos = `
                SELECT i.id_imagen, i.url_imagen, i.descripcion, u.nombre as guardado_por
                FROM imagenes_guardadas i
                JOIN usuario u ON i.id_usuario = u.id_usuario
                WHERE i.id_usuario = $1 ORDER BY i.fecha_guardado DESC
            `;
            const imgRes = await pool.query(soloMisFotos, [idUsuario]);
            imagenes = imgRes.rows;
        }

        // 4. Enviar todo el paquete de datos al frontend
        res.json({
            success: true,
            miPerfil: {
                nombre: miPerfil.nombre,
                presupuesto: miPerfil.presupuesto_estimado,
                codigo: miPerfil.codigo_pareja
            },
            pareja: nombrePareja,
            imagenes: imagenes
        });

    } catch (error) {
        console.error('Error en perfil:', error);
        res.status(500).json({ success: false, message: 'Error al cargar perfil' });
    }
});

// --- NUEVA RUTA: Obtener solo la info del Header ---
// La usaremos en Principal.html para que sea más rápido
app.get('/header-info/:id', async (req, res) => {
    const idUsuario = req.params.id;
    try {
        const userQuery = 'SELECT nombre, presupuesto_estimado FROM usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        if (userRes.rows.length > 0) {
            res.json({ success: true, usuario: userRes.rows[0] });
        } else {
            res.status(404).json({ success: false });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- ELIMINAR IMAGEN ---
app.post('/eliminar-imagen', async (req, res) => {
    const { id_imagen } = req.body;
    try {
        await pool.query('DELETE FROM imagenes_guardadas WHERE id_imagen = $1', [id_imagen]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});