-- ============================================================
-- SCRIPT DE BASE DE DATOS PARA SMARTPET ID
-- Compatible con PostgreSQL / MySQL
-- ============================================================

-- 1. TABLA DE USUARIOS (Dueños de las mascotas)
CREATE TABLE usuarios (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    telefono_contacto VARCHAR(20) NOT NULL, -- Incluye código de país (ej: +52 o +1)
    pais VARCHAR(2) NOT NULL DEFAULT 'MX',  -- 'MX' o 'US'
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. TABLA DE MASCOTAS (Información que se mostrará al rescatista)
CREATE TABLE mascotas (
    id SERIAL PRIMARY KEY,
    usuario_id INT NOT NULL,
    nombre_mascota VARCHAR(50) NOT NULL,
    foto_url VARCHAR(255),                  -- Link al almacenamiento de la imagen (S3, Cloudinary, etc.)
    especie VARCHAR(30) NOT NULL,           -- Perro, Gato, etc.
    raza VARCHAR(50),
    contacto_alternativo VARCHAR(20),       -- Segundo teléfono por si el dueño no contesta
    notas_medicas TEXT,                     -- Alergias, condiciones o si requiere medicina
    estado VARCHAR(20) DEFAULT 'Seguro',    -- 'Seguro' o 'Perdido'
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- 3. TABLA DE PLACAS (El puente entre el código QR físico y la mascota digital)
CREATE TABLE placas (
    id SERIAL PRIMARY KEY,
    mascota_id INT UNIQUE,                  -- Un tag solo pertenece a una mascota (puede ser NULL antes de activarse)
    codigo_qr_unico VARCHAR(50) NOT NULL UNIQUE, -- El token de la URL (ej: qr_max_992)
    url_completa VARCHAR(255) NOT NULL,     -- URL que va impresa en el QR (ej: smartpetid.com/p/qr_max_992)
    estado_pedido VARCHAR(30) DEFAULT 'pagado', -- 'pagado', 'en_produccion', 'enviado'
    printful_order_id VARCHAR(100),         -- ID de rastreo que nos devuelve la API de Printful
    fecha_compra TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mascota_id) REFERENCES mascotas(id) ON DELETE SET NULL
);

-- 4. TABLA DE HISTORIAL DE ESCANEOS (Logs de Geolocalización)
CREATE TABLE historial_escaneos (
    id SERIAL PRIMARY KEY,
    placa_id INT NOT NULL,
    fecha_escaneo TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    latitud DECIMAL(10, 8),                 -- Alta precisión para mapas (soporta hasta 8 decimales)
    longitud DECIMAL(11, 8),                -- Alta precisión para mapas
    user_agent VARCHAR(255),                -- Guarda si fue escaneado desde iPhone, Android, etc.
    FOREIGN KEY (placa_id) REFERENCES placas(id) ON DELETE CASCADE
);

-- ============================================================
-- INDEXACIÓN PARA OPTIMIZACIÓN DE BÚSQUEDAS
-- ============================================================
-- Los índices aceleran las consultas cuando la app tenga miles de filas.

CREATE INDEX idx_placas_codigo ON placas(codigo_qr_unico);
CREATE INDEX idx_mascotas_usuario ON mascotas(usuario_id);
CREATE INDEX idx_escaneos_placa ON historial_escaneos(placa_id);