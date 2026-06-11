const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { getDatabase } = require('./database');
const { procesarEInsertarPedido } = require('./server');

let client = null;

/**
 * Inicializa el cliente nativo de WhatsApp.
 * @param {object|function} mainWindowGetter - Función que retorna la ventana principal de Electron
 */
function initWhatsApp(mainWindowGetter) {
  console.log('[WhatsApp] Inicializando servicio nativo...');
  
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  // Evento para generar y enviar el QR en base64
  client.on('qr', async (qr) => {
    console.log('[WhatsApp] Código QR generado');
    try {
      const qrBase64 = await qrcode.toDataURL(qr);
      const mainWindow = typeof mainWindowGetter === 'function' ? mainWindowGetter() : mainWindowGetter;
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('whatsapp:qr', qrBase64);
      }
    } catch (err) {
      console.error('[WhatsApp] Error al convertir QR a base64:', err);
    }
  });

  // Conexión exitosa
  client.on('ready', () => {
    console.log('[WhatsApp] Cliente conectado y listo!');
    const mainWindow = typeof mainWindowGetter === 'function' ? mainWindowGetter() : mainWindowGetter;
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('whatsapp:ready');
    }
  });

  // Desconexión
  client.on('disconnected', (reason) => {
    console.log('[WhatsApp] Cliente desconectado:', reason);
    const mainWindow = typeof mainWindowGetter === 'function' ? mainWindowGetter() : mainWindowGetter;
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('whatsapp:disconnected', reason);
    }
  });

  // Escuchar mensajes entrantes (message_create para multidispositivo)
  client.on('message_create', async (msg) => {
    // Filtro anti-spam silencioso: Ignorar paquetes de sincronización vacíos
    if (!msg.body || msg.body.trim() === '') return;

    // 1. Log absoluto para confirmar que el evento disparó
    console.log('\n[WhatsApp] EVENTO MESSAGE_CREATE DISPARADO');
    
    // 2. Filtro de salida: Ignoramos los mensajes que enviamos nosotros mismos
    if (msg.fromMe) {
      return; 
    }

    // 3. Log del mensaje entrante
    console.log('[WhatsApp] Mensaje entrante de:', msg.from, '| Cuerpo:', msg.body);

    // 4. Verificación de seguridad básica
    if (!msg.body) return;

    // 5. Sanitización
    let cleanText = msg.body.replace(/[*_~]/g, "");

    // 6. Verificamos si es un pedido
    if (cleanText.includes('PEDIDO:') || cleanText.includes('Nombre completo:')) {
      console.log('[WhatsApp] ¡Pedido detectado! Iniciando parseo...');
      
      try {
        const from = msg.from || '';
        // Verificar que provenga de un chat normal (no estados, no grupos)
        if ((from.endsWith('@c.us') || from.endsWith('@lid') || !from.includes('@g.us')) && !msg.isGroup) {
          const pedidoObj = parsearMensajeWhatsApp(msg.body, from);
          
          if (pedidoObj) {
            console.log('[WhatsApp] Parseo exitoso. Insertando en base de datos...');
            const db = getDatabase();
            // Inserción directa en la base de datos y actualización de UI
            const result = procesarEInsertarPedido(db, pedidoObj, mainWindowGetter);
            console.log(`[WhatsApp] Pedido guardado en DB (ID: ${result.savedPedido.id}, Num: ${result.savedPedido.numero_pedido})`);
          } else {
            console.log('[WhatsApp] El mensaje contenía palabras clave pero no cumplía con la estructura de un pedido.');
          }
        } else {
          console.log('[WhatsApp] Ignorado por no ser un chat normal o ser un grupo.');
        }
      } catch (error) {
        console.error('[WhatsApp] CRÍTICO - Error procesando el pedido:', error);
      }
    }
  });

  // Lanzar inicialización
  client.initialize().catch(err => {
    console.error('[WhatsApp] Error durante la inicialización:', err);
  });
}

/**
 * Parsea el texto del mensaje de WhatsApp buscando patrones de pedido.
 * Tolerante a fallos de codificación (Mojibake) en caracteres especiales y tildes.
 * @param {string} body - Cuerpo del mensaje
 * @param {string} fromNumber - Número de origen
 * @returns {object|null} Objeto del pedido o null si no coincide con un pedido válido
 */
