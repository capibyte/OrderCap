// src/main/server.js
// ─────────────────────────────────────────────────────────────────────────────
// SERVIDOR HTTP INTERNO (Express)
// Se levanta dentro del main process de Electron para recibir peticiones
// externas (ej: webhooks de n8n).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');

const SERVER_PORT = 3000;

/**
 * Inicia el servidor HTTP interno.
 * Se ejecuta silenciosamente al arrancar la app.
 */
function startServer() {
  const app = express();

  // ── Middleware ─────────────────────────────────────────────────────────────
  app.use(express.json()); // Parsear body JSON automáticamente

  // ── Endpoints ─────────────────────────────────────────────────────────────

  // POST /n8n-pedidos — Recibe un JSON desde n8n (u otro servicio externo)
  app.post('/n8n-pedidos', (req, res) => {
    console.log('[Server] POST /n8n-pedidos — Pedido recibido:');
    console.log(JSON.stringify(req.body, null, 2));
    res.status(200).json({ ok: true, message: 'Pedido recibido correctamente' });
  });

  

  // ── Arrancar ──────────────────────────────────────────────────────────────
  app.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`[Server] Servidor HTTP escuchando en http://0.0.0.0:${SERVER_PORT} (Todas las interfaces)`);
  });
}

module.exports = { startServer };
