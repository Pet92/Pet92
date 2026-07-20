const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Conexión a la Base de Datos PostgreSQL de Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Middlewares estándar
app.use(cors());
app.use(express.static(__dirname)); // Sirve automáticamente los archivos HTML estáticos

// ============================================================
// INICIALIZACIÓN AUTOMÁTICA DE BASE DE DATOS + ALTER TABLE FORZADO
// ============================================================
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
        console.log('Estructurando tablas en PostgreSQL...');
        await pool.query(scriptSQL);

        // MODIFICACIÓN DE SEGURIDAD: Fuerza la adición de la columna tipo_plan si la tabla ya existía previa a este cambio
        await pool.query(`
            ALTER TABLE mascotas 
            ADD COLUMN IF NOT EXISTS tipo_plan VARCHAR(20) DEFAULT 'basico';
        `);

        console.log('¡Base de datos SmartPet ID verificada y actualizada en la nube!');
    } catch (error) {
        console.error('Error crítico al estructurar la base de datos:', error);
    }
}

// Middleware de JSON (Colocado después de la definición para no interferir con el Webhook de Stripe)
app.use(express.json());

// ============================================================
// ENDPOINTS: AUTENTICACIÓN DE USUARIOS
// ============================================================
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
        console.error(error);
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
        console.error(error);
        res.status(500).json({ success: false, error: 'Error interno en el servidor.' });
    }
});

// ============================================================
// ENDPOINT: PRE-REGISTRO Y SESIÓN DE CHECKOUT DE STRIPE
// ============================================================
app.post('/api/v1/registrar-pre-pago', async (req, res) => {
    const { nombre_mascota, especie, raza, foto_url, notas_medicas, contacto_alternativo, plan, email_dueno, nombre_dueno, telefono_dueno } = req.body;

    try {
        let userQuery = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email_dueno]);
        let usuarioId = userQuery.rows.length > 0 ? userQuery.rows[0].id : null;

        if (!usuarioId) {
            const nuevoUser = await pool.query(
                `INSERT INTO usuarios (nombre, email, password_hash, telefono_contacto) 
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [nombre_dueno || 'Cliente Temporal', email_dueno, 'temp_hash_123', telefono_dueno || '0000000']
            );
            usuarioId = nuevoUser.rows[0].id;
        }

        // Insertamos la mascota guardando el plan especificado
        const mascotaQuery = await pool.query(
            `INSERT INTO mascotas (usuario_id, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, estado, tipo_plan) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [usuarioId, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, 'Pendiente de Pago', plan]
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
        console.error("Error en endpoint pre-pago:", error);
        res.status(500).json({ error: 'No se pudo procesar la solicitud pre-pago.' });
    }
});

// ============================================================
// ENDPOINT: CONSULTA DATOS DASHBOARD
// ============================================================
app.get('/api/v1/dashboard/datos', async (req, res) => {
    const { usuario_id } = req.query;
    if(!usuario_id) return res.status(400).json({ success: false, error: 'ID de usuario requerido.' });

    try {
        const mascotas = await pool.query(
            `SELECT id, nombre_mascota, especie, raza, foto_url, estado, tipo_plan 
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

        res.json({ success: true, mascotas: mascotas.rows, escaneos: escaneos.rows, placas: placas.rows });
    } catch (error) {
        console.error("Error en Dashboard datos:", error);
        res.status(500).json({ success: false, error: 'Error en base de datos.' });
    }
});

// ============================================================
// WEBHOOK STRIPE (RECIBE CONFIRMACIONES DE PAGO EN SEGUNDO PLANO)
// ============================================================
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
            console.log(`¡Pago Exitoso! Mascota ID: ${mascotaId} activada. Dirección de envío: ${direccion}`);
        } catch (dbErr) {
            console.error("Error en Webhook BD:", dbErr);
        }
    }
    res.json({ received: true });
});

// Encendido del Servidor
app.listen(PORT, async () => {
    console.log(`Servidor SmartPet ID activo en puerto ${PORT}`);
    await inicializarBaseDeDatos();
});