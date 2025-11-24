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
// --- A. RUTA PARA GUARDAR PRESUPUESTO (CORREGIDA CON LOGS) ---
app.post('/actualizar-presupuesto', async (req, res) => {
    const { idUsuario, nuevoPresupuesto } = req.body;
    console.log(`--> SOLICITUD DE ACTUALIZACIÓN: Usuario ${idUsuario} a Presupuesto ${nuevoPresupuesto}`);

    try {
        // 1. Buscar la cuenta
        const userRes = await pool.query('SELECT fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1', [idUsuario]);
        
        if (userRes.rows.length === 0) {
            console.log("Error: Usuario no encontrado");
            return res.status(404).json({ success: false });
        }
        
        const idCuenta = userRes.rows[0].fk_cuentapareja_id;

        // 2. ACTUALIZAR (Asegurando que sea numérico)
        await pool.query(
            'UPDATE CuentaPareja SET presupuesto_estimado = $1 WHERE id_cuentapareja = $2', 
            [parseFloat(nuevoPresupuesto), idCuenta]
        );

        console.log(`--> ÉXITO: Cuenta ${idCuenta} actualizada a ${nuevoPresupuesto}`);
        res.json({ success: true, message: 'Presupuesto actualizado' });

    } catch (error) {
        console.error('Error actualizando presupuesto:', error);
        res.status(500).json({ success: false });
    }
});

