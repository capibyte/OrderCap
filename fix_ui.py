import io

with io.open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix Categorias Tab Location
# Remove the tab-categorias block from its current location
categorias_block = """    <!-- Contenido Categorias -->
    <div id="tab-categorias" class="tab-content">
      <div class="tab-header">
        <h2>Categorías</h2>
        <button id="btn-nueva-categoria" class="btn btn-primary">+ Nueva Categoría</button>
      </div>
      <div id="lista-categorias"></div>
    </div>"""

content = content.replace(categorias_block + "\n", "")

# Insert it at the end of vista-inventario
insert_target = """        <div class="receta-layout">
          <!-- Esto sera rediseñado, por ahora vacio para evitar doble tag -->
        </div>
      </div>
    </div>"""

# Buscamos donde termina el tab-recetas
tab_recetas_end = "    </div>\n  </main>"
if "    </div>\n  </main>" in content:
   # Ocurre varias veces, busquemos algo especifico
   pass

# A mejor manera de insertarlo es reemplazar la etiqueta de cierre de main de la vista inventario
vista_inventario_end_pattern = """        <div class="receta-productos-list">
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
    </div>
  </main>"""

new_end = """        <div class="receta-productos-list">
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
    </div>

""" + categorias_block + "\n  </main>"

content = content.replace(vista_inventario_end_pattern, new_end)

# Fix Button Texts
content = content.replace('<button id="btn-vista-kanban" class="vista-btn" title="Vista Kanban">⬛⬛</button>', '<button id="btn-vista-kanban" class="vista-btn" title="Vista Kanban">Pedidos</button>')
content = content.replace('<button id="btn-vista-lista" class="vista-btn" title="Vista Lista">☰</button>', '<button id="btn-vista-lista" class="vista-btn" title="Vista Lista">Todos</button>')

with io.open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)
