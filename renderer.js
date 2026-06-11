// src/renderer/renderer.js
// ─────────────────────────────────────────────────────────────────────────────
// RENDERER PROCESS — Lógica de la interfaz de usuario
// HTML/CSS/JS puro: sin frameworks, sin bundlers.
// Accede al backend ÚNICAMENTE a través de window.electronAPI (Context Bridge)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Estado de la aplicación ──────────────────────────────────────────────
const state = {
  pedidos: [],
  archivados: [], // Para poder abrirlos desde el modal
  historialVentas: [], // Copia del historial de ventas para filtrar
  lastCheck: null,
  pollingInterval: null,
  vistaActual: 'kanban',
  filtroEstado: 'activos',
  pedidoSeleccionado: null,
  isEditMode: false,
  isCreateMode: false,
  tiendaAbierta: false,
};

// ─── Constantes ────────────────────────────────────────────────────────────
const POLLING_MS = 3000; // Intervalo de polling en ms (3 segundos)

const ESTADOS = {
  nuevo: { label: 'Nuevo', color: '#e74c3c', emoji: '🆕' },
  esperando: { label: 'En Preparacion', color: '#f39c12', emoji: '⏳' },
  en_preparacion: { label: 'En Preparacion', color: '#f39c12', emoji: '⏳' },
  listo: { label: 'Listo', color: '#27ae60', emoji: '✅' },
  entregado: { label: 'Entregado', color: '#3498db', emoji: '✔✔' },
  cancelado: { label: 'Cancelado', color: '#7f8c8d', emoji: '❌' },
  desperdicio: { label: 'Desperdicio', color: '#1a1a1a', emoji: '🗑️' },
};

const COLUMNAS_KANBAN = ['nuevo', 'esperando', 'listo'];

// ID del pedido que se está arrastrando
let draggedPedidoId = null;

// ─── Inicialización ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Renderer] App inicializada');
  await cargarPedidosIniciales();
  await inicializarEstadoTienda();
  iniciarPolling();
  setupEventListeners();
  setupTiendaListeners();
  setupWhatsAppListeners();

  // Escuchar nuevos pedidos en tiempo real vía IPC (enviados desde Express / n8n)
  window.electronAPI.on('pedidos:nuevo', (data) => {
    console.log('[Renderer] Recibido evento IPC pedidos:nuevo:', data);
    const { pedido, flag_alerta } = data;

    // Evitar duplicados debido al polling periódico
    const existe = state.pedidos.find(p => p.id === pedido.id || p.numero_pedido === pedido.numero_pedido);
    if (!existe) {
      // Forzar que el campo de flag_alerta se guarde en formato de base de datos (0/1)
      pedido.flag_alerta = flag_alerta ? 1 : 0;
      
      // Añadir al inicio de los pedidos locales
      state.pedidos.unshift(pedido);

      // Disparar notificaciones y toast
      mostrarNotificacionNuevoPedido(pedido);

      if (flag_alerta) {
        mostrarToast('⚠️ Advertencia: Requiere revisión de comprobante de pago/transferencia.', 'warning');
      }

      // Volver a renderizar la vista activa para pintar el nuevo pedido al instante
      renderizarVista();
    }
  });
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
  // Los pedidos activos excluyen archivados y solo muestran los del flujo principal
  const pedidosFiltrados = filtrarPedidos(state.pedidos);

  const vistaKanban = document.getElementById('vista-kanban');
  const vistaLista = document.getElementById('vista-lista');
  const vistaInventario = document.getElementById('vista-inventario');
  const vistaHistorial = document.getElementById('vista-historial');
  const headerFilters = document.getElementById('header-filters');
  const fab = document.getElementById('btn-fab-crear');

  // Ocultar todo primero
  if (vistaKanban) vistaKanban.style.display = 'none';
  if (vistaLista) vistaLista.style.display = 'none';
  if (vistaInventario) vistaInventario.style.display = 'none';
  if (vistaHistorial) vistaHistorial.style.display = 'none';
  if (headerFilters) headerFilters.style.display = 'none';
  if (fab) fab.style.display = 'flex';

  if (state.vistaActual === 'kanban') {
    if (vistaKanban) vistaKanban.style.display = 'grid';
    renderizarKanban(pedidosFiltrados);
  } else if (state.vistaActual === 'lista') {
    if (vistaLista) vistaLista.style.display = 'block';
    if (headerFilters) headerFilters.style.display = 'flex';
    renderizarLista(pedidosFiltrados);
  } else if (state.vistaActual === 'inventario') {
    if (vistaInventario) vistaInventario.style.display = 'block';
    if (fab) fab.style.display = 'none';
    renderizarInventario();
  } else if (state.vistaActual === 'historial') {
    if (vistaHistorial) vistaHistorial.style.display = 'flex';
    if (fab) fab.style.display = 'none';
    cargarHistorial();
  }

  actualizarContadores();
  mostrarStatsFooter();
}

function renderizarLista(pedidos) {
  const container = document.getElementById('lista-pedidos');
  if (!container) return;
  if (pedidos.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay pedidos para esta vista</div>';
    return;
  }
  container.innerHTML = pedidos.map(p => crearListaRowHTML(p)).join('');
}

function mostrarStatsFooter() {
  const footer = document.getElementById('stats-footer');
  if (!footer) return;
  if (state.vistaActual !== 'lista' || state.filtroEstado !== 'entregado') {
    footer.innerHTML = '';
    footer.style.display = 'none';
    return;
  }
  const entregadosHoy = state.pedidos.filter(p => 
    !p.archivado && p.estado === 'entregado'
  );
  const totalDinero = entregadosHoy.reduce((acc, p) => acc + (parseFloat(p.total) || 0), 0);
  const desperdiciosHoy = state.pedidos.filter(p =>
    !p.archivado && p.estado === 'desperdicio'
  );
  footer.style.display = 'flex';
  footer.className = 'stats-footer';
  footer.innerHTML = `
    <div class="stats-item">Pedidos Entregados (Hoy): <strong>${entregadosHoy.length}</strong></div>
    <div class="stats-item">Total Recaudado (Hoy): <strong>$${totalDinero.toLocaleString('es-AR')}</strong></div>
    <div class="stats-item" style="color: #a0a0b8;">Desperdicio: <strong style="color: #a0a0b8;">${desperdiciosHoy.length} Pedidos</strong></div>
  `;
}

function filtrarPedidos(pedidos) {
  // Siempre excluir pedidos archivados del flujo diario
  const activos = pedidos.filter(p => !p.archivado);

  if (state.filtroEstado === 'activos') {
    return activos.filter(p => ['nuevo', 'esperando', 'en_preparacion', 'listo'].includes(p.estado));
  }
  if (state.filtroEstado === 'todos') return activos;
  if (state.filtroEstado === 'entregado') {
    return activos.filter(p => p.estado === 'entregado');
  }
  return activos.filter(p => p.estado === state.filtroEstado || (state.filtroEstado === 'esperando' && p.estado === 'en_preparacion'));
}

