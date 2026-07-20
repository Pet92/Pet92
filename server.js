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

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Sirve index.html y registro.html de forma automática

// ============================================================
// ¡SINTAXIS BLINDADA! Inicialización limpia de tablas
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

        -- Creación del índice corregido para búsquedas ultra rápidas
        CREATE INDEX IF NOT EXISTS idx_placas_codigo ON placas(codigo_qr_unico);
    `;

    try {
        console.log('Estructurando tablas e índices en PostgreSQL...');
        await pool.query(scriptSQL);
        console.log('¡Base de datos SmartPet ID inicializada con éxito en la nube!');
    } catch (error) {
        console.error('Error crítico al estructurar la base de datos:', error);
    }
}

// ============================================================
// ENDPOINT: REGISTRAR ANTES DE MANDAR A STRIPE
// ============================================================
app.post('/api/v1/registrar-pre-pago', async (req, res) => {
    const { nombre_mascota, especie, raza, foto_url, notas_medicas, contacto_alternativo, plan, email_dueno, nombre_dueno, telefono_dueno } = req.body;

    try {
        // 1. Validar e insertar al usuario dueño
        let userQuery = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email_dueno]);
        let usuarioId;

        if (userQuery.rows.length === 0) {
            const nuevoUser = await pool.query(
                `INSERT INTO usuarios (nombre, email, password_hash, telefono_contacto) 
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [nombre_dueno || 'Cliente Temporal', email_dueno, 'temp_hash_123', telefono_dueno || '0000000']
            );
            usuarioId = nuevoUser.rows[0].id;
        } else {
            usuarioId = userQuery.rows[0].id;
        }

        // 2. Insertar los datos de la mascota enlazando al usuario
        // 2. Insertar los datos de la mascota enlazando al usuario
        const mascotaQuery = await pool.query(
            `INSERT INTO mascotas (usuario_id, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, estado) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [usuarioId, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, 'Pendiente de Pago']
        );
        const mascotaId = mascotaQuery.rows[0].id;

        // 3. Resolver precio e intenciones de Stripe
        let priceId = (plan === 'guardian') ? process.env.STRIPE_PRICE_GUARDIAN : process.env.STRIPE_PRICE_BASICO;
        let modeType = (plan === 'guardian') ? 'subscription' : 'payment';

        // 4. Construir la pasarela mandando el id de la mascota en metadatos ocultos
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email_dueno,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: modeType,
            shipping_address_collection: { allowed_countries: ['MX', 'US'] },
            metadata: {
                mascota_id: mascotaId.toString(),
                plan_tipo: plan
            },
            success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/index.html`,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error("Error en endpoint pre-pago:", error);
        res.status(500).json({ error: 'No se pudo registrar la información previa.' });
    }
});

// Webhook para la confirmación del pago
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
                 VALUES ($1, $2, $3, $4)`,
                [mascotaId, codigoQR, `https://pet92.onrender.com/rescuer.html?code=${codigoQR}`, 'pagado']
            );
            console.log(`¡Pago completado! Mascota ${mascotaId} activada. Enviar a: ${direccion}`);
        } catch (dbErr) {
            console.error("Error en Webhook BD:", dbErr);
        }
    }
    res.json({ received: true });
});

// Encendido global
app.listen(PORT, async () => {
    console.log(`Servidor SmartPet ID corriendo en el puerto ${PORT}`);
    // Al arrancar, creará todas las tablas limpias de golpe
    await inicializarBaseDeDatos();
});
