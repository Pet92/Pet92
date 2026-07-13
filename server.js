const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Conexión a la Base de Datos (Render inyectará esto automáticamente)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Requerido por Render para conexiones seguras
});

// ============================================================
// ¡LA MAGIA AQUÍ! Función para crear las tablas automáticamente
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

        -- Crear los índices si no existen
        CREATE INDEX IF NOT EXISTS idx_placas_codigo ON placas(codigo_qr_unico);
        CREATE INDEX IF NOT EXISTS idx_mascotas_usuario ON mascotas(usuario_id);
        CREATE INDEX IF NOT EXISTS idx_escaneos_placa ON historial_escaneos(placa_id);
    `;

    try {
        console.log('Verificando e inicializando tablas en la Base de Datos...');
        await pool.query(scriptSQL);
        console.log('¡Base de datos estructurada correctamente!');
    } catch (error) {
        console.error('Error al inicializar la base de datos:', error);
    }
}

// Middlewares
app.use(cors());
app.use(express.json());

// API ENDPOINT: Recibir Escaneo de Placa
app.post('/api/v1/escaneos', async (req, res) => {
    const { codigo_qr_interno, latitud, longitud } = req.body;
    const userAgent = req.headers['user-agent']; 

    if (!codigo_qr_interno) {
        return res.status(400).json({ success: false, error: 'El código de la placa es requerido.' });
    }

    try {
        const placaQuery = await pool.query(
            `SELECT p.id AS placa_id, m.nombre_mascota, u.email, u.telefono_contacto 
             FROM placas p
             JOIN mascotas m ON p.mascota_id = m.id
             JOIN usuarios u ON m.usuario_id = u.id
             WHERE p.codigo_qr_unico = $1`,
            [codigo_qr_interno]
        );

        if (placaQuery.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Placa no registrada.' });
        }

        const infoRescate = placaQuery.rows[0];

        await pool.query(
            `INSERT INTO historial_escaneos (placa_id, latitud, longitud, user_agent) 
             VALUES ($1, $2, $3, $4)`,
            [infoRescate.placa_id, latitud || null, longitud || null, userAgent]
        );

        return res.status(200).json({
            success: true,
            message: 'Ubicación procesada. Notificación enviada.'
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: 'Error interno.' });
    }
});

// Levantar el servidor e inicializar la base de datos
app.listen(PORT, async () => {
    console.log(`Servidor de SmartPet ID corriendo en el puerto ${PORT}`);
    // Ejecutamos la creación de tablas justo al encender
    await inicializarBaseDeDatos();
});