// src/renderer/renderer.js
// ─────────────────────────────────────────────────────────────────────────────
// RENDERER PROCESS — Lógica de la interfaz de usuario
// HTML/CSS/JS puro: sin frameworks, sin bundlers.
// Accede al backend ÚNICAMENTE a través de window.electronAPI (Context Bridge)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Estado de la aplicación ──────────────────────────────────────────────
const state = {
  pedidos: [],           // Array de todos los pedidos activos
  lastCheck: null,       // ISO string de la última consulta (para polling)
  pollingInterval: null, // Referencia al setInterval del polling
  vistaActual: 'kanban', // 'kanban' | 'lista'
  filtroEstado: 'activos', // 'activos' | 'todos' | estado específico
  pedidoSeleccionado: null,
  isEditMode: false,
};

// ─── Constantes ────────────────────────────────────────────────────────────
const POLLING_MS = 3000; // Intervalo de polling en ms (3 segundos)

const ESTADOS = {
  nuevo:     { label: 'Nuevo',     color: '#e74c3c', emoji: '🆕' },
  esperando: { label: 'En Preparacion', color: '#f39c12', emoji: '⏳' },
  listo:     { label: 'Listo',     color: '#27ae60', emoji: '✅' },
  cancelado: { label: 'Cancelado', color: '#7f8c8d', emoji: '❌' },
};

const COLUMNAS_KANBAN = ['nuevo', 'esperando', 'listo'];

// ID del pedido que se está arrastrando
let draggedPedidoId = null;

// ─── Inicialización ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Renderer] App inicializada');
  await cargarPedidosIniciales();
  iniciarPolling();
  setupEventListeners();
});

// ─── Carga inicial ─────────────────────────────────────────────────────────
async function cargarPedidosIniciales() {
  mostrarLoading(true);
  const result = await window.electronAPI.getAllPedidos();
  mostrarLoading(false);

  if (!result.ok) {
    mostrarError('No se pudieron cargar los pedidos: ' + result.error);
    return;
  }

  state.pedidos = result.data || [];
  state.lastCheck = new Date().toISOString();
  renderizarVista();
}

// ─── Polling: verificar nuevos pedidos cada N segundos ────────────────────
function iniciarPolling() {
  if (state.pollingInterval) clearInterval(state.pollingInterval);

  state.pollingInterval = setInterval(async () => {
    const result = await window.electronAPI.getNewPedidos(state.lastCheck);

    if (!result.ok || !result.data?.length) return;

    // Hay pedidos nuevos
    const nuevos = result.data;
    state.lastCheck = new Date().toISOString();

    // Agregar al estado sin duplicar
    nuevos.forEach(p => {
      const existe = state.pedidos.find(existing => existing.id === p.id);
      if (!existe) {
        state.pedidos.unshift(p); // Agregar al inicio
        mostrarNotificacionNuevoPedido(p);
      }
    });

    renderizarVista();
  }, POLLING_MS);

  console.log(`[Renderer] Polling iniciado: cada ${POLLING_MS / 1000}s`);
}

// ─── Renderizado principal ─────────────────────────────────────────────────
function renderizarVista() {
  const pedidosFiltrados = filtrarPedidos(state.pedidos);

  const vistaKanban = document.getElementById('vista-kanban');
  const vistaLista = document.getElementById('vista-lista');

  if (state.vistaActual === 'kanban') {
    if (vistaKanban) vistaKanban.style.display = 'grid';
    if (vistaLista) vistaLista.style.display = 'none';
    renderizarKanban(pedidosFiltrados);
  } else {
    if (vistaKanban) vistaKanban.style.display = 'none';
    if (vistaLista) vistaLista.style.display = 'block';
    renderizarLista(pedidosFiltrados);
  }

  actualizarContadores();
}

function filtrarPedidos(pedidos) {
  if (state.filtroEstado === 'activos') {
    // Las 3 columnas del Kanban: Nuevo, En Preparacion, Listo
    // Los Cancelados solo se ven en "Todos"
    return pedidos.filter(p => p.estado !== 'cancelado');
  }
  if (state.filtroEstado === 'todos') return pedidos;
  // La solapa 'Entregados' muestra los pedidos en estado 'listo'
  if (state.filtroEstado === 'entregado') {
    return pedidos.filter(p => p.estado === 'listo');
  }
  return pedidos.filter(p => p.estado === state.filtroEstado);
}