function parsearMensajeWhatsApp(body, fromNumber) {
  if (!body) return null;

  // Sanitización robusta
  let cleanText = body.replace(/[*_~]/g, "");

  // Extracción con comodines '.' para evitar fallos de codificación (UTF-8)
  const id_pencyl = cleanText.match(/PEDIDO:\s*(.*?)(?=\s*Estado del pago:|$)/i)?.[1]?.trim() || "";
  const cliente_nombre = cleanText.match(/Nombre completo:\s*(.*?)(?=\s*Forma de pago:|$)/i)?.[1]?.trim() || "Cliente WhatsApp";
  const metodo_pago = cleanText.match(/Forma de pago:\s*(.*?)(?=\s*M.todo de entrega:|$)/i)?.[1]?.trim() || "Efectivo";
  const tipo_envio = cleanText.match(/M.todo de entrega:\s*(.*?)(?=\s*Direcci.n de env.o:|$)/i)?.[1]?.trim() || "Retiro Local";
  const direccion = cleanText.match(/Direcci.n de env.o:\s*(.*?)(?=\s*Departamento\?:|$)/i)?.[1]?.trim() || "";
  const departamento = cleanText.match(/Departamento\?:\s*(.*?)(?=\s*Aclaraciones del pedido:|\s*N.mero de Contacto:|$)/i)?.[1]?.trim() || "";
  const aclaraciones = cleanText.match(/Aclaraciones del pedido:\s*(.*?)(?=\s*N.mero de Contacto:|$)/i)?.[1]?.trim() || "";

  // El teléfono ya lo estabas extrayendo bien con tu lógica anterior, mantenla.
  let cliente_tel = cleanText.match(/N.mero de Contacto:\s*(.*?)(?=\s*\||$)/i)?.[1]?.trim();
  if (!cliente_tel && fromNumber) {
    cliente_tel = fromNumber.split('@')[0].trim();
  }

  // Costo de envío y Total (necesarios para la comparación en el backend y evitar falsas alertas de discrepancia)
  const costoEnvioMatch = cleanText.match(/Costo de env.o:\s*\$?\s*([\d.,]+)/i);
  const costo_envio = costoEnvioMatch ? parseFloat(costoEnvioMatch[1].replace(/\./g, '').replace(',', '.')) : 0;

  const totalMatch = cleanText.match(/Total:\s*\$?\s*([\d.,]+)/i);
  const total = totalMatch ? parseFloat(totalMatch[1].replace(/\./g, '').replace(',', '.')) : 0;

  // Parseo de productos (Anclado estricto a la barra '|' ignorando el guion corrupto)
  const regexProductos = /\|([^|]+)\|\s*(.*?)\s*>\s*\$\s*([\d.,]+)/g;
  let productosFinales = [];
  let match;

  while ((match = regexProductos.exec(cleanText)) !== null) {
    const nombreProd = match[1].trim();
    const detallesRaw = match[2];
    const precioUnitario = parseFloat(match[3].replace(/\s/g, '').replace('.', '').replace(',', '.'));

    const opcionesCrudas = detallesRaw.split('-'); 
    const cantidad = parseInt(opcionesCrudas[0].trim(), 10) || 1;
    const opciones = opcionesCrudas.slice(1);

    const opcionesProcesadas = opciones.map(op => {
      const partes = op.split(':');
      return {
        nombre: partes[1] ? partes[1].trim() : partes[0].trim(),
        precio_extra: 0 
      };
    }).filter(op => op.nombre !== "");

    productosFinales.push({
      nombre: nombreProd,
      precio: precioUnitario,
      cantidad: cantidad, 
      personalizacion: {
        opciones: opcionesProcesadas
      }
    });
  }

  // Concatenación de notas
  let notasFinales = `ID Pencyl: ${id_pencyl}`;
  if (aclaraciones && aclaraciones.toLowerCase() !== "esto no va") {
    notasFinales += ` | ACLARACIONES: ${aclaraciones}`;
  }

  // Validar que tengamos al menos productos y nombre de cliente
  if (productosFinales.length === 0 || !cliente_nombre) {
    return null;
  }

  return {
    cliente_nombre,
    cliente_tel,
    direccion,
    metodo_pago,
    tipo_envio,
    departamento,
    notas: notasFinales,
    productos: productosFinales,
    total,
    fuente: 'whatsapp',
    costo_envio,
    flag_alerta: 0
  };
}

module.exports = { initWhatsApp };
