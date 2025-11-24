const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
// Ajusta esto si tus html están en la carpeta 'boda'
app.use(express.static(__dirname)); 

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'bodaantes', // ¡Asegúrate de que sea el nombre correcto de tu BD!
    password: '13498710',
    port: 5432,
});

// --- Rutas Básicas ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

// ==================================================================
// 1. RUTA DE REGISTRO (Lógica: Catálogo Personalizado por Pareja)
// ==================================================================
app.post('/register', async (req, res) => {
    const { nombre, correo, contrasena, presupuesto, codigo_pareja_input, colores } = req.body;
    
    console.log('--- NUEVO REGISTRO ---');
    console.log('Colores recibidos:', colores);

    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Verificar email
        const checkMail = await client.query('SELECT id_usuario FROM Usuario WHERE email = $1', [correo]);
        if (checkMail.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'El correo ya está registrado.' });
        }

        let cuentaParejaId;
        let codigoFinal;
        // Ordenamos los colores individuales del usuario actual
        const coloresUsuarioActual = colores ? colores.sort() : [];
        const preferenciaColorString = coloresUsuarioActual.join(',');

        // ------------------------------------------------------------
        // ESCENARIO A: EL USUARIO SE UNE A UNA CUENTA EXISTENTE (USER 2)
        // ------------------------------------------------------------
        if (codigo_pareja_input && codigo_pareja_input.trim() !== "") {
            
            const codigoInput = codigo_pareja_input.trim().toUpperCase();
            
            // Buscar la cuenta y su catálogo asociado
            const cuentaRes = await client.query('SELECT id_cuentapareja, fk_catalogo_id FROM CuentaPareja WHERE codigodepareja = $1', [codigoInput]);

            if (cuentaRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'El código ingresado no existe.' });
            }
            
            cuentaParejaId = cuentaRes.rows[0].id_cuentapareja;
            const catalogoIdExistente = cuentaRes.rows[0].fk_catalogo_id;
            codigoFinal = codigoInput;

            // Verificar cupo (Máximo 2 usuarios)
            const checkConteo = await client.query('SELECT count(*) as total, array_agg(preferencia_color) as colores_previos FROM Usuario WHERE fk_cuentapareja_id = $1', [cuentaParejaId]);
            
            if (parseInt(checkConteo.rows[0].total) >= 2) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Ese código ya tiene 2 personas.' });
            }

            // --- LÓGICA DE ACTUALIZACIÓN DEL CATÁLOGO ---
            // Obtenemos colores del User 1
            const user1ColoresString = checkConteo.rows[0].colores_previos[0] || '';
            const user1ColoresArray = user1ColoresString ? user1ColoresString.split(',') : [];

            // Combinamos con colores del User 2 (evitar duplicados y ordenar)
            const todosLosColores = [...new Set([...user1ColoresArray, ...coloresUsuarioActual])].sort();
            const coloresFinalesString = todosLosColores.join(',');

            console.log(`Actualizando Catalogo ID ${catalogoIdExistente} a colores: ${coloresFinalesString}`);

            // ACTUALIZAMOS el catálogo existente
            if (catalogoIdExistente) {
                await client.query(
                    'UPDATE Catalogo SET colores_asociados = $1, nombre_tema = $2 WHERE id_catalogo = $3',
                    [coloresFinalesString, `Tema ${codigoFinal}`, catalogoIdExistente]
                );
            } else {
                // (Caso raro de seguridad: si no tenía catálogo, creamos uno)
                 const createCat = await client.query(
                    'INSERT INTO Catalogo (nombre_tema, colores_asociados) VALUES ($1, $2) RETURNING id_catalogo',
                    [`Tema ${codigoFinal}`, coloresFinalesString]
                );
                await client.query('UPDATE CuentaPareja SET fk_catalogo_id = $1 WHERE id_cuentapareja = $2', [createCat.rows[0].id_catalogo, cuentaParejaId]);
            }

        } 
        // ------------------------------------------------------------
        // ESCENARIO B: CREAR CUENTA NUEVA (USER 1)
        // ------------------------------------------------------------
        else {
            codigoFinal = Math.random().toString(36).substring(2, 8).toUpperCase();

            const nuevoNombreTema = `Tema ${codigoFinal}`; 
            console.log(`Creando nuevo catálogo: ${nuevoNombreTema} con colores: ${preferenciaColorString}`);

            // Creamos el catálogo INMEDIATAMENTE (aunque solo tenga los colores de 1 persona)
            const createThemeRes = await client.query(
                'INSERT INTO Catalogo (nombre_tema, colores_asociados) VALUES ($1, $2) RETURNING id_catalogo',
                [nuevoNombreTema, preferenciaColorString]
            );
            
            const nuevoCatalogoId = createThemeRes.rows[0].id_catalogo;

            // Crear la CuentaPareja vinculada
            const queryCuenta = `
                INSERT INTO CuentaPareja (codigodepareja, presupuesto_estimado, fk_catalogo_id) 
                VALUES ($1, $2, $3) 
                RETURNING id_cuentapareja`;
            const resultCuenta = await client.query(queryCuenta, [codigoFinal, presupuesto || 0, nuevoCatalogoId]);
            cuentaParejaId = resultCuenta.rows[0].id_cuentapareja;
        }

        // ------------------------------------------------------------
        // PASO FINAL: CREAR EL USUARIO
        // ------------------------------------------------------------
        const saltRounds = 10;
        const hashContrasena = await bcrypt.hash(contrasena, saltRounds);

        const queryUsuario = `
            INSERT INTO Usuario (nombre_completo, email, password_hash, preferencia_color, fk_cuentapareja_id) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id_usuario`;
        
        await client.query(queryUsuario, [nombre, correo, hashContrasena, preferenciaColorString, cuentaParejaId]);

        await client.query('COMMIT');
        res.status(201).json({ message: '¡Registro exitoso!', codigo: codigoFinal });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error en registro:", error);
        res.status(500).json({ message: 'Error en el servidor' });
    } finally {
        client.release();
    }
});

