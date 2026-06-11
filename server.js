// src/main/server.js
// ─────────────────────────────────────────────────────────────────────────────
// SERVIDOR HTTP INTERNO (Express)
// Se levanta dentro del main process de Electron para recibir peticiones
// externas (ej: webhooks de n8n desde un contenedor Docker local).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');

const SERVER_PORT = 3000;

/**
 * Procesa, valida, enriquece, inserta un pedido en la base de datos SQLite y descuenta stock.
 * También emite el evento IPC 'pedidos:nuevo' al proceso de renderizado.
 *
 * @param {object} db - Instancia de SQLite
 * @param {object} pedidoObj - Objeto con los datos del pedido
 * @param {object|function} mainWindow - Instancia o getter de la ventana principal
 * @returns {object} { savedPedido, alertasStock }
 */
function procesarEInsertarPedido(db, pedidoObj, mainWindow) {
  const liveWindow = typeof mainWindow === 'function' ? mainWindow() : mainWindow;

  // Validaciones básicas de campos obligatorios
  if (!pedidoObj.cliente_nombre) {
    throw new Error('El campo cliente_nombre es requerido.');
  }
  if (!pedidoObj.productos) {
    throw new Error('El listado de productos es requerido.');
  }

  // Generar el número de pedido correlativo
  const { generarNumeroPedido } = require('./database');
  const numero_pedido = generarNumeroPedido();

  // Formatear campo productos y resolver ID/Precio por nombre si es necesario
  let productosObj = [];
  if (typeof pedidoObj.productos === 'string') {
    try { productosObj = JSON.parse(pedidoObj.productos); } catch (e) { productosObj = []; }
  } else if (Array.isArray(pedidoObj.productos)) {
    // Clonar para evitar mutar el objeto original inesperadamente
    productosObj = JSON.parse(JSON.stringify(pedidoObj.productos));
  } else {
    productosObj = [];
  }

  // Enriquecer productos y opciones con IDs de base de datos usando el nombre
  for (const p of productosObj) {
    if (!p.producto_id && p.nombre) {
      const cleanName = p.nombre.trim();
      const dbProd = db.prepare(`SELECT id, precio FROM productos WHERE nombre = ? COLLATE NOCASE`).get(cleanName);
      if (dbProd) {
        p.producto_id = dbProd.id;
        if (p.precio === undefined || p.precio === null || p.precio === '') {
          p.precio = dbProd.precio;
        }
      }
    }

    // Si tenemos producto_id, también podemos resolver las opciones de personalización
    if (p.producto_id && p.personalizacion && Array.isArray(p.personalizacion.opciones)) {
      for (const opt of p.personalizacion.opciones) {
        if (!opt.id && opt.nombre) {
          const cleanOptName = opt.nombre.trim();
          const dbOpt = db.prepare(`
            SELECT o.id, o.precio_extra 
            FROM opciones o
            JOIN producto_grupos pg ON o.grupo_id = pg.grupo_id
            WHERE pg.producto_id = ? AND o.nombre = ? COLLATE NOCASE
          `).get(p.producto_id, cleanOptName);
          if (dbOpt) {
            opt.id = dbOpt.id;
            if (opt.precio_extra === undefined || opt.precio_extra === null || opt.precio_extra === '') {
              opt.precio_extra = dbOpt.precio_extra;
            }
          }
        }
      }
    }
  }

  const productosStr = JSON.stringify(productosObj);

  // Calcular el total real basado en la lista de productos y sus modificadores
  let totalCalculado = 0;
  for (const p of productosObj) {
    const basePrice = parseFloat(p.precio || 0);
    let extraPrice = 0;
    if (p.personalizacion && p.personalizacion.opciones) {
      for (const opt of p.personalizacion.opciones) {
        extraPrice += parseFloat(opt.precio_extra || 0);
      }
    }
    totalCalculado += (p.cantidad || 1) * (basePrice + extraPrice);
  }

  // Sumar costo de envío
  const costoEnvio = parseFloat(pedidoObj.costo_envio || 0);
  totalCalculado += costoEnvio;

  // Obtener el total enviado por el cliente/n8n/whatsapp
  const totalEnviado = parseFloat(pedidoObj.total_real || pedidoObj.total || 0);

  // Determinar si hay discrepancia de total para forzar la alerta
  let flag_alerta = (pedidoObj.flag_alerta === true || pedidoObj.flag_alerta === 1 || String(pedidoObj.flag_alerta).toLowerCase() === 'true') ? 1 : 0;
  if (Math.abs(totalEnviado - totalCalculado) > 0.01) {
    console.log(`[Database Controller] Discrepancia detectada: enviado=$${totalEnviado}, calculado=$${totalCalculado}. Forzando flag_alerta = 1`);
    flag_alerta = 1;
  }

  // Guardamos el total calculado por el programa en lugar del discrepante enviado
  const total = totalCalculado;

  // Ejecutar la inserción y descuento de stock de forma transaccional y atómica
  const executeTx = db.transaction(() => {
    // 1. Insertar el pedido en la base de datos
    const info = db.prepare(`
      INSERT INTO pedidos (
        numero_pedido, cliente_nombre, cliente_tel, direccion, productos, 
        total, metodo_pago, notas, fuente, estado, 
        tipo_envio, costo_envio, departamento, flag_alerta
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'nuevo', ?, ?, ?, ?)
    `).run(
      numero_pedido,
      pedidoObj.cliente_nombre,
      pedidoObj.cliente_tel || '',
      pedidoObj.direccion || '',
      productosStr,
      total,
      pedidoObj.metodo_pago || 'efectivo',
      pedidoObj.notas || '',
      pedidoObj.fuente || 'n8n',
      pedidoObj.tipo_envio || 'Retiro Local',
      parseFloat(pedidoObj.costo_envio || 0),
      pedidoObj.departamento || '',
      flag_alerta
    );

    const newId = info.lastInsertRowid;
    const alertasStock = [];

    // 2. Descontar stock
    for (const p of productosObj) {
      const cantidadPedida = p.cantidad || 1;

      if (p.producto_id) {
        const prod = db.prepare(`SELECT controla_stock FROM productos WHERE id = ?`).get(p.producto_id);
        // Solo descontar si el producto controla stock
        if (prod && prod.controla_stock !== 0) {
          const receta = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas WHERE producto_id = ?`).all(p.producto_id);
          if (receta.length > 0) {
            // Descontar por insumos
            for (const r of receta) {
              const cant = r.cantidad_necesaria * cantidadPedida;
              db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual - ? WHERE id = ?`).run(cant, r.insumo_id);

              // Alerta de punto de reposición
              const insumo = db.prepare(`SELECT nombre, cantidad_actual, punto_reposicion FROM insumos WHERE id = ?`).get(r.insumo_id);
              if (insumo && insumo.cantidad_actual <= insumo.punto_reposicion) {
                alertasStock.push(insumo.nombre);
              }
            }
          } else {
            // Descontar producto directamente si no tiene receta
            db.prepare(`UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?`).run(cantidadPedida, p.producto_id);
          }
        }
      }

      // Descontar stock por modificadores / opciones personalizadas en combos
      if (p.personalizacion && p.personalizacion.opciones) {
        for (const opt of p.personalizacion.opciones) {
          const recetaOpcion = db.prepare(`SELECT insumo_id, cantidad_necesaria FROM recetas_opciones WHERE opcion_id = ?`).all(opt.id);
          for (const ro of recetaOpcion) {
            const cantOpt = ro.cantidad_necesaria * cantidadPedida;
            db.prepare(`UPDATE insumos SET cantidad_actual = cantidad_actual - ? WHERE id = ?`).run(cantOpt, ro.insumo_id);

            // Alerta de punto de reposición
            const insumo = db.prepare(`SELECT nombre, cantidad_actual, punto_reposicion FROM insumos WHERE id = ?`).get(ro.insumo_id);
            if (insumo && insumo.cantidad_actual <= insumo.punto_reposicion) {
              alertasStock.push(insumo.nombre);
            }
          }
        }
      }
    }

    // Obtener el registro completo insertado
    const savedPedido = db.prepare(`SELECT * FROM pedidos WHERE id = ?`).get(newId);
    return { savedPedido, alertasStock };
  });

  const { savedPedido, alertasStock } = executeTx();

  // Emitir evento IPC en tiempo real hacia el Renderer process
  if (liveWindow && !liveWindow.webContents.isDestroyed()) {
    console.log(`[Database Controller] Enviando pedido ${savedPedido.numero_pedido} al Renderer via IPC. flag_alerta=${flag_alerta === 1}`);
    liveWindow.webContents.send('pedidos:nuevo', {
      pedido: savedPedido,
      flag_alerta: flag_alerta === 1
    });
  }

  return { savedPedido, alertasStock };
}