// ─── Kanban ────────────────────────────────────────────────────────────────
function renderizarKanban(pedidos) {
  COLUMNAS_KANBAN.forEach(estado => {
    const columna = document.getElementById(`col-${estado}`);
    if (!columna) return;

    const pedidosColumna = pedidos.filter(p => p.estado === estado);
    const lista = columna.querySelector('.kanban-cards');
    if (!lista) return;

    lista.innerHTML = pedidosColumna.map(p => crearCardHTML(p)).join('');

    // Actualizar contador
    const contador = columna.querySelector('.col-count');
    if (contador) contador.textContent = pedidosColumna.length;
  });

  // Listeners de click en la card (abre modal)
  document.querySelectorAll('.pedido-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.id);
      abrirModal(id);
    });
  });

  // Botones de acción rápida — cancelar
  document.querySelectorAll('.quick-btn-cancel').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      const pedido = state.pedidos.find(p => p.id === id);
      if (!pedido) return;
      const confirmar = confirm(`¿Cancelar el pedido ${pedido.numero_pedido || '#' + pedido.id} de ${pedido.cliente_nombre}?`);
      if (!confirmar) return;
      const result = await window.electronAPI.deletePedido(id);
      if (result.ok) {
        if (pedido) pedido.estado = 'cancelado';
        renderizarVista();
        mostrarToast('Pedido cancelado', 'warning');
      } else {
        mostrarToast('❌ Error al cancelar: ' + (result.error || 'Error desconocido'), 'error');
      }
    });
  });

  // Botones de acción rápida — en preparación
  document.querySelectorAll('.quick-btn-prep').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      await cambiarEstado(id, 'esperando');
    });
  });

  // Botones de acción rápida — listo
  document.querySelectorAll('.quick-btn-listo').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      await cambiarEstado(id, 'listo');
    });
  });

  // Activar drag & drop
  setupDragAndDrop();
}

// ─── Drag & Drop ───────────────────────────────────────────────────────────
function setupDragAndDrop() {

  // ── Cards: hacer arrastrables ──
  document.querySelectorAll('.pedido-card').forEach(card => {
    card.setAttribute('draggable', 'true');

    card.addEventListener('dragstart', (e) => {
      draggedPedidoId = parseInt(card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      // Delay para que el ghost image del browser se genere antes del estilo
      setTimeout(() => {
        card.classList.add('dragging');
        // Deshabilitar pointer-events en hijos para que el drop llegue a la zona
        card.style.pointerEvents = 'none';
      }, 0);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.style.pointerEvents = '';
      // Limpiar todos los resaltados
      document.querySelectorAll('.kanban-cards').forEach(z => z.classList.remove('drag-over'));
    });
  });

  // ── Zonas de drop (las listas de cada columna) ──
  document.querySelectorAll('.kanban-cards').forEach(zona => {
    // Contador para manejar el dragleave cuando hay hijos dentro de la zona
    let dragCounter = 0;

    zona.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      zona.classList.add('drag-over');
    });

    zona.addEventListener('dragleave', () => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        zona.classList.remove('drag-over');
      }
    });

    zona.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    zona.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      zona.classList.remove('drag-over');

      const nuevoEstado = zona.dataset.estado;
      if (!nuevoEstado || !draggedPedidoId) return;

      const pedido = state.pedidos.find(p => p.id === draggedPedidoId);
      if (!pedido || pedido.estado === nuevoEstado) {
        draggedPedidoId = null;
        return;
      }

      const estadoAnterior = pedido.estado;
      const idArrastrado = draggedPedidoId;
      draggedPedidoId = null;

      // Cambiar estado en backend y actualizar UI
      await cambiarEstado(idArrastrado, nuevoEstado);
      // (La impresion automatica ocurre en cambiarEstado si fue Nuevo → Esperando)
    });
  });
}

