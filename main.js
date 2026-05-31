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
const { startServer } = require('./server');

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
    title: '🍔 CapiMenu',
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

function setupIpcHandlers(db) {

  // ── DIALOGOS NATIVOS ─────────────────────────────────────────────────────
  ipcMain.handle('dialog:confirm', async (_, message) => {
    const { dialog } = require('electron');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancelar', 'Aceptar'],
      title: 'Confirmar',
      message: message,
      defaultId: 1,
      cancelId: 0
    });
    // Devuelve true si hace click en "Aceptar" (índice 1)
    return response === 1;
  });

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

  // ── PEDIDOS: Leer uno por ID ─────────────────────────────────────────────
  ipcMain.handle('pedidos:getById', async (_, id) => {
    try {
      const pedido = db.prepare(`SELECT * FROM pedidos WHERE id = ?`).get(id);
      if (!pedido) return { ok: false, error: 'Pedido no encontrado' };
      return { ok: true, data: pedido };
    } catch (err) {
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
    const estadosValidos = ['nuevo', 'en_preparacion', 'esperando', 'listo', 'entregado', 'cancelado', 'desperdicio'];
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
            const prod = db.prepare(`SELECT controla_stock FROM productos WHERE id = ?`).get(p.producto_id);
            if (prod && prod.controla_stock === 0) {
              continue; // No controla stock
            }
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
          
          // Devolver stock de las opciones personalizadas
          if (p.personalizacion && p.personalizacion.opciones) {
            for (const opt of p.personalizacion.opciones) {
              const recetaOpcion = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas_opciones WHERE opcion_id = ?`).all(opt.id);
              for (const ro of recetaOpcion) {
                const cantOpt = ro.cantidad_necesaria * cantidadPedida;
                db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual + ? WHERE id = ?`).run(cantOpt, ro.insumo_id);
              }
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
          INSERT INTO pedidos (numero_pedido, cliente_nombre, cliente_tel, direccion, productos, total, metodo_pago, notas, fuente, estado, tipo_envio, costo_envio, departamento)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'nuevo', ?, ?, ?)
        `).run(
          numero_pedido,
          pedidoObj.cliente_nombre || 'Cliente Manual',
          pedidoObj.cliente_tel || '',
          pedidoObj.direccion || '',
          pedidoObj.productos || '[]',
          pedidoObj.total || 0,
          pedidoObj.metodo_pago || 'efectivo',
          pedidoObj.notas || '',
          pedidoObj.tipo_envio || 'Retiro Local',
          pedidoObj.costo_envio || 0,
          pedidoObj.departamento || ''
        );
        const pedidoId = info.lastInsertRowid;

        // Descontar stock
        let productos = [];
        try { productos = JSON.parse(pedidoObj.productos); } catch (e) {}

        const alertas = [];

        for (const p of productos) {
          const cantidadPedida = p.cantidad || 1;
          
          if (p.producto_id) {
            const prod = db.prepare(`SELECT controla_stock FROM productos WHERE id = ?`).get(p.producto_id);
            if (prod && prod.controla_stock === 0) {
              continue; // No controla stock
            }
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
          
          // Descontar stock de opciones personalizadas
          if (p.personalizacion && p.personalizacion.opciones) {
            for (const opt of p.personalizacion.opciones) {
              const recetaOpcion = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas_opciones WHERE opcion_id = ?`).all(opt.id);
              for (const ro of recetaOpcion) {
                const cantOpt = ro.cantidad_necesaria * cantidadPedida;
                db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual - ? WHERE id = ?`).run(cantOpt, ro.insumo_id);
                
                const insumo = db.prepare(`SELECT nombre, cantidad_actual, punto_reposicion FROM insumos WHERE id = ?`).get(ro.insumo_id);
                if (insumo && insumo.cantidad_actual <= insumo.punto_reposicion) {
                  alertas.push(insumo.nombre);
                }
              }
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
      const updateTx = db.transaction((pedidoObj) => {
        // 1. Obtener pedido actual para restaurar stock
        const oldPedido = db.prepare(`SELECT productos, estado FROM pedidos WHERE id = ?`).get(pedidoObj.id);
        if (!oldPedido) throw new Error('Pedido no encontrado');

        // Solo restauramos stock si el pedido no estaba cancelado
        if (oldPedido.estado !== 'cancelado') {
          let oldProductos = [];
          try { oldProductos = JSON.parse(oldPedido.productos); } catch (e) { }

          for (const p of oldProductos) {
            const cant = p.cantidad || 1;
            if (p.producto_id) {
              const prod = db.prepare(`SELECT controla_stock FROM productos WHERE id = ?`).get(p.producto_id);
              if (prod && prod.controla_stock === 0) {
                continue; // No controla stock
              }
              const receta = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas WHERE producto_id = ?`).all(p.producto_id);
              if (receta.length > 0) {
                for (const r of receta) {
                  db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual + ? WHERE id = ?`)
                    .run(r.cantidad_necesaria * cant, r.insumo_id);
                }
              } else {
                db.prepare(`UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?`)
                  .run(cant, p.producto_id);
              }
            }
            
            if (p.personalizacion && p.personalizacion.opciones) {
              for (const opt of p.personalizacion.opciones) {
                const recetaOpcion = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas_opciones WHERE opcion_id = ?`).all(opt.id);
                for (const ro of recetaOpcion) {
                  const cantOpt = ro.cantidad_necesaria * cant;
                  db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual + ? WHERE id = ?`).run(cantOpt, ro.insumo_id);
                }
              }
            }
          }
        }

        // 2. Actualizar el pedido
        db.prepare(`
          UPDATE pedidos
          SET cliente_nombre = ?, cliente_tel = ?, direccion = ?, productos = ?, total = ?, metodo_pago = ?, notas = ?, tipo_envio = ?, costo_envio = ?, departamento = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(
          pedidoObj.cliente_nombre,
          pedidoObj.cliente_tel || '',
          pedidoObj.direccion || '',
          pedidoObj.productos,
          pedidoObj.total,
          pedidoObj.metodo_pago,
          pedidoObj.notas || '',
          pedidoObj.tipo_envio || 'Retiro Local',
          pedidoObj.costo_envio || 0,
          pedidoObj.departamento || '',
          pedidoObj.id
        );

        // 3. Descontar stock del nuevo contenido (si no está cancelado)
        // Nota: Si el usuario edita un pedido cancelado, probablemente no deberíamos descontar stock 
        // a menos que cambie el estado, pero cambiarEstado tiene su propia lógica.
        // Aquí asumimos que si se está editando, el estado se mantiene o se maneja aparte.
        if (oldPedido.estado !== 'cancelado') {
          let newProductos = [];
          try { newProductos = JSON.parse(pedidoObj.productos); } catch (e) { }
          const alertas = [];

          for (const p of newProductos) {
            const cant = p.cantidad || 1;
            if (p.producto_id) {
              const prod = db.prepare(`SELECT controla_stock FROM productos WHERE id = ?`).get(p.producto_id);
              if (prod && prod.controla_stock === 0) {
                continue; // No controla stock
              }
              const receta = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas WHERE producto_id = ?`).all(p.producto_id);
              if (receta.length > 0) {
                for (const r of receta) {
                  const descontar = r.cantidad_necesaria * cant;
                  db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual - ? WHERE id = ?`)
                    .run(descontar, r.insumo_id);

                  const insumo = db.prepare(`SELECT nombre, cantidad_actual, punto_reposicion FROM insumos WHERE id = ?`).get(r.insumo_id);
                  if (insumo && insumo.cantidad_actual <= insumo.punto_reposicion) {
                    alertas.push(insumo.nombre);
                  }
                }
              } else {
                db.prepare(`UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?`)
                  .run(cant, p.producto_id);
              }
            }
            
            if (p.personalizacion && p.personalizacion.opciones) {
              for (const opt of p.personalizacion.opciones) {
                const recetaOpcion = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas_opciones WHERE opcion_id = ?`).all(opt.id);
                for (const ro of recetaOpcion) {
                  const cantOpt = ro.cantidad_necesaria * cant;
                  db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual - ? WHERE id = ?`).run(cantOpt, ro.insumo_id);
                  
                  const insumo = db.prepare(`SELECT nombre, cantidad_actual, punto_reposicion FROM insumos WHERE id = ?`).get(ro.insumo_id);
                  if (insumo && insumo.cantidad_actual <= insumo.punto_reposicion) {
                    alertas.push(insumo.nombre);
                  }
                }
              }
            }
          }
          return { alertas: [...new Set(alertas)] };
        }
        return { alertas: [] };
      });

      const res = updateTx(pedido);

      if (res.alertas && res.alertas.length > 0 && Notification.isSupported()) {
        new Notification({
          title: '⚠️ Alerta de Stock (Pedido Editado)',
          body: 'Insumos críticos: ' + res.alertas.join(', ')
        }).show();
      }

      return { ok: true };
    } catch (err) {
      console.error('[IPC] pedidos:update error:', err);
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
      const info = db.prepare(`INSERT INTO productos (nombre, precio, categoria, stock_actual, categoria_id, controla_stock) VALUES (?, ?, ?, ?, ?, ?)`).run(prod.nombre, prod.precio || 0, prod.categoria || null, prod.stock_actual || 0, prod.categoria_id || null, prod.controla_stock ?? 1);
      return { ok: true, id: info.lastInsertRowid };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('productos:update', async (_, prod) => {
    try {
      db.prepare(`UPDATE productos SET nombre=?, precio=?, categoria=?, stock_actual=?, categoria_id=?, controla_stock=? WHERE id=?`).run(prod.nombre, prod.precio || 0, prod.categoria || null, prod.stock_actual || 0, prod.categoria_id || null, prod.controla_stock ?? 1, prod.id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('productos:delete', async (_, id) => {
    try {
      db.prepare(`DELETE FROM productos WHERE id=?`).run(id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('productos:getDetallePersonalizacion', async (_, producto_id) => {
    try {
      const producto = db.prepare(`SELECT * FROM productos WHERE id = ?`).get(producto_id);
      if (!producto) return { ok: false, error: 'Producto no encontrado' };

      // Obtener grupos vinculados al producto
      const grupos = db.prepare(`
        SELECT g.* 
        FROM grupos_opciones g
        JOIN producto_grupos pg ON g.id = pg.grupo_id
        WHERE pg.producto_id = ?
        ORDER BY pg.prioridad ASC
      `).all(producto_id);

      // Para cada grupo, obtener sus opciones
      for (const grupo of grupos) {
        grupo.opciones = db.prepare(`
          SELECT * FROM opciones WHERE grupo_id = ?
        `).all(grupo.id);
      }

      producto.grupos = grupos;
      return { ok: true, data: producto };
    } catch (err) {
      console.error('[IPC] productos:getDetallePersonalizacion error:', err);
      return { ok: false, error: err.message };
    }
  });

  // ── GRUPOS DE OPCIONES (Combos) ──────────────────────────────────────────
  ipcMain.handle('grupos:getAll', async () => {
    try {
      const grupos = db.prepare(`
        SELECT g.*, COUNT(o.id) as num_opciones
        FROM grupos_opciones g
        LEFT JOIN opciones o ON g.id = o.grupo_id
        GROUP BY g.id
        ORDER BY g.id ASC
      `).all();
      return { ok: true, data: grupos };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('grupos:create', async (_, { nombre, min_seleccion, max_seleccion }) => {
    try {
      const r = db.prepare(`INSERT INTO grupos_opciones (nombre, min_seleccion, max_seleccion) VALUES (?, ?, ?)`).run(nombre, min_seleccion ?? 1, max_seleccion ?? 1);
      return { ok: true, id: r.lastInsertRowid };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('grupos:update', async (_, { id, nombre, min_seleccion, max_seleccion }) => {
    try {
      db.prepare(`UPDATE grupos_opciones SET nombre = ?, min_seleccion = ?, max_seleccion = ? WHERE id = ?`).run(nombre, min_seleccion, max_seleccion, id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('grupos:delete', async (_, id) => {
    try {
      db.prepare(`DELETE FROM grupos_opciones WHERE id = ?`).run(id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── OPCIONES ─────────────────────────────────────────────────────────────
  ipcMain.handle('opciones:getByGrupo', async (_, grupo_id) => {
    try {
      const opciones = db.prepare(`SELECT * FROM opciones WHERE grupo_id = ? ORDER BY id ASC`).all(grupo_id);
      return { ok: true, data: opciones };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('opciones:create', async (_, { grupo_id, nombre, precio_extra }) => {
    try {
      const r = db.prepare(`INSERT INTO opciones (grupo_id, nombre, precio_extra) VALUES (?, ?, ?)`).run(grupo_id, nombre, precio_extra ?? 0);
      return { ok: true, id: r.lastInsertRowid };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('opciones:update', async (_, { id, nombre, precio_extra }) => {
    try {
      db.prepare(`UPDATE opciones SET nombre = ?, precio_extra = ? WHERE id = ?`).run(nombre, precio_extra, id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('opciones:delete', async (_, id) => {
    try {
      db.prepare(`DELETE FROM opciones WHERE id = ?`).run(id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── RECETAS DE OPCIONES ──────────────────────────────────────────────────
  ipcMain.handle('recetas_opciones:getByOpcion', async (_, opcion_id) => {
    try {
      const items = db.prepare(`
        SELECT ro.*, i.nombre as insumo_nombre, i.unidad_medida
        FROM recetas_opciones ro
        JOIN insumos i ON ro.insumo_id = i.id
        WHERE ro.opcion_id = ?
      `).all(opcion_id);
      return { ok: true, data: items };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('recetas_opciones:save', async (_, { opcion_id, items }) => {
    try {
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM recetas_opciones WHERE opcion_id = ?`).run(opcion_id);
        const stmt = db.prepare(`INSERT INTO recetas_opciones (opcion_id, insumo_id, cantidad_necesaria) VALUES (?, ?, ?)`);
        for (const item of items) {
          stmt.run(opcion_id, item.insumo_id, item.cantidad_necesaria);
        }
      });
      tx();
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── PRODUCTO_GRUPOS ──────────────────────────────────────────────────────
  ipcMain.handle('producto_grupos:getByProducto', async (_, producto_id) => {
    try {
      const rows = db.prepare(`SELECT grupo_id FROM producto_grupos WHERE producto_id = ? ORDER BY prioridad ASC`).all(producto_id);
      return { ok: true, data: rows.map(r => r.grupo_id) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('producto_grupos:save', async (_, { producto_id, grupo_ids }) => {
    try {
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM producto_grupos WHERE producto_id = ?`).run(producto_id);
        const stmt = db.prepare(`INSERT INTO producto_grupos (producto_id, grupo_id, prioridad) VALUES (?, ?, ?)`);
        (grupo_ids || []).forEach((gid, idx) => stmt.run(producto_id, gid, idx));
      });
      tx();
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

  ipcMain.handle('inventario:checkStock', async (_, { productos, pedidoId }) => {
    try {
      let enough = true;
      let errors = [];
      const requirements = {};

      // Si es una edición, sumamos el stock que ya tiene este pedido reservado
      const reservedQuantities = {};
      if (pedidoId) {
        const oldPedido = db.prepare(`SELECT productos FROM pedidos WHERE id = ?`).get(pedidoId);
        if (oldPedido) {
          let oldProds = [];
          try { oldProds = JSON.parse(oldPedido.productos); } catch (e) { }
          for (const op of oldProds) {
            if (!op.producto_id) continue;
            reservedQuantities[op.producto_id] = (reservedQuantities[op.producto_id] || 0) + (op.cantidad || 1);
          }
        }
      }

      for (const p of productos) {
        if (!p.producto_id) continue;
        const prod = db.prepare(`SELECT stock_actual, nombre, controla_stock FROM productos WHERE id = ?`).get(p.producto_id);
        if (prod && prod.controla_stock === 0) {
          continue; // No controla stock
        }
        const receta = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas WHERE producto_id = ?`).all(p.producto_id);
        if (receta.length > 0) {
          for (const r of receta) {
            requirements[r.insumo_id] = (requirements[r.insumo_id] || 0) + (r.cantidad_necesaria * p.cantidad);
          }
        } else {
          if (prod) {
            const availableStock = prod.stock_actual + (reservedQuantities[p.producto_id] || 0);
            if (availableStock < p.cantidad) {
              enough = false;
              errors.push(`Sin stock de ${prod.nombre} (Quedan: ${availableStock})`);
            }
          }
        }
      }

      // Validar insumos
      for (const [insumo_id, required] of Object.entries(requirements)) {
        const insumo = db.prepare(`SELECT cantidad_actual, nombre, unidad_medida FROM insumos WHERE id = ?`).get(insumo_id);
        if (insumo) {
          // Si el producto usa insumos, necesitamos saber cuánto de ese insumo aportaba el pedido anterior
          let extraInsumoFromOld = 0;
          if (pedidoId) {
            const oldPedido = db.prepare(`SELECT productos FROM pedidos WHERE id = ?`).get(pedidoId);
            if (oldPedido) {
              let oldProds = [];
              try { oldProds = JSON.parse(oldPedido.productos); } catch (e) { }
              for (const op of oldProds) {
                if (op.producto_id) {
                  const r = db.prepare(`SELECT cantidad_necesaria FROM recetas WHERE producto_id = ? AND insumo_id = ?`).get(op.producto_id, insumo_id);
                  if (r) extraInsumoFromOld += (r.cantidad_necesaria * (op.cantidad || 1));
                }
              }
            }
          }

          const availableInsumo = insumo.cantidad_actual + extraInsumoFromOld;
          if (availableInsumo < required) {
            enough = false;
            errors.push(`Sin stock de ${insumo.nombre} (Faltan ${Math.ceil(required - availableInsumo)} ${insumo.unidad_medida})`);
          }
        }
      }
      return { ok: true, enough, errors };
    } catch (err) {
      console.error('[checkStock] Error:', err);
      return { ok: false, error: err.message };
    }
  });

  // ── CONFIGURACIÓN GENÉRICA ───────────────────────────────────────────────
  ipcMain.handle('config:getAll', async () => {
    try {
      const rows = db.prepare(`SELECT clave, valor FROM configuracion`).all();
      const configObj = {};
      for (const row of rows) {
        configObj[row.clave] = row.valor;
      }
      return { ok: true, data: configObj };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('config:save', async (_, { clave, valor }) => {
    try {
      db.prepare(`
        INSERT INTO configuracion (clave, valor)
        VALUES (?, ?)
        ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor;
      `).run(clave, valor);
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

  // ── IMPRESIÓN: Listar impresoras del sistema Windows (via PowerShell) ─────
  // Más confiable que getPrintersAsync() para impresoras térmicas USB
  ipcMain.handle('printer:listSystem', async () => {
    try {
      const { exec } = require('child_process');
      return await new Promise((resolve) => {
        exec(
          'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress"',
          { timeout: 8000 },
          (error, stdout, stderr) => {
            if (error || !stdout.trim()) {
              resolve({ ok: false, error: 'No se pudieron listar las impresoras.' });
              return;
            }
            try {
              let names = JSON.parse(stdout.trim());
              if (typeof names === 'string') names = [names]; // si solo hay una
              resolve({ ok: true, data: names });
            } catch {
              resolve({ ok: false, error: 'Error al parsear la lista de impresoras.' });
            }
          }
        );
      });
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

  // ── TIENDA: Estado ────────────────────────────────────────────────────────
  ipcMain.handle('tienda:getStatus', async () => {
    try {
      const row = db.prepare(`SELECT valor FROM configuracion WHERE clave = 'tienda_abierta'`).get();
      return { ok: true, abierta: row ? row.valor === '1' : false };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── TIENDA: Abrir ─────────────────────────────────────────────────────────
  ipcMain.handle('tienda:abrirTienda', async () => {
    try {
      const fs = require('fs');

      // 1. Archivar todos los pedidos del día anterior para limpiar las vistas diarias
      db.prepare(`
        UPDATE pedidos SET archivado = 1, updated_at = datetime('now')
        WHERE archivado = 0
      `).run();

      // 1b. Purgar archivados con más de 3 días de antigüedad (borrado definitivo)
      db.prepare(`
        DELETE FROM pedidos
        WHERE archivado = 1
        AND estado NOT IN ('entregado', 'cancelado', 'desperdicio')
        AND julianday('now') - julianday(created_at) > 3
      `).run();

      // 2. Purga por mes calendario completo
      //    Mantenemos: mes actual + 2 meses anteriores completos
      //    Ejemplo: En Junio, guardamos Junio, Mayo y Abril → purgamos Marzo y anteriores
      const hoy = new Date();
      // Primer día del mes de hace 2 meses (límite de retención)
      const limiteFecha = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1);
      const limiteStr = limiteFecha.toISOString().split('T')[0]; // YYYY-MM-DD

      // Buscar pedidos entregados más viejos que el límite
      const pedidosViejos = db.prepare(`
        SELECT * FROM pedidos
        WHERE estado = 'entregado'
        AND date(created_at) < ?
        ORDER BY created_at ASC
      `).all(limiteStr);

      if (pedidosViejos.length > 0) {
        // Agrupar por mes (MM-YYYY)
        const porMes = {};
        for (const p of pedidosViejos) {
          const fecha = new Date(p.created_at);
          const key = `${String(fecha.getMonth() + 1).padStart(2, '0')}-${fecha.getFullYear()}`;
          if (!porMes[key]) porMes[key] = [];
          porMes[key].push(p);
        }

        // Crear carpeta "Historial de venta" si no existe
        const carpetaHistorial = path.join(__dirname, 'Historial de venta');
        if (!fs.existsSync(carpetaHistorial)) {
          fs.mkdirSync(carpetaHistorial, { recursive: true });
        }

        // Generar un CSV por cada mes y guardar
        const cabecera = 'ID,Numero Pedido,Cliente,Telefono,Direccion,Productos,Total,Metodo Pago,Estado,Notas,Fecha\n';
        for (const [mes, pedidos] of Object.entries(porMes)) {
          const rutaCSV = path.join(carpetaHistorial, `${mes}.csv`);
          let contenido = cabecera;
          for (const p of pedidos) {
            const productos = (() => { try { return JSON.parse(p.productos).map(x => `${x.cantidad || 1}x ${x.nombre || x.name}`).join(' | '); } catch { return p.productos; } })();
            const fila = [
              p.id, p.numero_pedido, p.cliente_nombre, p.cliente_tel || '',
              p.direccion || '', `"${productos}"`, p.total,
              p.metodo_pago, p.estado, p.notas || '', p.created_at
            ].join(',');
            contenido += fila + '\n';
          }
          fs.writeFileSync(rutaCSV, contenido, 'utf8');
        }

        // Eliminar esos pedidos viejos de la base de datos
        db.prepare(`
          DELETE FROM pedidos WHERE estado = 'entregado' AND date(created_at) < ?
        `).run(limiteStr);
      }

      // 3. Marcar tienda como abierta
      db.prepare(`UPDATE configuracion SET valor = '1' WHERE clave = 'tienda_abierta'`).run();

      return { ok: true };
    } catch (err) {
      console.error('[tienda:abrirTienda] Error:', err);
      return { ok: false, error: err.message };
    }
  });

  // ── TIENDA: Cerrar ────────────────────────────────────────────────────────
  ipcMain.handle('tienda:cerrarTienda', async () => {
    try {
      db.prepare(`UPDATE configuracion SET valor = '0' WHERE clave = 'tienda_abierta'`).run();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── TIENDA: Stock para checklist de apertura ──────────────────────────────
  ipcMain.handle('tienda:getStockApertura', async () => {
    try {
      const productos = db.prepare(`SELECT id, nombre, stock_actual FROM productos WHERE stock_actual > 0 AND (controla_stock IS NULL OR controla_stock != 0) ORDER BY nombre ASC`).all();
      const insumos = db.prepare(`SELECT id, nombre, cantidad_actual, unidad_medida FROM insumos WHERE cantidad_actual > 0 ORDER BY nombre ASC`).all();
      return { ok: true, productos, insumos };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── TIENDA: Actualizar stock desde checklist ──────────────────────────────
  ipcMain.handle('tienda:updateStock', async (_, { productos, insumos }) => {
    try {
      const tx = db.transaction(() => {
        for (const p of (productos || [])) {
          db.prepare(`UPDATE productos SET stock_actual = ? WHERE id = ?`).run(p.stock_actual, p.id);
        }
        for (const i of (insumos || [])) {
          db.prepare(`UPDATE insumos SET cantidad_actual = ? WHERE id = ?`).run(i.cantidad_actual, i.id);
        }
      });
      tx();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── HISTORIAL: Pedidos entregados (últimos 3 meses calendario) ────────────
  ipcMain.handle('historial:getPedidos', async () => {
    try {
      const hoy = new Date();
      // Primer día del mes de hace 2 meses (inicio del rango de 3 meses)
      const desde = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1);
      const desdeStr = desde.toISOString().split('T')[0];

      const pedidos = db.prepare(`
        SELECT * FROM pedidos
        WHERE estado = 'entregado'
        AND date(created_at) >= ?
        ORDER BY created_at DESC
      `).all(desdeStr);
      return { ok: true, data: pedidos };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── HISTORIAL: Pedidos archivados ─────────────────────────────────────────
  ipcMain.handle('historial:getArchivados', async () => {
    try {
      const pedidos = db.prepare(`
        SELECT * FROM pedidos
        WHERE archivado = 1 AND estado NOT IN ('entregado', 'cancelado', 'desperdicio')
        ORDER BY created_at DESC
        LIMIT 200
      `).all();
      return { ok: true, data: pedidos };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── HISTORIAL: Desarchivar un pedido ─────────────────────────────────────
  ipcMain.handle('historial:desarchivar', async (_, id) => {
    try {
      db.prepare(`UPDATE pedidos SET archivado = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── HISTORIAL: Exportar CSV manual (el usuario elige la ruta) ────────────
  ipcMain.handle('historial:exportarCSV', async () => {
    try {
      const { dialog } = require('electron');

      const hoy = new Date();
      const desde = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1);
      const desdeStr = desde.toISOString().split('T')[0];

      const pedidos = db.prepare(`
        SELECT * FROM pedidos
        WHERE estado = 'entregado'
        AND date(created_at) >= ?
        ORDER BY created_at DESC
      `).all(desdeStr);

      const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Exportar Historial de Ventas',
        defaultPath: `Historial_Ventas_${hoy.toISOString().split('T')[0]}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });

      if (!filePath) return { ok: false, error: 'Cancelado por el usuario' };

      const fs = require('fs');
      const cabecera = 'ID,Numero Pedido,Cliente,Telefono,Direccion,Productos,Total,Metodo Pago,Notas,Fecha\n';
      let contenido = cabecera;
      for (const p of pedidos) {
        const productos = (() => { try { return JSON.parse(p.productos).map(x => `${x.cantidad || 1}x ${x.nombre || x.name}`).join(' | '); } catch { return p.productos; } })();
        const fila = [
          p.id, p.numero_pedido, `"${p.cliente_nombre}"`, p.cliente_tel || '',
          p.direccion || '', `"${productos}"`, p.total,
          p.metodo_pago, `"${p.notas || ''}"`, p.created_at
        ].join(',');
        contenido += fila + '\n';
      }
      fs.writeFileSync(filePath, contenido, 'utf8');

      return { ok: true, filePath };
    } catch (err) {
      console.error('[historial:exportarCSV] Error:', err);
      return { ok: false, error: err.message };
    }
  });
}

// ─── Ciclo de vida de la app ───────────────────────────────────────────────

app.whenReady().then(() => {
  // 1. Inicializar la base de datos (crea tablas si no existen)
  const db = initDatabase();
  console.log('[Main] Base de datos SQLite inicializada');

  // Purgar pedidos archivados con más de 3 días de antigüedad (borrado definitivo)
  try {
    db.prepare(`
      DELETE FROM pedidos
      WHERE archivado = 1
      AND estado NOT IN ('entregado', 'cancelado', 'desperdicio')
      AND julianday('now') - julianday(created_at) > 3
    `).run();
    console.log('[Main] Purgado de pedidos archivados antiguos completado');
  } catch (err) {
    console.error('[Main] Error al purgar pedidos archivados:', err);
  }

  // 2. Registrar todos los handlers IPC
  setupIpcHandlers(db);
  console.log('[Main] Handlers IPC registrados');

  // 3. Levantar servidor HTTP interno (Express)
  startServer();

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
