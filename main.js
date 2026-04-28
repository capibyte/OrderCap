// src/main/main.js
// ─────────────────────────────────────────────────────────────────────────────
// PROCESO PRINCIPAL DE ELECTRON
// Responsabilidades:
//   1. Crear la ventana de la aplicación
//   2. Levantar el servidor Express que recibe pedidos de n8n
//   3. Manejar los eventos IPC (impresión, CRUD de pedidos)
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');

// Módulos propios (los crearemos a continuación)
const { initDatabase } = require('./database');
const { startApiServer } = require('./api-server');
const { printTicket } = require('./printer');

// ─── Configuración ─────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === 'development';
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;

// ─── Ventana principal ─────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  // Buscar ícono si existe
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const fs = require('fs');
  const iconExists = fs.existsSync(iconPath);

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 900,
    minHeight: 600,
    title: '🍔 Burger Orders',
    icon: iconExists ? iconPath : undefined,
    webPreferences: {
      // ⚠️ SEGURIDAD: preload.js es el único puente entre renderer y main
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // Aisla el contexto del renderer
      nodeIntegration: false,   // El renderer NO tiene acceso a Node.js directamente
      sandbox: false,           // false porque necesitamos better-sqlite3 en el preload indirectamente
    },
    backgroundColor: '#1a1a2e', // Evita el flash blanco al cargar
  });

  // Carga la UI del renderer
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // En desarrollo: abre DevTools
  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Handlers IPC ──────────────────────────────────────────────────────────
// Estos son los "endpoints" que el renderer llama via window.electronAPI

function setupIpcHandlers() {
  const db = initDatabase();

  // ── PEDIDOS: Leer todos ──────────────────────────────────────────────────
  ipcMain.handle('pedidos:getAll', async () => {
    try {
      const pedidos = db.prepare(`
        SELECT * FROM pedidos ORDER BY created_at DESC LIMIT 100
      `).all();
      return { ok: true, data: pedidos };
    } catch (err) {
      console.error('[IPC] pedidos:getAll error:', err);
      return { ok: false, error: err.message };
    }
  });

  // ── PEDIDOS: Leer nuevos (para polling) ──────────────────────────────────
  ipcMain.handle('pedidos:getNew', async (_, since) => {
    try {
      const pedidos = db.prepare(`
        SELECT * FROM pedidos
        WHERE created_at > ?
        ORDER BY created_at ASC
      `).all(since);
      return { ok: true, data: pedidos };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── PEDIDOS: Actualizar estado ───────────────────────────────────────────
  ipcMain.handle('pedidos:updateEstado', async (_, { id, estado }) => {
    const estadosValidos = ['nuevo', 'en_preparacion', 'esperando', 'listo', 'entregado', 'cancelado'];
    if (!estadosValidos.includes(estado)) {
      return { ok: false, error: `Estado invalido: ${estado}` };
    }
    try {
      db.prepare(`
        UPDATE pedidos SET estado = ?, updated_at = datetime('now') WHERE id = ?
      `).run(estado, id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── PEDIDOS: Eliminar / Cancelar ─────────────────────────────────────────
  ipcMain.handle('pedidos:delete', async (_, id) => {
    try {
      db.prepare(`UPDATE pedidos SET estado = 'cancelado', updated_at = datetime('now') WHERE id = ?`).run(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── PEDIDOS: Editar ──────────────────────────────────────────────────────
  ipcMain.handle('pedidos:update', async (_, pedido) => {
    try {
      db.prepare(`
        UPDATE pedidos
        SET cliente_nombre = ?, cliente_tel = ?, direccion = ?, productos = ?, total = ?, metodo_pago = ?, notas = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        pedido.cliente_nombre,
        pedido.cliente_tel || '',
        pedido.direccion || '',
        pedido.productos,       // JSON string
        pedido.total,
        pedido.metodo_pago,
        pedido.notas || '',
        pedido.id
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IMPRESIÓN: Imprimir ticket ────────────────────────────────────────────
  // Este es el handler más importante: llama a printer.js que envía ESC/POS
  ipcMain.handle('printer:print', async (_, pedido) => {
    try {
      await printTicket(pedido);
      return { ok: true };
    } catch (err) {
      console.error('[IPC] printer:print error:', err);
      return { ok: false, error: err.message };
    }
  });

  // ── IMPRESIÓN: Listar impresoras disponibles ──────────────────────────────
  ipcMain.handle('printer:list', async () => {
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      return { ok: true, data: printers };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── NOTIFICACIONES: Mostrar notificación nativa ───────────────────────────
  ipcMain.on('notify:newOrder', (_, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });
}

// ─── Ciclo de vida de la app ───────────────────────────────────────────────

app.whenReady().then(() => {
  // 1. Inicializar la base de datos (crea tablas si no existen)
  initDatabase();
  console.log('[Main] Base de datos SQLite inicializada');

  // 2. Levantar el servidor Express para recibir pedidos de n8n
  startApiServer();
  console.log('[Main] Servidor API Express corriendo en puerto 3001');

  // 3. Registrar todos los handlers IPC
  setupIpcHandlers();
  console.log('[Main] Handlers IPC registrados');

  // 4. Crear la ventana principal
  createWindow();

  // macOS: re-crear ventana si se cierra y se reactiva el dock
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Cerrar la app cuando todas las ventanas estén cerradas (Windows/Linux)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Manejo de errores no capturados
process.on('uncaughtException', (err) => {
  console.error('[Main] Error no capturado:', err);
});