function abrirModalConfirmarImpresion() {
  document.getElementById('modal-confirmar-impresion').classList.add('visible');
}

function cerrarModalConfirmarImpresion() {
  document.getElementById('modal-confirmar-impresion').classList.remove('visible');
}

// ─── Lista ─────────────────────────────────────────────────────────────────
function renderizarLista(pedidos) {
  const lista = document.getElementById('lista-pedidos');
  if (!lista) return;

  if (pedidos.length === 0) {
    lista.innerHTML = '<div class="empty-state">No hay pedidos para mostrar</div>';
    return;
  }

  lista.innerHTML = pedidos.map(p => `
    <div class="lista-row" data-id="${p.id}">
      <span class="lista-numero">${p.numero_pedido || '#' + p.id}</span>
      <span class="lista-cliente">${escapeHtml(p.cliente_nombre)}</span>
      <span class="lista-estado estado-${p.estado}">${ESTADOS[p.estado]?.emoji} ${ESTADOS[p.estado]?.label || p.estado}</span>
      <span class="lista-total">$${parseFloat(p.total || 0).toLocaleString('es-AR')}</span>
      <span class="lista-tiempo">${tiempoRelativo(p.created_at)}</span>
    </div>
  `).join('');

  // Listeners: abrir modal al hacer click en cualquier fila
  lista.querySelectorAll('.lista-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.id);
      abrirModal(id);
    });
  });
}


// ─── Card HTML ─────────────────────────────────────────────────────────────
function crearCardHTML(pedido) {
  let productos = [];
  try {
    productos = JSON.parse(pedido.productos);
  } catch {
    productos = [];
  }

  const resumenProductos = Array.isArray(productos)
    ? productos.slice(0, 3).map(p => `${p.cantidad || 1}x ${p.nombre || p.name}`).join(' · ')
    : String(pedido.productos).substring(0, 60);

  return `
    <div class="pedido-card" data-id="${pedido.id}">
      <div class="card-header">
        <span class="card-numero">${pedido.numero_pedido || '#' + pedido.id}</span>
        <span class="card-tiempo">${tiempoRelativo(pedido.created_at)}</span>
      </div>
      <div class="card-cliente">👤 ${escapeHtml(pedido.cliente_nombre)}</div>
      <div class="card-productos">${escapeHtml(resumenProductos)}</div>
      <div class="card-footer">
        <span class="card-total">$${parseFloat(pedido.total || 0).toLocaleString('es-AR')}</span>
        <span class="card-pago">${pedido.metodo_pago || 'efectivo'}</span>
      </div>
      ${pedido.notas ? `<div class="card-nota">📝 ${escapeHtml(pedido.notas)}</div>` : ''}
      <div class="card-quick-actions">
        <button class="quick-btn quick-btn-cancel" data-id="${pedido.id}" title="Cancelar pedido">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <button class="quick-btn quick-btn-prep" data-id="${pedido.id}" title="Pasar a En Preparación">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button class="quick-btn quick-btn-listo" data-id="${pedido.id}" title="Marcar como Listo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
    </div>
  `;
}

// ─── Modal de pedido ───────────────────────────────────────────────────────
function abrirModal(id) {
  const pedido = state.pedidos.find(p => p.id === id);
  if (!pedido) return;

  state.pedidoSeleccionado = pedido;
  state.isEditMode = false;

  renderizarModalContenido();

  const modal = document.getElementById('modal-pedido');
  modal.classList.add('visible');
}

