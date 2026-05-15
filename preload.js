// src/preload/preload.js
// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT BRIDGE — El puente de comunicación seguro entre el Renderer y el Main.
//
// ¿POR QUÉ ES NECESARIO?
//   El renderer (tu HTML/JS) corre en un contexto aislado (contextIsolation: true)
//   y NO tiene acceso a Node.js ni a los módulos de Electron.
//   El Context Bridge expone SÓLO las funciones que vos habilitás explícitamente,
//   creando una API controlada: window.electronAPI
//
// SEGURIDAD:
//   - Nunca expongas `ipcRenderer` directamente al renderer
//   - Sólo exponé funciones específicas, no el objeto completo
//   - Validá los datos en el main process antes de usarlos
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

// ── API expuesta al Renderer Process ──────────────────────────────────────
// Disponible como: window.electronAPI.metodo()
contextBridge.exposeInMainWorld('electronAPI', {

  // ─── PEDIDOS ────────────────────────────────────────────────────────────

  /**
   * Obtener todos los pedidos (carga inicial)
   * @returns {Promise<{ok: boolean, data: Pedido[]}>}
   */
  getAllPedidos: () =>
    ipcRenderer.invoke('pedidos:getAll'),

  /**
   * Obtener pedidos nuevos desde una fecha (para polling)
   * @param {string} since - ISO string de la última actualización
   * @returns {Promise<{ok: boolean, data: Pedido[]}>}
   */
  getNewPedidos: (since) =>
    ipcRenderer.invoke('pedidos:getNew', since),

  /**
   * Actualizar el estado de un pedido
   * @param {number} id
   * @param {string} estado - 'nuevo' | 'en_preparacion' | 'listo' | 'entregado' | 'cancelado'
   */
  updateEstadoPedido: (id, estado) =>
    ipcRenderer.invoke('pedidos:updateEstado', { id, estado }),

  /**
   * Editar los datos de un pedido
   * @param {Pedido} pedido - Objeto con los datos actualizados
   */
  updatePedido: (pedido) =>
    ipcRenderer.invoke('pedidos:update', pedido),

  /**
   * Cancelar/eliminar un pedido
   * @param {number} id
   */
  deletePedido: (id) =>
    ipcRenderer.invoke('pedidos:delete', id),

  /**
   * Crear un pedido manual
   * @param {Pedido} pedido
   */
  createPedido: (pedido) =>
    ipcRenderer.invoke('pedidos:create', pedido),

  // ─── INVENTARIO ─────────────────────────────────────────────────────────

  getCategorias: () => ipcRenderer.invoke('categorias:getAll'),
  createCategoria: (cat) => ipcRenderer.invoke('categorias:create', cat),
  updateCategoria: (cat) => ipcRenderer.invoke('categorias:update', cat),
  deleteCategoria: (id) => ipcRenderer.invoke('categorias:delete', id),
  getProductos: () => ipcRenderer.invoke('productos:getAll'),
  createProducto: (prod) => ipcRenderer.invoke('productos:create', prod),
  updateProducto: (prod) => ipcRenderer.invoke('productos:update', prod),
  deleteProducto: (id) => ipcRenderer.invoke('productos:delete', id),

  getInsumos: () => ipcRenderer.invoke('insumos:getAll'),
  createInsumo: (insumo) => ipcRenderer.invoke('insumos:create', insumo),
  updateInsumo: (insumo) => ipcRenderer.invoke('insumos:update', insumo),
  deleteInsumo: (id) => ipcRenderer.invoke('insumos:delete', id),

  getAllRecetas: () => ipcRenderer.invoke('recetas:getAll'),
  deleteReceta: (productoId) => ipcRenderer.invoke('recetas:delete', productoId),
  getReceta: (productoId) => ipcRenderer.invoke('recetas:getByProducto', productoId),
  saveReceta: (productoId, items) => ipcRenderer.invoke('recetas:save', { producto_id: productoId, items }),

  checkStockAlerts: () => ipcRenderer.invoke('inventario:checkAlerts'),
  checkStock: (productos) => ipcRenderer.invoke('inventario:checkStock', productos),

  // ─── IMPRESIÓN ──────────────────────────────────────────────────────────

  /**
   * Imprimir el ticket de un pedido en la impresora térmica.
   * SILENCIOSO: no abre ningún diálogo del sistema operativo.
   * @param {Pedido} pedido - El objeto completo del pedido
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  printPedido: (pedido) =>
    ipcRenderer.invoke('printer:print', pedido),

  /**
   * Listar impresoras disponibles en el sistema
   * @returns {Promise<{ok: boolean, data: Printer[]}>}
   */
  listPrinters: () =>
    ipcRenderer.invoke('printer:list'),

  // ─── NOTIFICACIONES ─────────────────────────────────────────────────────

  /**
   * Mostrar notificación nativa del SO
   * @param {string} title
   * @param {string} body
   */
  notify: (title, body) =>
    ipcRenderer.send('notify:newOrder', { title, body }),

  // ─── UTILIDADES ─────────────────────────────────────────────────────────

  /**
   * Escuchar eventos enviados DESDE el main al renderer.
   * Útil si en el futuro querés que el main notifique cambios "push" sin polling.
   * @param {string} channel
   * @param {Function} callback
   */
  on: (channel, callback) => {
    // Whitelist de canales permitidos (seguridad)
    const allowedChannels = ['pedidos:nuevo', 'pedidos:actualizado', 'impresora:error'];
    if (allowedChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => callback(...args));
    }
  },

  /**
   * Remover un listener (para cleanup en componentes)
   */
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },

  // ─── TIENDA ─────────────────────────────────────────────────────────────

  /** Obtener si la tienda está abierta o cerrada */
  getTiendaStatus: () =>
    ipcRenderer.invoke('tienda:getStatus'),

  /** Abrir tienda: archiva pendientes y purga meses viejos */
  abrirTienda: () =>
    ipcRenderer.invoke('tienda:abrirTienda'),

  /** Cerrar tienda */
  cerrarTienda: () =>
    ipcRenderer.invoke('tienda:cerrarTienda'),

  /** Obtener stock para el checklist de apertura */
  getStockApertura: () =>
    ipcRenderer.invoke('tienda:getStockApertura'),

  /** Actualizar stock desde el checklist de apertura */
  updateStockApertura: (data) =>
    ipcRenderer.invoke('tienda:updateStock', data),

  // ─── HISTORIAL ──────────────────────────────────────────────────────────

  /** Pedidos entregados de los últimos 3 meses calendario */
  getHistorialPedidos: () =>
    ipcRenderer.invoke('historial:getPedidos'),

  /** Pedidos archivados (quedaron pendientes al abrir tienda) */
  getHistorialArchivados: () =>
    ipcRenderer.invoke('historial:getArchivados'),

  /** Desarchivar un pedido para que vuelva al flujo activo */
  desarchivarPedido: (id) =>
    ipcRenderer.invoke('historial:desarchivar', id),

  /** Exportar historial de ventas a CSV con diálogo de guardado */
  exportarHistorialCSV: () =>
    ipcRenderer.invoke('historial:exportarCSV'),

  // ─── CONFIGURACIÓN ──────────────────────────────────────────────────────

  /** Obtener toda la configuración de la tabla configuracion */
  getConfig: () =>
    ipcRenderer.invoke('config:getAll'),

  /** Guardar un par clave-valor en la configuración */
  saveConfig: (clave, valor) =>
    ipcRenderer.invoke('config:save', { clave, valor }),

  // ─── DIALOGOS NATIVOS ───────────────────────────────────────────────────
  showConfirmDialog: (message) =>
    ipcRenderer.invoke('dialog:confirm', message),
});

// ── Información de la plataforma (read-only, sin IPC) ─────────────────────
contextBridge.exposeInMainWorld('electronPlatform', {
  platform: process.platform,  // 'win32' | 'darwin' | 'linux'
  version: process.versions.electron,
});

console.log('[Preload] Context Bridge inicializado. API disponible en window.electronAPI');
