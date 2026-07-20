const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Conexión a PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.static(__dirname));

// Inicialización de Tablas
async function inicializarBaseDeDatos() {
    const scriptSQL = `
        CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(100) NOT NULL,
            email VARCHAR(150) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            telefono_contacto VARCHAR(20) NOT NULL,
            pais VARCHAR(2) NOT NULL DEFAULT 'MX',
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS mascotas (
            id SERIAL PRIMARY KEY,
            usuario_id INT NOT NULL,
            nombre_mascota VARCHAR(50) NOT NULL,
            foto_url VARCHAR(255),
            especie VARCHAR(30) NOT NULL,
            raza VARCHAR(50),
            contacto_alternativo VARCHAR(20),
            notas_medicas TEXT,
            estado VARCHAR(20) DEFAULT 'Pendiente de Pago',
            tipo_plan VARCHAR(20) DEFAULT 'basico',
            fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS placas (
            id SERIAL PRIMARY KEY,
            mascota_id INT UNIQUE,
            codigo_qr_unico VARCHAR(50) NOT NULL UNIQUE,
            url_completa VARCHAR(255) NOT NULL,
            estado_pedido VARCHAR(30) DEFAULT 'pagado',
            printful_order_id VARCHAR(100),
            fecha_compra TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (mascota_id) REFERENCES mascotas(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS historial_escaneos (
            id SERIAL PRIMARY KEY,
            placa_id INT NOT NULL,
            fecha_escaneo TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            latitud DECIMAL(10, 8),
            longitud DECIMAL(11, 8),
            user_agent VARCHAR(255),
            FOREIGN KEY (placa_id) REFERENCES placas(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_placas_codigo ON placas(codigo_qr_unico);
    `;

    try {
        await pool.query(scriptSQL);
        await pool.query(`ALTER TABLE mascotas ADD COLUMN IF NOT EXISTS tipo_plan VARCHAR(20) DEFAULT 'basico';`);
        console.log('¡Base de datos verificada y lista!');
    } catch (error) {
        console.error('Error al estructurar base de datos:', error);
    }
}

app.use(express.json());