function renderizarModalContenido() {
  const pedido = state.pedidoSeleccionado;
  const isEdit = state.isEditMode;

  let productos = [];
  try { productos = JSON.parse(pedido.productos); } catch { productos = []; }
  if (!Array.isArray(productos)) productos = [];

  const modal = document.getElementById('modal-pedido');
  const contenido = modal.querySelector('.modal-body');

  // Ajustar visibilidad de botones según estado y modo
  const esCancelado = pedido.estado === 'cancelado';
  const btnEditar = document.getElementById('btn-editar-pedido');
  const btnGuardar = document.getElementById('btn-guardar-pedido');
  const btnImprimir = document.getElementById('btn-imprimir');
  const btnCancelar = document.getElementById('btn-cancelar-pedido');
  if (btnEditar)  btnEditar.style.display  = (isEdit || esCancelado) ? 'none' : 'inline-flex';
  if (btnGuardar) btnGuardar.style.display = isEdit ? 'inline-flex' : 'none';
  if (btnImprimir) btnImprimir.style.display = (isEdit || esCancelado) ? 'none' : 'inline-flex';
  if (btnCancelar) btnCancelar.style.display = esCancelado ? 'none' : 'inline-flex';

  if (!isEdit) {
    // ── MODO LECTURA ──
    contenido.innerHTML = `
      <div class="modal-info-grid">
        <div>
          <label>Pedido</label>
          <strong>${pedido.numero_pedido || '#' + pedido.id}</strong>
        </div>
        <div>
          <label>Estado</label>
          ${esCancelado
            ? `<span class="estado-cancelado-badge">❌ Cancelado</span>`
            : `<select id="modal-estado" class="estado-select">
            <option value="nuevo"     ${pedido.estado === 'nuevo'     ? 'selected' : ''}>🆕 Nuevo</option>
            <option value="esperando" ${pedido.estado === 'esperando' ? 'selected' : ''}>⏳ En Preparacion</option>
            <option value="listo"     ${pedido.estado === 'listo'     ? 'selected' : ''}>✅ Listo</option>
          </select>`
          }
        </div>
        <div>
          <label>Cliente</label>
          <strong>${escapeHtml(pedido.cliente_nombre)}</strong>
          ${pedido.cliente_tel ? `<span class="tel">${pedido.cliente_tel}</span>` : ''}
        </div>
        <div>
          <label>Dirección</label>
          <strong>${pedido.direccion ? escapeHtml(pedido.direccion) : '-'}</strong>
        </div>
        <div>
          <label>Pago</label>
          <strong>${(pedido.metodo_pago || 'efectivo').toUpperCase()}</strong>
        </div>
      </div>

      <div class="modal-productos">
        <h4>Productos</h4>
        ${productos.map(p => `
          <div class="modal-producto-row">
            <span class="prod-cant">${p.cantidad || p.quantity || 1}x</span>
            <span class="prod-nombre">${escapeHtml(p.nombre || p.name || 'Producto')}</span>
            <span class="prod-precio">$${parseFloat((p.precio || p.price || 0) * (p.cantidad || p.quantity || 1)).toLocaleString('es-AR')}</span>
          </div>
          ${p.modificadores ? `<div class="prod-extras">${Array.isArray(p.modificadores) ? p.modificadores.join(', ') : p.modificadores}</div>` : ''}
        `).join('')}
      </div>

      <div class="modal-total">
        <span>Total</span>
        <strong>$${parseFloat(pedido.total || 0).toLocaleString('es-AR')}</strong>
      </div>

      ${pedido.notas ? `
        <div class="modal-notas">
          <label>Notas</label>
          <p>${escapeHtml(pedido.notas)}</p>
        </div>
      ` : ''}

      <div class="modal-fecha">
        Recibido: ${new Date(pedido.created_at).toLocaleString('es-AR')}
      </div>
    `;

    if (!esCancelado) {
      document.getElementById('modal-estado').addEventListener('change', async (e) => {
        await cambiarEstado(pedido.id, e.target.value);
      });
    }

  } else {
    // ── MODO EDICIÓN ──
    contenido.innerHTML = `
      <div class="modal-info-grid edit-mode">
        <div>
          <label>Cliente</label>
          <input type="text" id="edit-nombre" class="edit-input" value="${escapeHtml(pedido.cliente_nombre)}">
        </div>
        <div>
          <label>Teléfono</label>
          <input type="text" id="edit-tel" class="edit-input" value="${escapeHtml(pedido.cliente_tel || '')}">
        </div>
        <div>
          <label>Dirección</label>
          <input type="text" id="edit-direccion" class="edit-input" value="${escapeHtml(pedido.direccion || '')}">
        </div>
        <div>
          <label>Pago</label>
          <select id="edit-pago" class="edit-input">
            <option value="efectivo" ${pedido.metodo_pago === 'efectivo' ? 'selected' : ''}>Efectivo</option>
            <option value="mercadopago" ${pedido.metodo_pago === 'mercadopago' ? 'selected' : ''}>MercadoPago</option>
            <option value="transferencia" ${pedido.metodo_pago === 'transferencia' ? 'selected' : ''}>Transferencia</option>
          </select>
        </div>
      </div>

      <div class="modal-productos">
        <h4>Productos</h4>
        <div id="edit-productos-container">
          ${productos.map((p, idx) => generarFilaProducto(p, idx)).join('')}
        </div>
        <button id="btn-add-producto" class="btn btn-secondary btn-small" style="margin-top:10px">+ Agregar Producto</button>
      </div>

      <div class="modal-total edit-total-container">
        <span>Total Modificado</span>
        <input type="number" id="edit-total" class="edit-input total-input" value="${pedido.total || 0}" step="0.01">
      </div>

      <div class="modal-notas">
        <label>Notas</label>
        <textarea id="edit-notas" class="edit-input" rows="3">${escapeHtml(pedido.notas || '')}</textarea>
      </div>
    `;

    // Listeners del modo edición
    document.getElementById('btn-add-producto').addEventListener('click', () => {
      const container = document.getElementById('edit-productos-container');
      const idx = container.children.length;
      container.insertAdjacentHTML('beforeend', generarFilaProducto({ nombre: '', cantidad: 1, precio: 0 }, idx));
      bindProductEvents();
    });

    bindProductEvents();
  }
}

