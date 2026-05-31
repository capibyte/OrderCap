const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'renderer.js');
let content = fs.readFileSync(file, 'utf8');

const oldFn = `function mostrarStatsFooter() {
  const footer = document.getElementById('stats-footer');
  if (!footer) return;
  if (state.vistaActual !== 'lista' || state.filtroEstado !== 'entregado') {
    footer.innerHTML = '';
    footer.style.display = 'none';
    return;
  }
  const entregadosHoy = state.pedidos.filter(p => \r\n    !p.archivado && p.estado === 'entregado'\r\n  );
  const totalDinero = entregadosHoy.reduce((acc, p) => acc + (parseFloat(p.total) || 0), 0);
  footer.style.display = 'flex';
  footer.className = 'stats-footer';
  footer.innerHTML = \`
    <div class="stats-item">Pedidos Entregados (Hoy): <strong>\${entregadosHoy.length}</strong></div>
    <div class="stats-item">Total Recaudado (Hoy): <strong>$\${totalDinero.toLocaleString('es-AR')}</strong></div>
  \`;
}`;

const newFn = `function mostrarStatsFooter() {
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
  footer.innerHTML = \`
    <div class="stats-item">Pedidos Entregados (Hoy): <strong>\${entregadosHoy.length}</strong></div>
    <div class="stats-item">Total Recaudado (Hoy): <strong>$\${totalDinero.toLocaleString('es-AR')}</strong></div>
    <div class="stats-item" style="color:#e67e22;">🗑️ Desperdicio: <strong>\${desperdiciosHoy.length} Pedidos</strong></div>
  \`;
}`;

// Try line-by-line approach
const lines = content.split('\n');
const startMarker = "function mostrarStatsFooter() {";
const endMarker = "}\n";

let startIdx = -1;
let endIdx = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === startMarker.trim() && startIdx === -1) {
    startIdx = i;
  }
  if (startIdx !== -1 && i > startIdx && lines[i].trim() === '}') {
    endIdx = i;
    break;
  }
}

if (startIdx !== -1 && endIdx !== -1) {
  console.log(`Found function at lines ${startIdx+1}-${endIdx+1}`);
  const newLines = newFn.split('\n');
  lines.splice(startIdx, endIdx - startIdx + 1, ...newLines);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log('Patch applied successfully!');
} else {
  console.log('Function not found, startIdx:', startIdx, 'endIdx:', endIdx);
  // Show context
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('mostrarStatsFooter')) {
      console.log(`Line ${i+1}: ${lines[i]}`);
    }
  }
}