// AUTENTICACIÓN
app.post('/api/v1/auth/registro', async (req, res) => {
    const { nombre, email, telefono, password } = req.body;
    try {
        const existeUser = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existeUser.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'El correo electrónico ya está registrado.' });
        }
        const nuevoUser = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, telefono_contacto) 
             VALUES ($1, $2, $3, $4) RETURNING id, nombre, email, telefono_contacto`,
            [nombre, email, password, telefono]
        );
        res.json({ success: true, usuario: { id: nuevoUser.rows[0].id, nombre: nuevoUser.rows[0].nombre, email: nuevoUser.rows[0].email, telefono: nuevoUser.rows[0].telefono_contacto } });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Error interno en el servidor.' });
    }
});

app.post('/api/v1/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const queryUser = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (queryUser.rows.length === 0 || queryUser.rows[0].password_hash !== password) {
            return res.status(400).json({ success: false, error: 'Credenciales incorrectas.' });
        }
        const usuario = queryUser.rows[0];
        res.json({ success: true, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, telefono: usuario.telefono_contacto } });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Error interno en el servidor.' });
    }
});

// EDITAR PERFIL DE USUARIO
app.put('/api/v1/usuarios/editar', async (req, res) => {
    const { usuario_id, nombre, telefono, password } = req.body;
    try {
        let query = `UPDATE usuarios SET nombre = $1, telefono_contacto = $2`;
        let values = [nombre, telefono, usuario_id];
        
        if (password && password.trim() !== '') {
            query += `, password_hash = $4 WHERE id = $3`;
            values = [nombre, telefono, usuario_id, password];
        } else {
            query += ` WHERE id = $3`;
        }

        await pool.query(query, values);
        res.json({ success: true, message: 'Perfil actualizado correctamente.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'No se pudo actualizar el perfil.' });
    }
});

// EDITAR PERFIL DE MASCOTA
app.put('/api/v1/mascotas/editar', async (req, res) => {
    const { mascota_id, usuario_id, nombre_mascota, especie, raza, foto_url, notas_medicas, contacto_alternativo } = req.body;
    try {
        await pool.query(
            `UPDATE mascotas 
             SET nombre_mascota = $1, especie = $2, raza = $3, foto_url = $4, notas_medicas = $5, contacto_alternativo = $6
             WHERE id = $7 AND usuario_id = $8`,
            [nombre_mascota, especie, raza, foto_url, notas_medicas, contacto_alternativo, mascota_id, usuario_id]
        );
        res.json({ success: true, message: 'Datos de la mascota actualizados.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Error al actualizar mascota.' });
    }
});

// REGISTRO PRE-PAGO (ENLAZADO A USUARIO REAL)
app.post('/api/v1/registrar-pre-pago', async (req, res) => {
    const { usuario_id, nombre_mascota, especie, raza, foto_url, notas_medicas, contacto_alternativo, plan, email_dueno, nombre_dueno, telefono_dueno } = req.body;

    try {
        let usuarioIdFinal = usuario_id;

        // Si no viene usuario_id explícito, buscamos o creamos por correo
        if (!usuarioIdFinal) {
            let userQuery = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email_dueno]);
            if (userQuery.rows.length > 0) {
                usuarioIdFinal = userQuery.rows[0].id;
            } else {
                const nuevoUser = await pool.query(
                    `INSERT INTO usuarios (nombre, email, password_hash, telefono_contacto) 
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [nombre_dueno || 'Cliente', email_dueno, 'temp_hash_123', telefono_dueno || '0000000']
                );
                usuarioIdFinal = nuevoUser.rows[0].id;
            }
        }

        const mascotaQuery = await pool.query(
            `INSERT INTO mascotas (usuario_id, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, estado, tipo_plan) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [usuarioIdFinal, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, 'Pendiente de Pago', plan]
        );
        const mascotaId = mascotaQuery.rows[0].id;

        let priceId = (plan === 'guardian') ? process.env.STRIPE_PRICE_GUARDIAN : process.env.STRIPE_PRICE_BASICO;
        let modeType = (plan === 'guardian') ? 'subscription' : 'payment';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email_dueno,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: modeType,
            shipping_address_collection: { allowed_countries: ['MX', 'US'] },
            metadata: { mascota_id: mascotaId.toString(), plan_tipo: plan },
            success_url: `${req.headers.origin}/status.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/index.html`,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error("Error pre-pago:", error);
        res.status(500).json({ error: 'Error al procesar la sesión.' });
    }
});

// DATOS DEL DASHBOARD (INCLUYE DATOS DEL USUARIO)
app.get('/api/v1/dashboard/datos', async (req, res) => {
    const { usuario_id } = req.query;
    if(!usuario_id) return res.status(400).json({ success: false, error: 'ID requerido.' });

    try {
        const usuario = await pool.query(`SELECT id, nombre, email, telefono_contacto FROM usuarios WHERE id = $1`, [usuario_id]);

        const mascotas = await pool.query(
            `SELECT id, nombre_mascota, especie, raza, foto_url, notas_medicas, contacto_alternativo, estado, tipo_plan 
             FROM mascotas WHERE usuario_id = $1 ORDER BY id DESC`, [usuario_id]
        );

        const escaneos = await pool.query(
            `SELECT h.fecha_escaneo, h.latitud, h.longitud, m.nombre_mascota 
             FROM historial_escaneos h
             JOIN placas p ON h.placa_id = p.id
             JOIN mascotas m ON p.mascota_id = m.id
             WHERE m.usuario_id = $1 ORDER BY h.fecha_escaneo DESC`, [usuario_id]
        );

        const placas = await pool.query(
            `SELECT p.codigo_qr_unico, p.estado_pedido, m.nombre_mascota 
             FROM placas p
             LEFT JOIN mascotas m ON p.mascota_id = m.id
             WHERE m.usuario_id = $1 OR p.mascota_id IS NULL ORDER BY p.id DESC`, [usuario_id]
        );

        res.json({ 
            success: true, 
            usuario: usuario.rows[0] || null, 
            mascotas: mascotas.rows, 
            escaneos: escaneos.rows, 
            placas: placas.rows 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Error en base de datos.' });
    }
});

// WEBHOOK STRIPE
app.post('/api/v1/webhook-stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const mascotaId = session.metadata.mascota_id;
        const envio = session.shipping_details;
        const direccion = `${envio.address.line1}, ${envio.address.city}, ${envio.address.state}, ${envio.address.postal_code}, ${envio.address.country}`;

        try {
            await pool.query("UPDATE mascotas SET estado = 'Seguro' WHERE id = $1", [mascotaId]);
            const codigoQR = `qr_${Math.random().toString(36).substring(2, 9)}`;
            await pool.query(
                `INSERT INTO placas (mascota_id, codigo_qr_unico, url_completa, estado_pedido) 
                 VALUES ($1, $2, $3, $4)`, [mascotaId, codigoQR, `https://pet92.onrender.com/rescuer.html?code=${codigoQR}`, 'pagado']
            );
            console.log(`¡Pago completado! Mascota ${mascotaId} activa. Dirección: ${direccion}`);
        } catch (dbErr) {
            console.error(dbErr);
        }
    }
    res.json({ received: true });
});

app.listen(PORT, async () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    await inicializarBaseDeDatos();
});