function generarFilaProducto(p, idx) {
  return `
    <div class="edit-producto-row" data-idx="${idx}">
      <input type="number" class="edit-input prod-edit-cant" value="${p.cantidad || p.quantity || 1}" min="1" placeholder="Cant">
      <input type="text" class="edit-input prod-edit-nombre" value="${escapeHtml(p.nombre || p.name || '')}" placeholder="Nombre del producto">
      <input type="number" class="edit-input prod-edit-precio" value="${p.precio || p.price || 0}" min="0" step="0.01" placeholder="Precio U.">
      <button class="btn-icon btn-remove-prod" title="Quitar">✕</button>
    </div>
  `;
}

function bindProductEvents() {
  document.querySelectorAll('.btn-remove-prod').forEach(btn => {
    btn.onclick = (e) => {
      e.target.closest('.edit-producto-row').remove();
      recalcularTotal();
    };
  });

  document.querySelectorAll('.prod-edit-cant, .prod-edit-precio').forEach(input => {
    input.oninput = recalcularTotal;
  });
}

function recalcularTotal() {
  let total = 0;
  document.querySelectorAll('.edit-producto-row').forEach(row => {
    const cant = parseFloat(row.querySelector('.prod-edit-cant').value) || 0;
    const precio = parseFloat(row.querySelector('.prod-edit-precio').value) || 0;
    total += cant * precio;
  });
  document.getElementById('edit-total').value = total;
}

function cerrarModal() {
  const modal = document.getElementById('modal-pedido');
  modal.classList.remove('visible');
  state.pedidoSeleccionado = null;
  state.isEditMode = false;
}

// ─── Acciones desde el modal ───────────────────────────────────────────────
async function guardarPedidoEditado() {
  const btn = document.getElementById('btn-guardar-pedido');
  btn.disabled = true;
  btn.textContent = '⏳ Guardando...';

  // Recopilar datos
  const productos = [];
  document.querySelectorAll('.edit-producto-row').forEach(row => {
    productos.push({
      nombre: row.querySelector('.prod-edit-nombre').value,
      cantidad: parseFloat(row.querySelector('.prod-edit-cant').value) || 1,
      precio: parseFloat(row.querySelector('.prod-edit-precio').value) || 0
    });
  });

  const pedidoModificado = {
    id: state.pedidoSeleccionado.id,
    cliente_nombre: document.getElementById('edit-nombre').value,
    cliente_tel: document.getElementById('edit-tel').value,
    direccion: document.getElementById('edit-direccion').value,
    metodo_pago: document.getElementById('edit-pago').value,
    notas: document.getElementById('edit-notas').value,
    total: parseFloat(document.getElementById('edit-total').value) || 0,
    productos: JSON.stringify(productos)
  };

  const result = await window.electronAPI.updatePedido(pedidoModificado);

  btn.disabled = false;
  btn.textContent = '💾 Guardar';

  if (result.ok) {
    mostrarToast('✅ Pedido actualizado', 'success');
    // Actualizar localmente
    const idx = state.pedidos.findIndex(p => p.id === pedidoModificado.id);
    if (idx !== -1) {
      state.pedidos[idx] = { ...state.pedidos[idx], ...pedidoModificado };
    }
    state.pedidoSeleccionado = state.pedidos[idx];
    state.isEditMode = false;
    renderizarVista();
    renderizarModalContenido();
  } else {
    mostrarToast('❌ Error: ' + result.error, 'error');
  }
}

