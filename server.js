const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Middlewares estándar
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================================
// ENDPOINT 1: GUARDAR MASCOTA TEMPORAL ANTES DE PAGAR
// ============================================================
app.post('/api/v1/registrar-pre-pago', async (req, res) => {
    const { nombre_mascota, especie, raza, foto_url, notas_medicas, contacto_alternativo, plan, email_dueno, nombre_dueno, telefono_dueno } = req.body;

    try {
        // 1. Insertar o buscar al usuario de forma temporal
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

        // 2. Crear la mascota con estado 'Pendiente de Pago'
        const mascotaQuery = await pool.query(
            `INSERT INTO mascotas (usuario_id, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, estado) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [usuarioId, nombre_mascota, foto_url, especie, raza, contacto_alternativo, notas_medicas, 'Pendiente de Pago']
        );
        const mascotaId = mascotaQuery.rows[0].id;

        // 3. Determinar el Price ID de Stripe
        let priceId = (plan === 'guardian') ? process.env.STRIPE_PRICE_GUARDIAN : process.env.STRIPE_PRICE_BASICO;
        let modeType = (plan === 'guardian') ? 'subscription' : 'payment';

        // 4. Crear la sesión de Stripe enlazando el id de la mascota en los metadatos (metadata)
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email_dueno,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: modeType,
            shipping_address_collection: {
                allowed_countries: ['MX', 'US'], // Captura direcciones reales de Mex y USA
            },
            metadata: {
                mascota_id: mascotaId.toString(),
                plan_tipo: plan
            },
            success_url: `${req.headers.origin}/status.html?id=${mascotaId}`,
            cancel_url: `${req.headers.origin}/index.html`,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al iniciar el registro y pasarela.' });
    }
});

// ============================================================
// ENDPOINT 2: WEBHOOK REAL DE STRIPE (CAPTURA DATOS DE ENVÍO)
// ============================================================
app.post('/api/v1/webhook-stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Validación de seguridad para asegurar que el mensaje viene de Stripe
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Escuchamos cuando el pago se completa con éxito
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        // Extraemos los metadatos que inyectamos antes
        const mascotaId = session.metadata.mascota_id;
        
        // Extraemos la dirección de envío capturada por la pantalla de Stripe
        const envio = session.shipping_details; 
        const direccionCompleta = `${envio.address.line1}, ${envio.address.city}, ${envio.address.state}, ${envio.address.postal_code}, ${envio.address.country}`;

        try {
            // 1. Activamos la mascota en la Base de Datos
            await pool.query("UPDATE mascotas SET estado = 'Seguro' WHERE id = $1", [mascotaId]);

            // 2. Generamos un código QR aleatorio único para la placa
            const codigoQR = `qr_${Math.random().toString(36).substring(2, 9)}`;
            
            // 3. Insertamos la placa física asociada marcando el estatus como 'pagado' 
            // y guardamos la dirección de envío en la URL o campo correspondiente
            await pool.query(
                `INSERT INTO placas (mascota_id, codigo_qr_unico, url_completa, estado_pedido) 
                 VALUES ($1, $2, $3, $4)`,
                [mascotaId, codigoQR, `https://pet92.onrender.com/rescuer.html?code=${codigoQR}`, 'pagado']
            );

            console.log(`¡Pedido Procesado! Mascota ID: ${mascotaId}. Enviar a: ${direccionCompleta}`);
            
            // TODO: Aquí llamarás en la siguiente fase a la API del proveedor de placas (Printful/Gelato)
            
        } catch (dbErr) {
            console.error("Error al procesar el éxito del pago en BD:", dbErr);
        }
    }

    res.json({ received: true });
});

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));