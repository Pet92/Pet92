const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Conector para PostgreSQL

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de la Base de Datos (Usa variables de entorno por seguridad)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://usuario:password@localhost:5432/smartpetid'
});

// Middlewares obligatorios
app.use(cors());          // Permite que el celular del rescatista se conecte a tu servidor sin bloqueos
app.use(express.json()); // Permite al servidor entender formatos JSON

// ============================================================
// API ENDPOINT: Recibir Escaneo de Placa Inteligente
// ============================================================
app.post('/api/v1/escaneos', async (req, res) => {
    const { codigo_qr_interno, latitud, longitud } = req.body;
    
    // Capturamos el dispositivo del rescatista desde la cabecera de la petición
    const userAgent = req.headers['user-agent']; 

    // 1. Validación básica de datos
    if (!codigo_qr_interno) {
        return res.status(400).json({ success: false, error: 'El código de la placa es requerido.' });
    }

    try {
        // 2. Verificar si la placa existe en la BD y obtener los datos de contacto del dueño
        const placaQuery = await pool.query(
            `SELECT p.id AS placa_id, m.nombre_mascota, u.email, u.telefono_contacto, u.nombre AS nombre_dueno
             FROM placas p
             JOIN mascotas m ON p.mascota_id = m.id
             JOIN usuarios u ON m.usuario_id = u.id
             WHERE p.codigo_qr_unico = $1`,
            [codigo_qr_interno]
        );

        if (placaQuery.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'La placa escaneada no está registrada o activa.' });
        }

        const infoRescate = placaQuery.rows[0];

        // 3. Insertar el registro de geolocalización en la tabla 'historial_escaneos'
        await pool.query(
            `INSERT INTO historial_escaneos (placa_id, latitud, longitud, user_agent) 
             VALUES ($1, $2, $3, $4)`,
            [infoRescate.placa_id, latitud || null, longitud || null, userAgent]
        );

        // 4. Actualizar el estado de la mascota a 'Perdido' automáticamente si se comparte el GPS
        if (latitud && longitud) {
            await pool.query(
                `UPDATE mascotas SET estado = 'Perdido' WHERE id = (SELECT mascota_id FROM placas WHERE id = $1)`,
                [infoRescate.placa_id]
            );
        }

        // 5. ACCIÓN EN SEGUNDO PLANO: Notificar al dueño
        // Aquí llamarás a las funciones de SendGrid (Email) o Twilio (WhatsApp) que veremos más adelante.
        console.log(`[ALERTA] Enviar correo a ${infoRescate.email} y WhatsApp a ${infoRescate.telefono_contacto}`);
        console.log(`Coordenadas de ${infoRescate.nombre_mascota}: Lat: ${latitud}, Lng: ${longitud}`);

        // 6. Responder con éxito al celular del rescatista
        return res.status(200).json({
            success: true,
            message: 'Ubicación procesada correctamente. Notificación enviada al propietario.'
        });

    } catch (error) {
        console.error('Error en el servidor al procesar el escaneo:', error);
        return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
    }
});

// Iniciar Servidor
app.listen(PORT, () => {
    console.log(`Servidor de SmartPet ID corriendo en el puerto ${PORT}`);
});