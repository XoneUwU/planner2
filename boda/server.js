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
    // VALIDACIÓN BACKEND
    const nombreRegex = /^[a-zA-ZñÑáéíóúÁÉÍÓÚ\s]+$/;
    if (!nombreRegex.test(nombre)) {
        return res.status(400).json({ message: 'Nombre inválido (solo letras permitidas).' });
    }
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
// 1. RUTA PERFIL (ACTUALIZADA: TRAE DATOS DETALLADOS)
app.get('/perfil-completo/:id', async (req, res) => {
    const idUsuario = req.params.id;
    if (!idUsuario) return res.status(400).json({ success: false });

    try {
        // ... (Tu lógica de usuario y cuenta se mantiene igual) ...
        const userQuery = 'SELECT nombre_completo, fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false });
        
        const miPerfil = userRes.rows[0];
        const idCuenta = miPerfil.fk_cuentapareja_id;

        const cuentaQuery = 'SELECT codigodepareja, presupuesto_estimado, fecha_boda FROM CuentaPareja WHERE id_cuentapareja = $1';
        const cuentaRes = await pool.query(cuentaQuery, [idCuenta]);
        const miCuenta = cuentaRes.rows[0];

        let nombrePareja = null;
        const parejaQuery = 'SELECT nombre_completo FROM Usuario WHERE fk_cuentapareja_id = $1 AND id_usuario != $2';
        const parejaRes = await pool.query(parejaQuery, [idCuenta, idUsuario]);
        if (parejaRes.rows.length > 0) nombrePareja = parejaRes.rows[0].nombre_completo;

        // --- CONSULTA MEJORADA (Trae Capacidad, Depto y Reglas) ---
        // --- CONSULTA CORREGIDA (AHORA INCLUYE EL ACUMULADO) ---
        const itemsQuery = `
            SELECT 
                r.id_reserva, 
                r.tipo_opcion, 
                r.monto_total, 
                r.estado_pago,
                r.monto_pagado_acumulado, -- <--- ¡ESTO FALTABA!
                r.fecha_limite_pago,

                -- Nombre
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.nombre_lugar
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.nombre_item
                    WHEN r.tipo_opcion = 'Catering' THEN c.nombre_servicio
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.nombre_servicio
                    WHEN r.tipo_opcion = 'Planeador' THEN p.nombre_servicio
                END AS nombre_item,
                -- Imagen
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.url_imagen
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.url_imagen
                    WHEN r.tipo_opcion = 'Catering' THEN c.url_imagen
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.url_imagen
                    WHEN r.tipo_opcion = 'Planeador' THEN p.url_imagen
                END AS url_imagen,
                -- Departamento
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.departamento
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.departamento
                    WHEN r.tipo_opcion = 'Catering' THEN c.departamento
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.departamento
                    WHEN r.tipo_opcion = 'Planeador' THEN p.departamento
                END AS departamento,
                -- Regla Pago
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.regla_pago_meses
                    WHEN r.tipo_opcion = 'Decoracion' THEN d.regla_pago_meses
                    WHEN r.tipo_opcion = 'Catering' THEN c.regla_pago_meses
                    WHEN r.tipo_opcion = 'Fotografo' THEN f.regla_pago_meses
                    WHEN r.tipo_opcion = 'Planeador' THEN p.regla_pago_meses
                END AS regla_meses,
                -- Capacidad
                CASE
                    WHEN r.tipo_opcion = 'Salon' THEN s.capacidad
                    ELSE NULL
                END AS capacidad

            FROM Reserva r
            LEFT JOIN Salon s ON r.fk_opcion_id = s.id_salon AND r.tipo_opcion = 'Salon'
            LEFT JOIN Decoraciones d ON r.fk_opcion_id = d.id_decoracion AND r.tipo_opcion = 'Decoracion'
            LEFT JOIN Catering c ON r.fk_opcion_id = c.id_catering AND r.tipo_opcion = 'Catering'
            LEFT JOIN Fotografo f ON r.fk_opcion_id = f.id_fotografo AND r.tipo_opcion = 'Fotografo'
            LEFT JOIN Planeador p ON r.fk_opcion_id = p.id_planeador AND r.tipo_opcion = 'Planeador'
            WHERE r.fk_cuentapareja_id = $1
            ORDER BY r.id_reserva DESC;
        `;
        
        const itemsRes = await pool.query(itemsQuery, [idCuenta]);

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
        res.status(500).json({ success: false });
    }
});