// ─── Kanban ────────────────────────────────────────────────────────────────
function renderizarKanban(pedidos) {
  COLUMNAS_KANBAN.forEach(estado => {
    const columna = document.getElementById(`col-${estado}`);
    if (!columna) return;

    const pedidosColumna = pedidos.filter(p => p.estado === estado || (estado === 'esperando' && p.estado === 'en_preparacion'));
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

  // Botones de acción rápida — desperdicio
  document.querySelectorAll('.quick-btn-desperdicio').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      const pedido = state.pedidos.find(p => p.id === id);
      if (!pedido) return;
      const confirmar = confirm(`¿Marcar el pedido ${pedido.numero_pedido || '#' + pedido.id} de ${pedido.cliente_nombre} como Desperdicio?`);
      if (!confirmar) return;
      await cambiarEstado(id, 'desperdicio');
      mostrarToast('🗑️ Pedido marcado como desperdicio', 'warning');
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

  // Botones de acción rápida — entregar
  document.querySelectorAll('.quick-btn-entregar').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      await cambiarEstado(id, 'entregado');
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

  lista.innerHTML = pedidos.map(p => {
    const isAlerta = p.flag_alerta === 1 || p.flag_alerta === true;
    const alertaClase = isAlerta ? 'alerta-transferencia-row' : '';
    const alertaBadge = isAlerta ? `<span class="badge-alerta-chico" title="Requiere revisión de transferencia">⚠️</span>` : '';

    return `
      <div class="lista-row ${alertaClase}" data-id="${p.id}">
        <span class="lista-numero">${p.numero_pedido || '#' + p.id}${alertaBadge}</span>
        <span class="lista-cliente">${escapeHtml(p.cliente_nombre)}</span>
        <span class="lista-estado estado-${p.estado}">${ESTADOS[p.estado]?.emoji} ${ESTADOS[p.estado]?.label || p.estado}</span>
        <span class="lista-total">$${parseFloat(p.total || 0).toLocaleString('es-AR')}</span>
        <span class="lista-tiempo">${tiempoRelativo(p.created_at)}</span>
      </div>
    `;
  }).join('');

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

  let chipsHtml = '';
  if (Array.isArray(productos)) {
    const todasLasOpciones = [];
    productos.forEach(p => {
      if (p.personalizacion && p.personalizacion.opciones) {
        p.personalizacion.opciones.forEach(opt => {
          todasLasOpciones.push(opt.nombre);
        });
      }
    });
    if (todasLasOpciones.length > 0) {
      chipsHtml = `
        <div class="prod-extras-row" style="margin-top: 6px; padding: 0 0 6px 0;">
          ${todasLasOpciones.map(nombre => `<span class="prod-extras-tag">✓ ${escapeHtml(nombre)}</span>`).join('')}
        </div>
      `;
    }
  }

  const alertaClase = (pedido.flag_alerta === 1 || pedido.flag_alerta === true) ? 'alerta-transferencia' : '';
  const alertaBadge = (pedido.flag_alerta === 1 || pedido.flag_alerta === true) 
    ? `<span class="badge-alerta" title="El precio pagado por el cliente no coincide. Requiere revisión.">⚠️ Revisar Pago</span>` 
    : '';

  return `
    <div class="pedido-card ${alertaClase}" data-id="${pedido.id}">
      <div class="card-header">
        <span class="card-numero">${pedido.numero_pedido || '#' + pedido.id}${alertaBadge}</span>
        <span class="card-tiempo">${tiempoRelativo(pedido.created_at)}</span>
      </div>
      <div class="card-cliente">👤 ${escapeHtml(pedido.cliente_nombre)}</div>
      <div class="card-productos">${escapeHtml(resumenProductos)}</div>
      ${chipsHtml}
      <div class="card-footer">
        <span class="card-total">$${parseFloat(pedido.total || 0).toLocaleString('es-AR')}</span>
        <span class="card-pago">${pedido.metodo_pago || 'efectivo'}</span>
      </div>
      ${pedido.notas ? `<div class="card-nota">📝 ${escapeHtml(pedido.notas)}</div>` : ''}
      <div class="card-quick-actions">
        <button class="quick-btn quick-btn-cancel" data-id="${pedido.id}" title="Cancelar pedido">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        ${['nuevo', 'esperando', 'listo'].includes(pedido.estado) ? `
          <button class="quick-btn quick-btn-desperdicio" data-id="${pedido.id}" title="Marcar como Desperdicio">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        ` : ''}
        <button class="quick-btn quick-btn-prep" data-id="${pedido.id}" title="Pasar a En Preparación">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button class="quick-btn quick-btn-listo" data-id="${pedido.id}" title="Marcar como Listo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        ${pedido.estado === 'listo' ? `
          <button class="quick-btn quick-btn-entregar" data-id="${pedido.id}" title="Marcar como Entregado">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="7 12 12 17 22 7"></polyline>
              <polyline points="2 12 7 17 12 12"></polyline>
            </svg>
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

// ─── Modal de pedido ───────────────────────────────────────────────────────
async function abrirModal(id) {
  let pedido = state.pedidos.find(p => p.id === id);
  if (!pedido && state.archivados) {
    pedido = state.archivados.find(p => p.id === id);
  }
  // Si no está en memoria, lo cargamos directamente del backend
  if (!pedido) {
    const res = await window.electronAPI.getPedidoById(id);
    if (res && res.ok && res.data) {
      pedido = res.data;
    }
  }
  if (!pedido) return;

  // Siempre refresca productos para evitar datos desactualizados
  const res = await window.electronAPI.getProductos();
  if (res.ok) inventarioState.productos = res.data;

  state.pedidoSeleccionado = pedido;
  state.isEditMode = false;
  state.isCreateMode = false;

  renderizarModalContenido();

  const modal = document.getElementById('modal-pedido');
  modal.classList.add('visible');
}

async function abrirModalCrear() {
  // Siempre refresca productos para evitar datos desactualizados
  const res = await window.electronAPI.getProductos();
  if (res.ok) inventarioState.productos = res.data;

  state.pedidoSeleccionado = {
    cliente_nombre: '',
    cliente_tel: '',
    direccion: '',
    metodo_pago: 'efectivo',
    notas: '',
    total: 0,
    productos: '[]'
  };
  state.isEditMode = true;
  state.isCreateMode = true;

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

  // Si está archivado, cancelado, entregado o desperdicio, es SIEMPRE solo lectura
  const esArchivado = !!pedido.archivado;
  const esCancelado = pedido.estado === 'cancelado';
  const esEntregado = pedido.estado === 'entregado';
  const esDesperdicio = pedido.estado === 'desperdicio';
  const soloLectura = esCancelado || esArchivado || esEntregado || esDesperdicio;

  // Ajustar visibilidad de botones según estado y modo
  const btnEditar = document.getElementById('btn-editar-pedido');
  const btnGuardar = document.getElementById('btn-guardar-pedido');
  const btnImprimir = document.getElementById('btn-imprimir');
  const btnCancelar = document.getElementById('btn-cancelar-pedido');
  const btnDesperdicio = document.getElementById('btn-desperdicio-pedido');
  
  if (btnEditar) btnEditar.style.display = (isEdit || soloLectura || state.isCreateMode) ? 'none' : 'inline-flex';
  if (btnGuardar) btnGuardar.style.display = isEdit ? 'inline-flex' : 'none';
  if (btnImprimir) btnImprimir.style.display = (isEdit || soloLectura || state.isCreateMode) ? 'none' : 'inline-flex';
  if (btnCancelar) btnCancelar.style.display = (soloLectura || state.isCreateMode) ? 'none' : 'inline-flex';
  if (btnDesperdicio) btnDesperdicio.style.display = (soloLectura || state.isCreateMode) ? 'none' : 'inline-flex';

  const modalHeader = modal.querySelector('.modal-header h2');
  if (state.isCreateMode) {
    modalHeader.textContent = 'Nuevo Pedido Manual';
  } else if (state.isEditMode) {
    modalHeader.textContent = 'Editar Pedido';
  } else {
    modalHeader.textContent = 'Detalle del Pedido';
  }

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
          ${soloLectura
        ? `<span class="lista-estado estado-${pedido.estado}">${ESTADOS[pedido.estado]?.emoji || ''} ${ESTADOS[pedido.estado]?.label || pedido.estado}</span>`
        : `<select id="modal-estado" class="estado-select">
            <option value="nuevo"     ${pedido.estado === 'nuevo' ? 'selected' : ''}>🆕 Nuevo</option>
            <option value="esperando" ${pedido.estado === 'esperando' || pedido.estado === 'en_preparacion' ? 'selected' : ''}>⏳ En Preparacion</option>
            <option value="listo"     ${pedido.estado === 'listo' ? 'selected' : ''}>✅ Listo</option>
            <option value="entregado" ${pedido.estado === 'entregado' ? 'selected' : ''}>📦 Entregado</option>
            <option value="desperdicio" ${pedido.estado === 'desperdicio' ? 'selected' : ''} style="color:#1a1a1a;font-weight:600;">🗑️ Desperdicio</option>
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
        <div>
          <label>Envío</label>
          <strong>${pedido.tipo_envio || 'Retiro Local'}</strong>
          ${pedido.tipo_envio === 'Delivery' && pedido.costo_envio ? `<span class="tel">+$${pedido.costo_envio}</span>` : ''}
        </div>
        <div>
          <label>Dpto / Piso</label>
          <strong>${pedido.departamento ? escapeHtml(pedido.departamento) : 'No'}</strong>
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
          ${p.personalizacion && p.personalizacion.opciones && p.personalizacion.opciones.length > 0
            ? `<div class="prod-extras-row" style="padding-left: 38px; margin-top: 2px;">
                ${p.personalizacion.opciones.map(opt => `<span class="prod-extras-tag">✓ ${escapeHtml(opt.nombre)}</span>`).join('')}
               </div>`
            : ''
          }
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
        Recibido: ${parseSQLiteDate(pedido.created_at).toLocaleString('es-AR')}
      </div>
    `;

    if (!soloLectura) {
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
          <label>Dpto / Piso</label>
          <div style="display:flex; gap:5px; margin-top:5px;">
            <select id="edit-tiene-dpto" class="edit-input" style="width:70px;">
              <option value="No" ${!pedido.departamento ? 'selected' : ''}>No</option>
              <option value="Si" ${pedido.departamento ? 'selected' : ''}>Sí</option>
            </select>
            <input type="text" id="edit-departamento" class="edit-input" style="display: ${pedido.departamento ? 'block' : 'none'}; flex:1;" placeholder="Ej: 3B" value="${escapeHtml(pedido.departamento || '')}">
          </div>
        </div>
        <div>
          <label>Tipo de Envío</label>
          <select id="edit-tipo-envio" class="edit-input">
            <option value="Retiro Local" ${pedido.tipo_envio === 'Retiro Local' || !pedido.tipo_envio ? 'selected' : ''}>Retiro Local</option>
            <option value="Delivery" ${pedido.tipo_envio === 'Delivery' ? 'selected' : ''}>Delivery</option>
          </select>
          <input type="number" id="edit-costo-envio" class="edit-input" style="margin-top:5px; display: ${pedido.tipo_envio === 'Delivery' ? 'block' : 'none'}" placeholder="Costo de envío ($)" value="${pedido.costo_envio || ''}">
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

    const tipoEnvioSelect = document.getElementById('edit-tipo-envio');
    const costoEnvioInput = document.getElementById('edit-costo-envio');
    tipoEnvioSelect.addEventListener('change', () => {
      costoEnvioInput.style.display = tipoEnvioSelect.value === 'Delivery' ? 'block' : 'none';
      if (tipoEnvioSelect.value !== 'Delivery') {
        costoEnvioInput.value = '';
      }
      recalcularTotal();
    });
    costoEnvioInput.addEventListener('input', recalcularTotal);

    const tieneDptoSelect = document.getElementById('edit-tiene-dpto');
    const dptoInput = document.getElementById('edit-departamento');
    tieneDptoSelect.addEventListener('change', () => {
      dptoInput.style.display = tieneDptoSelect.value === 'Si' ? 'block' : 'none';
      if (tieneDptoSelect.value !== 'Si') {
        dptoInput.value = '';
      }
    });

    bindProductEvents();
  }
}

function generarFilaProducto(p, idx) {
  let nameInput = '';

  if (inventarioState.productos.length > 0) {
    const options = inventarioState.productos.map(prod =>
      `<option value="${prod.id}" data-precio="${prod.precio}" ${p.producto_id == prod.id ? 'selected' : ''}>${escapeHtml(prod.nombre)} - $${prod.precio}</option>`
    ).join('');

    nameInput = `
      <select class="edit-input prod-edit-select" style="flex:1;">
        <option value="">Seleccione un producto...</option>
        ${options}
      </select>
    `;
  } else {
    nameInput = `<input type="text" class="edit-input prod-edit-nombre" value="${escapeHtml(p.nombre || p.name || '')}" placeholder="Nombre del producto">`;
  }

  const persAttr = p.personalizacion ? `data-personalizacion="${escapeHtml(JSON.stringify(p.personalizacion))}"` : '';

  let chipsHtml = '';
  if (p.personalizacion && p.personalizacion.opciones && p.personalizacion.opciones.length > 0) {
    chipsHtml = `
      <div class="prod-extras-row" style="grid-column: 1 / -1; margin-left: 68px; display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0 0 0;">
        ${p.personalizacion.opciones.map(opt => `<span class="prod-extras-tag">✓ ${escapeHtml(opt.nombre)}</span>`).join('')}
      </div>
    `;
  }

  return `
    <div class="edit-producto-row" data-idx="${idx}" ${persAttr}>
      <input type="number" class="edit-input prod-edit-cant" value="${p.cantidad || p.quantity || 1}" min="1" placeholder="Cant" style="width: 70px;">
      ${nameInput}
      <input type="number" class="edit-input prod-edit-precio" value="${p.precio || p.price || 0}" min="0" step="0.01" placeholder="Precio U." style="width: 100px;">
      <button class="btn-icon btn-personalizar-prod" title="Personalizar Combo" style="display:none; font-size: 14px; margin-left: 4px;">⚙️</button>
      <button class="btn-icon btn-remove-prod" title="Quitar" style="margin-left: 4px;">✕</button>
      ${chipsHtml}
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

  // Mostrar el botón ⚙️ en las filas que ya cargan un combo
  document.querySelectorAll('.edit-producto-row').forEach(async row => {
    const select = row.querySelector('.prod-edit-select');
    const btnPers = row.querySelector('.btn-personalizar-prod');
    if (select && select.value && btnPers) {
      const productoId = parseInt(select.value);
      const res = await window.electronAPI.getDetallePersonalizacion(productoId);
      if (res.ok && res.data && res.data.grupos && res.data.grupos.length > 0) {
        btnPers.style.display = 'inline-block';
      } else {
        btnPers.style.display = 'none';
      }
    }
  });

  // Cambios de selección de producto
  document.querySelectorAll('.prod-edit-select').forEach(select => {
    select.onchange = async (e) => {
      const option = e.target.options[e.target.selectedIndex];
      const row = e.target.closest('.edit-producto-row');
      const inputPrecio = row.querySelector('.prod-edit-precio');
      const btnPers = row.querySelector('.btn-personalizar-prod');
      
      const productoId = parseInt(select.value);
      if (productoId) {
        if (option && option.dataset.precio) {
          inputPrecio.value = option.dataset.precio;
        }
        
        // Consultar si es combo (tiene grupos de opciones)
        const res = await window.electronAPI.getDetallePersonalizacion(productoId);
        if (res.ok && res.data && res.data.grupos && res.data.grupos.length > 0) {
          if (btnPers) btnPers.style.display = 'inline-block';
          // Abrir popup automáticamente al elegirlo por primera vez
          abrirModalPersonalizacion(row, res.data);
        } else {
          if (btnPers) btnPers.style.display = 'none';
          row.removeAttribute('data-personalizacion');
          row.querySelector('.prod-extras-row')?.remove();
        }
      } else {
        if (btnPers) btnPers.style.display = 'none';
        row.removeAttribute('data-personalizacion');
        row.querySelector('.prod-extras-row')?.remove();
      }
      recalcularTotal();
    };
  });

  // Click en el botón de personalización (⚙️)
  document.querySelectorAll('.btn-personalizar-prod').forEach(btn => {
    btn.onclick = async (e) => {
      const row = e.target.closest('.edit-producto-row');
      const select = row.querySelector('.prod-edit-select');
      const productoId = parseInt(select.value);
      if (productoId) {
        const res = await window.electronAPI.getDetallePersonalizacion(productoId);
        if (res.ok && res.data) {
          abrirModalPersonalizacion(row, res.data);
        }
      }
    };
  });
}

let tempPersRow = null;

async function abrirModalPersonalizacion(row, cachedData = null) {
  const select = row.querySelector('.prod-edit-select');
  const productoId = parseInt(select.value);
  if (!productoId) return;

  tempPersRow = row;

  let productDetails = cachedData;
  if (!productDetails) {
    const res = await window.electronAPI.getDetallePersonalizacion(productoId);
    if (res.ok && res.data) {
      productDetails = res.data;
    }
  }

  if (!productDetails || !productDetails.grupos || productDetails.grupos.length === 0) return;

  // 1. Configurar encabezados
  document.getElementById('pers-producto-nombre').textContent = productDetails.nombre;
  const basePrice = parseFloat(productDetails.precio) || 0;
  document.getElementById('pers-producto-descripcion').textContent = `Precio base: $${basePrice.toLocaleString('es-AR')}`;

  // 2. Obtener IDs seleccionados previamente en esta fila
  const selectedIds = [];
  if (row.dataset.personalizacion) {
    try {
      const pers = JSON.parse(row.dataset.personalizacion);
      if (pers && pers.opciones) {
        pers.opciones.forEach(opt => selectedIds.push(opt.id));
      }
    } catch (e) {
      console.error("Error al parsear personalización guardada:", e);
    }
  }

  // 3. Renderizar los grupos de opciones
  const container = document.getElementById('pers-grupos-container');
  container.innerHTML = productDetails.grupos.map(g => {
    const isRequired = g.min_seleccion > 0;
    const badgeText = isRequired ? 'Obligatorio' : 'Opcional';
    const isSingleSelect = g.max_seleccion === 1;

    return `
      <div class="pers-grupo-box" data-id="${g.id}" data-min="${g.min_seleccion}" data-max="${g.max_seleccion}" data-nombre="${escapeHtml(g.nombre)}">
        <div class="pers-grupo-header">
          <h3>${escapeHtml(g.nombre)}</h3>
          <span class="pers-grupo-badge">${badgeText}</span>
        </div>
        <div class="pers-opciones-list">
          ${g.opciones.map(o => {
            const isSelected = selectedIds.includes(o.id);
            const inputType = isSingleSelect ? 'radio' : 'checkbox';
            const inputName = isSingleSelect ? `pers_grupo_${g.id}` : `pers_opc_${o.id}`;

            return `
              <div class="pers-opcion-item ${isSelected ? 'selected' : ''}" data-id="${o.id}" data-precio-extra="${o.precio_extra}" data-nombre="${escapeHtml(o.nombre)}">
                <input type="${inputType}" name="${inputName}" value="${o.id}" ${isSelected ? 'checked' : ''} style="cursor:pointer;">
                ${!isSingleSelect ? '<span class="pers-opcion-check">✓</span>' : ''}
                <span class="pers-opcion-nombre">${escapeHtml(o.nombre)}</span>
                <span class="pers-opcion-precio ${o.precio_extra === 0 ? 'zero' : ''}">
                  ${o.precio_extra > 0 ? '+$' + o.precio_extra.toLocaleString('es-AR') : 'Sin cargo'}
                </span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');

  // 4. Agregar listeners de click en las opciones
  container.querySelectorAll('.pers-opcion-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Evitar que el clic en el propio input dispare doble evento
      if (e.target.tagName === 'INPUT') return;
      
      const input = item.querySelector('input');
      const box = item.closest('.pers-grupo-box');
      const isSingleSelect = parseInt(box.dataset.max) === 1;

      if (isSingleSelect) {
        // Desmarcar todos los demás en el grupo
        box.querySelectorAll('.pers-opcion-item').forEach(other => {
          other.classList.remove('selected');
          other.querySelector('input').checked = false;
        });
        item.classList.add('selected');
        input.checked = true;
      } else {
        // Toggle para selección múltiple
        const isChecked = !input.checked;
        input.checked = isChecked;
        item.classList.toggle('selected', isChecked);
      }

      actualizarTotalPersonalizacion(basePrice);
    });

    // Event listener en caso de hacer click directo en el input
    item.querySelector('input').addEventListener('change', () => {
      const box = item.closest('.pers-grupo-box');
      const isSingleSelect = parseInt(box.dataset.max) === 1;

      if (isSingleSelect) {
        box.querySelectorAll('.pers-opcion-item').forEach(other => {
          other.classList.toggle('selected', other.querySelector('input').checked);
        });
      } else {
        item.classList.toggle('selected', item.querySelector('input').checked);
      }

      actualizarTotalPersonalizacion(basePrice);
    });
  });

  // 5. Configurar selector de cantidad
  const cantInput = row.querySelector('.prod-edit-cant');
  const qtyVal = document.getElementById('pers-qty-value');
  qtyVal.textContent = cantInput ? (cantInput.value || 1) : 1;

  // 6. Configurar total
  actualizarTotalPersonalizacion(basePrice);

  // 7. Mostrar modal
  document.getElementById('modal-personalizacion').classList.add('visible');
}

function actualizarTotalPersonalizacion(basePrice) {
  let extra = 0;
  document.querySelectorAll('.pers-opcion-item.selected').forEach(item => {
    extra += parseFloat(item.dataset.precioExtra) || 0;
  });
  
  const cant = parseInt(document.getElementById('pers-qty-value').textContent) || 1;
  const unitPrice = basePrice + extra;
  const total = unitPrice * cant;

  document.getElementById('pers-total-display').textContent = `$ ${total.toLocaleString('es-AR')}`;
  
  // Guardar datos calculados en el dataset del modal
  const modal = document.getElementById('modal-personalizacion');
  modal.dataset.unitPrice = unitPrice;
  modal.dataset.basePrice = basePrice;
}

async function recalcularTotal() {
  let total = 0;
  const productosSeleccionados = [];

  document.querySelectorAll('.edit-producto-row').forEach(row => {
    const cant = parseFloat(row.querySelector('.prod-edit-cant').value) || 0;
    const precio = parseFloat(row.querySelector('.prod-edit-precio').value) || 0;
    total += cant * precio;

    const select = row.querySelector('.prod-edit-select');
    if (select && select.value) {
      productosSeleccionados.push({ producto_id: parseInt(select.value), cantidad: cant });
    }
  });

  const costoEnvioInput = document.getElementById('edit-costo-envio');
  if (costoEnvioInput && costoEnvioInput.style.display !== 'none') {
    total += parseFloat(costoEnvioInput.value) || 0;
  }

  document.getElementById('edit-total').value = total;

  if (productosSeleccionados.length > 0) {
    const pedidoId = (!state.isCreateMode && state.pedidoSeleccionado) ? state.pedidoSeleccionado.id : null;
    const res = await window.electronAPI.checkStock({ productos: productosSeleccionados, pedidoId });
    const btnGuardar = document.getElementById('btn-guardar-pedido');
    const errorMsg = document.getElementById('error-msg');

    if (res.ok && !res.enough) {
      btnGuardar.disabled = true;
      btnGuardar.innerHTML = '❌';
      mostrarError('Stock insuficiente: ' + res.errors.join(' | '));
    } else {
      btnGuardar.disabled = false;
      btnGuardar.innerHTML = '💾';
      if (errorMsg && errorMsg.style.display === 'block') errorMsg.style.display = 'none';
    }
  }
}

function cerrarModal() {
  const modal = document.getElementById('modal-pedido');
  modal.classList.remove('visible');
  state.pedidoSeleccionado = null;
  state.isEditMode = false;
  state.isCreateMode = false;
  
  // Limpiar el DOM para evitar que queden event listeners colgados o estados corruptos
  const contenido = modal.querySelector('.modal-body');
  if (contenido) contenido.innerHTML = '';
}

// ─── Acciones desde el modal ───────────────────────────────────────────────
async function guardarPedidoEditado() {
  const btn = document.getElementById('btn-guardar-pedido');
  btn.disabled = true;
  btn.innerHTML = '⏳';

  // Recopilar datos
  const productos = [];
  document.querySelectorAll('.edit-producto-row').forEach(row => {
    const isCreate = state.isCreateMode;
    let nombre = '';
    let producto_id = null;

    const select = row.querySelector('.prod-edit-select');
    if (select) {
      const option = select.options[select.selectedIndex];
      nombre = option ? option.text.split(' - $')[0] : '';
      producto_id = parseInt(select.value) || null;
    } else {
      const inputNombre = row.querySelector('.prod-edit-nombre');
      nombre = inputNombre ? inputNombre.value : '';
    }

    const personalizacionStr = row.dataset.personalizacion;
    let personalizacion = null;
    if (personalizacionStr) {
      try { personalizacion = JSON.parse(personalizacionStr); } catch(e) {}
    }

    productos.push({
      producto_id,
      nombre: nombre,
      cantidad: parseFloat(row.querySelector('.prod-edit-cant').value) || 1,
      precio: parseFloat(row.querySelector('.prod-edit-precio').value) || 0,
      personalizacion: personalizacion
    });
  });

  const pedidoModificado = {
    cliente_nombre: document.getElementById('edit-nombre').value,
    cliente_tel: document.getElementById('edit-tel').value,
    direccion: document.getElementById('edit-direccion').value,
    metodo_pago: document.getElementById('edit-pago').value,
    notas: document.getElementById('edit-notas').value,
    total: parseFloat(document.getElementById('edit-total').value) || 0,
    productos: JSON.stringify(productos),
    tipo_envio: document.getElementById('edit-tipo-envio').value,
    costo_envio: parseFloat(document.getElementById('edit-costo-envio').value) || 0,
    departamento: document.getElementById('edit-tiene-dpto').value === 'Si' ? document.getElementById('edit-departamento').value : ''
  };

  let result;
  if (state.isCreateMode) {
    result = await window.electronAPI.createPedido(pedidoModificado);
  } else {
    pedidoModificado.id = state.pedidoSeleccionado.id;
    result = await window.electronAPI.updatePedido(pedidoModificado);
  }

  btn.disabled = false;
  btn.innerHTML = '💾';

  if (result.ok) {
    mostrarToast(state.isCreateMode ? '✅ Pedido creado' : '✅ Pedido actualizado', 'success');
    if (state.isCreateMode) {
      cerrarModal();
      // Opcional: recargar todos los pedidos para asegurar consistencia
      cargarPedidosIniciales();
    } else {
      // Actualizar localmente
      const idx = state.pedidos.findIndex(p => p.id === pedidoModificado.id);
      if (idx !== -1) {
        state.pedidos[idx] = { ...state.pedidos[idx], ...pedidoModificado };
      }
      state.pedidoSeleccionado = state.pedidos[idx];
      state.isEditMode = false;
      renderizarVista();
      renderizarModalContenido();
    }
  } else {
    mostrarToast('❌ Error: ' + result.error, 'error');
  }
}

async function imprimirPedido() {
  const pedido = state.pedidoSeleccionado;
  if (!pedido) return;

  const btn = document.getElementById('btn-imprimir');
  btn.innerHTML = '⏳';
  btn.disabled = true;

  const result = await window.electronAPI.printPedido(pedido);

  btn.innerHTML = '🖨️';
  btn.disabled = false;

  if (result.ok) {
    mostrarToast('✅ Ticket impreso correctamente', 'success');
    // Auto-avanzar estado si está en "nuevo"
    if (pedido.estado === 'nuevo') {
      await cambiarEstado(pedido.id, 'esperando');
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
    if (pedido) {
      pedido.estado = nuevoEstado;
      if (nuevoEstado === 'listo') {
        pedido.flag_alerta = 0; // Quitar alerta visual
      }
    }
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
  if (!pedido || state.isCreateMode) return; // Prevent cancelling if it's a new unsaved order

  const confirmar = confirm(`¿Cancelar el pedido ${pedido.numero_pedido || '#' + pedido.id} de ${pedido.cliente_nombre}?`);
  if (!confirmar) return;

  try {
    const result = await window.electronAPI.deletePedido(pedido.id);
    if (result.ok) {
      const pedidoLocal = state.pedidos.find(p => p.id === pedido.id);
      if (pedidoLocal) pedidoLocal.estado = 'cancelado';
      
      cerrarModal();
      renderizarVista();
      mostrarToast('❌ Pedido cancelado correctamente', 'warning');
    } else {
      mostrarToast('❌ Error al cancelar: ' + (result.error || 'Error desconocido'), 'error');
    }
  } catch (err) {
    mostrarToast('❌ Error inesperado al cancelar', 'error');
    console.error(err);
    cerrarModal();
    renderizarVista();
  }
}

async function desperdicioPedido() {
  const pedido = state.pedidoSeleccionado;
  if (!pedido || state.isCreateMode) return;

  const confirmar = confirm(`¿Marcar el pedido ${pedido.numero_pedido || '#' + pedido.id} de ${pedido.cliente_nombre} como Desperdicio?`);
  if (!confirmar) return;

  try {
    await cambiarEstado(pedido.id, 'desperdicio');
    cerrarModal();
    mostrarToast('🗑️ Pedido marcado como desperdicio', 'warning');
  } catch (err) {
    mostrarToast('❌ Error inesperado al marcar como desperdicio', 'error');
    console.error(err);
    cerrarModal();
    renderizarVista();
  }
}

// ─── Event Listeners globales ──────────────────────────────────────────────
function setupEventListeners() {
  // Botones del modal
  document.getElementById('btn-imprimir')?.addEventListener('click', imprimirPedido);
  document.getElementById('btn-cancelar-pedido')?.addEventListener('click', cancelarPedido);
  document.getElementById('btn-desperdicio-pedido')?.addEventListener('click', desperdicioPedido);
  document.getElementById('btn-cerrar-modal')?.addEventListener('click', cerrarModal);
  document.getElementById('btn-volver')?.addEventListener('click', cerrarModal);

  document.getElementById('btn-fab-crear')?.addEventListener('click', abrirModalCrear);

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
    actualizarBotonesVista('btn-vista-kanban');
    actualizarBotonesFiltro();
    renderizarVista();
  });

  document.getElementById('btn-vista-lista')?.addEventListener('click', () => {
    state.vistaActual = 'lista';
    state.filtroEstado = 'todos'; // Por defecto todos en lista
    actualizarBotonesVista('btn-vista-lista');
    actualizarBotonesFiltro();
    renderizarVista();
  });

  document.getElementById('btn-vista-inventario')?.addEventListener('click', () => {
    state.vistaActual = 'inventario';
    actualizarBotonesVista('btn-vista-inventario');
    renderizarVista();
  });

  document.getElementById('btn-vista-historial')?.addEventListener('click', () => {
    state.vistaActual = 'historial';
    actualizarBotonesVista('btn-vista-historial');
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

  function actualizarBotonesVista(activeId) {
    document.querySelectorAll('.vista-btn').forEach(btn => btn.classList.remove('vista-activo'));
    document.getElementById(activeId)?.classList.add('vista-activo');
  }

  function actualizarBotonesFiltro() {
    document.querySelectorAll('[data-filtro]').forEach(b => b.classList.remove('filtro-activo'));
    const btnActivo = document.querySelector(`[data-filtro="${state.filtroEstado}"]`);
    if (btnActivo) btnActivo.classList.add('filtro-activo');
  }

  // Tecla Escape para cerrar modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrarModal();
  });

  setupInventarioListeners();

  // Personalización de combos event listeners
  const qtyVal = document.getElementById('pers-qty-value');
  document.getElementById('pers-qty-minus')?.addEventListener('click', () => {
    let cant = parseInt(qtyVal.textContent) || 1;
    if (cant > 1) {
      qtyVal.textContent = cant - 1;
      const basePrice = parseFloat(document.getElementById('modal-personalizacion').dataset.basePrice) || 0;
      actualizarTotalPersonalizacion(basePrice);
    }
  });

  document.getElementById('pers-qty-plus')?.addEventListener('click', () => {
    let cant = parseInt(qtyVal.textContent) || 1;
    qtyVal.textContent = cant + 1;
    const basePrice = parseFloat(document.getElementById('modal-personalizacion').dataset.basePrice) || 0;
    actualizarTotalPersonalizacion(basePrice);
  });

  document.getElementById('btn-cerrar-personalizacion')?.addEventListener('click', () => {
    document.getElementById('modal-personalizacion').classList.remove('visible');
  });

  document.getElementById('modal-personalizacion')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-personalizacion') {
      document.getElementById('modal-personalizacion').classList.remove('visible');
    }
  });

  document.getElementById('btn-guardar-personalizacion')?.addEventListener('click', () => {
    if (!tempPersRow) return;

    // 1. Validar grupos obligatorios
    let hasError = false;
    document.querySelectorAll('.pers-grupo-box').forEach(box => {
      const min = parseInt(box.dataset.min) || 0;
      const selected = box.querySelectorAll('.pers-opcion-item.selected').length;
      
      if (min > 0 && selected < min) {
        box.classList.add('required-missing');
        hasError = true;
      } else {
        box.classList.remove('required-missing');
      }
    });

    if (hasError) {
      return mostrarToast('Por favor, selecciona las opciones obligatorias marcadas en rojo.', 'error');
    }

    // 2. Recopilar opciones seleccionadas
    const opciones = [];
    document.querySelectorAll('.pers-opcion-item.selected').forEach(item => {
      opciones.push({
        id: parseInt(item.dataset.id),
        nombre: item.dataset.nombre,
        precio_extra: parseFloat(item.dataset.precioExtra) || 0
      });
    });

    const personalizacion = { opciones };
    tempPersRow.dataset.personalizacion = JSON.stringify(personalizacion);

    // Renderizar/actualizar los chips debajo de la fila en tiempo real
    let extrasRow = tempPersRow.querySelector('.prod-extras-row');
    if (opciones.length > 0) {
      if (!extrasRow) {
        extrasRow = document.createElement('div');
        extrasRow.className = 'prod-extras-row';
        extrasRow.style.cssText = 'grid-column: 1 / -1; margin-left: 68px; display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0 0 0;';
        tempPersRow.appendChild(extrasRow);
      }
      extrasRow.innerHTML = opciones.map(opt => `<span class="prod-extras-tag">✓ ${escapeHtml(opt.nombre)}</span>`).join('');
    } else if (extrasRow) {
      extrasRow.remove();
    }

    // 3. Actualizar la fila del producto
    const modal = document.getElementById('modal-personalizacion');
    const unitPrice = parseFloat(modal.dataset.unitPrice) || 0;
    const cant = parseInt(document.getElementById('pers-qty-value').textContent) || 1;

    const cantInput = tempPersRow.querySelector('.prod-edit-cant');
    const precioInput = tempPersRow.querySelector('.prod-edit-precio');

    if (cantInput) cantInput.value = cant;
    if (precioInput) precioInput.value = unitPrice;

    // 4. Recalcular total y cerrar modal
    recalcularTotal();
    modal.classList.remove('visible');
    mostrarToast('✅ Combo personalizado y añadido', 'success');
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
    en_preparacion: state.pedidos.filter(p => p.estado === 'en_preparacion' || p.estado === 'esperando').length,
    listo: state.pedidos.filter(p => p.estado === 'listo').length,
    entregado: state.pedidos.filter(p => p.estado === 'entregado').length,
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

function parseSQLiteDate(dateStr) {
  if (!dateStr) return new Date();
  if (dateStr instanceof Date) return dateStr;
  
  // Si ya tiene una T o es ISO, parsear directo
  if (dateStr.includes('T')) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
  }
  
  // Reemplazar espacio por T para asegurar compatibilidad total en todas las plataformas
  const isoStr = dateStr.replace(' ', 'T');
  const d = new Date(isoStr);
  if (!isNaN(d.getTime())) return d;
  
  // Si aún falla, intentar parsear por partes
  try {
    const parts = dateStr.split(/[- :]/);
    if (parts.length >= 3) {
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      const day = parseInt(parts[2]);
      const hour = parseInt(parts[3]) || 0;
      const minute = parseInt(parts[4]) || 0;
      const second = parseInt(parts[5]) || 0;
      const parsedD = new Date(year, month, day, hour, minute, second);
      if (!isNaN(parsedD.getTime())) return parsedD;
    }
  } catch (e) {
    console.error("Error parsing date:", dateStr, e);
  }
  
  return new Date(); // Fallback a fecha actual
}

function tiempoRelativo(fechaStr) {
  if (!fechaStr) return '';
  const fecha = parseSQLiteDate(fechaStr);
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

// --- INVENTARIO LOGIC ------------------------------------------------------

let inventarioState = {
  insumos: [],
  productos: [],
  categorias: [],
  tabActual: 'insumos',
};

function setupInventarioListeners() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-activo'));
      e.target.classList.add('tab-activo');
      
      const tabId = e.target.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('activo'));
      const targetTab = document.getElementById('tab-' + tabId);
      if (targetTab) targetTab.classList.add('activo');
      
      inventarioState.tabActual = tabId;
      renderizarInventario();
    });
  });

  document.getElementById('btn-nuevo-insumo')?.addEventListener('click', () => {
    document.getElementById('insumo-id').value = '';
    document.getElementById('insumo-nombre').value = '';
    document.getElementById('insumo-unidad').value = 'Unidad';
    document.getElementById('insumo-cantidad').value = '0';
    document.getElementById('insumo-alerta').value = '0';
    document.getElementById('insumo-categoria').value = '';
    document.getElementById('modal-insumo-title').textContent = 'Nuevo Insumo';
    document.getElementById('modal-insumo').classList.add('visible');
  });

  document.getElementById('btn-nuevo-producto')?.addEventListener('click', async () => {
    document.getElementById('producto-id').value = '';
    document.getElementById('producto-nombre').value = '';
    document.getElementById('producto-categoria').value = '';
    document.getElementById('producto-precio').value = '0';
    document.getElementById('producto-stock').value = '0';
    
    // Por defecto, maneja stock (así que "NO Maneja Stock" está desmarcado)
    const checkbox = document.getElementById('producto-controla-stock');
    if (checkbox) checkbox.checked = false;
    actualizarVisibilidadStock();

    document.getElementById('modal-producto-title').textContent = 'Nuevo Producto';
    
    // Cargar combos
    await cargarCombosEnProducto(null);

    document.getElementById('modal-producto').classList.add('visible');
  });

  document.getElementById('btn-nueva-categoria')?.addEventListener('click', () => {
    document.getElementById('categoria-id').value = '';
    document.getElementById('categoria-nombre').value = '';
    document.getElementById('categoria-tipo').value = 'general';
    document.getElementById('categoria-color').value = '#4b6584';
    document.getElementById('modal-categoria-title').textContent = 'Nueva Categoría';
    document.getElementById('modal-categoria').classList.add('visible');
  });

  document.getElementById('btn-nueva-receta')?.addEventListener('click', () => abrirModalReceta());

  document.getElementById('btn-guardar-insumo')?.addEventListener('click', guardarInsumo);
  document.getElementById('btn-guardar-producto')?.addEventListener('click', guardarProducto);
  document.getElementById('btn-guardar-categoria')?.addEventListener('click', guardarCategoria);
  document.getElementById('btn-guardar-receta')?.addEventListener('click', guardarReceta);
  
  document.getElementById('producto-controla-stock')?.addEventListener('change', actualizarVisibilidadStock);
  
  document.getElementById('btn-add-insumo-receta')?.addEventListener('click', () => agregarFilaReceta());
  
  document.getElementById('filtro-insumo-categoria')?.addEventListener('change', renderizarInventario);
  document.getElementById('filtro-producto-categoria')?.addEventListener('change', renderizarInventario);
  document.getElementById('filtro-receta-categoria')?.addEventListener('change', renderizarInventario);

  // Cerrar Modales
  document.getElementById('btn-cerrar-modal-insumo')?.addEventListener('click', () => document.getElementById('modal-insumo').classList.remove('visible'));
  document.getElementById('btn-cerrar-modal-producto')?.addEventListener('click', () => document.getElementById('modal-producto').classList.remove('visible'));
  document.getElementById('btn-cerrar-modal-categoria')?.addEventListener('click', () => document.getElementById('modal-categoria').classList.remove('visible'));
  document.getElementById('btn-cerrar-modal-receta')?.addEventListener('click', () => document.getElementById('modal-receta').classList.remove('visible'));

  // Click fuera para cerrar
  ['modal-insumo', 'modal-producto', 'modal-categoria', 'modal-receta'].forEach(modalId => {
    const modal = document.getElementById(modalId);
    if(modal) {
       modal.addEventListener('click', (e) => {
         if (e.target.id === modalId) modal.classList.remove('visible');
       });
    }
  });

  // Delegación de eventos para botones dinámicos
  document.getElementById('lista-insumos')?.addEventListener('click', (e) => {
    const btnEditar = e.target.closest('.btn-editar-insumo');
    const btnEliminar = e.target.closest('.btn-eliminar-insumo');
    if (btnEditar) editarInsumo(parseInt(btnEditar.dataset.id));
    if (btnEliminar) eliminarInsumo(parseInt(btnEliminar.dataset.id));
  });

  document.getElementById('lista-productos')?.addEventListener('click', (e) => {
    const btnEditar = e.target.closest('.btn-editar-producto');
    const btnEliminar = e.target.closest('.btn-eliminar-producto');
    if (btnEditar) editarProducto(parseInt(btnEditar.dataset.id));
    if (btnEliminar) eliminarProducto(parseInt(btnEliminar.dataset.id));
  });

  document.getElementById('lista-recetas-creadas')?.addEventListener('click', (e) => {
    const btnEditar = e.target.closest('.btn-editar-receta');
    const btnEliminar = e.target.closest('.btn-eliminar-receta');
    if (btnEditar) abrirModalReceta(parseInt(btnEditar.dataset.id));
    if (btnEliminar) eliminarReceta(parseInt(btnEliminar.dataset.id));
  });

  document.getElementById('lista-categorias')?.addEventListener('click', (e) => {
    const btnEditar = e.target.closest('.btn-editar-categoria');
    const btnEliminar = e.target.closest('.btn-eliminar-categoria');
    if (btnEditar) editarCategoria(parseInt(btnEditar.dataset.id));
    if (btnEliminar) eliminarCategoria(parseInt(btnEliminar.dataset.id));
  });

  // Delegación de eventos dentro del modal de recetas para botones de quitar
  document.getElementById('receta-items')?.addEventListener('click', (e) => {
    const btnQuitar = e.target.closest('.btn-quitar-fila');
    if (btnQuitar) {
      btnQuitar.closest('.receta-item-row').remove();
    }
  });

  // Listener para el selector de producto en el modal de receta
  document.getElementById('receta-producto-select')?.addEventListener('change', (e) => {
    const productoId = parseInt(e.target.value);
    if (productoId) cargarItemsReceta(productoId);
    else document.getElementById('receta-items').innerHTML = '';
  });

  setInterval(checkAlerts, 10000);
  checkAlerts();

  // ── COMBOS listeners ──
  document.getElementById('btn-nuevo-grupo')?.addEventListener('click', () => abrirModalGrupo());

  document.getElementById('lista-grupos')?.addEventListener('click', async (e) => {
    const btnEditar = e.target.closest('.btn-editar-grupo');
    const btnEliminar = e.target.closest('.btn-eliminar-grupo');
    const item = e.target.closest('.grupo-item');
    if (btnEditar) {
      abrirModalGrupo({
        id: parseInt(btnEditar.dataset.id),
        nombre: btnEditar.dataset.nombre,
        min: parseInt(btnEditar.dataset.min),
        max: parseInt(btnEditar.dataset.max)
      });
    } else if (btnEliminar) {
      await eliminarGrupo(parseInt(btnEliminar.dataset.id));
    } else if (item) {
      await renderizarOpciones(parseInt(item.dataset.id));
    }
  });

  document.getElementById('btn-guardar-grupo')?.addEventListener('click', guardarGrupo);
  document.getElementById('btn-cerrar-modal-grupo')?.addEventListener('click', () =>
    document.getElementById('modal-grupo').classList.remove('visible')
  );
  document.getElementById('modal-grupo')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-grupo') document.getElementById('modal-grupo').classList.remove('visible');
  });

  document.getElementById('btn-guardar-opcion')?.addEventListener('click', guardarOpcion);
  document.getElementById('btn-cerrar-modal-opcion')?.addEventListener('click', () =>
    document.getElementById('modal-opcion').classList.remove('visible')
  );
  document.getElementById('modal-opcion')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-opcion') document.getElementById('modal-opcion').classList.remove('visible');
  });

  document.getElementById('btn-add-insumo-opcion')?.addEventListener('click', () => agregarFilaOpcionReceta());
  document.getElementById('opcion-receta-items')?.addEventListener('click', (e) => {
    const btnQuitar = e.target.closest('.btn-quitar-opcion-fila');
    if (btnQuitar) {
      btnQuitar.closest('.opcion-receta-item-row').remove();
    }
  });
}

async function checkAlerts() {
  const result = await window.electronAPI.checkStockAlerts();
  const btn = document.getElementById('btn-vista-inventario');
  if (result.ok && result.hasAlerts) btn.classList.add('alert-pulse');
  else btn.classList.remove('alert-pulse');
}

async function cargarCategoriasYSelects() {
  const resCat = await window.electronAPI.getCategorias();
  if (resCat.ok) {
    inventarioState.categorias = resCat.data;

    const fillSelect = (id, optionsArray, defaultText) => {
      const el = document.getElementById(id);
      if(!el) return;
      const currentVal = el.value; // Guardar valor actual
      el.innerHTML = '<option value="">' + defaultText + '</option>' + optionsArray.map(c => '<option value="'+c.id+'">'+escapeHtml(c.nombre)+'</option>').join('');
      if (currentVal && Array.from(el.options).some(o => o.value === currentVal)) {
        el.value = currentVal; // Restaurar si aún existe
      }
    };

    fillSelect('producto-categoria', inventarioState.categorias, 'Sin Categoría');
    fillSelect('insumo-categoria', inventarioState.categorias, 'Sin Categoría');
    fillSelect('filtro-producto-categoria', inventarioState.categorias, 'Todas las categorías');
    fillSelect('filtro-insumo-categoria', inventarioState.categorias, 'Todas las categorías');
    fillSelect('filtro-receta-categoria', inventarioState.categorias, 'Todas las categorías');
  }
}

async function renderizarInventario() {
  await cargarCategoriasYSelects();

  if (inventarioState.tabActual === 'insumos') {
    const res = await window.electronAPI.getInsumos();
    if (res.ok) {
      inventarioState.insumos = res.data;
      const filtro = document.getElementById('filtro-insumo-categoria').value;
      const filtrados = filtro ? res.data.filter(i => i.categoria_id == filtro) : res.data;

      const html = filtrados.map(i => {
        let statusClass = 'status-ok';
        if (i.cantidad_actual <= 0) statusClass = 'status-danger';
        else if (i.cantidad_actual <= i.punto_reposicion) statusClass = 'status-warn';
        const cat = inventarioState.categorias.find(c => c.id === i.categoria_id);
        const catBadge = cat ? '<span class="badge" style="background:'+cat.color+'; color:#fff">'+escapeHtml(cat.nombre)+'</span>' : '';

        return '<div class="pedido-card" style="display:flex; justify-content:space-between; align-items:center;">' +
               '  <div><span class="status-indicator ' + statusClass + '"></span>' +
               '  <strong style="margin-left:8px;">' + escapeHtml(i.nombre) + '</strong> ' + catBadge +
               '  <div style="color:var(--text2); font-size:12px; margin-top:4px;">Cant: ' + i.cantidad_actual + ' ' + i.unidad_medida + '</div></div>' +
               '  <div><button class="btn btn-secondary btn-small btn-editar-insumo" data-id="' + i.id + '">✏️</button>' +
               '  <button class="btn btn-secondary btn-small btn-eliminar-insumo" data-id="' + i.id + '" style="color:var(--danger)">🗑️</button></div></div>';
      }).join('');
      document.getElementById('lista-insumos').innerHTML = html || '<div class="empty-state">No hay insumos</div>';
    }
  } else if (inventarioState.tabActual === 'productos') {
    const res = await window.electronAPI.getProductos();
    if (res.ok) {
      inventarioState.productos = res.data;
      const filtro = document.getElementById('filtro-producto-categoria').value;
      const filtrados = filtro ? res.data.filter(p => p.categoria_id == filtro) : res.data;
      const html = filtrados.map(p => {
        const color = p.categoria_color || 'var(--surface2)';
        const catObj = p.categoria_id ? inventarioState.categorias.find(c => c.id === p.categoria_id) : null;
        const catName = catObj ? catObj.nombre : 'Sin Categoría';
        return '<div class="pedido-card" style="display:flex; justify-content:space-between; align-items:center;">' +
               '  <div><strong>' + escapeHtml(p.nombre) + '</strong> <span class="badge" style="background:'+color+'; color:#fff">' + escapeHtml(catName) + '</span></div>' +
               '  <div><button class="btn btn-secondary btn-small btn-editar-producto" data-id="' + p.id + '">✏️</button>' +
               '  <button class="btn btn-secondary btn-small btn-eliminar-producto" data-id="' + p.id + '" style="color:var(--danger)">🗑️</button></div></div>';
      }).join('');
      document.getElementById('lista-productos').innerHTML = html || '<div class="empty-state">No hay productos</div>';
    }
  } else if (inventarioState.tabActual === 'recetas') {
    const res = await window.electronAPI.getAllRecetas();
    if (res.ok) {
      const filtro = document.getElementById('filtro-receta-categoria').value;
      const filtrados = filtro ? res.data.filter(r => r.categoria_id == filtro) : res.data;
      const html = filtrados.map(r => {
        const color = r.categoria_color || 'var(--surface2)';
        return '<div class="pedido-card" style="display:flex; justify-content:space-between; align-items:center;">' +
               '  <div><strong>' + escapeHtml(r.nombre) + '</strong> <span class="badge" style="background:'+color+'; color:#fff">' + escapeHtml(r.categoria_nombre || 'Sin Categoría') + '</span></div>' +
               '  <div><button class="btn btn-secondary btn-small btn-editar-receta" data-id="' + r.id + '">✏️ Editar Receta</button>' +
               '  <button class="btn btn-secondary btn-small btn-eliminar-receta" data-id="' + r.id + '" style="color:var(--danger)">🗑️</button></div></div>';
      }).join('');
      document.getElementById('lista-recetas-creadas').innerHTML = html || '<div class="empty-state">No hay recetas armadas</div>';
    }
  } else if (inventarioState.tabActual === 'categorias') {
    const html = inventarioState.categorias.map(c => 
      '<div class="pedido-card" style="display:flex; justify-content:space-between; align-items:center;">' +
      '  <div><span class="status-indicator" style="background-color:'+c.color+'; box-shadow:none;"></span>' +
      '  <strong style="margin-left:8px;">' + escapeHtml(c.nombre) + '</strong></div>' +
      '  <div><button class="btn btn-secondary btn-small btn-editar-categoria" data-id="' + c.id + '">✏️</button>' +
      '  <button class="btn btn-secondary btn-small btn-eliminar-categoria" data-id="' + c.id + '" style="color:var(--danger)">🗑️</button></div></div>'
    ).join('');
    document.getElementById('lista-categorias').innerHTML = html || '<div class="empty-state">No hay categorías</div>';
  } else if (inventarioState.tabActual === 'combos') {
    await renderizarGrupos();
  }
}

// ─── COMBOS: Grupos y Opciones ────────────────────────────────────────────────
let combosState = { grupoSeleccionado: null };

async function renderizarGrupos() {
  const res = await window.electronAPI.getGrupos();
  const lista = document.getElementById('lista-grupos');
  if (!res.ok || !lista) return;

  const grupos = res.data;
  if (grupos.length === 0) {
    lista.innerHTML = '<div class="empty-state">No hay grupos creados</div>';
    return;
  }

  lista.innerHTML = grupos.map(g => `
    <div class="grupo-item ${combosState.grupoSeleccionado === g.id ? 'grupo-selected' : ''}" data-id="${g.id}">
      <div class="grupo-item-info">
        <strong>${escapeHtml(g.nombre)}</strong>
        <span class="grupo-opciones-count">${g.num_opciones} opcion${g.num_opciones !== 1 ? 'es' : ''}</span>
      </div>
      <div class="grupo-item-actions">
        <button class="btn btn-secondary btn-small btn-editar-grupo" data-id="${g.id}" data-nombre="${escapeHtml(g.nombre)}" data-min="${g.min_seleccion}" data-max="${g.max_seleccion}">✏️</button>
        <button class="btn btn-secondary btn-small btn-eliminar-grupo" data-id="${g.id}" style="color:var(--danger)">🗑️</button>
      </div>
    </div>
  `).join('');

  if (combosState.grupoSeleccionado) {
    await renderizarOpciones(combosState.grupoSeleccionado);
  }
}

async function renderizarOpciones(grupoId) {
  combosState.grupoSeleccionado = grupoId;
  const panel = document.getElementById('panel-grupo-detalle');
  if (!panel) return;

  // Actualizar clase seleccionada en la lista
  document.querySelectorAll('.grupo-item').forEach(el => {
    el.classList.toggle('grupo-selected', parseInt(el.dataset.id) === grupoId);
  });

  const resGrupo = await window.electronAPI.getGrupos();
  const grupo = resGrupo.ok ? resGrupo.data.find(g => g.id === grupoId) : null;
  const resOpc = await window.electronAPI.getOpcionesByGrupo(grupoId);
  const opciones = resOpc.ok ? resOpc.data : [];

  panel.className = 'combos-panel-content';
  panel.innerHTML = `
    <div class="combos-panel-header">
      <h3>${grupo ? escapeHtml(grupo.nombre) : 'Grupo'}</h3>
      <div class="combos-panel-meta">
        <span>Mín: ${grupo?.min_seleccion ?? 1}</span>
        <span>Máx: ${grupo?.max_seleccion ?? 1}</span>
      </div>
    </div>
    <div class="opciones-lista" id="opciones-lista">
      ${opciones.length === 0 ? '<div class="empty-state">No hay opciones en este grupo</div>' : opciones.map(o => `
        <div class="opcion-item" data-id="${o.id}">
          <span class="opcion-nombre">${escapeHtml(o.nombre)}</span>
          <span class="opcion-precio">${o.precio_extra > 0 ? '+$' + o.precio_extra : 'Sin cargo'}</span>
          <div>
            <button class="btn btn-secondary btn-small btn-editar-opcion" data-id="${o.id}" data-nombre="${escapeHtml(o.nombre)}" data-precio="${o.precio_extra}">✏️</button>
            <button class="btn btn-secondary btn-small btn-eliminar-opcion" data-id="${o.id}" style="color:var(--danger)">🗑️</button>
          </div>
        </div>
      `).join('')}
    </div>
    <button class="btn btn-primary" id="btn-nueva-opcion" data-grupo="${grupoId}">+ Nueva Opción</button>
  `;

  // Listener para nueva opción
  document.getElementById('btn-nueva-opcion')?.addEventListener('click', () => {
    abrirModalOpcion(null, grupoId);
  });

  document.getElementById('opciones-lista')?.addEventListener('click', (e) => {
    const btnEditar = e.target.closest('.btn-editar-opcion');
    const btnEliminar = e.target.closest('.btn-eliminar-opcion');
    if (btnEditar) {
      abrirModalOpcion({
        id: parseInt(btnEditar.dataset.id),
        nombre: btnEditar.dataset.nombre,
        precio_extra: parseFloat(btnEditar.dataset.precio)
      }, grupoId);
    }
    if (btnEliminar) eliminarOpcion(parseInt(btnEliminar.dataset.id), grupoId);
  });
}

function abrirModalGrupo(data = null) {
  document.getElementById('grupo-id').value = data?.id ?? '';
  document.getElementById('grupo-nombre').value = data?.nombre ?? '';
  document.getElementById('grupo-min').value = data?.min ?? 1;
  document.getElementById('grupo-max').value = data?.max ?? 1;
  document.getElementById('modal-grupo-title').textContent = data ? 'Editar Grupo' : 'Nuevo Grupo';
  document.getElementById('modal-grupo').classList.add('visible');
}

async function guardarGrupo() {
  const nombre = document.getElementById('grupo-nombre').value.trim();
  if (!nombre) return mostrarToast('El nombre del grupo es obligatorio', 'error');
  const idRaw = document.getElementById('grupo-id').value;
  const min_seleccion = parseInt(document.getElementById('grupo-min').value) || 1;
  const max_seleccion = parseInt(document.getElementById('grupo-max').value) || 1;
  const data = { nombre, min_seleccion, max_seleccion };
  let res;
  if (idRaw) {
    res = await window.electronAPI.updateGrupo({ id: parseInt(idRaw), ...data });
  } else {
    res = await window.electronAPI.createGrupo(data);
  }
  if (res.ok) {
    document.getElementById('modal-grupo').classList.remove('visible');
    await renderizarGrupos();
    mostrarToast('Grupo guardado', 'success');
  } else {
    mostrarToast('Error: ' + res.error, 'error');
  }
}

async function eliminarGrupo(id) {
  if (!confirm('¿Eliminar este grupo y todas sus opciones?')) return;
  const res = await window.electronAPI.deleteGrupo(id);
  if (res.ok) {
    if (combosState.grupoSeleccionado === id) {
      combosState.grupoSeleccionado = null;
      const panel = document.getElementById('panel-grupo-detalle');
      if (panel) {
        panel.className = 'combos-empty-state';
        panel.innerHTML = '<span>👈</span><p>Seleccioná un grupo para ver y gestionar sus opciones</p>';
      }
    }
    await renderizarGrupos();
  } else {
    mostrarToast('Error: ' + res.error, 'error');
  }
}

async function abrirModalOpcion(data = null, grupoId) {
  document.getElementById('opcion-id').value = data?.id ?? '';
  document.getElementById('opcion-grupo-id').value = grupoId;
  document.getElementById('opcion-nombre').value = data?.nombre ?? '';
  document.getElementById('opcion-precio').value = data?.precio_extra ?? 0;
  document.getElementById('modal-opcion-title').textContent = data ? 'Editar Opción' : 'Nueva Opción';

  // Limpiar y cargar insumos de la receta de la opción
  const container = document.getElementById('opcion-receta-items');
  if (container) {
    container.innerHTML = '';
    if (inventarioState.insumos.length === 0) {
      const res = await window.electronAPI.getInsumos();
      if (res.ok) inventarioState.insumos = res.data;
    }

    if (data && data.id) {
      const resRec = await window.electronAPI.getRecetaOpcion(data.id);
      if (resRec.ok && resRec.data && resRec.data.length > 0) {
        resRec.data.forEach(item => agregarFilaOpcionReceta(item));
      }
    }
  }

  document.getElementById('modal-opcion').classList.add('visible');
}

async function guardarOpcion() {
  const nombre = document.getElementById('opcion-nombre').value.trim();
  if (!nombre) return mostrarToast('El nombre de la opción es obligatorio', 'error');
  const idRaw = document.getElementById('opcion-id').value;
  const grupo_id = parseInt(document.getElementById('opcion-grupo-id').value);
  const precio_extra = parseFloat(document.getElementById('opcion-precio').value) || 0;
  
  let res;
  if (idRaw) {
    res = await window.electronAPI.updateOpcion({ id: parseInt(idRaw), nombre, precio_extra });
  } else {
    res = await window.electronAPI.createOpcion({ grupo_id, nombre, precio_extra });
  }
  
  if (res.ok) {
    const opcionId = idRaw ? parseInt(idRaw) : res.id;
    
    // Obtener los insumos configurados para esta opción
    const items = [];
    document.querySelectorAll('.opcion-receta-item-row').forEach(row => {
      const insumo_id = parseInt(row.querySelector('.select-insumo').value);
      const cant = parseFloat(row.querySelector('.input-cant-insumo').value);
      if (insumo_id && cant > 0) {
        items.push({ insumo_id, cantidad_necesaria: cant });
      }
    });

    // Guardar receta de la opción
    await window.electronAPI.saveRecetaOpcion(opcionId, items);

    document.getElementById('modal-opcion').classList.remove('visible');
    await renderizarOpciones(grupo_id);
    mostrarToast('Opción guardada', 'success');
  } else {
    mostrarToast('Error: ' + res.error, 'error');
  }
}

function agregarFilaOpcionReceta(data = null) {
  const container = document.getElementById('opcion-receta-items');
  if (!container) return;

  const options = inventarioState.insumos.map(i => 
    '<option value="'+i.id+'" '+(data && data.insumo_id === i.id ? 'selected' : '')+'>'+escapeHtml(i.nombre)+' ('+i.unidad_medida+')</option>'
  ).join('');

  const div = document.createElement('div');
  div.className = 'receta-item-row opcion-receta-item-row';
  div.innerHTML = `<select class="edit-input select-insumo"><option value="">Insumo...</option>${options}</select>
    <input type="number" class="edit-input input-cant-insumo" step="0.01" value="${data ? data.cantidad_necesaria : ''}" placeholder="Cant.">
    <button class="btn-icon btn-quitar-opcion-fila">✕</button>`;
  container.appendChild(div);
}

async function eliminarOpcion(id, grupoId) {
  if (!confirm('¿Eliminar esta opción?')) return;
  const res = await window.electronAPI.deleteOpcion(id);
  if (res.ok) await renderizarOpciones(grupoId);
  else mostrarToast('Error: ' + res.error, 'error');
}

// RECETAS LOGIC
async function abrirModalReceta(productoId = null) {
  const resProd = await window.electronAPI.getProductos();
  if (resProd.ok) inventarioState.productos = resProd.data;
  
  const select = document.getElementById('receta-producto-select');
  select.innerHTML = '<option value="">Seleccione un producto...</option>' + 
    inventarioState.productos.map(p => '<option value="'+p.id+'">'+escapeHtml(p.nombre)+'</option>').join('');
  
  document.getElementById('receta-items').innerHTML = '';
  
  if (productoId) {
    select.value = productoId;
    await cargarItemsReceta(productoId);
    document.getElementById('modal-receta-title').textContent = 'Editar Receta';
  } else {
    document.getElementById('modal-receta-title').textContent = 'Nueva Receta';
  }
  
  document.getElementById('modal-receta').classList.add('visible');
}

async function cargarItemsReceta(productoId) {
  if (inventarioState.insumos.length === 0) {
    const res = await window.electronAPI.getInsumos();
    if (res.ok) inventarioState.insumos = res.data;
  }
  const resRec = await window.electronAPI.getReceta(productoId);
  const container = document.getElementById('receta-items');
  container.innerHTML = '';
  if (resRec.ok && resRec.data.length > 0) {
    resRec.data.forEach(item => agregarFilaReceta(item));
  } else {
    agregarFilaReceta();
  }
}

function agregarFilaReceta(data = null) {
  const container = document.getElementById('receta-items');
  const options = inventarioState.insumos.map(i => 
    '<option value="'+i.id+'" '+(data && data.insumo_id === i.id ? 'selected' : '')+'>'+escapeHtml(i.nombre)+' ('+i.unidad_medida+')</option>'
  ).join('');
  
  const div = document.createElement('div');
  div.className = 'receta-item-row';
  div.innerHTML = `<select class="edit-input select-insumo"><option value="">Insumo...</option>${options}</select>
    <input type="number" class="edit-input input-cant-insumo" step="0.01" value="${data ? data.cantidad_necesaria : ''}" placeholder="Cant.">
    <button class="btn-icon btn-quitar-fila">✕</button>`;
  container.appendChild(div);
}

async function guardarReceta() {
  const productoId = parseInt(document.getElementById('receta-producto-select').value);
  if (!productoId) return mostrarToast('Selecciona un producto', 'error');
  
  const items = [];
  document.querySelectorAll('.receta-item-row').forEach(row => {
    const insumo_id = parseInt(row.querySelector('.select-insumo').value);
    const cant = parseFloat(row.querySelector('.input-cant-insumo').value);
    if (insumo_id && cant > 0) items.push({ insumo_id, cantidad_necesaria: cant });
  });
  
  if (items.length === 0) return mostrarToast('Agrega al menos un insumo con cantidad', 'error');

  const res = await window.electronAPI.saveReceta(productoId, items);
  if (res.ok) {
    document.getElementById('modal-receta').classList.remove('visible');
    renderizarInventario();
    mostrarToast('Receta guardada', 'success');
  } else {
    console.error('[Receta] Error al guardar:', res.error);
    mostrarToast('Error: ' + res.error, 'error');
  }
}

async function eliminarReceta(id) {
  if (!confirm("¿Eliminar la receta de este producto?")) return;
  const res = await window.electronAPI.deleteReceta(id);
  if (res.ok) renderizarInventario();
}

// INSUMOS, PRODUCTOS, CATEGORIAS CRUD
function editarInsumo(id) {
  const i = inventarioState.insumos.find(x => x.id === id);
  if (!i) return;
  document.getElementById('insumo-id').value = i.id;
  document.getElementById('insumo-nombre').value = i.nombre;
  document.getElementById('insumo-unidad').value = i.unidad_medida;
  document.getElementById('insumo-cantidad').value = i.cantidad_actual;
  document.getElementById('insumo-alerta').value = i.punto_reposicion;
  document.getElementById('insumo-categoria').value = i.categoria_id || '';
  document.getElementById('modal-insumo-title').textContent = 'Editar Insumo';
  document.getElementById('modal-insumo').classList.add("visible");
}
async function guardarInsumo() {
  const nombre = document.getElementById('insumo-nombre').value.trim();
  if (!nombre) return mostrarToast('El nombre del insumo es obligatorio', 'error');
  const idRaw = document.getElementById('insumo-id').value;
  const data = {
    id: idRaw ? parseInt(idRaw) : null,
    nombre,
    unidad_medida: document.getElementById('insumo-unidad').value,
    cantidad_actual: parseFloat(document.getElementById('insumo-cantidad').value) || 0,
    punto_reposicion: parseFloat(document.getElementById('insumo-alerta').value) || 0,
    categoria_id: parseInt(document.getElementById('insumo-categoria').value) || null
  };
  const res = data.id ? await window.electronAPI.updateInsumo(data) : await window.electronAPI.createInsumo(data);
  if (res.ok) { document.getElementById('modal-insumo').classList.remove('visible'); renderizarInventario(); checkAlerts(); }
  else { console.error('[Insumo] Error al guardar:', res.error); mostrarToast('Error: ' + res.error, 'error'); }
}
async function eliminarInsumo(id) { if (confirm("¿Eliminar insumo?")) { await window.electronAPI.deleteInsumo(id); renderizarInventario(); } }

function actualizarVisibilidadStock() {
  const checkbox = document.getElementById('producto-controla-stock');
  const wrapper = document.getElementById('stock-actual-wrapper');
  if (checkbox && wrapper) {
    if (checkbox.checked) {
      wrapper.style.display = 'none';
    } else {
      wrapper.style.display = 'block';
    }
  }
}

async function cargarCombosEnProducto(productoId) {
  const container = document.getElementById('producto-grupos-checkboxes');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--text2)">Cargando grupos...</p>';

  // 1. Obtener todos los grupos
  const resGrupos = await window.electronAPI.getGrupos();
  if (!resGrupos.ok) {
    container.innerHTML = '<p style="color:var(--danger)">Error al cargar grupos</p>';
    return;
  }
  const grupos = resGrupos.data || [];

  if (grupos.length === 0) {
    container.innerHTML = '<p style="color:var(--text3); font-size:12px;">No hay grupos de opciones creados en la pestaña "Combos"</p>';
    return;
  }

  // 2. Obtener grupos vinculados al producto actual
  let vinculados = [];
  if (productoId) {
    const resVinculados = await window.electronAPI.getProductoGrupos(productoId);
    if (resVinculados.ok) {
      vinculados = resVinculados.data || [];
    }
  }

  // 3. Renderizar
  container.innerHTML = grupos.map(g => {
    const isChecked = vinculados.includes(g.id);
    const badgeText = g.min_seleccion > 0 ? 'Obligatorio' : 'Opcional';
    const badgeClass = g.min_seleccion > 0 ? 'grupo-badge-oblig' : 'grupo-badge-opc';

    return `
      <label class="grupo-check-item ${isChecked ? 'checked' : ''}" data-id="${g.id}">
        <input type="checkbox" class="combo-grupo-checkbox" value="${g.id}" ${isChecked ? 'checked' : ''}>
        <span class="grupo-check-nombre">${escapeHtml(g.nombre)}</span>
        <span class="grupo-check-badge ${badgeClass}">${badgeText}</span>
      </label>
    `;
  }).join('');

  // 4. Agregar event listeners para actualizar la clase "checked" al hacer click
  container.querySelectorAll('.grupo-check-item').forEach(item => {
    const checkbox = item.querySelector('.combo-grupo-checkbox');
    checkbox.addEventListener('change', () => {
      item.classList.toggle('checked', checkbox.checked);
    });
  });
}

async function editarProducto(id) {
  const p = inventarioState.productos.find(x => x.id === id);
  if (!p) return;
  document.getElementById('producto-id').value = p.id;
  document.getElementById('producto-nombre').value = p.nombre;
  document.getElementById('producto-categoria').value = p.categoria_id || '';
  document.getElementById('producto-precio').value = p.precio;
  document.getElementById('producto-stock').value = p.stock_actual;

  // Si p.controla_stock === 0, entonces "NO Maneja Stock" está checked
  const checkbox = document.getElementById('producto-controla-stock');
  if (checkbox) {
    checkbox.checked = (p.controla_stock === 0);
  }
  actualizarVisibilidadStock();

  // Cargar combos seleccionados para este producto
  await cargarCombosEnProducto(p.id);

  document.getElementById('modal-producto').classList.add("visible");
}

async function guardarProducto() {
  const nombre = document.getElementById('producto-nombre').value.trim();
  if (!nombre) return mostrarToast('El nombre del producto es obligatorio', 'error');
  
  const idRaw = document.getElementById('producto-id').value;
  const controlaStockCheckbox = document.getElementById('producto-controla-stock');
  
  // Checked ("NO maneja stock") -> controla_stock = 0
  // Unchecked ("Maneja stock") -> controla_stock = 1
  const controla_stock = controlaStockCheckbox ? (controlaStockCheckbox.checked ? 0 : 1) : 1;

  const data = {
    id: idRaw ? parseInt(idRaw) : null,
    nombre,
    categoria_id: parseInt(document.getElementById('producto-categoria').value) || null,
    precio: parseFloat(document.getElementById('producto-precio').value) || 0,
    stock_actual: parseInt(document.getElementById('producto-stock').value) || 0,
    controla_stock: controla_stock
  };

  const res = data.id ? await window.electronAPI.updateProducto(data) : await window.electronAPI.createProducto(data);
  if (res.ok) {
    const productoId = data.id || res.id;
    
    // Guardar vinculación de combos/grupos
    const grupoIds = Array.from(document.querySelectorAll('.combo-grupo-checkbox:checked'))
      .map(cb => parseInt(cb.value));
    
    await window.electronAPI.saveProductoGrupos(productoId, grupoIds);

    document.getElementById('modal-producto').classList.remove('visible');
    renderizarInventario();
    mostrarToast('Producto guardado correctamente', 'success');
  } else {
    console.error('[Producto] Error al guardar:', res.error);
    mostrarToast('Error al guardar: ' + res.error, 'error');
  }
}
async function eliminarProducto(id) { if (confirm("¿Eliminar producto?")) { await window.electronAPI.deleteProducto(id); renderizarInventario(); } }

function editarCategoria(id) {
  const c = inventarioState.categorias.find(x => x.id === id);
  if (!c) return;
  document.getElementById('categoria-id').value = c.id;
  document.getElementById('categoria-nombre').value = c.nombre;
  document.getElementById('categoria-tipo').value = c.tipo;
  document.getElementById('categoria-color').value = c.color;
  document.getElementById('modal-categoria').classList.add("visible");
}
async function guardarCategoria() {
  const nombre = document.getElementById('categoria-nombre').value.trim();
  if (!nombre) return mostrarToast('El nombre de la categoría es obligatorio', 'error');
  const idRaw = document.getElementById('categoria-id').value;
  const data = {
    id: idRaw ? parseInt(idRaw) : null,
    nombre,
    tipo: document.getElementById('categoria-tipo').value || 'general',
    color: document.getElementById('categoria-color').value || '#4b6584',
  };
  const res = data.id ? await window.electronAPI.updateCategoria(data) : await window.electronAPI.createCategoria(data);
  if (res.ok) { document.getElementById('modal-categoria').classList.remove('visible'); renderizarInventario(); }
  else { console.error('[Categoria] Error al guardar:', res.error); mostrarToast('Error: ' + res.error, 'error'); }
}
async function eliminarCategoria(id) { if (confirm("¿Eliminar categoría?")) { await window.electronAPI.deleteCategoria(id); renderizarInventario(); } }
// ─── TIENDA: Estado y Apertura/Cierre ─────────────────────────────────────────
async function inicializarEstadoTienda() {
  const res = await window.electronAPI.getTiendaStatus();
  if (res.ok) {
    state.tiendaAbierta = res.abierta;
    actualizarBotonTienda();
  }
}

function actualizarBotonTienda() {
  const btn = document.getElementById('btn-tienda');
  const icon = document.getElementById('btn-tienda-icon');
  const text = document.getElementById('btn-tienda-text');
  if (!btn) return;

  if (state.tiendaAbierta) {
    btn.className = 'btn-tienda abierta';
    icon.textContent = '🟢';
    text.textContent = '¿Cerramos el Día?';
  } else {
    btn.className = 'btn-tienda cerrada';
    icon.textContent = '🔴';
    text.textContent = '¿Abrimos la Tienda?';
  }
}

function setupWhatsAppListeners() {
  const statusDot = document.getElementById('whatsapp-status-dot');
  const statusText = document.getElementById('whatsapp-status-text');
  const qrContainer = document.getElementById('whatsapp-qr-container');
  const qrImage = document.getElementById('whatsapp-qr-image');

  if (!statusDot || !statusText || !qrContainer || !qrImage) {
    console.error('[WhatsApp UI] No se encontraron algunos elementos de la interfaz de WhatsApp.');
    return;
  }

  // 1. Evento QR recibido
  window.electronAPI.on('whatsapp:qr', (qrBase64) => {
    console.log("QR recibido", qrBase64);
    
    // Cambiar estado visual
    statusDot.className = 'status-dot dot-escaneando';
    statusText.textContent = 'Escaneando...';
    
    // Mostrar QR e inyectar src
    qrImage.src = qrBase64;
    qrContainer.style.display = 'flex';
  });

  // 2. Evento Listo (Conectado)
  window.electronAPI.on('whatsapp:ready', () => {
    console.log("WhatsApp Conectado exitosamente");
    
    // Cambiar estado visual
    statusDot.className = 'status-dot dot-conectado';
    statusText.textContent = 'Conectado';
    
    // Ocultar QR
    qrContainer.style.display = 'none';
    qrImage.src = '';
  });

  // 3. Evento Desconectado
  window.electronAPI.on('whatsapp:disconnected', () => {
    console.log("WhatsApp Desconectado");
    
    // Cambiar estado visual
    statusDot.className = 'status-dot dot-desconectado';
    statusText.textContent = 'Desconectado';
    
    // Ocultar QR
    qrContainer.style.display = 'none';
    qrImage.src = '';
  });
}

function setupTiendaListeners() {
  // Boton principal de tienda
  document.getElementById('btn-tienda')?.addEventListener('click', () => {
    if (state.tiendaAbierta) {
      abrirModalCierre();
    } else {
      abrirModalApertura();
    }
  });

  // Modal Apertura ─ cancelar
  document.getElementById('btn-cancelar-apertura')?.addEventListener('click', () => {
    document.getElementById('modal-apertura').classList.remove('visible');
  });

  // Modal Apertura ─ confirmar
  document.getElementById('btn-confirmar-apertura')?.addEventListener('click', async () => {
    await confirmarApertura();
  });

  // Modal Cierre ─ cancelar
  document.getElementById('btn-cancelar-cierre')?.addEventListener('click', () => {
    document.getElementById('modal-cierre').classList.remove('visible');
  });

  // Modal Cierre ─ confirmar
  document.getElementById('btn-confirmar-cierre')?.addEventListener('click', async () => {
    await confirmarCierre();
  });

  // Historial: tabs
  document.getElementById('tab-ventas')?.addEventListener('click', () => {
    document.getElementById('historial-ventas').style.display = 'block';
    document.getElementById('historial-archivados').style.display = 'none';
    document.getElementById('tab-ventas').classList.add('activo');
    document.getElementById('tab-archivados').classList.remove('activo');
    const filters = document.getElementById('historial-filtros-ventas');
    if (filters) filters.style.display = 'flex';
  });

  document.getElementById('tab-archivados')?.addEventListener('click', () => {
    document.getElementById('historial-ventas').style.display = 'none';
    document.getElementById('historial-archivados').style.display = 'block';
    document.getElementById('tab-ventas').classList.remove('activo');
    document.getElementById('tab-archivados').classList.add('activo');
    const filters = document.getElementById('historial-filtros-ventas');
    if (filters) filters.style.display = 'none';
    cargarArchivados();
  });

  // Historial: filtros de fecha
  document.getElementById('filtro-fecha-desde')?.addEventListener('change', aplicarFiltrosVentas);
  document.getElementById('filtro-fecha-hasta')?.addEventListener('change', aplicarFiltrosVentas);
  document.getElementById('btn-limpiar-fechas')?.addEventListener('click', () => {
    const desde = document.getElementById('filtro-fecha-desde');
    const hasta = document.getElementById('filtro-fecha-hasta');
    if (desde) desde.value = '';
    if (hasta) hasta.value = '';
    aplicarFiltrosVentas();
  });

  // Historial: exportar CSV
  document.getElementById('btn-exportar-csv')?.addEventListener('click', async () => {
    const res = await window.electronAPI.exportarHistorialCSV();
    if (res.ok) {
      mostrarToast('✅ CSV exportado correctamente', 'success');
    } else if (res.error !== 'Cancelado por el usuario') {
      mostrarToast('❌ Error al exportar: ' + res.error, 'error');
    }
  });
}

async function abrirModalApertura() {
  const modal = document.getElementById('modal-apertura');
  const contProductos = document.getElementById('apertura-productos');
  const contInsumos = document.getElementById('apertura-insumos');

  contProductos.innerHTML = '<p style="color:var(--text2)">Cargando...</p>';
  contInsumos.innerHTML = '<p style="color:var(--text2)">Cargando...</p>';
  modal.classList.add('visible');

  const res = await window.electronAPI.getStockApertura();
  if (!res.ok) {
    contProductos.innerHTML = '<p style="color:var(--danger)">Error al cargar stock</p>';
    return;
  }

  contProductos.innerHTML = res.productos.length === 0
    ? '<p style="color:var(--text2)">No hay productos con stock.</p>'
    : res.productos.map(p => `
      <div class="apertura-item">
        <span class="apertura-nombre">${escapeHtml(p.nombre)}</span>
        <input type="number" class="apertura-input" data-id="${p.id}" data-tipo="producto" value="${p.stock_actual}" min="0">
        <span class="apertura-unidad">u.</span>
      </div>
    `).join('');

  contInsumos.innerHTML = res.insumos.length === 0
    ? '<p style="color:var(--text2)">No hay insumos con stock.</p>'
    : res.insumos.map(i => `
      <div class="apertura-item">
        <span class="apertura-nombre">${escapeHtml(i.nombre)}</span>
        <input type="number" class="apertura-input" data-id="${i.id}" data-tipo="insumo" value="${i.cantidad_actual}" min="0" step="0.1">
        <span class="apertura-unidad">${escapeHtml(i.unidad_medida)}</span>
      </div>
    `).join('');
}

async function confirmarApertura() {
  // Recolectar cambios de stock
  const inputs = document.querySelectorAll('.apertura-input');
  const productos = [];
  const insumos = [];

  inputs.forEach(input => {
    const id = parseInt(input.dataset.id);
    const val = parseFloat(input.value) || 0;
    if (input.dataset.tipo === 'producto') {
      productos.push({ id, stock_actual: val });
    } else {
      insumos.push({ id, cantidad_actual: val });
    }
  });

  // Guardar stock actualizado
  await window.electronAPI.updateStockApertura({ productos, insumos });

  // Abrir la tienda (archiva pendientes + purga CSV)
  const res = await window.electronAPI.abrirTienda();
  if (!res.ok) {
    mostrarToast('❌ Error al abrir la tienda: ' + res.error, 'error');
    return;
  }

  document.getElementById('modal-apertura').classList.remove('visible');
  state.tiendaAbierta = true;
  actualizarBotonTienda();

  // Recargar pedidos (el kanban estará limpio ahora)
  await cargarPedidosIniciales();
  mostrarToast('🟢 ¡Tienda abierta! Buen día de trabajo.', 'success');
}

async function abrirModalCierre() {
  const modal = document.getElementById('modal-cierre');
  const resumen = document.getElementById('cierre-resumen');

  // Calcular resumen de la sesión actual
  const entregadosHoy = state.pedidos.filter(p =>
    !p.archivado && p.estado === 'entregado'
  );
  const totalHoy = entregadosHoy.reduce((acc, p) => acc + (parseFloat(p.total) || 0), 0);
  
  const canceladosHoy = state.pedidos.filter(p =>
    !p.archivado && p.estado === 'cancelado'
  );

  const desperdiciosHoy = state.pedidos.filter(p =>
    !p.archivado && p.estado === 'desperdicio'
  );

  resumen.innerHTML = `
    <div class="cierre-stat">
      <span class="cierre-stat-label">✅ Pedidos Entregados</span>
      <span class="cierre-stat-valor">${entregadosHoy.length}</span>
    </div>
    <div class="cierre-stat">
      <span class="cierre-stat-label">💰 Total Recaudado</span>
      <span class="cierre-stat-valor verde">$${totalHoy.toLocaleString('es-AR')}</span>
    </div>
    <div class="cierre-stat">
      <span class="cierre-stat-label">🗑️ Pedidos en Desperdicio</span>
      <span class="cierre-stat-valor" style="color: #a0a0b8;">${desperdiciosHoy.length}</span>
    </div>
    <div class="cierre-stat">
      <span class="cierre-stat-label">❌ Pedidos Cancelados</span>
      <span class="cierre-stat-valor">${canceladosHoy.length}</span>
    </div>
  `;

  modal.classList.add('visible');
}

async function confirmarCierre() {
  const res = await window.electronAPI.cerrarTienda();
  if (!res.ok) {
    mostrarToast('❌ Error al cerrar: ' + res.error, 'error');
    return;
  }
  document.getElementById('modal-cierre').classList.remove('visible');
  state.tiendaAbierta = false;
  actualizarBotonTienda();
  mostrarToast('🔴 Tienda cerrada. ¡Hasta mañana!', 'warning');
}

// ─── HISTORIAL ──────────────────────────────────────────────────────────
async function cargarHistorial() {
  // Mostrar pestaña activa (ventas por defecto)
  const tabVentas = document.getElementById('tab-ventas');
  const tabArchivados = document.getElementById('tab-archivados');
  const contVentas = document.getElementById('historial-ventas');
  const contArchivados = document.getElementById('historial-archivados');

  if (!contVentas) return;

  // Resetear a tab ventas si es la primera vez
  if (tabVentas && !tabVentas.classList.contains('activo') && !tabArchivados.classList.contains('activo')) {
    tabVentas.classList.add('activo');
  }

  // Inicializar explícitamente los estilos de visualización y filtros según la pestaña activa para evitar desajustes en el primer render
  if (tabVentas && tabVentas.classList.contains('activo')) {
    contVentas.style.display = 'block';
    if (contArchivados) contArchivados.style.display = 'none';
    const filters = document.getElementById('historial-filtros-ventas');
    if (filters) filters.style.display = 'flex';
  } else if (tabArchivados && tabArchivados.classList.contains('activo')) {
    contVentas.style.display = 'none';
    if (contArchivados) contArchivados.style.display = 'block';
    const filters = document.getElementById('historial-filtros-ventas');
    if (filters) filters.style.display = 'none';
  }

  if (contVentas.style.display !== 'none') {
    contVentas.innerHTML = '<p style="color:var(--text2);padding:20px">Cargando...</p>';
    const res = await window.electronAPI.getHistorialPedidos();
    if (!res.ok) {
      contVentas.innerHTML = '<p style="color:var(--danger)">Error al cargar historial</p>';
      return;
    }
    state.historialVentas = res.data || [];
    aplicarFiltrosVentas();
  }
}

function aplicarFiltrosVentas() {
  const desdeVal = document.getElementById('filtro-fecha-desde')?.value;
  const hastaVal = document.getElementById('filtro-fecha-hasta')?.value;
  const contVentas = document.getElementById('historial-ventas');
  if (!contVentas) return;

  let filtered = [...state.historialVentas];

  if (desdeVal) {
    const desdeDate = new Date(desdeVal + 'T00:00:00');
    filtered = filtered.filter(p => parseSQLiteDate(p.created_at) >= desdeDate);
  }

  if (hastaVal) {
    const hastaDate = new Date(hastaVal + 'T23:59:59');
    filtered = filtered.filter(p => parseSQLiteDate(p.created_at) <= hastaDate);
  }

  renderizarHistorialVentas(filtered, contVentas);
}

function renderizarHistorialVentas(pedidos, container) {
  if (pedidos.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay pedidos para mostrar en este rango de fechas.</div>';
    return;
  }

  // Agrupar por día
  const porDia = {};
  pedidos.forEach(p => {
    const fecha = parseSQLiteDate(p.created_at);
    // Clave para agrupar por día
    const key = fecha.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!porDia[key]) porDia[key] = { pedidos: [], total: 0 };
    porDia[key].pedidos.push(p);
    porDia[key].total += parseFloat(p.total) || 0;
  });

  container.innerHTML = Object.entries(porDia).map(([dia, data]) => `
    <div class="historial-dia">
      <div class="historial-dia-header">
        <h3>📅 ${dia.charAt(0).toUpperCase() + dia.slice(1)}</h3>
        <span class="historial-dia-total">${data.pedidos.length} pedidos — <strong>$${data.total.toLocaleString('es-AR')}</strong></span>
      </div>
      <div class="historial-tabla">
        <div class="historial-tabla-header">
          <span>Pedido</span><span>Cliente</span><span>Productos</span><span>Total</span><span>Método</span><span>Hora</span>
        </div>
        ${data.pedidos.map(p => {
          let prods = [];
          try { prods = JSON.parse(p.productos); } catch {}
          const resumen = Array.isArray(prods) ? prods.slice(0,2).map(x => `${x.cantidad||1}x ${x.nombre||x.name}`).join(', ') : '';
          return `
            <div class="historial-tabla-row clickable-row" onclick="abrirModal(${p.id})">
              <span class="hist-numero">${p.numero_pedido || '#'+p.id}</span>
              <span>${escapeHtml(p.cliente_nombre)}</span>
              <span class="hist-prods">${escapeHtml(resumen)}</span>
              <span class="hist-total">$${parseFloat(p.total||0).toLocaleString('es-AR')}</span>
              <span>${p.metodo_pago || 'efectivo'}</span>
              <span class="hist-fecha">${parseSQLiteDate(p.created_at).toLocaleTimeString('es-AR', {hour: '2-digit', minute:'2-digit'})}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');
}

async function cargarArchivados() {
  const container = document.getElementById('historial-archivados');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--text2);padding:20px">Cargando...</p>';
  const res = await window.electronAPI.getHistorialArchivados();
  if (!res.ok) {
    container.innerHTML = '<p style="color:var(--danger)">Error al cargar archivados</p>';
    return;
  }

  if (res.data.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay pedidos archivados.</div>';
    return;
  }

  state.archivados = res.data;

  container.innerHTML = `
    <div class="historial-tabla">
      <div class="historial-tabla-header">
        <span>Pedido</span><span>Cliente</span><span>Estado</span><span>Total</span><span>Fecha</span><span>Acción</span>
      </div>
      ${res.data.map(p => `
        <div class="historial-tabla-row clickable-row" data-id="${p.id}">
          <span class="hist-numero">${p.numero_pedido || '#'+p.id}</span>
          <span>${escapeHtml(p.cliente_nombre)}</span>
          <span class="lista-estado estado-${p.estado}">${ESTADOS[p.estado]?.emoji || ''} ${ESTADOS[p.estado]?.label || p.estado}</span>
          <span class="hist-total">$${parseFloat(p.total||0).toLocaleString('es-AR')}</span>
          <span class="hist-fecha">${parseSQLiteDate(p.created_at).toLocaleDateString('es-AR')}</span>
          <div style="display:flex; gap:5px; align-items:center;">
            <button class="btn btn-small btn-primary btn-entregar-arch" data-id="${p.id}" style="font-size: 11px; padding: 4px 8px;">✔ Entregar</button>
            <button class="btn btn-small btn-danger btn-cancelar-arch" data-id="${p.id}" style="font-size: 11px; padding: 4px 8px;">❌ Cancelar</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  // Click en la fila → abrir modal en modo solo lectura
  container.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', async (e) => {
      // Si hizo click en un botón de acción, no abrir modal
      if (e.target.closest('button')) return;
      const id = parseInt(row.dataset.id);
      await abrirModal(id);
      document.getElementById('modal-pedido').classList.add('visible');
    });
  });

  container.querySelectorAll('.btn-entregar-arch').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      // Actualizar a estado 'entregado'
      const res = await window.electronAPI.updateEstadoPedido(id, 'entregado');
      if (res.ok) {
        await window.electronAPI.desarchivarPedido(id);
        mostrarToast('📦 Pedido marcado como entregado', 'success');
        await cargarPedidosIniciales();
        cargarArchivados();
      } else {
        mostrarToast('❌ Error: ' + res.error, 'error');
      }
    });
  });

  container.querySelectorAll('.btn-cancelar-arch').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      const confirmar = confirm('¿Cancelar este pedido archivado? Se restaurará el stock de sus ingredientes.');
      if (!confirmar) return;
      const res = await window.electronAPI.deletePedido(id);
      if (res.ok) {
        await window.electronAPI.desarchivarPedido(id);
        mostrarToast('❌ Pedido cancelado correctamente', 'warning');
        await cargarPedidosIniciales();
        cargarArchivados();
      } else {
        mostrarToast('❌ Error al cancelar: ' + (res.error || 'Error desconocido'), 'error');
      }
    });
  });
}

// ─── CONFIGURACIÓN DE IMPRESORA ─────────────────────────────────────────

// Función auxiliar: llenar el select de impresoras usando el sistema Windows
async function cargarImpresorasEnSelect(selectPrinter, currentValue) {
  selectPrinter.innerHTML = '<option value="">Detectando impresoras...</option>';
  
  // Intentar primero con PowerShell (más confiable para impresoras térmicas USB)
  let printerNames = [];
  const resSys = await window.electronAPI.listSystemPrinters?.();
  
  if (resSys && resSys.ok && resSys.data && resSys.data.length > 0) {
    printerNames = resSys.data; // array de strings
  } else {
    // Fallback: API de Electron
    const resElectron = await window.electronAPI.listPrinters();
    if (resElectron.ok && resElectron.data) {
      printerNames = resElectron.data.map(p => p.displayName || p.name);
    }
  }

  if (printerNames.length > 0) {
    selectPrinter.innerHTML = '<option value="">-- Seleccionar Impresora --</option>';
    printerNames.forEach(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      selectPrinter.appendChild(option);
    });
    // Si había un valor previo y está en la lista, seleccionarlo
    if (currentValue) {
      selectPrinter.value = currentValue;
      // Si no encontró el valor guardado, marcarlo como opción custom
      if (!selectPrinter.value) {
        const customOpt = document.createElement('option');
        customOpt.value = currentValue;
        customOpt.textContent = `${currentValue} (no encontrada en esta PC)`;
        customOpt.style.color = '#e74c3c';
        selectPrinter.insertBefore(customOpt, selectPrinter.children[1]);
        selectPrinter.value = currentValue;
      }
    }
    return true;
  } else {
    selectPrinter.innerHTML = '<option value="">No se detectaron impresoras</option>';
    return false;
  }
}

document.getElementById('btn-configuracion')?.addEventListener('click', async () => {
  const modal = document.getElementById('modal-configuracion');
  const selectPrinter = document.getElementById('config-impresora-nombre');
  const selectWidth = document.getElementById('config-impresora-ancho');

  // Cargar configuración actual primero
  const resConfig = await window.electronAPI.getConfig();
  let savedPrinterName = '';
  if (resConfig.ok) {
    savedPrinterName = resConfig.data.impresora_nombre || '';
    if (resConfig.data.impresora_ancho) selectWidth.value = resConfig.data.impresora_ancho;
    if (resConfig.data.negocio_nombre) document.getElementById('config-empresa-nombre').value = resConfig.data.negocio_nombre;
    if (resConfig.data.negocio_direccion) document.getElementById('config-empresa-direccion').value = resConfig.data.negocio_direccion;
    if (resConfig.data.negocio_web) document.getElementById('config-empresa-web').value = resConfig.data.negocio_web;
  }

  // Cargar impresoras (PowerShell)
  await cargarImpresorasEnSelect(selectPrinter, savedPrinterName);

  modal.classList.add('visible');
});

// Botón "Detectar" — recarga la lista de impresoras en tiempo real
document.getElementById('btn-detectar-impresoras')?.addEventListener('click', async () => {
  const selectPrinter = document.getElementById('config-impresora-nombre');
  const currentValue = selectPrinter.value;
  const btn = document.getElementById('btn-detectar-impresoras');
  btn.textContent = '⏳';
  btn.disabled = true;
  const found = await cargarImpresorasEnSelect(selectPrinter, currentValue);
  btn.textContent = '🔍 Detectar';
  btn.disabled = false;
  if (found) {
    mostrarToast('✅ Impresoras detectadas en esta computadora', 'success');
  } else {
    mostrarToast('⚠️ No se encontraron impresoras instaladas', 'warning');
  }
});


document.getElementById('btn-cerrar-configuracion')?.addEventListener('click', () => {
  document.getElementById('modal-configuracion').classList.remove('visible');
});

document.getElementById('btn-guardar-configuracion')?.addEventListener('click', async () => {
  const printerName = document.getElementById('config-impresora-nombre').value;
  const paperWidth = document.getElementById('config-impresora-ancho').value;
  const negocioNombre = document.getElementById('config-empresa-nombre').value;
  const negocioDireccion = document.getElementById('config-empresa-direccion').value;
  const negocioWeb = document.getElementById('config-empresa-web').value;

  if (!printerName) {
    mostrarToast('❌ Por favor, selecciona una impresora', 'error');
    return;
  }

  const res1 = await window.electronAPI.saveConfig('impresora_nombre', printerName);
  const res2 = await window.electronAPI.saveConfig('impresora_ancho', paperWidth);
  const res3 = await window.electronAPI.saveConfig('negocio_nombre', negocioNombre);
  const res4 = await window.electronAPI.saveConfig('negocio_direccion', negocioDireccion);
  const res5 = await window.electronAPI.saveConfig('negocio_web', negocioWeb);

  if (res1.ok && res2.ok && res3.ok && res4.ok && res5.ok) {
    mostrarToast('✅ Configuración guardada', 'success');
    document.getElementById('modal-configuracion').classList.remove('visible');
  } else {
    mostrarToast('❌ Error al guardar configuración', 'error');
  }
});