/**
 * Inicia el servidor HTTP interno de Express.
 * Recibe la instancia de la base de datos y de la ventana principal de Electron.
 * 
 * @param {object} db - Instancia de SQLite (better-sqlite3)
 * @param {object} mainWindow - Instancia de BrowserWindow de Electron
 */
function startServer(db, mainWindow) {
  const app = express();

  // ── Middleware ─────────────────────────────────────────────────────────────
  app.use(cors());
  app.use(express.json()); // Parsear body JSON automáticamente

  // ── Endpoints ─────────────────────────────────────────────────────────────

  /**
   * GET /api/productos
   * Devuelve el catálogo completo de productos con sus grupos de variantes y opciones
   * formateado adecuadamente para que n8n pueda validar límites de selección.
   */
  app.get('/api/productos', (req, res) => {
    try {
      console.log('[Server] GET /api/productos — Solicitando catálogo de productos');

      // 1. Obtener todos los productos con el nombre y color de su categoría
      const productos = db.prepare(`
        SELECT p.*, c.nombre as categoria_nombre, c.color as categoria_color
        FROM productos p
        LEFT JOIN categorias c ON p.categoria_id = c.id
        ORDER BY c.nombre ASC, p.nombre ASC
      `).all();

      // 2. Para cada producto, adjuntar sus grupos de variantes y opciones asociadas
      for (const prod of productos) {
        const grupos = db.prepare(`
          SELECT g.* 
          FROM grupos_opciones g
          JOIN producto_grupos pg ON g.id = pg.grupo_id
          WHERE pg.producto_id = ?
          ORDER BY pg.prioridad ASC
        `).all(prod.id);

        for (const grupo of grupos) {
          // Exponer límites con sus nombres originales en BD y con los alias solicitados por el cliente
          grupo.min_options = grupo.min_seleccion;
          grupo.max_options = grupo.max_seleccion;

          // Obtener las opciones específicas del grupo
          grupo.opciones = db.prepare(`
            SELECT * FROM opciones WHERE grupo_id = ? ORDER BY id ASC
          `).all(grupo.id);
        }

        prod.grupos = grupos;
      }

      res.status(200).json({
        ok: true,
        data: productos
      });
    } catch (err) {
      console.error('[Server] Error en GET /api/productos:', err);
      res.status(500).json({
        ok: false,
        error: 'Error interno al consultar el catálogo de productos.'
      });
    }
  });

  /**
   * POST /api/pedidos
   * Recibe una orden validada desde n8n, la inserta de forma transaccional,
   * descuenta el stock/insumos e informa por IPC en tiempo real con alertas de pago.
   */
  app.post('/api/pedidos', (req, res) => {
    try {
      console.log('[Server] POST /api/pedidos — Recibiendo pedido automatizado');
      const pedidoObj = req.body;

      // Usamos la función extraída
      const { savedPedido, alertasStock } = procesarEInsertarPedido(db, pedidoObj, mainWindow);

      res.status(201).json({
        ok: true,
        message: 'Pedido insertado y notificado en tiempo real con éxito.',
        id: savedPedido.id,
        numero_pedido: savedPedido.numero_pedido,
        alertas_stock: alertasStock
      });

    } catch (err) {
      console.error('[Server] Error en POST /api/pedidos:', err);
      res.status(500).json({
        ok: false,
        error: 'Error interno al procesar e insertar el pedido: ' + err.message
      });
    }
  });

  // ── Arrancar el servidor ────────────────────────────────────────────────────
  app.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`[Server] Servidor Express de integración escuchando en http://0.0.0.0:${SERVER_PORT}`);
  });
}

module.exports = { startServer, procesarEInsertarPedido };
