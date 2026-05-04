let inventarioState = {
  insumos: [],
  productos: [],
  categorias: [],
  tabActual: 'insumos',
  productoSeleccionadoId: null
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

  document.getElementById('btn-nuevo-producto')?.addEventListener('click', () => {
    document.getElementById('producto-id').value = '';
    document.getElementById('producto-nombre').value = '';
    document.getElementById('producto-categoria').value = '';
    document.getElementById('producto-precio').value = '0';
    document.getElementById('producto-stock').value = '0';
    document.getElementById('modal-producto-title').textContent = 'Nuevo Producto';
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
      el.innerHTML = '<option value="">' + defaultText + '</option>' + optionsArray.map(c => '<option value="'+c.id+'">'+escapeHtml(c.nombre)+'</option>').join('');
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
        const catName = p.categoria_id ? inventarioState.categorias.find(c => c.id === p.categoria_id)?.nombre : 'Sin Categoría';
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
  }
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
  
  const res = await window.electronAPI.saveReceta(productoId, items);
  if (res.ok) {
    document.getElementById('modal-receta').classList.remove('visible');
    renderizarInventario();
    mostrarToast('Receta guardada', 'success');
  } else mostrarToast('Error: ' + res.error, 'error');
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
  const data = {
    id: document.getElementById('insumo-id').value,
    nombre: document.getElementById('insumo-nombre').value,
    unidad_medida: document.getElementById('insumo-unidad').value,
    cantidad_actual: parseFloat(document.getElementById('insumo-cantidad').value) || 0,
    punto_reposicion: parseFloat(document.getElementById('insumo-alerta').value) || 0,
    categoria_id: parseInt(document.getElementById('insumo-categoria').value) || null
  };
  console.log('[DEBUG] Guardando Insumo:', data);
  let res = data.id ? await window.electronAPI.updateInsumo(data) : await window.electronAPI.createInsumo(data);
  if (res.ok) { document.getElementById('modal-insumo').classList.remove("visible"); renderizarInventario(); checkAlerts(); }
  else console.error('[ERROR] Guardar Insumo:', res.error);
}
async function eliminarInsumo(id) { if (confirm("¿Eliminar insumo?")) { await window.electronAPI.deleteInsumo(id); renderizarInventario(); } }

function editarProducto(id) {
  const p = inventarioState.productos.find(x => x.id === id);
  if (!p) return;
  document.getElementById('producto-id').value = p.id;
  document.getElementById('producto-nombre').value = p.nombre;
  document.getElementById('producto-categoria').value = p.categoria_id || '';
  document.getElementById('producto-precio').value = p.precio;
  document.getElementById('producto-stock').value = p.stock_actual;
  document.getElementById('modal-producto').classList.add("visible");
}
async function guardarProducto() {
  const catId = parseInt(document.getElementById('producto-categoria').value) || null;
  const data = {
    id: document.getElementById('producto-id').value, nombre: document.getElementById('producto-nombre').value,
    categoria_id: catId, precio: parseFloat(document.getElementById('producto-precio').value) || 0,
    stock_actual: parseInt(document.getElementById('producto-stock').value) || 0,
  };
  console.log('[DEBUG] Guardando Producto:', data);
  let res = data.id ? await window.electronAPI.updateProducto(data) : await window.electronAPI.createProducto(data);
  if (res.ok) { document.getElementById('modal-producto').classList.remove("visible"); renderizarInventario(); }
  else {
    console.error('[ERROR] Guardar Producto:', res.error);
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
  const data = {
    id: document.getElementById('categoria-id').value, nombre: document.getElementById('categoria-nombre').value,
    tipo: document.getElementById('categoria-tipo').value, color: document.getElementById('categoria-color').value,
  };
  console.log('[DEBUG] Guardando Categoria:', data);
  let res = data.id ? await window.electronAPI.updateCategoria(data) : await window.electronAPI.createCategoria(data);
  if (res.ok) { document.getElementById('modal-categoria').classList.remove("visible"); renderizarInventario(); }
  else console.error('[ERROR] Guardar Categoria:', res.error);
}
async function eliminarCategoria(id) { if (confirm("¿Eliminar categoría?")) { await window.electronAPI.deleteCategoria(id); renderizarInventario(); } }
