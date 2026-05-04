import io

with io.open('renderer.js', 'r', encoding='utf-8') as f:
    content = f.read()

split_str = '// --- INVENTARIO LOGIC ------------------------------------------------------'
parts = content.split(split_str)

with io.open('inventario_logic_current.js', 'w', encoding='utf-8') as f:
    f.write(parts[1])
