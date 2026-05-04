const fs = require('fs');

const inventarioCode = `let inventarioState = {
  insumos: [],
  productos: [],
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
      document.getElementById('tab-' + tabId).classList.add('activo');
      
      inventarioState.tabActual = tabId;
      renderizarInventario();
    });
  });

  document.getElementById('btn-nuevo-insumo').addEventListener('click', () => {
    document.getElementById('insumo-id').value = '';
    document.getElementById('insumo-nombre').value = '';
    document.getElementById('insumo-unidad').value = '';
    document.getElementById('insumo-cantidad').value = '0';
    document.getElementById('insumo-alerta').value = '0';
    document.getElementById('modal-insumo-title').textContent = 'Nuevo Insumo';
    document.getElementById('modal-insumo').classList.add('visible');
  });

  document.getElementById('btn-nuevo-producto').addEventListener('click', () => {
    document.getElementById('producto-id').value = '';
    document.getElementById('producto-nombre').value = '';
    document.getElementById('producto-categoria').value = '';
    document.getElementById('producto-precio').value = '0';
    document.getElementById('producto-stock').value = '0';
    document.getElementById('modal-producto-title').textContent = 'Nuevo Producto';
    document.getElementById('modal-producto').classList.add('visible');
  });

  document.getElementById('btn-guardar-insumo').addEventListener('click', guardarInsumo);
  document.getElementById('btn-guardar-producto').addEventListener('click', guardarProducto);
  
  // Recetas
  document.getElementById('btn-add-insumo-receta').addEventListener('click', () => agregarFilaReceta());
  document.getElementById('btn-guardar-receta').addEventListener('click', guardarReceta);
  
  // Alertas Polling
  setInterval(checkAlerts, 10000);
  checkAlerts();
}

async function checkAlerts() {
  const result = await window.electronAPI.checkStockAlerts();
  const btn = document.getElementById('btn-vista-inventario');
  if (result.ok && result.hasAlerts) {
    btn.classList.add('alert-pulse');
  } else {
    btn.classList.remove('alert-pulse');
  }
}

async function renderizarInventario() {
  if (inventarioState.tabActual === 'insumos') {
    const res = await window.electronAPI.getInsumos();
    if (res.ok) {
      inventarioState.insumos = res.data;
      const html = res.data.map(i => {
        let statusClass = 'status-ok';
        if (i.cantidad_actual <= 0) statusClass = 'status-danger';
        else if (i.cantidad_actual <= i.punto_reposicion) statusClass = 'status-warn';
        
        return '<div class="pedido-card" style="display:flex; justify-content:space-between; align-items:center;">' +
               '  <div>' +
               '    <span class="status-indicator ' + statusClass + '"></span>' +
               '    <strong style="margin-left:8px;">' + escapeHtml(i.nombre) + '</strong>' +
               '    <div style="color:var(--text2); font-size:12px; margin-top:4px;">' +
               '      Cant: ' + i.cantidad_actual + ' ' + escapeHtml(i.unidad_medida) + ' | Alerta en: ' + i.punto_reposicion +
               '    </div>' +
               '  </div>' +
               '  <div>' +
               '    <button class="btn btn-secondary btn-small" onclick="editarInsumo(' + i.id + ')">✏️ Editar</button>' +
               '    <button class="btn btn-secondary btn-small" style="color:var(--danger)" onclick="eliminarInsumo(' + i.id + ')">🗑️</button>' +
               '  </div>' +
               '</div>';
      }).join('');
      document.getElementById('lista-insumos').innerHTML = html || '<div class="empty-state">No hay insumos registrados</div>';
    }
  } else if (inventarioState.tabActual === 'productos' || inventarioState.tabActual === 'recetas') {
    const res = await window.electronAPI.getProductos();
    if (res.ok) {
      inventarioState.productos = res.data;
      if (inventarioState.tabActual === 'productos') {
        const html = res.data.map(p => 
          '<div class="pedido-card" style="display:flex; justify-content:space-between; align-items:center;">' +
          '  <div>' +
          '    <strong>' + escapeHtml(p.nombre) + '</strong> <span class="badge" style="background:var(--surface2)">' + escapeHtml(p.categoria) + '</span>' +
          '    <div style="color:var(--text2); font-size:12px; margin-top:4px;">' +
          '      Precio: $' + p.precio + ' | Stock directo: ' + p.stock_actual +
          '    </div>' +
          '  </div>' +
          '  <div>' +
          '    <button class="btn btn-secondary btn-small" onclick="editarProducto(' + p.id + ')">✏️ Editar</button>' +
          '    <button class="btn btn-secondary btn-small" style="color:var(--danger)" onclick="eliminarProducto(' + p.id + ')">🗑️</button>' +
          '  </div>' +
          '</div>'
        ).join('');
        document.getElementById('lista-productos').innerHTML = html || '<div class="empty-state">No hay productos registrados</div>';
      } else {
        // Tab Recetas
        const listaHtml = res.data.map(p => 
          '<li onclick="seleccionarProductoReceta(' + p.id + ')" id="receta-prod-' + p.id + '">' + escapeHtml(p.nombre) + '</li>'
        ).join('');
        document.getElementById('lista-productos-receta').innerHTML = listaHtml;
        if (inventarioState.productoSeleccionadoId) {
          seleccionarProductoReceta(inventarioState.productoSeleccionadoId);
        }
      }
    }
  }
}

// INSUMOS CRUD
function editarInsumo(id) {
  const i = inventarioState.insumos.find(x => x.id === id);
  if (!i) return;
  document.getElementById('insumo-id').value = i.id;
  document.getElementById('insumo-nombre').value = i.nombre;
  document.getElementById('insumo-unidad').value = i.unidad_medida;
  document.getElementById('insumo-cantidad').value = i.cantidad_actual;
  document.getElementById('insumo-alerta').value = i.punto_reposicion;
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
  };
  if (!data.nombre || !data.unidad_medida) return mostrarToast('Completa todos los campos', 'error');
  
  let res;
  if (data.id) res = await window.electronAPI.updateInsumo(data);
  else res = await window.electronAPI.createInsumo(data);
  
  if (res.ok) {
    document.getElementById('modal-insumo').classList.remove("visible");
    renderizarInventario();
    checkAlerts();
    mostrarToast('Insumo guardado', 'success');
  } else {
    mostrarToast('Error al guardar: ' + res.error, 'error');
  }
}

async function eliminarInsumo(id) {
  if (!confirm("¿Seguro que deseas eliminar este insumo?")) return;
  const res = await window.electronAPI.deleteInsumo(id);
  if (res.ok) renderizarInventario();
}

// PRODUCTOS CRUD
function editarProducto(id) {
  const p = inventarioState.productos.find(x => x.id === id);
  if (!p) return;
  document.getElementById('producto-id').value = p.id;
  document.getElementById('producto-nombre').value = p.nombre;
  document.getElementById('producto-categoria').value = p.categoria;
  document.getElementById('producto-precio').value = p.precio;
  document.getElementById('producto-stock').value = p.stock_actual;
  document.getElementById('modal-producto-title').textContent = 'Editar Producto';
  document.getElementById('modal-producto').classList.add("visible");
}

async function guardarProducto() {
  const data = {
    id: document.getElementById('producto-id').value,
    nombre: document.getElementById('producto-nombre').value,
    categoria: document.getElementById('producto-categoria').value,
    precio: parseFloat(document.getElementById('producto-precio').value) || 0,
    stock_actual: parseInt(document.getElementById('producto-stock').value) || 0,
  };
  if (!data.nombre || !data.categoria) return mostrarToast('Completa todos los campos', 'error');
  
  let res;
  if (data.id) res = await window.electronAPI.updateProducto(data);
  else res = await window.electronAPI.createProducto(data);
  
  if (res.ok) {
    document.getElementById('modal-producto').classList.remove("visible");
    renderizarInventario();
    mostrarToast('Producto guardado', 'success');
  } else {
    mostrarToast('Error al guardar: ' + res.error, 'error');
  }
}

async function eliminarProducto(id) {
  if (!confirm("¿Seguro que deseas eliminar este producto?")) return;
  const res = await window.electronAPI.deleteProducto(id);
  if (res.ok) renderizarInventario();
}

// RECETAS CRUD
window.seleccionarProductoReceta = async function(id) {
  inventarioState.productoSeleccionadoId = id;
  document.querySelectorAll('#lista-productos-receta li').forEach(li => li.classList.remove('activo'));
  const activeLi = document.getElementById('receta-prod-' + id);
  if (activeLi) activeLi.classList.add('activo');
  
  const p = inventarioState.productos.find(x => x.id === id);
  if (!p) return;
  document.getElementById('receta-titulo').textContent = 'Receta para: ' + p.nombre;
  
  document.getElementById('btn-add-insumo-receta').style.display = 'block';
  document.getElementById('btn-guardar-receta').parentElement.style.display = 'block';
  
  if (inventarioState.insumos.length === 0) {
     const resIns = await window.electronAPI.getInsumos();
     if (resIns.ok) inventarioState.insumos = resIns.data;
  }
  
  const res = await window.electronAPI.getReceta(id);
  const itemsContainer = document.getElementById('receta-items');
  itemsContainer.innerHTML = '';
  
  if (res.ok && res.data.length > 0) {
    res.data.forEach(item => agregarFilaReceta(item));
  } else {
    agregarFilaReceta();
  }
}

function agregarFilaReceta(data = null) {
  const container = document.getElementById('receta-items');
  const insumosOptions = inventarioState.insumos.map(i => 
    '<option value="' + i.id + '" ' + (data && data.insumo_id === i.id ? 'selected' : '') + '>' + escapeHtml(i.nombre) + ' (' + escapeHtml(i.unidad_medida) + ')</option>'
  ).join('');
  
  const div = document.createElement('div');
  div.className = 'receta-item-row';
  div.innerHTML = 
    '<select class="edit-input select-insumo">' +
    '  <option value="">Seleccione insumo...</option>' +
       insumosOptions +
    '</select>' +
    '<input type="number" class="edit-input input-cant-insumo" step="0.01" value="' + (data ? data.cantidad_necesaria : '') + '" placeholder="Cant.">' +
    '<button class="btn-icon" onclick="this.parentElement.remove()" title="Quitar">✕</button>';
  
  container.appendChild(div);
}

async function guardarReceta() {
  if (!inventarioState.productoSeleccionadoId) return;
  
  const items = [];
  document.querySelectorAll('.receta-item-row').forEach(row => {
    const insumo_id = row.querySelector('.select-insumo').value;
    const cantidad_necesaria = parseFloat(row.querySelector('.input-cant-insumo').value);
    
    if (insumo_id && cantidad_necesaria > 0) {
      items.push({ insumo_id: parseInt(insumo_id), cantidad_necesaria });
    }
  });
  
  const res = await window.electronAPI.saveReceta(inventarioState.productoSeleccionadoId, items);
  if (res.ok) {
    mostrarToast('Receta guardada con éxito', 'success');
  } else {
    mostrarToast('Error al guardar receta: ' + res.error, 'error');
  }
}

window.editarInsumo = editarInsumo;
window.eliminarInsumo = eliminarInsumo;
window.editarProducto = editarProducto;
window.eliminarProducto = eliminarProducto;
`;

let renderer = fs.readFileSync('renderer.js', 'utf8');
const marker = '// --- INVENTARIO LOGIC ------------------------------------------------------';
const parts = renderer.split(marker);
let newRenderer = parts[0] + marker + '\n\n' + inventarioCode;
fs.writeFileSync('renderer.js', newRenderer, 'utf8');
console.log('Fixed renderer.js correctly');
