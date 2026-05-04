import io

with io.open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Redesign Recetas Tab and Add Categorias Tab
old_recetas_tab = """    <!-- Contenido Recetas -->
    <div id="tab-recetas" class="tab-content">
      <div class="tab-header">
        <h2>Gestión de Recetas</h2>
      </div>
      <div class="receta-layout">
        <div class="receta-productos-list">
          <ul id="lista-productos-receta"></ul>
        </div>
        <div class="receta-editor">
          <h3 id="receta-titulo">Seleccione un producto...</h3>
          <div id="receta-items"></div>
          <button id="btn-add-insumo-receta" class="btn btn-secondary btn-small" style="display:none; margin-top:10px">+ Agregar Insumo</button>
          <div class="receta-actions" style="display:none; margin-top:20px">
             <button id="btn-guardar-receta" class="btn btn-primary">💾 Guardar Receta</button>
          </div>
        </div>
      </div>
    </div>"""

new_tabs_content = """    <!-- Contenido Recetas -->
    <div id="tab-recetas" class="tab-content">
      <div class="tab-header">
        <h2>Recetas Armadas</h2>
        <button id="btn-nueva-receta" class="btn btn-primary">+ Nueva Receta</button>
      </div>
      <div id="lista-recetas-creadas"></div>
    </div>

    <!-- Contenido Categorias -->
    <div id="tab-categorias" class="tab-content">
      <div class="tab-header">
        <h2>Categorías</h2>
        <button id="btn-nueva-categoria" class="btn btn-primary">+ Nueva Categoría</button>
      </div>
      <div id="lista-categorias"></div>
    </div>"""

content = content.replace(old_recetas_tab, new_tabs_content)

# 2. Add Modal Receta
modal_receta = """
  <!-- ── Modal Receta ────────────────────────────────────────── -->
  <div id="modal-receta" class="modal-overlay">
    <div class="modal-container" style="width: 500px;">
      <div class="modal-header">
        <h2 id="modal-receta-title">Armar Receta</h2>
        <button class="btn-icon" id="btn-cerrar-modal-receta">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group edit-mode">
           <label>Producto</label>
           <select id="receta-producto-select" class="edit-input" style="margin-bottom:20px;">
              <option value="">Seleccione un producto...</option>
           </select>
           
           <h3 style="font-size: 14px; margin-bottom:10px; color:var(--text1)">Insumos Necesarios</h3>
           <div id="receta-items"></div>
           <button id="btn-add-insumo-receta" class="btn btn-secondary btn-small" style="margin-top:10px">+ Agregar Insumo</button>
        </div>
      </div>
      <div class="modal-actions">
        <button id="btn-guardar-receta" class="btn btn-primary">💾 Guardar Receta</button>
      </div>
    </div>
  </div>
"""

content = content.replace('<!-- ── Modal Categoria ────────────────────────────────────────── -->', modal_receta + '\n  <!-- ── Modal Categoria ────────────────────────────────────────── -->')

with io.open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)
