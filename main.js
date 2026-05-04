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
const { initDatabase, generarNumeroPedido } = require('./database');
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
      const cancelTx = db.transaction((pedidoId) => {
        // Obtenemos los productos del pedido antes de cancelar
        const pedido = db.prepare(`SELECT productos, estado FROM pedidos WHERE id = ?`).get(pedidoId);
        if (!pedido || pedido.estado === 'cancelado') return;

        db.prepare(`UPDATE pedidos SET estado = 'cancelado', updated_at = datetime('now') WHERE id = ?`).run(pedidoId);

        // Restaurar stock
        let productos = [];
        try { productos = JSON.parse(pedido.productos); } catch (e) {}

        for (const p of productos) {
          const cantidadPedida = p.cantidad || 1;
          if (p.producto_id) {
            const receta = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas WHERE producto_id = ?`).all(p.producto_id);
            if (receta.length > 0) {
              for (const r of receta) {
                const cant = r.cantidad_necesaria * cantidadPedida;
                db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual + ? WHERE id = ?`).run(cant, r.insumo_id);
              }
            } else {
              db.prepare(`UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?`).run(cantidadPedida, p.producto_id);
            }
          }
        }
      });

      cancelTx(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── PEDIDOS: Crear ───────────────────────────────────────────────────────
  ipcMain.handle('pedidos:create', async (_, pedido) => {
    try {
      const createTx = db.transaction((pedidoObj) => {
        const numero_pedido = generarNumeroPedido();
        const info = db.prepare(`
          INSERT INTO pedidos (numero_pedido, cliente_nombre, cliente_tel, direccion, productos, total, metodo_pago, notas, fuente, estado)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'nuevo')
        `).run(
          numero_pedido,
          pedidoObj.cliente_nombre || 'Cliente Manual',
          pedidoObj.cliente_tel || '',
          pedidoObj.direccion || '',
          pedidoObj.productos || '[]',
          pedidoObj.total || 0,
          pedidoObj.metodo_pago || 'efectivo',
          pedidoObj.notas || ''
        );
        const pedidoId = info.lastInsertRowid;

        // Descontar stock
        let productos = [];
        try { productos = JSON.parse(pedidoObj.productos); } catch (e) {}

        const alertas = [];

        for (const p of productos) {
          const cantidadPedida = p.cantidad || 1;
          
          if (p.producto_id) {
            const receta = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas WHERE producto_id = ?`).all(p.producto_id);
            if (receta.length > 0) {
              for (const r of receta) {
                const cant = r.cantidad_necesaria * cantidadPedida;
                db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual - ? WHERE id = ?`).run(cant, r.insumo_id);
                
                const insumo = db.prepare(`SELECT nombre, cantidad_actual, punto_reposicion FROM insumos WHERE id = ?`).get(r.insumo_id);
                if (insumo && insumo.cantidad_actual <= insumo.punto_reposicion) {
                  alertas.push(insumo.nombre);
                }
              }
            } else {
              db.prepare(`UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?`).run(cantidadPedida, p.producto_id);
            }
          }
        }
        return { id: pedidoId, alertas: [...new Set(alertas)] };
      });

      const res = createTx(pedido);
      
      // Enviar notificaciones
      if (res.alertas && res.alertas.length > 0 && Notification.isSupported()) {
        new Notification({ 
          title: '⚠️ Alerta de Stock', 
          body: 'Los siguientes insumos necesitan reposición: ' + res.alertas.join(', ')
        }).show();
      }

      return { ok: true, id: res.id };
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

  // ── INVENTARIO: Categorias ───────────────────────────────────────────────
  ipcMain.handle('categorias:getAll', async () => {
    try {
      const rows = db.prepare(`SELECT * FROM categorias ORDER BY tipo ASC, nombre ASC`).all();
      return { ok: true, data: rows };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('categorias:create', async (_, cat) => {
    try {
      const info = db.prepare(`INSERT INTO categorias (nombre, tipo, color) VALUES (?, ?, ?)`).run(cat.nombre, cat.tipo || 'general', cat.color || '#4b6584');
      return { ok: true, id: info.lastInsertRowid };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('categorias:update', async (_, cat) => {
    try {
      db.prepare(`UPDATE categorias SET nombre=?, tipo=?, color=? WHERE id=?`).run(cat.nombre, cat.tipo, cat.color || '#4b6584', cat.id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('categorias:delete', async (_, id) => {
    try {
      db.prepare(`DELETE FROM categorias WHERE id=?`).run(id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── INVENTARIO: Insumos ──────────────────────────────────────────────────
  ipcMain.handle('insumos:getAll', async () => {
    try {
      const rows = db.prepare(`SELECT * FROM insumos ORDER BY nombre ASC`).all();
      return { ok: true, data: rows };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('insumos:create', async (_, insumo) => {
    try {
      const info = db.prepare(`INSERT INTO insumos (nombre, unidad_medida, cantidad_actual, punto_reposicion, categoria_id) VALUES (?, ?, ?, ?, ?)`).run(insumo.nombre, insumo.unidad_medida, insumo.cantidad_actual || 0, insumo.punto_reposicion || 0, insumo.categoria_id || null);
      return { ok: true, id: info.lastInsertRowid };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('insumos:update', async (_, insumo) => {
    try {
      db.prepare(`UPDATE insumos SET nombre=?, unidad_medida=?, cantidad_actual=?, punto_reposicion=?, categoria_id=? WHERE id=?`).run(insumo.nombre, insumo.unidad_medida, insumo.cantidad_actual || 0, insumo.punto_reposicion || 0, insumo.categoria_id || null, insumo.id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('insumos:delete', async (_, id) => {
    try {
      db.prepare(`DELETE FROM insumos WHERE id=?`).run(id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── INVENTARIO: Productos ────────────────────────────────────────────────
  ipcMain.handle('productos:getAll', async () => {
    try {
      // Usamos LEFT JOIN para obtener el color de la categoría
      const rows = db.prepare(`
        SELECT p.*, c.color as categoria_color 
        FROM productos p 
        LEFT JOIN categorias c ON p.categoria_id = c.id 
        ORDER BY c.nombre ASC, p.nombre ASC
      `).all();
      return { ok: true, data: rows };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('productos:create', async (_, prod) => {
    try {
      const info = db.prepare(`INSERT INTO productos (nombre, precio, categoria, stock_actual, categoria_id) VALUES (?, ?, ?, ?, ?)`).run(prod.nombre, prod.precio || 0, prod.categoria || null, prod.stock_actual || 0, prod.categoria_id || null);
      return { ok: true, id: info.lastInsertRowid };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('productos:update', async (_, prod) => {
    try {
      db.prepare(`UPDATE productos SET nombre=?, precio=?, categoria=?, stock_actual=?, categoria_id=? WHERE id=?`).run(prod.nombre, prod.precio || 0, prod.categoria || null, prod.stock_actual || 0, prod.categoria_id || null, prod.id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('productos:delete', async (_, id) => {
    try {
      db.prepare(`DELETE FROM productos WHERE id=?`).run(id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── INVENTARIO: Recetas ──────────────────────────────────────────────────
  ipcMain.handle('recetas:getAll', async () => {
    try {
      const rows = db.prepare(`
        SELECT DISTINCT p.id, p.nombre, p.categoria_id, c.nombre as categoria_nombre, c.color as categoria_color
        FROM productos p
        JOIN recetas r ON p.id = r.producto_id
        LEFT JOIN categorias c ON p.categoria_id = c.id
        ORDER BY p.nombre ASC
      `).all();
      return { ok: true, data: rows };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('recetas:delete', async (_, producto_id) => {
    try {
      db.prepare(`DELETE FROM recetas WHERE producto_id = ?`).run(producto_id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('recetas:getByProducto', async (_, producto_id) => {
    try {
      const rows = db.prepare(`
        SELECT r.*, i.nombre, i.unidad_medida 
        FROM recetas r 
        JOIN insumos i ON r.insumo_id = i.id 
        WHERE r.producto_id = ?
      `).all(producto_id);
      return { ok: true, data: rows };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('recetas:save', async (_, { producto_id, items }) => {
    try {
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM recetas WHERE producto_id=?`).run(producto_id);
        const stmt = db.prepare(`INSERT INTO recetas (producto_id, insumo_id, cantidad_necesaria) VALUES (?, ?, ?)`);
        for (const item of items) {
          stmt.run(producto_id, item.insumo_id, item.cantidad_necesaria);
        }
      });
      tx();
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── INVENTARIO: Alertas y Validación ─────────────────────────────────────
  ipcMain.handle('inventario:checkAlerts', async () => {
    try {
      const rows = db.prepare(`SELECT COUNT(*) as count FROM insumos WHERE cantidad_actual <= punto_reposicion`).get();
      return { ok: true, hasAlerts: rows.count > 0 };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('inventario:checkStock', async (_, productos) => {
    try {
      let enough = true;
      let errors = [];
      const requirements = {}; 
      for (const p of productos) {
        if (!p.producto_id) continue;
        const receta = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas WHERE producto_id = ?`).all(p.producto_id);
        if (receta.length > 0) {
          for (const r of receta) {
            requirements[r.insumo_id] = (requirements[r.insumo_id] || 0) + (r.cantidad_necesaria * p.cantidad);
          }
        } else {
           const prod = db.prepare(`SELECT stock_actual, nombre FROM productos WHERE id = ?`).get(p.producto_id);
           if (prod && prod.stock_actual < p.cantidad) {
             enough = false;
             errors.push(`Sin stock de ${prod.nombre} (Quedan: ${prod.stock_actual})`);
           }
        }
      }
      for (const [insumo_id, required] of Object.entries(requirements)) {
        const insumo = db.prepare(`SELECT cantidad_actual, nombre, unidad_medida FROM insumos WHERE id = ?`).get(insumo_id);
        if (insumo && insumo.cantidad_actual < required) {
           enough = false;
           errors.push(`Sin stock de ${insumo.nombre} (Faltan ${required - insumo.cantidad_actual} ${insumo.unidad_medida})`);
        }
      }
      return { ok: true, enough, errors };
    } catch(err) { return { ok: false, error: err.message }; }
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

  // 2. Registrar todos los handlers IPC
  setupIpcHandlers();
  console.log('[Main] Handlers IPC registrados');

  // 3. Crear la ventana principal
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