async function imprimirPedido() {
  const pedido = state.pedidoSeleccionado;
  if (!pedido) return;

  const btn = document.getElementById('btn-imprimir');
  btn.textContent = '⏳ Imprimiendo...';
  btn.disabled = true;

  const result = await window.electronAPI.printPedido(pedido);

  btn.textContent = '🖨️ Imprimir';
  btn.disabled = false;

  if (result.ok) {
    mostrarToast('✅ Ticket impreso correctamente', 'success');
    // Auto-avanzar estado si está en "nuevo"
    if (pedido.estado === 'nuevo') {
      await cambiarEstado(pedido.id, 'en_preparacion');
    }
  } else {
    mostrarToast('❌ Error al imprimir: ' + result.error, 'error');
  }
}

async function cambiarEstado(id, nuevoEstado) {
  const result = await window.electronAPI.updateEstadoPedido(id, nuevoEstado);
  if (result.ok) {
    // Guardar estado anterior antes de actualizarlo
    const pedido = state.pedidos.find(p => p.id === id);
    const estadoAnterior = pedido ? pedido.estado : null;

    // Actualizar el estado local
    if (pedido) pedido.estado = nuevoEstado;
    renderizarVista();

    // Si pasó de Nuevo → Esperando (En Preparacion): imprimir automáticamente
    if (estadoAnterior === 'nuevo' && nuevoEstado === 'esperando') {
      mostrarToast('🖨️ Imprimiendo ticket...', 'info');
      const pedidoActualizado = state.pedidos.find(p => p.id === id);
      const printResult = await window.electronAPI.printPedido(pedidoActualizado);
      if (printResult.ok) {
        mostrarToast('✅ Ticket impreso', 'success');
      } else {
        mostrarToast('⚠️ Impresora no encontrada: ' + (printResult.error || 'Error desconocido'), 'warning');
      }
    }
  } else {
    // Mostrar popup de error con el detalle
    mostrarToast('❌ Error al cambiar estado: ' + (result.error || 'Error desconocido'), 'error');
    console.error('[cambiarEstado] Fallo:', result.error);
  }
}

async function cancelarPedido() {
  const pedido = state.pedidoSeleccionado;
  if (!pedido) return;

  const confirmar = confirm(`¿Cancelar el pedido ${pedido.numero_pedido || '#' + pedido.id} de ${pedido.cliente_nombre}?`);
  if (!confirmar) return;

  const result = await window.electronAPI.deletePedido(pedido.id);
  if (result.ok) {
    const pedidoLocal = state.pedidos.find(p => p.id === pedido.id);
    if (pedidoLocal) pedidoLocal.estado = 'cancelado';
    cerrarModal();
    renderizarVista();
    mostrarToast('Pedido cancelado', 'warning');
  }
}