// ==================================================================
// 2. RUTA DE LOGIN
// ==================================================================
app.post('/login', async (req, res) => {
    const { correo, contrasena } = req.body;

    try {
        const queryUsuario = `
            SELECT id_usuario, nombre_completo, password_hash, fk_cuentapareja_id 
            FROM Usuario WHERE email = $1`;
        
        const resultUsuario = await pool.query(queryUsuario, [correo]);

        if (resultUsuario.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Correo no encontrado' });
        }

        const usuario = resultUsuario.rows[0];
        const match = await bcrypt.compare(contrasena, usuario.password_hash);

        if (!match) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }

        const idCuentaPareja = usuario.fk_cuentapareja_id;
        
        const queryCuenta = `
            SELECT id_cuentapareja, codigodepareja, presupuesto_estimado, fecha_boda, cantidad_invitados, fk_catalogo_id 
            FROM CuentaPareja WHERE id_cuentapareja = $1`;
            
        const resultCuenta = await pool.query(queryCuenta, [idCuentaPareja]);
        
        if (resultCuenta.rows.length === 0) {
            return res.status(500).json({ success: false, message: 'Error: Cuenta de pareja no encontrada.' });
        }

        const cuentaPareja = resultCuenta.rows[0];

        res.status(200).json({
            success: true,
            message: 'Login correcto',
            usuario: {
                id: usuario.id_usuario,
                nombre: usuario.nombre_completo 
            },
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

// ==================================================================
// 3. RUTA DE PERFIL COMPLETO
// ==================================================================
app.get('/perfil-completo/:id', async (req, res) => {
    const idUsuario = req.params.id;

    if (!idUsuario) return res.status(400).json({ success: false, message: 'Falta ID' });

    try {
        const userQuery = 'SELECT nombre_completo, fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        
        if (userRes.rows.length === 0) return res.status(404).json({ success: false });
        
        const miPerfil = userRes.rows[0];
        const idCuentaPareja = miPerfil.fk_cuentapareja_id;

        const cuentaQuery = 'SELECT codigodepareja, presupuesto_estimado, fecha_boda FROM CuentaPareja WHERE id_cuentapareja = $1';
        const cuentaRes = await pool.query(cuentaQuery, [idCuentaPareja]);
        const miCuenta = cuentaRes.rows[0];

        let nombrePareja = null;
        const parejaQuery = 'SELECT nombre_completo FROM Usuario WHERE fk_cuentapareja_id = $1 AND id_usuario != $2';
        const parejaRes = await pool.query(parejaQuery, [idCuentaPareja, idUsuario]);
        if (parejaRes.rows.length > 0) nombrePareja = parejaRes.rows[0].nombre_completo;

        // Consulta para traer los ítems reservados
        const itemsQuery = `
            SELECT r.id_reserva, r.tipo_opcion, r.monto_total, r.estado_pago,
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.nombre_lugar
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.nombre_item
                    WHEN r.tipo_opcion = 'Catering' THEN c.nombre_servicio
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.nombre_servicio
                    WHEN r.tipo_opcion = 'Planeador' THEN p.nombre_servicio
                END AS nombre_item,
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.url_imagen
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.url_imagen
                    WHEN r.tipo_opcion = 'Catering' THEN c.url_imagen
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.url_imagen
                    WHEN r.tipo_opcion = 'Planeador' THEN p.url_imagen
                END AS url_imagen
            FROM Reserva r
            LEFT JOIN Salon s ON r.fk_opcion_id = s.id_salon AND r.tipo_opcion = 'Salon'
            LEFT JOIN Decoraciones d ON r.fk_opcion_id = d.id_decoracion AND r.tipo_opcion = 'Decoracion'
            LEFT JOIN Catering c ON r.fk_opcion_id = c.id_catering AND r.tipo_opcion = 'Catering'
            LEFT JOIN Fotografo f ON r.fk_opcion_id = f.id_fotografo AND r.tipo_opcion = 'Fotografo'
            LEFT JOIN Planeador p ON r.fk_opcion_id = p.id_planeador AND r.tipo_opcion = 'Planeador'
            WHERE r.fk_cuentapareja_id = $1
            ORDER BY r.id_reserva DESC;
        `;
        
        const itemsRes = await pool.query(itemsQuery, [idCuentaPareja]);

        res.json({
            success: true,
            miPerfil: { nombre: miPerfil.nombre_completo },
            cuenta: {
                presupuesto: miCuenta.presupuesto_estimado,
                codigo: miCuenta.codigodepareja,
                fechaBoda: miCuenta.fecha_boda
            },
            pareja: nombrePareja,
            items: itemsRes.rows
        });

    } catch (error) {
        console.error('Error en perfil:', error);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

// ==================================================================
// 4. RUTA HEADER INFO (Usada en Principal.html)
// ==================================================================
app.get('/header-info/:id', async (req, res) => {
    const idUsuario = req.params.id;
    try {
        const userQuery = 'SELECT nombre_completo, fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false });
        
        const usuario = userRes.rows[0];
        const cuentaQuery = 'SELECT presupuesto_estimado FROM CuentaPareja WHERE id_cuentapareja = $1';
        const cuentaRes = await pool.query(cuentaQuery, [usuario.fk_cuentapareja_id]);

        res.json({ 
            success: true, 
            usuario: {
                nombre: usuario.nombre_completo,
                presupuesto_estimado: cuentaRes.rows[0].presupuesto_estimado
            } 
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ==================================================================
// 5. RUTA CATÁLOGO PODEROSA (Con Filtros de Color, Fecha, Dpto y Capacidad) ---
// --- RUTA CATÁLOGO (CORREGIDA PARA TRAER TODOS LOS DETALLES) ---
app.get('/catalogo-personalizado/:idUsuario', async (req, res) => {
    const { idUsuario } = req.params;
    const { fecha, dpto, capacidad } = req.query; 

    try {
        // 1. Obtener colores
        const userQuery = `
            SELECT c.colores_asociados 
            FROM Usuario u
            JOIN CuentaPareja cp ON u.fk_cuentapareja_id = cp.id_cuentapareja
            JOIN Catalogo c ON cp.fk_catalogo_id = c.id_catalogo
            WHERE u.id_usuario = $1
        `;
        const userRes = await pool.query(userQuery, [idUsuario]);
        let coloresArray = [];
        if (userRes.rows.length > 0 && userRes.rows[0].colores_asociados) {
            coloresArray = userRes.rows[0].colores_asociados.split(',');
        }

        // Filtro Departamento común
        let filtroDptoSQL = "";
        let paramsDpto = [];
        if (dpto && dpto !== "") {
            filtroDptoSQL = " AND departamento = $2 ";
            paramsDpto = [dpto];
        }

        // --- A. DECORACIONES (Agregamos 'descripcion') ---
        const decorQuery = `
            SELECT id_decoracion as id, nombre_item, costo_base, departamento, 
                   url_imagen, color, regla_pago_meses, descripcion, 'Decoracion' as tipo 
            FROM Decoraciones
            WHERE (color = ANY($1) OR color IS NULL)
            ${filtroDptoSQL}
        `;
        const decorRes = await pool.query(decorQuery, [coloresArray, ...paramsDpto]);

        // --- B. SALONES (Agregamos 'incluye_mesas', 'incluye_cubiertos', 'descripcion') ---
        let salonQueryText = `
            SELECT id_salon as id, nombre_lugar as nombre_item, costo_base, departamento, 
                   capacidad, url_imagen, regla_pago_meses, incluye_mesas, incluye_cubiertos, 
                   'Descripción del lugar' as descripcion, -- Si no tienes columna descripcion en Salon, usa texto fijo o agrégala
                   'Salon' as tipo 
            FROM Salon
            WHERE 1=1 
        `;
        
        let salonParams = [];
        let paramCounter = 1;

        if (dpto && dpto !== "") {
            salonQueryText += ` AND departamento = $${paramCounter} `;
            salonParams.push(dpto);
            paramCounter++;
        }
        if (capacidad) {
            salonQueryText += ` AND capacidad >= $${paramCounter} `;
            salonParams.push(capacidad);
            paramCounter++;
        }
        if (fecha) {
            salonQueryText += `
                AND id_salon NOT IN (
                    SELECT fk_opcion_id FROM Reserva r
                    JOIN CuentaPareja cp ON r.fk_cuentapareja_id = cp.id_cuentapareja
                    WHERE r.tipo_opcion = 'Salon' AND cp.fecha_boda = $${paramCounter} AND r.estado_pago != 'Cancelado'
                )
            `;
            salonParams.push(fecha);
            paramCounter++;
        }

        const salonRes = await pool.query(salonQueryText, salonParams);

        // --- C. OTROS (Catering, etc - Agregamos descripcion) ---
        const otrosParams = (dpto && dpto !== "") ? [dpto] : [];
        const clauseDptoOtros = (dpto && dpto !== "") ? " WHERE departamento = $1 " : "";

        const catQuery = `SELECT id_catering as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Catering' as tipo FROM Catering ${clauseDptoOtros}`;
        const fotoQuery = `SELECT id_fotografo as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Fotografo' as tipo FROM Fotografo ${clauseDptoOtros}`;
        const planQuery = `SELECT id_planeador as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Planeador' as tipo FROM Planeador ${clauseDptoOtros}`;

        const catRes = await pool.query(catQuery, otrosParams);
        const fotoRes = await pool.query(fotoQuery, otrosParams);
        const planRes = await pool.query(planQuery, otrosParams);

        // UNIR TODO
        const productos = [
            ...decorRes.rows, ...salonRes.rows, ...catRes.rows, ...fotoRes.rows, ...planRes.rows
        ];
        const productosBarajados = productos.sort(() => 0.5 - Math.random());

        res.json({ success: true, productos: productosBarajados });

    } catch (error) {
        console.error('Error catálogo:', error);
        res.status(500).json({ success: false });
    }
});

// ==================================================================
// 6. RUTA CREAR RESERVA (Reemplaza guardar-imagen)
// ==================================================================
app.post('/crear-reserva', async (req, res) => {
    const { id_usuario, id_opcion, tipo_opcion, monto_total, regla_pago_meses } = req.body;

    if (!id_usuario || !id_opcion) {
        return res.status(400).json({ success: false, message: 'Datos incompletos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1', [id_usuario]);
        const idCuentaPareja = userRes.rows[0].fk_cuentapareja_id;

        let fechaLimite = null;
        if (regla_pago_meses) {
            fechaLimite = new Date();
            fechaLimite.setMonth(fechaLimite.getMonth() + parseInt(regla_pago_meses));
        }

        const query = `
            INSERT INTO Reserva 
                (fk_cuentapareja_id, fk_opcion_id, tipo_opcion, cantidad, monto_total, estado_pago, fecha_limite_pago)
            VALUES 
                ($1, $2, $3, 1, $4, 'Pendiente', $5)
            RETURNING id_reserva`;
        
        await client.query(query, [idCuentaPareja, id_opcion, tipo_opcion, monto_total, fechaLimite]);
        
        await client.query('COMMIT');
        res.status(201).json({ success: true, message: '¡Guardado!' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al guardar.' });
    } finally {
        client.release();
    }
});

// ==================================================================
// 7. RUTA ELIMINAR RESERVA
// ==================================================================
app.post('/eliminar-reserva', async (req, res) => {
    const { id_reserva } = req.body; 
    try {
        const result = await pool.query('DELETE FROM Reserva WHERE id_reserva = $1', [id_reserva]);
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});