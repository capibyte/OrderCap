// src/main/printer.js
// ─────────────────────────────────────────────────────────────────────────────
// IMPRESIÓN SILENCIOSA vía ESC/POS
// Usa node-thermal-printer para enviar comandos directamente a la impresora
// sin abrir ningún diálogo del sistema operativo.
//
// CONEXIONES SOPORTADAS:
//   - USB directo (más común): interfaceType = 'usb'
//   - Red/WiFi (ej: Epson con Ethernet): interfaceType = 'network', deviceAddress = IP
//   - Serial: interfaceType = 'serial', deviceAddress = 'COM3' o '/dev/ttyUSB0'
//
// LIBRERÍAS:
//   node-thermal-printer: abstrae los comandos ESC/POS
//   usb: para conexión USB de bajo nivel (si usás interfaceType = 'usb')
// ─────────────────────────────────────────────────────────────────────────────

const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer');
const { getDatabase } = require('./database');

// ── Obtener configuración de impresora desde la DB ─────────────────────────
function getPrinterConfig() {
  try {
    const db = getDatabase();
    const rows = db.prepare(`SELECT clave, valor FROM configuracion WHERE clave LIKE 'impresora_%' OR clave LIKE '%negocio%'`).all();
    const config = {};
    rows.forEach(r => { config[r.clave] = r.valor; });
    return config;
  } catch {
    return {};
  }
}

// ── Crear instancia de la impresora ─────────────────────────────────────────
function createPrinter(config) {
  // Solución para Windows sin necesidad de instalar controladores nativos de Node (node-printer):
  // Se enviará el archivo a la impresora compartida en la red local.
  // IMPORTANTE: La impresora debe estar compartida en Windows con el nombre 'POS-58'
  const nombreImpresora = 'POS-58';
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: 'file://dummy', // Dummy interface para evitar el error de validación de la librería
    characterSet: CharacterSet.PC858_EURO,
    removeSpecialCharacters: false,
    lineCharacter: '-',
    breakLine: BreakLine.WORD,
  });

  // Sobrescribimos el método execute para usar el comando COPY nativo de Windows
  // Esto nos dará el error REAL de red de Windows en lugar de un "timeout" genérico
  printer.execute = async function() {
    return new Promise((resolve, reject) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { exec } = require('child_process');

        const buffer = this.getBuffer();
        const tempPath = path.join(os.tmpdir(), 'ticket.bin');
        fs.writeFileSync(tempPath, buffer);

        // Usar 127.0.0.1 suele ser más confiable que localhost para recursos compartidos en Windows
        const command = `copy /B "${tempPath}" "\\\\127.0.0.1\\\\${nombreImpresora}"`;
        
        exec(command, (error, stdout, stderr) => {
          this.clear();
          if (error) {
            reject(new Error(`CMD Error: ${stderr || error.message}`));
            return;
          }
          resolve(stdout);
        });
      } catch (err) {
        this.clear();
        reject(err);
      }
    });
  };

  return printer;
}