// ─── Event Listeners globales ──────────────────────────────────────────────
function setupEventListeners() {
  // Botones del modal
  document.getElementById('btn-imprimir')?.addEventListener('click', imprimirPedido);
  document.getElementById('btn-cancelar-pedido')?.addEventListener('click', cancelarPedido);
  document.getElementById('btn-cerrar-modal')?.addEventListener('click', cerrarModal);
  document.getElementById('btn-volver')?.addEventListener('click', cerrarModal);

  document.getElementById('btn-editar-pedido')?.addEventListener('click', () => {
    state.isEditMode = true;
    renderizarModalContenido();
  });

  document.getElementById('btn-guardar-pedido')?.addEventListener('click', async () => {
    await guardarPedidoEditado();
  });

  // Modal de confirmación de impresión (al arrastrar Esperando → Listo)
  document.getElementById('btn-confirmar-imprimir')?.addEventListener('click', async () => {
    cerrarModalConfirmarImpresion();
    await imprimirPedido();
  });
  document.getElementById('btn-confirmar-no-imprimir')?.addEventListener('click', () => {
    cerrarModalConfirmarImpresion();
  });
  document.getElementById('btn-cerrar-confirmar')?.addEventListener('click', () => {
    cerrarModalConfirmarImpresion();
  });

  // Cerrar modal haciendo click fuera
  document.getElementById('modal-pedido')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-pedido') cerrarModal();
  });

  // Cambio de vista
  document.getElementById('btn-vista-kanban')?.addEventListener('click', () => {
    state.vistaActual = 'kanban';
    state.filtroEstado = 'activos'; // Kanban solo muestra activos
    actualizarBotonesFiltro();
    renderizarVista();
  });

  document.getElementById('btn-vista-lista')?.addEventListener('click', () => {
    state.vistaActual = 'lista';
    renderizarVista();
  });

  // Filtros
  document.querySelectorAll('[data-filtro]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filtroEstado = btn.dataset.filtro;
      // Si elige Todos o Entregados, pasamos a modo lista automáticamente
      if (state.filtroEstado !== 'activos') {
        state.vistaActual = 'lista';
      }
      actualizarBotonesFiltro();
      renderizarVista();
    });
  });

  function actualizarBotonesFiltro() {
    document.querySelectorAll('[data-filtro]').forEach(b => b.classList.remove('filtro-activo'));
    const btnActivo = document.querySelector(`[data-filtro="${state.filtroEstado}"]`);
    if (btnActivo) btnActivo.classList.add('filtro-activo');
  }

  // Tecla Escape para cerrar modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrarModal();
  });
}

// ─── Notificaciones y UI helpers ───────────────────────────────────────────
function mostrarNotificacionNuevoPedido(pedido) {
  window.electronAPI.notify(
    '🍔 Nuevo pedido!',
    `${pedido.cliente_nombre} — $${parseFloat(pedido.total || 0).toLocaleString('es-AR')}`
  );

  // También mostrar toast en la UI
  mostrarToast(`🆕 Nuevo pedido de ${pedido.cliente_nombre}`, 'info');
}

function mostrarToast(mensaje, tipo = 'info') {
  const container = document.getElementById('toast-container') || crearToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${tipo}`;
  toast.textContent = mensaje;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add('visible'), 10);
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function crearToastContainer() {
  const div = document.createElement('div');
  div.id = 'toast-container';
  document.body.appendChild(div);
  return div;
}

function actualizarContadores() {
  const contadores = {
    nuevo: state.pedidos.filter(p => p.estado === 'nuevo').length,
    en_preparacion: state.pedidos.filter(p => p.estado === 'en_preparacion').length,
    listo: state.pedidos.filter(p => p.estado === 'listo').length,
  };

  const badge = document.getElementById('badge-nuevos');
  if (badge) badge.textContent = contadores.nuevo || '';

  document.title = contadores.nuevo > 0
    ? `(${contadores.nuevo}) 🍔 Burger Orders`
    : '🍔 Burger Orders';
}

function mostrarLoading(show) {
  const el = document.getElementById('loading');
  if (el) el.style.display = show ? 'flex' : 'none';
}

function mostrarError(msg) {
  const el = document.getElementById('error-msg');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function tiempoRelativo(fechaStr) {
  if (!fechaStr) return '';
  const fecha = new Date(fechaStr);
  const diff = Math.floor((Date.now() - fecha.getTime()) / 1000);
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return fecha.toLocaleDateString('es-AR');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
}

// Exponer funciones necesarias para los onclick del HTML
window.abrirModal = abrirModal;
window.cerrarModal = cerrarModal;
