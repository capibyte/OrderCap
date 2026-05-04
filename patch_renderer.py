import io

with io.open('renderer.js', 'r', encoding='utf-8') as f:
    renderer_content = f.read()

split_str = '// --- INVENTARIO LOGIC ------------------------------------------------------'
parts = renderer_content.split(split_str)

with io.open('inventario_logic_new.js', 'r', encoding='utf-8') as f:
    new_logic = f.read()

new_renderer_content = parts[0] + split_str + '\n\n' + new_logic

with io.open('renderer.js', 'w', encoding='utf-8') as f:
    f.write(new_renderer_content)