// ── Formatear precio ────────────────────────────────────────────────────────
function formatPrice(n) {
  return `$${parseFloat(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
}

// ── FUNCIÓN PRINCIPAL: Imprimir ticket ─────────────────────────────────────
async function printTicket(pedido) {
  const config = getPrinterConfig();
  const printer = createPrinter(config);

  // Verificar conexión con la impresora
  // NOTA: En Windows, fs.existsSync siempre devuelve false para impresoras compartidas en red (\\localhost\...)
  // por lo que omitimos este chequeo y dejamos que falle en printer.execute() si realmente no hay conexión.
  // const isConnected = await printer.isPrinterConnected();
  // if (!isConnected) {
  //   throw new Error('No se pudo conectar con la impresora. Verificá que esté encendida y conectada.');
  // }

  // Parsear productos (vienen como JSON string desde SQLite)
  let productos = [];
  try {
    productos = typeof pedido.productos === 'string'
      ? JSON.parse(pedido.productos)
      : pedido.productos;
  } catch {
    productos = [{ nombre: pedido.productos, cantidad: 1, precio: pedido.total }];
  }

  const negocio = config.nombre_negocio || 'Burger House';
  const direccion = config.direccion_negocio || '';
  const ahora = new Date();
  const fechaHora = ahora.toLocaleString('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  // ── DISEÑO DEL TICKET (32 caracteres de ancho — estándar 58mm) ──────────

  printer.alignCenter();
  printer.bold(true);
  printer.setTextSize(1, 1);          // Doble tamaño para el nombre del negocio
  printer.println(negocio.toUpperCase());
  printer.setTextNormal();
  printer.bold(false);

  if (direccion) printer.println(direccion);
  printer.drawLine();

  // Número y fecha del pedido
  printer.alignLeft();
  printer.bold(true);
  printer.println(`PEDIDO: ${pedido.numero_pedido || '#' + pedido.id}`);
  printer.bold(false);
  printer.println(`Fecha:  ${fechaHora}`);
  printer.println(`Cliente: ${pedido.cliente_nombre}`);
  if (pedido.cliente_tel) printer.println(`Tel: ${pedido.cliente_tel}`);

  printer.drawLine();

  // ── Detalle de productos ────────────────────────────────────────────────
  printer.bold(true);
  printer.println('ITEMS:');
  printer.bold(false);

  if (Array.isArray(productos) && productos.length > 0) {
    productos.forEach(item => {
      const nombre = (item.nombre || item.name || 'Producto').substring(0, 16);
      const cant = item.cantidad || item.quantity || 1;
      const precio = item.precio || item.price || 0;
      const subtotal = cant * precio;

      // Línea: "2x Burger Clásica       $2.400,00"
      const izq = `${cant}x ${nombre}`;
      const der = formatPrice(subtotal);
      const espacios = 32 - izq.length - der.length;
      printer.println(izq + ' '.repeat(Math.max(1, espacios)) + der);

      // Modificadores o extras (si los hay)
      if (item.modificadores || item.extras) {
        const extras = item.modificadores || item.extras;
        if (Array.isArray(extras)) {
          extras.forEach(e => printer.println(`   + ${e}`));
        }
      }
    });
  } else {
    printer.println(String(productos));
  }

  printer.drawLine();

  // ── Total ────────────────────────────────────────────────────────────────
  printer.bold(true);
  printer.setTextNormal();
  const totalStr = formatPrice(pedido.total);
  const labelTotal = 'TOTAL:';
  const espaciosTotal = 32 - labelTotal.length - totalStr.length;
  printer.println(labelTotal + ' '.repeat(Math.max(1, espaciosTotal)) + totalStr);
  printer.setTextNormal();
  printer.bold(false);

  // Método de pago
  const pago = (pedido.metodo_pago || 'efectivo').toUpperCase();
  printer.println(`Pago: ${pago}`);

  // Notas del pedido
  if (pedido.notas && pedido.notas.trim()) {
    printer.drawLine();
    printer.bold(true);
    printer.println('NOTAS:');
    printer.bold(false);
    printer.println(pedido.notas);
  }

  printer.drawLine();

  // ── Pie del ticket ───────────────────────────────────────────────────────
  printer.alignCenter();
  printer.println('¡Gracias por tu pedido!');
  printer.println('www.tupagina.com.ar');

  // Avanzar papel y cortar
  printer.newLine();
  printer.newLine();
  printer.cut();  // Corte automático del papel

  // ── Enviar a la impresora ────────────────────────────────────────────────
  try {
    await printer.execute();
    console.log(`[Printer] Ticket impreso: ${pedido.numero_pedido || pedido.id}`);
  } catch (error) {
    console.error('[Printer Error] Falló printer.execute():', error);
    // Extraer el mensaje real de error (a veces es un string, a veces un objeto Error)
    const detalleError = error.message ? error.message : JSON.stringify(error);
    throw new Error(`Error al enviar datos: ${detalleError}`);
  }
}

module.exports = { printTicket };