// 2. RUTA CREAR RESERVA (ACTUALIZADA: BLOQUEA DUPLICADOS)
// 6. RUTA CREAR RESERVA (CON BLOQUEO DE SALONES MÚLTIPLES)
app.post('/crear-reserva', async (req, res) => {
    const { id_usuario, id_opcion, tipo_opcion, monto_total, regla_pago_meses } = req.body;

    if (!id_usuario || !id_opcion) {
        return res.status(400).json({ success: false, message: 'Datos incompletos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1', [id_usuario]);
        const idCuenta = userRes.rows[0].fk_cuentapareja_id;

        // --- NUEVA VALIDACIÓN: REGLA DE EXCLUSIVIDAD DE SALÓN ---
        if (tipo_opcion === 'Salon') {
            // Verificar si YA existe un salón con dinero de por medio (Abonado o Pagado)
            const checkSalonComprometido = await client.query(
                `SELECT id_reserva FROM Reserva 
                 WHERE fk_cuentapareja_id = $1 
                 AND tipo_opcion = 'Salon' 
                 AND estado_pago IN ('Abonado', 'Pagado Total')`,
                [idCuenta]
            );

            if (checkSalonComprometido.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    success: false, 
                    message: 'No puedes reservar otro salón. Ya tienes uno con pagos realizados.' 
                });
            }
        }
        // ---------------------------------------------------------

        const check = await client.query('SELECT id_reserva FROM Reserva WHERE fk_cuentapareja_id=$1 AND fk_opcion_id=$2 AND tipo_opcion=$3 AND estado_pago!=\'Cancelado\'', [idCuenta, id_opcion, tipo_opcion]);
        if(check.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Ya guardado.' }); }

        let fl = null; if(regla_pago_meses) { fl = new Date(); fl.setMonth(fl.getMonth() + parseInt(regla_pago_meses)); }
        
        await client.query('INSERT INTO Reserva (fk_cuentapareja_id, fk_opcion_id, tipo_opcion, monto_total, estado_pago, fecha_limite_pago) VALUES ($1, $2, $3, $4, \'Pendiente\', $5)', [idCuenta, id_opcion, tipo_opcion, monto_total, fl]);
        
        await client.query('COMMIT'); 
        res.json({ success: true, message: '¡Guardado!' });

    } catch (e) { 
        await client.query('ROLLBACK'); 
        console.error(e); 
        res.status(500).json({ message: 'Error' }); 
    } finally { client.release(); }
});

