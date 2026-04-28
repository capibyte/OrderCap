# 🚀 Comandos de terminal y guía de setup

## 1. Inicializar el proyecto

```bash
# Crear carpeta y entrar
mkdir burger-orders && cd burger-orders

# Inicializar npm (acepta defaults)
npm init -y

# Instalar dependencias de producción
npm install \
  electron@29 \
  better-sqlite3@9 \
  express@4 \
  cors@2 \
  node-thermal-printer@4 \
  usb@2 \
  electron-store@8

# Instalar devDependencies
npm install --save-dev electron-builder@24

# En Windows, si hay problemas compilando módulos nativos:
npm install --save-dev @electron/rebuild
npx electron-rebuild
```

## 2. Crear la estructura de carpetas

```bash
mkdir -p src/main src/preload src/renderer data
```

## 3. Correr la app en desarrollo

```bash
npm start
# o para ver logs más detallados:
NODE_ENV=development npm start
```

## 4. Compilar para producción (Windows .exe)

```bash
npm run build:win
# El instalador queda en /dist/
```

---

## 5. Configuración de n8n

### Workflow para capturar pedidos de WhatsApp:

**Nodos necesarios:**
1. **Webhook** (trigger) — recibe el mensaje de WhatsApp Business / Baileys / n8n WhatsApp node
2. **Function** — parsea el texto del mensaje
3. **HTTP Request** — envía el pedido a Express

### Nodo Function (parsear mensaje):
```javascript
// Ejemplo de parsing de un mensaje de WhatsApp con formato Pency
const mensaje = $json.body || $json.message || '';

// Pency suele enviar algo como:
// "🛒 Nuevo pedido de Juan García
// - 2x Burger Clásica $1200 c/u
// - 1x Papas Fritas $500
// Total: $2900
// Pago: Mercado Pago"

const nombreMatch = mensaje.match(/pedido de (.+)/i);
const totalMatch = mensaje.match(/total[:\s]+\$?([\d.,]+)/i);
const pagoMatch = mensaje.match(/pago[:\s]+(.+)/i);

// Parsear productos (simplificado — ajustá al formato de Pency)
const productos = [];
const lineas = mensaje.split('\n');
for (const linea of lineas) {
  const match = linea.match(/[-•]\s*(\d+)x\s+(.+?)\s+\$?([\d.,]+)/);
  if (match) {
    productos.push({
      cantidad: parseInt(match[1]),
      nombre: match[2].trim(),
      precio: parseFloat(match[3].replace('.', '').replace(',', '.'))
    });
  }
}

return [{
  json: {
    cliente_nombre: nombreMatch ? nombreMatch[1].trim() : 'Cliente',
    cliente_tel: $json.from || '',
    productos: productos,
    total: totalMatch ? parseFloat(totalMatch[1].replace('.', '').replace(',', '.')) : 0,
    metodo_pago: pagoMatch ? pagoMatch[1].trim().toLowerCase() : 'efectivo',
    fuente: 'whatsapp'
  }
}];
```

### Nodo HTTP Request (enviar a Express):
```
Method: POST
URL: http://localhost:3001/api/pedidos
Headers:
  Content-Type: application/json
  x-api-key: burger-secret-2024
Body: {{ $json }}
```

---

## 6. Detectar tu impresora USB

### En Linux/Mac:
```bash
lsusb
# Buscá algo como: "Epson TM-T20" → anota VID y PID
```

### En Windows (PowerShell):
```powershell
Get-WmiObject Win32_USBControllerDevice | 
  ForEach-Object { [Wmi]$_.Dependent } | 
  Select-Object Name, DeviceID
```

### Actualizar VID/PID en printer.js:
```javascript
// En createPrinter() cuando tipo === 'usb':
// Epson TM-T20:  vid=0x04b8, pid=0x0202
// Star TSP100:   vid=0x0519, pid=0x0003
// Bixolon SRP:   vid=0x1504, pid=0x0006
```

### Probar impresión directa sin Electron (debug):
```bash
node -e "
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const p = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: 'tcp://192.168.1.100:9100' });
p.println('TEST IMPRESION'); p.cut(); p.execute().then(() => console.log('OK')).catch(console.error);
"
```

---

## 7. Módulos nativos en Electron (importante)

`better-sqlite3` y `usb` son módulos nativos (C++) que deben compilarse
para la versión correcta de Node.js que usa Electron.

Si ves errores como `MODULE_NOT_FOUND` o `Invalid ELF header`:

```bash
# Instalar electron-rebuild
npm install --save-dev @electron/rebuild

# Recompilar todos los módulos nativos para tu versión de Electron
npx electron-rebuild

# O solo los que necesitás:
npx electron-rebuild -f -w better-sqlite3
npx electron-rebuild -f -w usb
```

En package.json podés agregar:
```json
"scripts": {
  "postinstall": "electron-rebuild"
}
```
Así se ejecuta automáticamente después de cada `npm install`.
