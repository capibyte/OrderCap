// src/main/api-server.js
// ─────────────────────────────────────────────────────────────────────────────
// Servidor Express interno que n8n consume para guardar pedidos en SQLite.
//
// FLUJO n8n → Express:
//   1. n8n captura el mensaje de WhatsApp
//   2. n8n parsea: nombre, productos, total, método de pago
//   3. n8n hace POST http://localhost:3001/api/pedidos con el JSON
//   4. Express valida, guarda en SQLite y responde 201
//   5. La UI de Electron hace polling y muestra el nuevo pedido
//
// WORKFLOW DE n8n (configura así el nodo HTTP Request):
//   URL: http://localhost:3001/api/pedidos
//   Method: POST
//   Body: { "cliente_nombre": "...", "productos": [...], "total": 0, "metodo_pago": "..." }
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const { getDatabase, generarNumeroPedido } = require('./database');

const API_PORT = 3001;
const API_SECRET = process.env.API_SECRET || 'burger-secret-2024'; // Cambia esto

function startApiServer() {
  const app = express();

  app.use(express.json());
  // Solo permite requests desde localhost (n8n también corre local)
  app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:5678'] }));

  // ── Middleware: autenticación básica por header ─────────────────────────
  // En n8n configura el header: x-api-key: burger-secret-2024
  app.use('/api', (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (key !== API_SECRET) {
      return res.status(401).json({ ok: false, error: 'API key inválida' });
    }
    next();
  });

  // ── POST /api/pedidos — Crear pedido nuevo ────────────────────────────
  // Llamado por n8n cada vez que llega un pedido por WhatsApp
  app.post('/api/pedidos', (req, res) => {
    const { cliente_nombre, cliente_tel, direccion, productos, total, metodo_pago, notas, fuente } = req.body;

    // Validación básica
    if (!cliente_nombre || !productos || total === undefined) {
      return res.status(400).json({
        ok: false,
        error: 'Campos requeridos: cliente_nombre, productos, total'
      });
    }

    try {
      const db = getDatabase();
      const numero_pedido = generarNumeroPedido();

      // productos puede venir como array (n8n lo parsea) o como string JSON
      const productosStr = Array.isArray(productos)
        ? JSON.stringify(productos)
        : productos;

      const stmt = db.prepare(`
        INSERT INTO pedidos (numero_pedido, cliente_nombre, cliente_tel, direccion, productos, total, metodo_pago, notas, fuente)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = stmt.run(
        numero_pedido,
        cliente_nombre.trim(),
        cliente_tel || '',
        direccion || '',
        productosStr,
        parseFloat(total) || 0,
        metodo_pago || 'efectivo',
        notas || '',
        fuente || 'whatsapp'
      );

      console.log(`[API] Nuevo pedido recibido: ${numero_pedido} — ${cliente_nombre}`);

      res.status(201).json({
        ok: true,
        id: info.lastInsertRowid,
        numero_pedido,
        message: `Pedido ${numero_pedido} guardado correctamente`
      });
    } catch (err) {
      console.error('[API] Error al guardar pedido:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/pedidos — Listar pedidos (útil para debug) ───────────────
  app.get('/api/pedidos', (req, res) => {
    try {
      const db = getDatabase();
      const { estado, limit = 50 } = req.query;
      let query = 'SELECT * FROM pedidos';
      const params = [];

      if (estado) {
        query += ' WHERE estado = ?';
        params.push(estado);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(parseInt(limit));

      const pedidos = db.prepare(query).all(...params);
      res.json({ ok: true, data: pedidos, total: pedidos.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/health — Healthcheck para n8n ────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, status: 'running', timestamp: new Date().toISOString() });
  });

  app.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[API] Express escuchando en http://127.0.0.1:${API_PORT}`);
  });
}

module.exports = { startApiServer };
