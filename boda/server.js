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
    database: 'bodaantes',
    password: '13498710', // TU CONTRASEÑA
    port: 5432,
});

// --- Rutas Básicas ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});
// --- RUTA DE REGISTRO (ACTUALIZADA PARA LA NUEVA BD) ---
app.post('/register', async (req, res) => {
    // Los datos del frontend son los mismos
    const { nombre, correo, contrasena, presupuesto, codigo_pareja_input, colores } = req.body;
    
    const client = await pool.connect();
    
    try {
        // Iniciamos la transacción
        await client.query('BEGIN');

        // 1. Verificar si el email ya existe en la nueva tabla 'Usuario'
        const checkMail = await client.query('SELECT id_usuario FROM Usuario WHERE email = $1', [correo]);
        if (checkMail.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'El correo ya está registrado.' });
        }

        let cuentaParejaId;
        let codigoFinal;
        const coloresString = colores ? colores.join(',') : ''; // 'Rosa,Azul'

        if (codigo_pareja_input && codigo_pareja_input.trim() !== "") {
            // --- LÓGICA PARA EL USUARIO 2 (Unirse a una cuenta) ---
            
            const codigoInput = codigo_pareja_input.trim().toUpperCase();
            
            // 2. Buscar el código en la nueva tabla 'CuentaPareja'
            const cuentaRes = await client.query('SELECT id_cuentapareja FROM CuentaPareja WHERE codigodepareja = $1', [codigoInput]);

            if (cuentaRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'El código ingresado no existe.' });
            }
            
            cuentaParejaId = cuentaRes.rows[0].id_cuentapareja;
            codigoFinal = codigoInput;

            // 3. Verificar que la cuenta no esté llena (buscando en 'Usuario')
            const checkConteo = await client.query('SELECT count(*) as total FROM Usuario WHERE fk_cuentapareja_id = $1', [cuentaParejaId]);
            const totalUsuarios = parseInt(checkConteo.rows[0].total);

            if (totalUsuarios >= 2) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Ese código ya tiene 2 personas.' });
            }

            // 4. (NUEVO) Actualizar el Catálogo de la Pareja con los colores combinados
            // Obtenemos el color del Usuario 1
            const user1Res = await client.query('SELECT preferencia_color FROM Usuario WHERE fk_cuentapareja_id = $1', [cuentaParejaId]);
            const user1Colores = user1Res.rows[0].preferencia_color || '';
            
            // Combinamos y ordenamos los colores (ej. 'Azul' + 'Rosa' -> 'Azul,Rosa')
            const combinedColores = [user1Colores, coloresString].filter(Boolean).sort().join(',');

            // Buscamos el ID del tema combinado en la tabla 'Catalogo'
            const themeRes = await client.query('SELECT id_catalogo FROM Catalogo WHERE colores_asociados = $1', [combinedColores]);
            
            if (themeRes.rows.length > 0) {
                const fkCatalogoId = themeRes.rows[0].id_catalogo;
                // Actualizamos la CuentaPareja con el nuevo tema combinado
                await client.query('UPDATE CuentaPareja SET fk_catalogo_id = $1 WHERE id_cuentapareja = $2', [fkCatalogoId, cuentaParejaId]);
            }

        } else {
            // --- LÓGICA PARA EL USUARIO 1 (Crear una cuenta nueva) ---
            
            // 2. Generar código único para 'CuentaPareja'
            codigoFinal = Math.random().toString(36).substring(2, 8).toUpperCase(); // (Tu lógica es perfecta)

            // 3. (NUEVO) Buscar el ID del catálogo para este primer usuario
            let fkCatalogoId = null;
            if (coloresString) {
                const themeRes = await client.query('SELECT id_catalogo FROM Catalogo WHERE colores_asociados = $1', [coloresString]);
                if (themeRes.rows.length > 0) {
                    fkCatalogoId = themeRes.rows[0].id_catalogo;
                }
            }

            // 4. (NUEVO) Insertar el proyecto en 'CuentaPareja'
            const queryCuenta = `
                INSERT INTO CuentaPareja (codigodepareja, presupuesto_estimado, fk_catalogo_id) 
                VALUES ($1, $2, $3) 
                RETURNING id_cuentapareja`;
            const resultCuenta = await client.query(queryCuenta, [codigoFinal, presupuesto || 0, fkCatalogoId]);
            cuentaParejaId = resultCuenta.rows[0].id_cuentapareja;
        }

        // 5. Hashear la contraseña (Sin cambios)
        const saltRounds = 10;
        const hashContrasena = await bcrypt.hash(contrasena, saltRounds);

        // 6. (MODIFICADO) Insertar la persona en 'Usuario' y vincularla
        const queryUsuario = `
            INSERT INTO Usuario (nombre_completo, email, password_hash, preferencia_color, fk_cuentapareja_id) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id_usuario`;
        
        await client.query(queryUsuario, [nombre, correo, hashContrasena, coloresString, cuentaParejaId]);

        // 7. Finalizar la transacción
        await client.query('COMMIT');
        
        res.status(201).json({ message: '¡Registro exitoso!', codigo: codigoFinal });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor' });
    } finally {
        client.release();
    }
});