// ==================================================================
// --- 1. RUTA HEADER INFO (AHORA DEVUELVE TAMBIÉN CANTIDAD INVITADOS) ---
app.get('/header-info/:id', async (req, res) => {
    const idUsuario = req.params.id;
    try {
        const userQuery = 'SELECT nombre_completo, fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1';
        const userRes = await pool.query(userQuery, [idUsuario]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false });
        
        const usuario = userRes.rows[0];
        
        // Agregamos 'cantidad_invitados' a la consulta
        const cuentaQuery = 'SELECT presupuesto_estimado, cantidad_invitados FROM CuentaPareja WHERE id_cuentapareja = $1';
        const cuentaRes = await pool.query(cuentaQuery, [usuario.fk_cuentapareja_id]);

        res.json({ 
            success: true, 
            usuario: {
                nombre: usuario.nombre_completo,
                presupuesto_estimado: cuentaRes.rows[0].presupuesto_estimado,
                cantidad_invitados: cuentaRes.rows[0].cantidad_invitados // <--- NUEVO CAMPO
            } 
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- 2. RUTA ACTUALIZAR PREFERENCIAS (PRESUPUESTO + CAPACIDAD) ---
// (Reemplaza a la ruta antigua /actualizar-presupuesto)
app.post('/actualizar-preferencias', async (req, res) => {
    const { idUsuario, nuevoPresupuesto, nuevaCapacidad } = req.body;

    try {
        // 1. Buscar la cuenta
        const userRes = await pool.query('SELECT fk_cuentapareja_id FROM Usuario WHERE id_usuario = $1', [idUsuario]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false });
        
        const idCuenta = userRes.rows[0].fk_cuentapareja_id;

        // 2. Actualización Dinámica (Solo actualiza si el dato viene)
        // Truco SQL: COALESCE(valor_nuevo, valor_viejo) mantiene el viejo si el nuevo es nulo
        const query = `
            UPDATE CuentaPareja 
            SET 
                presupuesto_estimado = COALESCE($1, presupuesto_estimado),
                cantidad_invitados = COALESCE($2, cantidad_invitados)
            WHERE id_cuentapareja = $3
        `;
        
        // Si vienen vacíos o undefined, mandamos NULL para que COALESCE use el valor viejo
        const presVal = nuevoPresupuesto ? parseFloat(nuevoPresupuesto) : null;
        const capVal = nuevaCapacidad ? parseInt(nuevaCapacidad) : null;

        await pool.query(query, [presVal, capVal, idCuenta]);

        res.json({ success: true, message: 'Preferencias actualizadas' });

    } catch (error) {
        console.error('Error actualizando preferencias:', error);
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
// --- RUTA CATÁLOGO (CORREGIDA PARA BÚSQUEDAS PARCIALES "Azul/Blanco") ---
app.get('/catalogo-personalizado/:idUsuario', async (req, res) => {
    const { idUsuario } = req.params;
    const { fecha, dpto, capacidad, presupuesto } = req.query; 

    try {
        // 1. Obtener colores del usuario
        const userQuery = `
            SELECT c.colores_asociados 
            FROM Usuario u
            JOIN CuentaPareja cp ON u.fk_cuentapareja_id = cp.id_cuentapareja
            JOIN Catalogo c ON cp.fk_catalogo_id = c.id_catalogo
            WHERE u.id_usuario = $1
        `;
        const userRes = await pool.query(userQuery, [idUsuario]);
        
        // --- CAMBIO 1: PREPARAR COLORES PARA BÚSQUEDA PARCIAL ---
        let coloresRegex = ''; // Usaremos Regex de PostgreSQL (~)
        if (userRes.rows.length > 0 && userRes.rows[0].colores_asociados) {
            // Convertimos ['Azul', 'Rojo'] en 'Azul|Rojo' (Esto significa Azul O Rojo en Regex)
            coloresRegex = userRes.rows[0].colores_asociados.split(',').join('|');
        }

        // --- HELPER PARA FILTROS (MODIFICADO) ---
        const construirFiltros = (indiceInicio, nombreTabla) => {
            let sql = "";
            let params = [];
            let idx = indiceInicio;

            // --- CAMBIO 2: DEPARTAMENTO CON 'ILIKE' Y COMODINES ---
            if (dpto && dpto !== "") {
                // ILIKE busca sin importar mayúsculas/minúsculas
                // Los % significan "cualquier texto antes o después"
                sql += ` AND departamento ILIKE $${idx} `;
                params.push(`%${dpto}%`); // Ej: busca "%Tarija%" dentro de "Tarija/Cochabamba"
                idx++;
            }

            if (presupuesto && presupuesto > 0) {
                sql += ` AND costo_base <= $${idx}::numeric `;
                params.push(presupuesto);
                idx++;
            }
            
            return { sql, params, nextIdx: idx };
        };

        // --- A. DECORACIONES (USANDO REGEX PARA COLORES) ---
        // Parametro $1 ahora es el string del Regex ('Azul|Blanco'), no el array
        const filtrosDecor = construirFiltros(2, 'Decoraciones');
        
        const decorQuery = `
            SELECT id_decoracion as id, nombre_item, costo_base, departamento, 
                   url_imagen, color, regla_pago_meses, descripcion, 'Decoracion' as tipo 
            FROM Decoraciones
            WHERE (color ~* $1 OR color IS NULL) -- '~*' significa: coincide con el patrón Regex (insensible a mayúsculas)
            ${filtrosDecor.sql}
        `;
        
        // Nota: Si coloresRegex está vacío, pasamos un string imposible para que no traiga nada por error (o ajusta lógica si quieres ver todo)
        const paramColor = coloresRegex || 'SIN_COLOR_DEFINIDO';
        const decorRes = await pool.query(decorQuery, [paramColor, ...filtrosDecor.params]);

        // --- B. SALONES (CON LÓGICA DE REGLA DE TIEMPO) ---
        let salonFiltros = construirFiltros(1, 'Salon');
        let salonQueryText = `
            SELECT id_salon as id, nombre_lugar as nombre_item, costo_base, departamento, 
                   capacidad, url_imagen, regla_pago_meses, incluye_mesas, incluye_cubiertos, 
                   'Descripción del lugar' as descripcion, 'Salon' as tipo 
            FROM Salon
            WHERE 1=1 
            ${salonFiltros.sql}
        `;
        let salonParams = [...salonFiltros.params];
        let salonIdx = salonFiltros.nextIdx;

        if (capacidad) {
            salonQueryText += ` AND capacidad >= $${salonIdx} `;
            salonParams.push(capacidad);
            salonIdx++;
        }

        if (fecha) {
            // 1. FILTRO DE DISPONIBILIDAD (Ocupado ese día)
            salonQueryText += `
                AND id_salon NOT IN (
                    SELECT fk_opcion_id FROM Reserva r
                    JOIN CuentaPareja cp ON r.fk_cuentapareja_id = cp.id_cuentapareja
                    WHERE r.tipo_opcion = 'Salon' AND cp.fecha_boda = $${salonIdx} AND r.estado_pago != 'Cancelado'
                )
            `;
            // 2. NUEVO: FILTRO DE REGLA DE TIEMPO (Anticipación)
            // Calculamos la diferencia en meses entre la Fecha Boda ($idx) y HOY.
            // Si la regla del salón es MAYOR que el tiempo que falta, se oculta.
            salonQueryText += `
                AND regla_pago_meses <= (
                    EXTRACT(YEAR FROM age($${salonIdx}::date, CURRENT_DATE)) * 12 + 
                    EXTRACT(MONTH FROM age($${salonIdx}::date, CURRENT_DATE))
                )
            `;
            
            salonParams.push(fecha);
            salonIdx++;
        }
        
        const salonRes = await pool.query(salonQueryText, salonParams);
        // --- C. OTROS ---
        const otrosFiltros = construirFiltros(1);
        const otrosClause = ` WHERE 1=1 ${otrosFiltros.sql} `;
        const otrosParams = [...otrosFiltros.params];

        const catQuery = `SELECT id_catering as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Catering' as tipo FROM Catering ${otrosClause}`;
        const fotoQuery = `SELECT id_fotografo as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Fotografo' as tipo FROM Fotografo ${otrosClause}`;
        const planQuery = `SELECT id_planeador as id, nombre_servicio as nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, 'Planeador' as tipo FROM Planeador ${otrosClause}`;

        const catRes = await pool.query(catQuery, otrosParams);
        const fotoRes = await pool.query(fotoQuery, otrosParams);
        const planRes = await pool.query(planQuery, otrosParams);

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
// 7. RUTA ELIMINAR RESERVA
// ==================================================================
// ==================================================================
// 7. RUTA ELIMINAR RESERVA (BLINDADA)
// ==================================================================
app.post('/eliminar-reserva', async (req, res) => {
    const { id_reserva } = req.body; 
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar si tiene pagos antes de borrar
        const checkQuery = 'SELECT monto_pagado_acumulado FROM Reserva WHERE id_reserva = $1';
        const checkRes = await client.query(checkQuery, [id_reserva]);

        if (checkRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Reserva no encontrada.' });
        }

        const pagado = parseFloat(checkRes.rows[0].monto_pagado_acumulado || 0);

        // 2. SI YA PAGÓ ALGO, PROHIBIDO BORRAR
        if (pagado > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No puedes eliminar una reserva que ya tiene pagos/abonos.' });
        }

        // 3. Si no ha pagado nada, procedemos a borrar
        await client.query('DELETE FROM Reserva WHERE id_reserva = $1', [id_reserva]);
        
        await client.query('COMMIT');
        res.json({ success: true });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ success: false });
    } finally {
        client.release();
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
// 9. RUTA PARA PAGAR (CON REGLA DE EXCLUSIVIDAD DE SALONES)
// ==================================================================
// 7. RUTA PAGAR RESERVA (CORREGIDA: PROTEGE ABONOS)
app.post('/pagar-reserva', async (req, res) => {
    const { id_reserva, monto_pagado, metodo_pago, tipo_pago_elegido } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const resData = await client.query('SELECT fk_cuentapareja_id, tipo_opcion, monto_total, monto_pagado_acumulado FROM Reserva WHERE id_reserva = $1', [id_reserva]);
        const r = resData.rows[0];
        
        // --- NUEVA VALIDACIÓN ---
        // Si intentas pagar un salón, verificar que no haya OTRO salón ya pagado/abonado
        if (r.tipo_opcion === 'Salon') {
            const conflicto = await client.query(
                `SELECT id_reserva FROM Reserva 
                 WHERE fk_cuentapareja_id = $1 
                 AND tipo_opcion = 'Salon' 
                 AND id_reserva != $2 
                 AND estado_pago IN ('Abonado', 'Pagado Total')`,
                [r.fk_cuentapareja_id, id_reserva]
            );
            
            if (conflicto.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, message: 'Error: Ya tienes otro salón con pagos activos.' });
            }
        }
        // ------------------------

        const nuevoAcum = parseFloat(r.monto_pagado_acumulado || 0) + parseFloat(monto_pagado);
        let estado = (tipo_pago_elegido === 'Total' || nuevoAcum >= parseFloat(r.monto_total)) ? 'Pagado Total' : 'Abonado';

        await client.query('INSERT INTO Factura (fk_reserva_id, monto_pagado, metodo_pago, estado_pago) VALUES ($1, $2, $3, \'Aprobado\')', [id_reserva, monto_pagado, metodo_pago]);
        await client.query('UPDATE Reserva SET estado_pago = $1, monto_pagado_acumulado = $2 WHERE id_reserva = $3', [estado, nuevoAcum, id_reserva]);

        // REGLA DE ORO CORREGIDA: 
        // Solo borrar los otros salones si están PENDIENTES (solo 'Me gusta')
        if(r.tipo_opcion === 'Salon') {
            await client.query(
                `DELETE FROM Reserva 
                 WHERE fk_cuentapareja_id = $1 
                 AND tipo_opcion = 'Salon' 
                 AND id_reserva != $2
                 AND estado_pago = 'Pendiente'`, // <--- ESTO ES CLAVE: Solo borra los que no tienen dinero
                [r.fk_cuentapareja_id, id_reserva]
            );
        }
        
        await client.query('COMMIT'); 
        res.json({ success: true });

    } catch (e) { 
        await client.query('ROLLBACK'); 
        res.status(500).json({ message: 'Error' }); 
    } finally { client.release(); }
});
// ==================================================================
// 10. RUTA ADMIN: AGREGAR PRODUCTO (VERSIÓN TEXTO SIMPLE)
// ==================================================================
app.post('/admin/agregar-producto', async (req, res) => {
    const { 
        tipo, // 'Salon', 'Decoracion', etc.
        nombre, costo, depto, imagen, regla, // 'imagen' es solo el nombre del archivo (ej: foto.jpg)
        // Campos específicos
        color, capacidad, mesas, cubiertos, descripcion 
    } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. CONSTRUIR LA RUTA AUTOMÁTICA
        let subcarpeta = '';
        if (tipo === 'Salon') subcarpeta = 'salon';
        else if (tipo === 'Decoracion') subcarpeta = 'decoracion';
        else if (tipo === 'Catering') subcarpeta = 'catering';
        else if (tipo === 'Fotografo') subcarpeta = 'fotografo';
        else if (tipo === 'Planeador') subcarpeta = 'planeador'; // Asegúrate de que coincida con tu carpeta real

        // Si el usuario escribió "foto.jpg", guardamos "catalogo/salon/foto.jpg"
        // Si el usuario ya escribió "catalogo/...", respetamos lo que escribió
        let urlFinal = imagen;
        if (!imagen.startsWith('catalogo/')) {
            urlFinal = `catalogo/${subcarpeta}/${imagen}`;
        }

        // 2. INSERTAR EN LA TABLA CORRECTA
        let query = '';
        let params = [];

        if (tipo === 'Decoracion') {
            query = `INSERT INTO Decoraciones (nombre_item, costo_base, departamento, url_imagen, regla_pago_meses, descripcion, color) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`;
            params = [nombre, costo, depto, urlFinal, regla, descripcion, color]; 
        } 
        else if (tipo === 'Salon') {
            query = `INSERT INTO Salon (nombre_lugar, costo_base, departamento, url_imagen, regla_pago_meses, capacidad, incluye_mesas, incluye_cubiertos) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
            params = [nombre, costo, depto, urlFinal, regla, capacidad, mesas, cubiertos];
        } 
        else {
            let tabla = tipo; // 'Catering', 'Fotografo', etc.
            query = `INSERT INTO ${tabla} (nombre_servicio, costo_base, departamento, url_imagen, regla_pago_meses, descripcion) 
                     VALUES ($1, $2, $3, $4, $5, $6)`;
            params = [nombre, costo, depto, urlFinal, regla, descripcion];
        }

        await client.query(query, params);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Producto agregado correctamente' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error agregando producto:', error);
        res.status(500).json({ success: false, message: 'Error en base de datos: ' + error.message });
    } finally {
        client.release();
    }
});
// ==================================================================
// 11. RUTA ADMIN: ELIMINAR PRODUCTO
// ==================================================================
app.post('/admin/eliminar-producto', async (req, res) => {
    const { tipo, id } = req.body;

    let tabla = '', idCol = '';
    if (tipo === 'Salon') { tabla = 'Salon'; idCol = 'id_salon'; }
    else if (tipo === 'Decoracion') { tabla = 'Decoraciones'; idCol = 'id_decoracion'; }
    else if (tipo === 'Catering') { tabla = 'Catering'; idCol = 'id_catering'; }
    else if (tipo === 'Fotografo') { tabla = 'Fotografo'; idCol = 'id_fotografo'; }
    else if (tipo === 'Planeador') { tabla = 'Planeador'; idCol = 'id_planeador'; }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar si hay reservas activas ligadas a este producto
        // (Si borras un salón reservado, dejas a una novia sin salón)
        const checkReservas = await client.query(
            `SELECT COUNT(*) as total FROM Reserva 
             WHERE tipo_opcion = $1 AND fk_opcion_id = $2 AND estado_pago != 'Cancelado'`,
            [tipo, id]
        );

        if (parseInt(checkReservas.rows[0].total) > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No se puede eliminar: Hay reservas activas usando este producto.' });
        }

        // 2. Eliminar (Si no hay reservas o solo canceladas)
        await client.query(`DELETE FROM ${tabla} WHERE ${idCol} = $1`, [id]);

        // 3. (OPCIONAL) Resetear secuencia ID? -> NO RECOMENDADO POR SEGURIDAD
        
        await client.query('COMMIT');
        res.json({ success: true, message: 'Producto eliminado.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al eliminar.' });
    } finally {
        client.release();
    }
});
// RUTA SIMPLE PARA LISTAR PRODUCTOS (ADMIN)
app.get('/admin/listar-productos', async (req, res) => {
    const { tipo } = req.query;
    try {
        let tabla = '';
        if (tipo === 'Salon') tabla = 'Salon';
        else if (tipo === 'Decoracion') tabla = 'Decoraciones';
        else if (tipo === 'Catering') tabla = 'Catering';
        else if (tipo === 'Fotografo') tabla = 'Fotografo';
        else if (tipo === 'Planeador') tabla = 'Planeador';
        else return res.json([]);

        const result = await pool.query(`SELECT * FROM ${tabla} ORDER BY 1 DESC`);
        res.json(result.rows);
    } catch (e) { res.status(500).json([]); }
});
// ==================================================================
// 8. RUTA DE REPORTES (ACTUALIZADA Y CORREGIDA)
// ==================================================================
app.get('/admin/reportes/:tipo', async (req, res) => {
    const { tipo } = req.params; 
    const { servicio, periodo } = req.query;

    try {
        let q = '', p = [];
        
        switch (tipo) {
            // 1. USUARIOS CRECIMIENTO
            case 'usuarios-crecimiento':
                if (periodo === 'dia') {
                    // Si es por DÍA: Agrupamos por la fecha exacta (DATE) y ordenamos por ella
                    q = `
                        SELECT to_char(fecha_creacion, 'DD/MM') as lbl, COUNT(*) as val 
                        FROM CuentaPareja 
                        GROUP BY to_char(fecha_creacion, 'DD/MM'), DATE(fecha_creacion) 
                        ORDER BY DATE(fecha_creacion) ASC
                        LIMIT 30
                    `;
                } else {
                    // Si es por MES: Agrupamos por el inicio del mes (DATE_TRUNC) y ordenamos por ello
                    // Esto evita que Enero 2025 se mezcle con Enero 2024
                    q = `
                        SELECT to_char(fecha_creacion, 'Month') as lbl, COUNT(*) as val 
                        FROM CuentaPareja 
                        GROUP BY to_char(fecha_creacion, 'Month'), DATE_TRUNC('month', fecha_creacion) 
                        ORDER BY DATE_TRUNC('month', fecha_creacion) ASC
                    `;
                }
                break;

            // 2. USUARIOS PRESUPUESTO
            case 'usuarios-presupuesto':
                q = `SELECT 
                        CASE 
                            WHEN presupuesto_estimado < 5000 THEN 'Bajo (< 5k)'
                            WHEN presupuesto_estimado BETWEEN 5000 AND 15000 THEN 'Medio (5k - 15k)'
                            WHEN presupuesto_estimado BETWEEN 15001 AND 30000 THEN 'Alto (15k - 30k)'
                            ELSE 'Premium (> 30k)'
                        END as lbl, 
                        COUNT(*) as val 
                     FROM CuentaPareja 
                     GROUP BY 1
                     ORDER BY val DESC`;
                break;

            // 3. DEMANDA MENSUAL
            case 'demanda-mes':
                if (!servicio) return res.status(400).json({ error: 'Falta servicio' });
                q = `SELECT to_char(cp.fecha_boda, 'Month') as lbl, COUNT(r.id_reserva) as val 
                     FROM Reserva r 
                     JOIN CuentaPareja cp ON r.fk_cuentapareja_id = cp.id_cuentapareja 
                     WHERE r.tipo_opcion = $1 AND r.estado_pago != 'Cancelado' AND cp.fecha_boda IS NOT NULL 
                     GROUP BY 1, date_part('month', cp.fecha_boda) 
                     ORDER BY date_part('month', cp.fecha_boda) ASC`; 
                p = [servicio];
                break;

            // 4. TOP ITEMS (CON 3 ESTADOS: PENDIENTE, ABONADO, PAGADO)
            case 'top-items':
                if (!servicio) return res.status(400).json({ error: 'Falta servicio' });
                
                let tbl = servicio === 'Salon' ? 'Salon' : (servicio === 'Decoracion' ? 'Decoraciones' : servicio);
                let nameCol = servicio.includes('Salon') ? 'nombre_lugar' : (servicio.includes('Decor') ? 'nombre_item' : 'nombre_servicio');
                let idCol = 'id_' + tbl.toLowerCase().replace('es',''); 
                if (servicio === 'Decoracion') idCol = 'id_decoracion'; 

                q = `SELECT s.${nameCol} as lbl, 
                     COUNT(r.id_reserva) FILTER (WHERE r.estado_pago = 'Pendiente') as pendientes,
                     COUNT(r.id_reserva) FILTER (WHERE r.estado_pago = 'Abonado') as abonados,
                     COUNT(r.id_reserva) FILTER (WHERE r.estado_pago = 'Pagado Total') as pagados
                     FROM ${tbl} s 
                     LEFT JOIN Reserva r ON r.fk_opcion_id = s.${idCol} 
                        AND r.tipo_opcion = $1 
                        AND r.estado_pago != 'Cancelado'
                     GROUP BY 1 
                     ORDER BY (COUNT(r.id_reserva)) DESC 
                     LIMIT 5`;
                p = [servicio];
                break;

            default:
                return res.status(400).json({ error: 'Tipo no válido' });
        }

        const result = await pool.query(q, p);
        
        // --- PREPARAR RESPUESTA ---
        const etiquetas = result.rows.map(r => (r.lbl || 'Sin Nombre').toString().trim());
        
        // Objeto base de respuesta
        let respuesta = { etiquetas };

        // Si es un reporte simple (Usuarios, Demanda Mes)
        if (tipo !== 'top-items') {
            respuesta.valores = result.rows.map(r => parseInt(r.val || 0));
        } 
        // Si es reporte detallado (Top Items)
        else {
            respuesta.pendientes = result.rows.map(r => parseInt(r.pendientes || 0));
            respuesta.abonados = result.rows.map(r => parseInt(r.abonados || 0));
            respuesta.pagados = result.rows.map(r => parseInt(r.pagados || 0));
        }

        res.json(respuesta);

    } catch (e) { 
        console.error(`Error en reporte ${tipo}:`, e); 
        if (!res.headersSent) res.status(500).json({ error: 'Error interno' });
    }
});
// ==================================================================
// 13. RUTA ADMIN: EDITAR PRODUCTO
// ==================================================================
app.post('/admin/editar-producto', async (req, res) => {
    const { 
        id, tipo, nombre, costo, depto, imagen, regla, 
        color, capacidad, mesas, cubiertos, descripcion 
    } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let query = '';
        let params = [];

        // Lógica dinámica según la tabla
        if (tipo === 'Decoracion') {
            query = `UPDATE Decoraciones SET 
                        nombre_item = $1, costo_base = $2, departamento = $3, url_imagen = $4, 
                        regla_pago_meses = $5, descripcion = $6, color = $7
                     WHERE id_decoracion = $8`;
            params = [nombre, costo, depto, imagen, regla, descripcion, color, id]; 
        } 
        else if (tipo === 'Salon') {
            query = `UPDATE Salon SET 
                        nombre_lugar = $1, costo_base = $2, departamento = $3, url_imagen = $4, 
                        regla_pago_meses = $5, capacidad = $6, incluye_mesas = $7, incluye_cubiertos = $8
                     WHERE id_salon = $9`;
            const bMesas = (mesas === true || mesas === 'on');
            const bCubiertos = (cubiertos === true || cubiertos === 'on');
            params = [nombre, costo, depto, imagen, regla, capacidad, bMesas, bCubiertos, id];
        } 
        else {
            let tabla = tipo; 
            // Nombre de columna ID dinámica (id_catering, id_fotografo...)
            let colId = 'id_' + tipo.toLowerCase(); 

            query = `UPDATE ${tabla} SET 
                        nombre_servicio = $1, costo_base = $2, departamento = $3, url_imagen = $4, 
                        regla_pago_meses = $5, descripcion = $6
                     WHERE ${colId} = $7`;
            params = [nombre, costo, depto, imagen, regla, descripcion, id];
        }

        await client.query(query, params);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Producto actualizado correctamente' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error editando:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar.' });
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});