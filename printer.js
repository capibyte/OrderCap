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
  // Solución robusta para Windows:
  // Intentamos imprimir usando PowerShell con la API nativa de Windows (OpenPrinter/WritePrinter).
  // Esto permite imprimir en cualquier impresora local o de red sin necesidad de compartirla.
  // Si falla o no está disponible, hace un fallback al comando COPY tradicional.
  const nombreImpresora = config.impresora_nombre || 'POS-58';
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: 'file://dummy', // Dummy interface para evitar el error de validación de la librería
    characterSet: CharacterSet.PC858_EURO,
    removeSpecialCharacters: false,
    lineCharacter: '-',
    breakLine: BreakLine.WORD,
  });

  printer.execute = async function() {
    return new Promise((resolve, reject) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { exec } = require('child_process');

        const buffer = this.getBuffer();
        const tempBinPath = path.join(os.tmpdir(), 'ticket.bin');
        fs.writeFileSync(tempBinPath, buffer);

        // Script de PowerShell para enviar bytes RAW directamente a la cola de la impresora usando la API Win32
        const psScript = `
param(
    [string]$PrinterName,
    [string]$FileName
)

$code = @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static bool SendFileToPrinter(string szPrinterName, string szFileName) {
        IntPtr hPrinter = new IntPtr(0);
        DOCINFOA di = new DOCINFOA();
        bool bSuccess = false;
        di.pDocName = "RAW Document";
        di.pDataType = "RAW";
        if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
            if (StartDocPrinter(hPrinter, 1, di)) {
                if (StartPagePrinter(hPrinter)) {
                    byte[] bytes = File.ReadAllBytes(szFileName);
                    int nLength = bytes.Length;
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(nLength);
                    Marshal.Copy(bytes, 0, pUnmanagedBytes, nLength);
                    int dwWritten = 0;
                    bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, nLength, out dwWritten);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                }
                EndDocPrinter(hPrinter);
            }
            ClosePrinter(hPrinter);
        }
        return bSuccess;
    }
}
"@

try {
    # Guard: solo compilar si el tipo no existe ya en esta sesión de PowerShell
    if (-not ([System.Management.Automation.PSTypeName]'RawPrinterHelper').Type) {
        Add-Type -TypeDefinition $code -ErrorAction Stop
    }
    $result = [RawPrinterHelper]::SendFileToPrinter($PrinterName, $FileName)
    if ($result) {
        Write-Output "OK"
        exit 0
    } else {
        throw "No se pudo iniciar el documento de impresion o escribir en la impresora."
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
`;
        const tempPsPath = path.join(os.tmpdir(), 'print_raw.ps1');
        fs.writeFileSync(tempPsPath, psScript, 'utf8');

        const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPsPath}" -PrinterName "${nombreImpresora}" -FileName "${tempBinPath}"`;

        exec(command, (error, stdout, stderr) => {
          this.clear();
          try { fs.unlinkSync(tempPsPath); } catch {}

          if (error) {
            console.warn('[Printer] PowerShell raw print failed, trying fallback...', stderr || error.message);

            // ── FALLBACK: Segundo intento con powershell usando [System.Drawing.Printing] ──
            // Esto funciona aunque el script anterior haya fallado por permisos.
            // Re-escribir el binario temporal (ya que lo limpiamos antes)
            try { fs.writeFileSync(tempBinPath, buffer); } catch (e) {
              reject(new Error(`No se pudo escribir el archivo temporal: ${e.message}`));
              return;
            }

            const psScript2 = `
param([string]$PrinterName, [string]$FileName)
try {
    $bytes = [System.IO.File]::ReadAllBytes($FileName)
    $rawPrint = New-Object System.Drawing.Printing.PrintDocument
    $rawPrint.PrinterSettings.PrinterName = $PrinterName
    if (-not $rawPrint.PrinterSettings.IsValid) {
        Write-Error "Impresora '$PrinterName' no encontrada. Verificar nombre exacto en Configuracion."
        exit 2
    }
    Add-Type -AssemblyName System.Drawing
    $dataToSend = $bytes
    $rawPrint.add_PrintPage({
        param($sender, $e)
        $g = $e.Graphics
    })
    # Para impresoras RAW, usamos el metodo directo de winspool
    $winspool = @"
using System;
using System.Runtime.InteropServices;
public class WinSpool {
    [DllImport("winspool.drv", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
    [DllImport("winspool.drv", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", CharSet=CharSet.Ansi, SetLastError=true)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int level, IntPtr pDocInfo);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
}
"@
    Add-Type -TypeDefinition $winspool -ErrorAction Stop
    $hPrinter = [IntPtr]::Zero
    if (-not [WinSpool]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Error "OpenPrinter fallo. Codigo de error Win32: $err. Verificar que la impresora '$PrinterName' existe."
        exit 1
    }
    [WinSpool]::StartDocPrinter($hPrinter, 1, [IntPtr]::Zero) | Out-Null
    [WinSpool]::StartPagePrinter($hPrinter) | Out-Null
    $written = 0
    [WinSpool]::WritePrinter($hPrinter, $bytes, $bytes.Length, [ref]$written) | Out-Null
    [WinSpool]::EndPagePrinter($hPrinter) | Out-Null
    [WinSpool]::EndDocPrinter($hPrinter) | Out-Null
    [WinSpool]::ClosePrinter($hPrinter) | Out-Null
    Write-Output "OK"
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
`;
            const tempPs2Path = path.join(os.tmpdir(), 'print_raw2.ps1');
            fs.writeFileSync(tempPs2Path, psScript2, 'utf8');

            const fallbackCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPs2Path}" -PrinterName "${nombreImpresora}" -FileName "${tempBinPath}"`;

            exec(fallbackCommand, (fallbackError, fallbackStdout, fallbackStderr) => {
              try { fs.unlinkSync(tempPs2Path); } catch {}
              try { fs.unlinkSync(tempBinPath); } catch {}

              if (fallbackError) {
                // Extraer mensaje relevante del stderr de PowerShell
                const psError1 = (stderr || error.message || '').trim();
                const psError2 = (fallbackStderr || fallbackError.message || '').trim();
                // Detectar si el error es por nombre de impresora inválido
                const errMsg = psError2.includes('no encontrada') || psError2.includes('IsValid') || psError2.includes('OpenPrinter')
                  ? `Impresora "${nombreImpresora}" no encontrada en esta computadora. Verificá el nombre exacto en Configuración > Impresora.`
                  : `Error al enviar datos a la impresora "${nombreImpresora}".\nDetalle: ${psError2 || psError1}`;
                reject(new Error(errMsg));
              } else {
                resolve(fallbackStdout);
              }
            });
            return;
          }

          try { fs.unlinkSync(tempBinPath); } catch {}
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

  const negocio = config.negocio_nombre || 'Burger House';
  const direccion = config.negocio_direccion || '';
  const web = config.negocio_web || 'www.tupagina.com.ar';
  const ahora = new Date();
  const fechaHora = ahora.toLocaleString('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  // ── DISEÑO DEL TICKET ──────────
  // Usamos el ancho configurado dinámicamente o 32 por defecto (58mm)
  const ANCHO_TICKET = parseInt(config.impresora_ancho) || 32;

  printer.alignCenter();
  printer.bold(true);
  printer.setTextSize(1, 1);          // (1, 1) significa Doble Ancho y Doble Alto. (0, 0) es normal.
  printer.println(negocio.toUpperCase());
  printer.setTextNormal();            // Volver a tamaño estándar (0, 0)
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
  
  printer.println(`Envío: ${pedido.tipo_envio || 'Retiro Local'}`);
  if (pedido.tipo_envio === 'Delivery') {
    if (pedido.direccion) printer.println(`Dirección: ${pedido.direccion}`);
    if (pedido.departamento) printer.println(`Dpto/Piso: ${pedido.departamento}`);
  }

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

      // Cálculo de columnas: "Cant x Nombre" a la izquierda y "Precio" a la derecha.
      // Cortamos el nombre a 16 caracteres para que no empuje el precio a la línea de abajo.
      const izq = `${cant}x ${nombre}`;
      const der = formatPrice(subtotal);
      const espacios = ANCHO_TICKET - izq.length - der.length;
      printer.println(izq + ' '.repeat(Math.max(1, espacios)) + der);

      // Modificadores o extras (si los hay por sistema viejo)
      if (item.modificadores || item.extras) {
        const extras = item.modificadores || item.extras;
        if (Array.isArray(extras)) {
          extras.forEach(e => printer.println(`   + ${e}`));
        }
      }

      // Sistema de Combos (Personalización)
      if (item.personalizacion && item.personalizacion.opciones) {
        item.personalizacion.opciones.forEach(opt => {
          // Imprimir "Grupo: Opcion" ej. "Medallones: Doble"
          printer.println(`   ${opt.grupo_nombre}: ${opt.nombre}`);
        });
      }
    });
  } else {
    printer.println(String(productos));
  }

  printer.drawLine();

  if (pedido.tipo_envio === 'Delivery' && pedido.costo_envio > 0) {
    const costoStr = formatPrice(pedido.costo_envio);
    const labelEnvio = 'Costo de Envío:';
    const espEnvio = ANCHO_TICKET - labelEnvio.length - costoStr.length;
    printer.println(labelEnvio + ' '.repeat(Math.max(1, espEnvio)) + costoStr);
    printer.drawLine();
  }

  // Aquí usamos setTextNormal() para que no salga gigante. 
  // Si quisieras que el Total sea grande, podrías usar setTextSize(1, 0) (solo doble ancho).
  printer.setTextNormal();
  const totalStr = formatPrice(pedido.total);
  const labelTotal = 'TOTAL:';
  const espaciosTotal = ANCHO_TICKET - labelTotal.length - totalStr.length;
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
  printer.println(web);

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
