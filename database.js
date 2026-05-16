// src/main/database.js
// ─────────────────────────────────────────────────────────────────────────────
// Capa de acceso a SQLite usando better-sqlite3 (síncrono, rápido, sin callbacks)
//
// ¿POR QUÉ SQLITE Y NO FIREBASE?
//   ✅ Sin latencia de red — todo es local
//   ✅ Sin costo y sin dependencia de internet
//   ✅ n8n puede escribir vía HTTP a nuestro Express local (mismo equipo)
//   ✅ Para un negocio de un solo local, SQLite es más que suficiente
//   ✅ better-sqlite3 es síncrono: ideal para Electron (no bloquea porque
//      las operaciones DB son ms, no segundos)
//   ⚠️  Firebase tiene sentido si tuvieras múltiples locales o app mobile
// ─────────────────────────────────────────────────────────────────────────────

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Ruta de la base de datos (en producción va en userData de Electron)
function getDbPath() {
  const dataDir = app
    ? path.join(app.getPath('userData'), 'data')
    : path.join(__dirname, '../../data');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  return path.join(dataDir, 'pedidos.db');
}

let db = null;

function initDatabase() {
  if (db) return db; // Singleton: una sola conexión

  const dbPath = getDbPath();
  db = new Database(dbPath, { verbose: process.env.NODE_ENV === 'development' ? console.log : null });

  // Optimizaciones de performance para SQLite
  db.pragma('journal_mode = WAL');  // Write-Ahead Logging: más rápido con lecturas concurrentes
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 1000');
  db.pragma('foreign_keys = ON');

  // ── Crear tablas si no existen ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_pedido   TEXT UNIQUE NOT NULL,
      cliente_nombre  TEXT NOT NULL,
      cliente_tel     TEXT DEFAULT '',
      direccion       TEXT DEFAULT '',
      productos       TEXT NOT NULL,
      total           REAL NOT NULL DEFAULT 0,
      metodo_pago     TEXT DEFAULT 'efectivo',
      estado          TEXT DEFAULT 'nuevo',
      notas           TEXT DEFAULT '',
      fuente          TEXT DEFAULT 'manual',
      archivado       INTEGER DEFAULT 0,           -- 0 = activo | 1 = archivado (quedó pendiente al cerrar)
      created_at      TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL,
      categoria TEXT, -- Ahora opcional
      stock_actual INTEGER DEFAULT 0,
      categoria_id INTEGER REFERENCES categorias(id)
    );

    CREATE TABLE IF NOT EXISTS insumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      unidad_medida TEXT NOT NULL,
      cantidad_actual REAL DEFAULT 0,
      punto_reposicion REAL DEFAULT 0,
      categoria_id INTEGER REFERENCES categorias(id)
    );

    CREATE TABLE IF NOT EXISTS recetas (
      producto_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      cantidad_necesaria REAL NOT NULL,
      FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE CASCADE,
      FOREIGN KEY(insumo_id) REFERENCES insumos(id) ON DELETE CASCADE,
      PRIMARY KEY(producto_id, insumo_id)
    );

    CREATE TABLE IF NOT EXISTS modificadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio_extra REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL,         -- 'producto' o 'insumo'
      color TEXT DEFAULT '#4b6584'
    );

    CREATE TABLE IF NOT EXISTS modificadores_receta (
      modificador_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      diferencia_cantidad REAL NOT NULL,
      FOREIGN KEY(modificador_id) REFERENCES modificadores(id) ON DELETE CASCADE,
      FOREIGN KEY(insumo_id) REFERENCES insumos(id) ON DELETE CASCADE,
      PRIMARY KEY(modificador_id, insumo_id)
    );
    CREATE TABLE IF NOT EXISTS productos_modificadores (
      producto_id INTEGER NOT NULL,
      modificador_id INTEGER NOT NULL,
      FOREIGN KEY(producto_id) REFERENCES productos(id) ON DELETE CASCADE,
      FOREIGN KEY(modificador_id) REFERENCES modificadores(id) ON DELETE CASCADE,
      PRIMARY KEY(producto_id, modificador_id)
    );

    CREATE TABLE IF NOT EXISTS configuracion (
      clave   TEXT PRIMARY KEY,
      valor   TEXT NOT NULL
    );

    -- Índices para acelerar las consultas más comunes
    CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);
    CREATE INDEX IF NOT EXISTS idx_pedidos_created ON pedidos(created_at DESC);
  `);

  // Migraciones menores para añadir columnas a tablas existentes
  try { db.exec("ALTER TABLE productos ADD COLUMN categoria_id INTEGER REFERENCES categorias(id);"); } catch (e) { }
  try { db.exec("ALTER TABLE insumos ADD COLUMN categoria_id INTEGER REFERENCES categorias(id);"); } catch (e) { }
  try { db.prepare('ALTER TABLE pedidos ADD COLUMN direccion TEXT DEFAULT ""').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE pedidos ADD COLUMN archivado INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE pedidos ADD COLUMN tipo_envio TEXT DEFAULT "Retiro Local"').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE pedidos ADD COLUMN costo_envio REAL DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE pedidos ADD COLUMN departamento TEXT DEFAULT ""').run(); } catch (e) { }

  // Insertar config por defecto si no existe
  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)
  `);
  insertConfig.run('impresora_nombre', 'TM-T20');
  insertConfig.run('impresora_tipo', 'usb');
  insertConfig.run('impresora_ip', '192.168.1.100');
  insertConfig.run('nombre_negocio', 'Burger House');
  insertConfig.run('direccion_negocio', 'Tu dirección aquí');
  insertConfig.run('whatsapp_negocio', '+54 9 11 0000-0000');
  insertConfig.run('tienda_abierta', '0');  // 0 = cerrada | 1 = abierta

  console.log(`[DB] SQLite conectado en: ${dbPath}`);
  return db;
}

function getDatabase() {
  if (!db) throw new Error('Base de datos no inicializada. Llamar initDatabase() primero.');
  return db;
}

// ── Helper: generar número de pedido correlativo ───────────────────────────
function generarNumeroPedido() {
  const db = getDatabase();
  const row = db.prepare(`SELECT MAX(id) as max_id FROM pedidos`).get();
  const nextId = (row.max_id || 0) + 1;
  return `PED-${String(nextId).padStart(4, '0')}`;
}

module.exports = { initDatabase, getDatabase, generarNumeroPedido };
