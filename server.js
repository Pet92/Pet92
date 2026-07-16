const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
// Inicializamos Stripe usando la llave secreta de las variables de entorno
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Conexión a la Base de Datos PostgreSQL de Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Obligatorio para la seguridad de Render
});

// Función auto-instalable de la base de datos
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
            estado VARCHAR(20) DEFAULT 'Seguro',
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

        CREATE TABLE IF NOT EXISTS idx_placas_codigo ON placas(codigo_qr_unico);
    `;
    try {
        await pool.query(scriptSQL);
        console.log('¡Base de datos verificada y lista en la nube!');
    } catch (error) {
        console.error('Error al inicializar la BD:', error);
    }
}

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Sirve tus archivos HTML automáticamente en la raíz

// ============================================================
// PASO CLAVE: ENDPOINT PARA CREAR EL CHECKOUT DE STRIPE
// ============================================================
app.post('/api/v1/crear-checkout', async (req, res) => {
    const { plan } = req.body; // Recibe 'basico' o 'guardian' desde index.html
    
    // Configuración dinámica de IDs basados en tus productos de Stripe
    let priceId = '';
    let modeType = 'payment'; // 'payment' para cobro único

    if (plan === 'guardian') {
        priceId = process.env.STRIPE_PRICE_GUARDIAN; // ID de la suscripción mensual
        modeType = 'subscription';                  // Cambia el modo a suscripción
    } else {
        priceId = process.env.STRIPE_PRICE_BASICO;   // ID del pago único de la placa
        modeType = 'payment';
    }

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: modeType,
            // Redirecciones tras el pago
            success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/index.html`,
        });

        // Enviamos la URL de Stripe generada para la redirección
        res.json({ url: session.url });
    } catch (error) {
        console.error('Error al crear sesión de cobro:', error);
        res.status(500).json({ error: 'No se pudo procesar la pasarela de pago.' });
    }
});

// Endpoint para guardar coordenadas GPS del rescatista
app.post('/api/v1/escaneos', async (req, res) => {
    const { codigo_qr_interno, latitud, longitud } = req.body;
    const userAgent = req.headers['user-agent']; 

    try {
        const placaQuery = await pool.query(
            `SELECT id FROM placas WHERE codigo_qr_unico = $1`, [codigo_qr_interno]
        );
        if (placaQuery.rows.length > 0) {
            await pool.query(
                `INSERT INTO historial_escaneos (placa_id, latitud, longitud, user_agent) VALUES ($1, $2, $3, $4)`,
                [placaQuery.rows[0].id, latitud, longitud, userAgent]
            );
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Encendido del servidor
app.listen(PORT, async () => {
    console.log(`SmartPet Backend en puerto ${PORT}`);
    await inicializarBaseDeDatos();
});