// --- B. RUTA CATÁLOGO (FILTRO ESTRICTO SIN EXCEPCIONES) ---
app.get('/catalogo-personalizado/:idUsuario', async (req, res) => {
    const { idUsuario } = req.params;
    const { fecha, dpto, capacidad, presupuesto } = req.query; 

    console.log(`--> FILTRANDO CATÁLOGO para Usuario ${idUsuario}. Presupuesto Filtro: ${presupuesto}`);

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

        // --- CONSTRUCTOR DE FILTROS ---
        const construirFiltros = (indiceInicio) => {
            let sql = "";
            let params = [];
            let idx = indiceInicio;

            if (dpto && dpto !== "") {
                sql += ` AND departamento = $${idx} `;
                params.push(dpto);
                idx++;
            }

            // *** FILTRO DE PRECIO ESTRICTO ***
            // Si llega un presupuesto, filtramos TODO lo que sea mayor.
            if (presupuesto && presupuesto > 0) {
                sql += ` AND costo_base <= $${idx}::numeric `;
                params.push(presupuesto);
                idx++;
            }
            
            return { sql, params, nextIdx: idx };
        };

        // --- CONSULTAS ---
        
        // A. DECORACIONES
        const filtrosDecor = construirFiltros(2);
        const decorQuery = `
            SELECT id_decoracion as id, nombre_item, costo_base, departamento, 
                   url_imagen, color, regla_pago_meses, descripcion, 'Decoracion' as tipo 
            FROM Decoraciones
            WHERE (color = ANY($1) OR color IS NULL)
            ${filtrosDecor.sql}
        `;
        const decorRes = await pool.query(decorQuery, [coloresArray, ...filtrosDecor.params]);

        // B. SALONES
        let salonFiltros = construirFiltros(1);
        let salonQueryText = `
            SELECT id_salon as id, nombre_lugar as nombre_item, costo_base, departamento, 
                   capacidad, url_imagen, regla_pago_meses, incluye_mesas, incluye_cubiertos, 
                   'Descripción del lugar' as descripcion, 'Salon' as tipo 
            FROM Salon
            WHERE 1=1 ${salonFiltros.sql}
        `;
        let salonParams = [...salonFiltros.params];
        let salonIdx = salonFiltros.nextIdx;

        if (capacidad) {
            salonQueryText += ` AND capacidad >= $${salonIdx} `;
            salonParams.push(capacidad);
            salonIdx++;
        }
        if (fecha) {
            // Subconsulta de disponibilidad
            salonQueryText += `
                AND id_salon NOT IN (
                    SELECT fk_opcion_id FROM Reserva r
                    JOIN CuentaPareja cp ON r.fk_cuentapareja_id = cp.id_cuentapareja
                    WHERE r.tipo_opcion = 'Salon' AND cp.fecha_boda = $${salonIdx} AND r.estado_pago != 'Cancelado'
                )
            `;
            salonParams.push(fecha);
        }
        const salonRes = await pool.query(salonQueryText, salonParams);

        // C. OTROS
        const otrosFiltros = construirFiltros(1);
        const otrosClause = ` WHERE 1=1 ${otrosFiltros.sql} `;
        
        const catQuery = `SELECT id_catering as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Catering' as tipo FROM Catering ${otrosClause}`;
        const fotoQuery = `SELECT id_fotografo as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Fotografo' as tipo FROM Fotografo ${otrosClause}`;
        const planQuery = `SELECT id_planeador as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Planeador' as tipo FROM Planeador ${otrosClause}`;

        const catRes = await pool.query(catQuery, otrosFiltros.params);
        const fotoRes = await pool.query(fotoQuery, otrosFiltros.params);
        const planRes = await pool.query(planQuery, otrosFiltros.params);

        const productos = [
            ...decorRes.rows, ...salonRes.rows, ...catRes.rows, ...fotoRes.rows, ...planRes.rows
        ];

        res.json({ success: true, productos: productos.sort(() => 0.5 - Math.random()) });

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
// --- RUTA: OBTENER NOTIFICACIONES DE PAGO ---
app.get('/notificaciones/:idUsuario', async (req, res) => {
    const { idUsuario } = req.params;
    try {
        // 1. Obtener ID de cuenta
        const userRes = await pool.query('SELECT fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1', [idUsuario]);
        if(userRes.rows.length === 0) return res.json({ notificaciones: [] });
        const idCuenta = userRes.rows[0].fk_cuentapareja_id;

        // 2. Buscar reservas pendientes con fecha límite cercana (próximos 7 días o vencidos)
        // Solo nos interesan Salones/Catering que suelen tener fecha limite
        const query = `
            SELECT id_reserva, tipo_opcion, monto_total, fecha_limite_pago 
            FROM Reserva 
            WHERE fk_cuentapareja_id = $1 
            AND estado_pago != 'Pagado Total' 
            AND estado_pago != 'Cancelado'
            AND fecha_limite_pago IS NOT NULL
            AND fecha_limite_pago <= (CURRENT_DATE + INTERVAL '7 days')
        `;
        
        const result = await pool.query(query, [idCuenta]);
        res.json({ notificaciones: result.rows });

    } catch (error) {
        console.error(error);
        res.status(500).json({ notificaciones: [] });
    }
});
// --- RUTA: ESTADÍSTICAS ADMIN ---
app.get('/admin/stats', async (req, res) => {
    try {
        const users = await pool.query('SELECT COUNT(*) FROM Usuario');
        const cuentas = await pool.query('SELECT COUNT(*) FROM CuentaPareja');
        const reservas = await pool.query('SELECT COUNT(*) FROM Reserva WHERE estado_pago != \'Cancelado\'');
        
        res.json({
            usuarios: users.rows[0].count,
            cuentas: cuentas.rows[0].count,
            reservas: reservas.rows[0].count
        });
    } catch (error) {
        res.status(500).json({ error: 'Error' });
    }
});
// --- RUTA LOGIN ADMINISTRADOR ---
app.post('/admin/login', async (req, res) => {
    const { correo, contrasena } = req.body;

    try {
        // 1. Buscar en tabla ADMINISTRADOR
        const query = 'SELECT id_admin, nombre_admin, password_hash FROM Administrador WHERE email = $1';
        const result = await pool.query(query, [correo]);

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Admin no encontrado' });
        }

        const admin = result.rows[0];
        
        // 2. Verificar contraseña
        const match = await bcrypt.compare(contrasena, admin.password_hash);

        if (!match) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }

        // 3. Éxito
        res.json({
            success: true,
            message: 'Bienvenido Admin',
            admin: {
                id: admin.id_admin,
                nombre: admin.nombre_admin
            },
            redirect: 'Admin.html' // Redirige al panel que creamos antes
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error interno' });
    }
});
// ==================================================================
// ==================================================================
// 8. RUTA DE REPORTES AVANZADOS (ACTUALIZADA)
// ==================================================================
app.get('/admin/reportes/:tipo', async (req, res) => {
    const { tipo } = req.params;
    const { servicio } = req.query; // Para filtrar por 'Salon', 'Decoracion', etc.

    try {
        let query = '';
        let params = [];
        
        switch (tipo) {
            // 1. USUARIOS: Crecimiento por mes (Fecha de Creación)
            case 'usuarios-crecimiento':
                query = `
                    SELECT to_char(fecha_creacion, 'Month') as etiqueta, COUNT(*) as valor
                    FROM CuentaPareja
                    GROUP BY to_char(fecha_creacion, 'Month'), date_part('month', fecha_creacion)
                    ORDER BY date_part('month', fecha_creacion) ASC
                `;
                break;

            // 2. USUARIOS: Distribución de Presupuesto (Rangos)
            case 'usuarios-presupuesto':
                query = `
                    SELECT 
                        CASE 
                            WHEN presupuesto_estimado < 5000 THEN 'Bajo (< 5k)'
                            WHEN presupuesto_estimado BETWEEN 5000 AND 15000 THEN 'Medio (5k - 15k)'
                            WHEN presupuesto_estimado BETWEEN 15001 AND 30000 THEN 'Alto (15k - 30k)'
                            ELSE 'Premium (> 30k)'
                        END as etiqueta,
                        COUNT(*) as valor
                    FROM CuentaPareja
                    GROUP BY etiqueta
                    ORDER BY valor DESC
                `;
                break;

            // 3. SERVICIOS: Demanda por Mes (Basado en Fecha de Boda)
            // Sirve para las 5 tablas: Salon, Decoracion, Catering, Fotografo, Planeador
            case 'demanda-mes':
                if (!servicio) return res.status(400).json({ error: 'Falta parametro servicio' });
                
                query = `
                    SELECT to_char(cp.fecha_boda, 'Month') as etiqueta, COUNT(r.id_reserva) as valor
                    FROM Reserva r
                    JOIN CuentaPareja cp ON r.fk_cuentapareja_id = cp.id_cuentapareja
                    WHERE r.tipo_opcion = $1 AND r.estado_pago != 'Cancelado' AND cp.fecha_boda IS NOT NULL
                    GROUP BY to_char(cp.fecha_boda, 'Month'), date_part('month', cp.fecha_boda)
                    ORDER BY date_part('month', cp.fecha_boda) ASC
                `;
                params = [servicio];
                break;

            // 4. TOP DE CADA CATEGORÍA (Lo que ya tenías, optimizado)
            case 'top-items':
                if (!servicio) return res.status(400).json({ error: 'Falta parametro servicio' });
                
                // Lógica dinámica para saber qué tabla unir
                let tabla = '';
                let campoNombre = '';
                let idCampo = '';

                if (servicio === 'Salon') { tabla = 'Salon'; campoNombre = 'nombre_lugar'; idCampo = 'id_salon'; }
                else if (servicio === 'Decoracion') { tabla = 'Decoraciones'; campoNombre = 'nombre_item'; idCampo = 'id_decoracion'; }
                else if (servicio === 'Catering') { tabla = 'Catering'; campoNombre = 'nombre_servicio'; idCampo = 'id_catering'; }
                else if (servicio === 'Fotografo') { tabla = 'Fotografo'; campoNombre = 'nombre_servicio'; idCampo = 'id_fotografo'; }
                else if (servicio === 'Planeador') { tabla = 'Planeador'; campoNombre = 'nombre_servicio'; idCampo = 'id_planeador'; }

                query = `
                    SELECT s.${campoNombre} as etiqueta, COUNT(r.id_reserva) as valor
                    FROM Reserva r
                    JOIN ${tabla} s ON r.fk_opcion_id = s.${idCampo}
                    WHERE r.tipo_opcion = $1 AND r.estado_pago != 'Cancelado'
                    GROUP BY s.${campoNombre}
                    ORDER BY valor DESC
                    LIMIT 5
                `;
                params = [servicio];
                break;

            default:
                return res.status(400).json({ error: 'Tipo de reporte no válido' });
        }

        const result = await pool.query(query, params);
        
        const etiquetas = result.rows.map(row => row.etiqueta.trim());
        const valores = result.rows.map(row => parseInt(row.valor));

        res.json({ etiquetas, valores });

    } catch (error) {
        console.error('Error en reportes:', error);
        res.status(500).json({ error: 'Error al generar reporte' });
    }
});

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});