// --- RUTA DE LOGIN (ACTUALIZADA PARA LA NUEVA BD) ---
app.post('/login', async (req, res) => {
    // Los datos del frontend (correo, contrasena) son los mismos
    const { correo, contrasena } = req.body;

    try {
        // --- Paso 1: Autenticar al Usuario ---
        
        // Buscamos en la nueva tabla 'Usuario' (notar los nuevos nombres de columnas)
        const queryUsuario = `
            SELECT id_usuario, nombre_completo, password_hash, fk_cuentapareja_id 
            FROM Usuario 
            WHERE email = $1`;
        
        const resultUsuario = await pool.query(queryUsuario, [correo]);

        if (resultUsuario.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Correo no encontrado' });
        }

        const usuario = resultUsuario.rows[0];

        // Comparamos la contraseña (tu lógica bcrypt es perfecta)
        // Usamos 'password_hash' de la nueva tabla
        const match = await bcrypt.compare(contrasena, usuario.password_hash);

        if (!match) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }

        // --- Paso 2: Cargar el Proyecto (CuentaPareja) ---
        
        // Si la contraseña es correcta, usamos el FK para buscar el proyecto compartido
        const idCuentaPareja = usuario.fk_cuentapareja_id;
        
        const queryCuenta = `
            SELECT id_cuentapareja, codigodepareja, presupuesto_estimado, fecha_boda, cantidad_invitados, fk_catalogo_id 
            FROM CuentaPareja 
            WHERE id_cuentapareja = $1`;
            
        const resultCuenta = await pool.query(queryCuenta, [idCuentaPareja]);
        
        if (resultCuenta.rows.length === 0) {
            // Esto sería un error grave en la BD (un usuario sin cuenta)
            return res.status(500).json({ success: false, message: 'Error: No se encontró la cuenta de pareja asociada.' });
        }

        const cuentaPareja = resultCuenta.rows[0];

        // --- Paso 3: Enviar la Sesión Completa al Frontend ---
        
        // Combinamos los datos del Usuario y de la CuentaPareja
        res.status(200).json({
            success: true,
            message: 'Login correcto',
            // Datos del usuario individual
            usuario: {
                id: usuario.id_usuario,
                nombre: usuario.nombre_completo 
            },
            // Datos del proyecto compartido
            cuenta: {
                id: cuentaPareja.id_cuentapareja,
                codigo: cuentaPareja.codigodepareja,
                presupuesto: cuentaPareja.presupuesto_estimado,
                fechaBoda: cuentaPareja.fecha_boda,
                invitados: cuentaPareja.cantidad_invitados,
                idCatalogo: cuentaPareja.fk_catalogo_id
            }
        });

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

// --- RUTA DE PERFIL (ACTUALIZADA PARA LA NUEVA BD) ---
// Ahora la llamamos con el ID de Usuario y devuelve TODOS los datos del proyecto
app.get('/perfil-completo/:id', async (req, res) => {
    const idUsuario = req.params.id;

    if (!idUsuario) {
        return res.status(400).json({ success: false, message: 'Falta ID de usuario' });
    }

    try {
        // 1. Obtener mis datos (Nombre, ID de cuenta)
        const userQuery = 'SELECT nombre_completo, fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }
        
        const miPerfil = userRes.rows[0];
        const miNombre = miPerfil.nombre_completo;
        const idCuentaPareja = miPerfil.fk_cuentapareja_id;

        // 2. Obtener los datos de la CuentaPareja (El Proyecto)
        const cuentaQuery = 'SELECT codigodepareja, presupuesto_estimado, fecha_boda FROM CuentaPareja WHERE id_cuentapareja = $1';
        const cuentaRes = await pool.query(cuentaQuery, [idCuentaPareja]);
        const miCuenta = cuentaRes.rows[0];

        // 3. Buscar a mi pareja
        let nombrePareja = null;
        const parejaQuery = 'SELECT nombre_completo FROM Usuario WHERE fk_cuentapareja_id = $1 AND id_usuario != $2';
        const parejaRes = await pool.query(parejaQuery, [idCuentaPareja, idUsuario]);
        if (parejaRes.rows.length > 0) {
            nombrePareja = parejaRes.rows[0].nombre_completo;
        }

        // 4. Buscar ítems guardados (Reservas) - ESTA ES LA NUEVA LÓGICA
        // Esta consulta une la Reserva con las 5 tablas de opciones
        const itemsQuery = `
            SELECT 
                r.id_reserva, r.tipo_opcion, r.monto_total, r.estado_pago, r.fecha_limite_pago,
                
                -- Usamos CASE para obtener el nombre del producto de la tabla correcta
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.nombre_lugar
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.nombre_item
                    WHEN r.tipo_opcion = 'Catering' THEN c.nombre_servicio
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.nombre_servicio
                    WHEN r.tipo_opcion = 'Planeador' THEN p.nombre_servicio
                END AS nombre_item,
                
                -- Usamos CASE para obtener la imagen de la tabla correcta
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.url_imagen
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.url_imagen
                    WHEN r.tipo_opcion = 'Catering' THEN c.url_imagen
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.url_imagen
                    WHEN r.tipo_opcion = 'Planeador' THEN p.url_imagen
                END AS url_imagen
            FROM 
                Reserva r
            LEFT JOIN Salon s ON r.fk_opcion_id = s.id_salon AND r.tipo_opcion = 'Salon'
            LEFT JOIN Decoraciones d ON r.fk_opcion_id = d.id_decoracion AND r.tipo_opcion = 'Decoracion'
            LEFT JOIN Catering c ON r.fk_opcion_id = c.id_catering AND r.tipo_opcion = 'Catering'
            LEFT JOIN Fotografo f ON r.fk_opcion_id = f.id_fotografo AND r.tipo_opcion = 'Fotografo'
            LEFT JOIN Planeador p ON r.fk_opcion_id = p.id_planeador AND r.tipo_opcion = 'Planeador'
            WHERE 
                r.fk_cuentapareja_id = $1
            ORDER BY 
                r.id_reserva DESC;
        `;
        
        const itemsRes = await pool.query(itemsQuery, [idCuentaPareja]);
        const itemsGuardados = itemsRes.rows;

        // 5. Enviar todo el paquete de datos al frontend
        res.json({
            success: true,
            miPerfil: {
                nombre: miNombre,
                // (Los datos del proyecto ahora están en la sección 'cuenta')
            },
            cuenta: {
                presupuesto: miCuenta.presupuesto_estimado,
                codigo: miCuenta.codigodepareja,
                fechaBoda: miCuenta.fecha_boda
            },
            pareja: nombrePareja,
            items: itemsGuardados // Reemplaza 'imagenes' con 'items'
        });

    } catch (error) {
        console.error('Error en perfil:', error);
        res.status(500).json({ success: false, message: 'Error al cargar perfil' });
    }
});

// --- NUEVA RUTA: Obtener solo la info del Header ---
// (Esta ruta faltaba en la migración y la necesita 'principal.html')

app.get('/header-info/:id', async (req, res) => {
    const idUsuario = req.params.id;

    try {
        // 1. Buscar al usuario para obtener su nombre y el ID de la cuenta
        const userQuery = 'SELECT nombre_completo, fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }
        
        const usuario = userRes.rows[0];
        const idCuentaPareja = usuario.fk_cuentapareja_id;

        // 2. Buscar el presupuesto en la CuentaPareja
        const cuentaQuery = 'SELECT presupuesto_estimado FROM CuentaPareja WHERE id_cuentapareja = $1';
        const cuentaRes = await pool.query(cuentaQuery, [idCuentaPareja]);

        if (cuentaRes.rows.length === 0) {
             return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });
        }

        // 3. Devolver los datos EXACTAMENTE como los espera el HTML
        res.json({ 
            success: true, 
            usuario: {
                nombre: usuario.nombre_completo,
                presupuesto_estimado: cuentaRes.rows[0].presupuesto_estimado
            } 
        });

    } catch (error) {
        console.error('Error en /header-info:', error);
        res.status(500).json({ success: false, message: 'Error interno' });
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