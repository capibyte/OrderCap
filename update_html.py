import re

html_content = open('index.html', 'r', encoding='utf-8').read()

# 1. Add Categorias tab button
categorias_tab_btn = '<button data-tab="categorias" class="tab-btn">🏷️ Categorías</button>'
html_content = html_content.replace('<button data-tab="recetas" class="tab-btn">📝 Recetas</button>', '<button data-tab="recetas" class="tab-btn">📝 Recetas</button>\n      ' + categorias_tab_btn)

# 2. Add Categorias tab content
categorias_tab_content = """
    <!-- Contenido Categorias -->
    <div id="tab-categorias" class="tab-content">
      <div class="tab-header">
        <h2>Categorías</h2>
        <button id="btn-nueva-categoria" class="btn btn-primary">+ Nueva Categoría</button>
      </div>
      <div id="lista-categorias"></div>
    </div>
"""
html_content = html_content.replace('</main>', categorias_tab_content + '\n  </main>')

# 3. Add Modal Categoria
modal_categoria = """
  <!-- ── Modal Categoria ────────────────────────────────────────── -->
  <div id="modal-categoria" class="modal-overlay">
    <div class="modal-container" style="width: 400px;">
      <div class="modal-header">
        <h2 id="modal-categoria-title">Nueva Categoría</h2>
        <button class="btn-icon" id="btn-cerrar-modal-categoria">✕</button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="categoria-id">
        <div class="form-group edit-mode">
           <label>Nombre</label>
           <input type="text" id="categoria-nombre" class="edit-input" style="margin-bottom:10px;">
           <label>Aplica a</label>
           <select id="categoria-tipo" class="edit-input" style="margin-bottom:10px;">
             <option value="producto">Producto (Catálogo)</option>
             <option value="insumo">Insumo (Depósito)</option>
           </select>
           <label>Color Visual</label>
           <input type="color" id="categoria-color" class="edit-input" value="#4b6584">
        </div>
      </div>
      <div class="modal-actions">
        <button id="btn-guardar-categoria" class="btn btn-primary">💾 Guardar</button>
      </div>
    </div>
  </div>
"""
html_content = html_content.replace('<!-- ── Notificaciones ───────────────────────────────────────────── -->', modal_categoria + '\n  <!-- ── Notificaciones ───────────────────────────────────────────── -->')

# 4. Modify modal-insumo
# Remove onclick
html_content = html_content.replace('''<button class="btn-icon" onclick="document.getElementById('modal-insumo').classList.remove('visible')">✕</button>''', '''<button class="btn-icon" id="btn-cerrar-modal-insumo">✕</button>''')
# Change unidad_medida to select, add categoria
insumo_fields_old = """           <label>Unidad de Medida (ej. gr, unid)</label>
           <input type="text" id="insumo-unidad" class="edit-input" style="margin-bottom:10px;">"""
insumo_fields_new = """           <label>Unidad de Medida</label>
           <select id="insumo-unidad" class="edit-input" style="margin-bottom:10px;">
              <option value="Unidad">Unidad</option>
              <option value="Kg">Kilogramo (Kg)</option>
              <option value="Gr">Gramo (Gr)</option>
              <option value="Litro">Litro (L)</option>
              <option value="Ml">Mililitro (Ml)</option>
           </select>
           <label>Categoría</label>
           <select id="insumo-categoria" class="edit-input" style="margin-bottom:10px;">
              <option value="">Sin Categoría</option>
           </select>"""
html_content = html_content.replace(insumo_fields_old, insumo_fields_new)

# 5. Modify modal-producto
html_content = html_content.replace('''<button class="btn-icon" onclick="document.getElementById('modal-producto').classList.remove('visible')">✕</button>''', '''<button class="btn-icon" id="btn-cerrar-modal-producto">✕</button>''')

producto_fields_old = """           <label>Categoría</label>
           <input type="text" id="producto-categoria" class="edit-input" style="margin-bottom:10px;">"""
producto_fields_new = """           <label>Categoría</label>
           <select id="producto-categoria" class="edit-input" style="margin-bottom:10px;">
              <option value="">Sin Categoría</option>
           </select>"""
html_content = html_content.replace(producto_fields_old, producto_fields_new)

# 6. Add Filter Selects in Headers
insumos_header_old = """      <div class="tab-header">
        <h2>Insumos</h2>
        <button id="btn-nuevo-insumo" class="btn btn-primary">+ Nuevo Insumo</button>
      </div>"""
insumos_header_new = """      <div class="tab-header">
        <h2>Insumos</h2>
        <select id="filtro-insumo-categoria" class="edit-input" style="width:200px; margin-left:20px;">
           <option value="">Todas las categorías</option>
        </select>
        <button id="btn-nuevo-insumo" class="btn btn-primary">+ Nuevo Insumo</button>
      </div>"""
html_content = html_content.replace(insumos_header_old, insumos_header_new)

productos_header_old = """      <div class="tab-header">
        <h2>Productos</h2>
        <button id="btn-nuevo-producto" class="btn btn-primary">+ Nuevo Producto</button>
      </div>"""
productos_header_new = """      <div class="tab-header">
        <h2>Productos</h2>
        <select id="filtro-producto-categoria" class="edit-input" style="width:200px; margin-left:20px;">
           <option value="">Todas las categorías</option>
        </select>
        <button id="btn-nuevo-producto" class="btn btn-primary">+ Nuevo Producto</button>
      </div>"""
html_content = html_content.replace(productos_header_old, productos_header_new)

open('index.html', 'w', encoding='utf-8').write(html_content)
print("index.html updated successfully")
