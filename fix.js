const fs = require('fs');
let renderer = fs.readFileSync('renderer.js', 'utf8');
const marker = '// --- INVENTARIO LOGIC ------------------------------------------------------';
const parts = renderer.split(marker);
let newRenderer = parts[0] + marker + '\n';
newRenderer += fs.readFileSync('scratch_inventario.js', 'utf8');
fs.writeFileSync('renderer.js', newRenderer, 'utf8');
console.log('Fixed renderer.js');
