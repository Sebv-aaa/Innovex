// ============================================================
// Innovex — Adquisiciones
// Lee los correos nuevos de DOS casillas (IONOS), le pregunta a la
// IA si tienen que ver con un pedido, y actualiza/crea registros
// en Supabase. Nunca marca correos como leídos ni los mueve —
// lleva su propio registro de qué ya revisó, por casilla, en la
// tabla correo_estado (una fila por casilla, identificada por
// "casilla": 'principal' o 'secundaria').
//
// Variables de entorno necesarias:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY -> igual que siempre
//   IONOS_EMAIL_1, IONOS_PASSWORD_1 -> primera casilla
//   IONOS_EMAIL_2, IONOS_PASSWORD_2 -> segunda casilla
//   IMAP_HOST (opcional) -> servidor IMAP, por defecto imap.ionos.com (aplica a ambas)
//   IMAP_PORT (opcional) -> por defecto 993
// ============================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CASILLAS = [
  { nombre: 'principal', email: process.env.IONOS_EMAIL_1, password: process.env.IONOS_PASSWORD_1 },
  { nombre: 'secundaria', email: process.env.IONOS_EMAIL_2, password: process.env.IONOS_PASSWORD_2 },
];

for (const [nombre, valor] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY })) {
  if (!valor) {
    console.error(`Falta la variable de entorno: ${nombre}`);
    process.exit(1);
  }
}
for (const casilla of CASILLAS) {
  if (!casilla.email || !casilla.password) {
    console.error(`Faltan las credenciales de la casilla "${casilla.nombre}" (IONOS_EMAIL_${casilla.nombre === 'principal' ? '1' : '2'} / IONOS_PASSWORD_${casilla.nombre === 'principal' ? '1' : '2'})`);
    process.exit(1);
  }
}

function clasificarPrompt(pedidosActivos) {
  return `Eres un clasificador de correos para el sistema de seguimiento de pedidos de Innovex (área de Adquisiciones).
Analiza el correo y determina si tiene que ver con un pedido de compra (confirmación de envío, número de seguimiento, aviso de aduana, actualización de un envío, un recordatorio, etc.).

Te doy además la lista de pedidos que YA EXISTEN en el sistema (activos, no entregados todavía). Es muy importante que revises si este correo se refiere a uno de ellos — por ejemplo, un recordatorio o una segunda notificación del mismo envío — comparando proveedor, monto, destino y número de seguimiento en conjunto, no solo si el número de seguimiento se repite literalmente. Si el texto no repite el número de seguimiento pero todo lo demás (proveedor, monto aproximado, destino) coincide claramente con uno de la lista, trátalo como el MISMO pedido, no como uno nuevo.

Pedidos activos existentes (JSON):
${JSON.stringify(pedidosActivos)}

Responde ÚNICAMENTE con un objeto JSON, sin texto adicional, sin backticks. Usa exactamente estas claves:
- relevante (true o false)
- pedido_existente_id (el "id" de la lista de arriba si el correo se refiere a uno de esos pedidos, o null si es un pedido genuinamente nuevo que no está en la lista)
- proveedor (string o null)
- monto (número o null)
- moneda ("USD", "CLP", "EUR" o null)
- numero_seguimiento (string o null)
- courier (uno de "DHL", "UPS", "MercadoLibre", "Otro", o null)
- destino ("Puerto Montt", "Valdivia" o null)
- fecha_estimada (YYYY-MM-DD o null)
- estado_sugerido (uno de "En proceso", "En tránsito", "En aduana", "En destino", "Recibido", o null si no queda claro un cambio de estado)

Si el correo no tiene relación con un pedido (spam, boletines, temas internos no relacionados a compras), responde solo {"relevante": false}.
No inventes datos que no aparezcan explícitamente en el texto.`;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nuevoId() { return 'p' + Date.now() + Math.random().toString(16).slice(2, 7); }

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}`);
  return res.json();
}
async function supaPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} -> ${res.status}: ${await res.text()}`);
}
async function supaPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} -> ${res.status}: ${await res.text()}`);
}

async function obtenerPedidosActivos() {
  return supaGet('pedidos?estado=neq.Recibido&select=id,proveedor,numero_seguimiento,monto,moneda,destino,estado');
}

async function clasificarCorreo(asunto, texto, pedidosActivos) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      system: clasificarPrompt(pedidosActivos),
      messages: [{ role: 'user', content: `Asunto: ${asunto}\n\n${texto}`.slice(0, 6000) }],
    }),
  });
  const data = await res.json();
  const texto_respuesta = (data.content || []).map((b) => b.text || '').join('\n');
  try {
    return JSON.parse(texto_respuesta.replace(/```json/gi, '').replace(/```/g, '').trim());
  } catch (e) {
    console.warn('  No se pudo interpretar la respuesta de la IA:', texto_respuesta);
    return { relevante: false };
  }
}

async function procesarCasilla(casilla, pedidosActivos) {
  const IMAP_HOST = process.env.IMAP_HOST || 'imap.ionos.com';
  const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);

  console.log(`\n=== Casilla: ${casilla.nombre} (${casilla.email}) ===`);

  const [estado] = await supaGet(`correo_estado?casilla=eq.${casilla.nombre}&select=ultimo_uid`);
  const ultimoUid = (estado && estado.ultimo_uid) || 0;

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: casilla.email, pass: casilla.password },
    logger: false,
  });

  await client.connect();

  try {
    // Primera vez que corre esta casilla: no queremos procesar todo el
    // historial de golpe. Solo anotamos desde dónde empezar.
    if (ultimoUid === 0) {
      const status = await client.status('INBOX', { uidNext: true });
      const uidInicial = Math.max(0, (status.uidNext || 1) - 1);
      await supaPatch(`correo_estado?casilla=eq.${casilla.nombre}`, { ultimo_uid: uidInicial });
      console.log(`Primera ejecución en "${casilla.nombre}": punto de partida establecido en UID ${uidInicial}. No se procesan correos antiguos.`);
      return;
    }

    console.log(`Revisando correos con UID mayor a ${ultimoUid}...`);
    let maxUidVisto = ultimoUid;

    const lock = await client.getMailboxLock('INBOX');
    try {
      const mensajes = client.fetch({ uid: `${ultimoUid + 1}:*` }, { uid: true, source: true });

      for await (const msg of mensajes) {
        if (msg.uid <= ultimoUid) continue;
        if (msg.uid > maxUidVisto) maxUidVisto = msg.uid;

        const parsed = await simpleParser(msg.source);
        const asunto = parsed.subject || '(sin asunto)';
        const texto = parsed.text || parsed.html || '';
        console.log(`- [${casilla.nombre}] Correo UID ${msg.uid}: "${asunto}"`);

        const resultado = await clasificarCorreo(asunto, texto, pedidosActivos);
        if (!resultado.relevante) {
          console.log('  No relacionado con pedidos, se omite.');
          continue;
        }

        let pedidoExistente = null;
        if (resultado.pedido_existente_id) {
          pedidoExistente = pedidosActivos.find((p) => p.id === resultado.pedido_existente_id) || null;
        }
        if (!pedidoExistente && resultado.numero_seguimiento) {
          pedidoExistente = pedidosActivos.find((p) => p.numero_seguimiento === resultado.numero_seguimiento) || null;
        }

        if (pedidoExistente) {
          if (resultado.estado_sugerido && resultado.estado_sugerido !== pedidoExistente.estado) {
            await supaPatch(`pedidos?id=eq.${pedidoExistente.id}`, {
              estado: resultado.estado_sugerido,
              fecha_ultima_actualizacion: todayISO(),
            });
            pedidoExistente.estado = resultado.estado_sugerido;
            console.log(`  Pedido existente actualizado (${pedidoExistente.proveedor}) -> ${resultado.estado_sugerido}`);
          } else {
            console.log(`  Correo sobre un pedido que ya existe (${pedidoExistente.proveedor}), sin cambio de estado que aplicar. No se duplica.`);
          }
          continue;
        }

        if (!resultado.proveedor) {
          console.log('  Relevante pero sin datos suficientes para crear un pedido, se omite.');
          continue;
        }

        const nuevoPedido = {
          id: nuevoId(),
          proveedor: resultado.proveedor,
          monto: resultado.monto || null,
          moneda: resultado.moneda || null,
          numero_seguimiento: resultado.numero_seguimiento || null,
          courier: resultado.courier || null,
          destino: resultado.destino || null,
          estado: resultado.estado_sugerido || 'En proceso',
          fecha_registro: todayISO(),
          fecha_estimada: resultado.fecha_estimada || null,
          fecha_ultima_actualizacion: todayISO(),
          pendiente_revision: true,
        };
        await supaPost('pedidos', nuevoPedido);
        pedidosActivos.push(nuevoPedido); // para que la otra casilla, o correos siguientes, no lo dupliquen
        console.log(`  Pedido nuevo creado, pendiente de revisión: ${resultado.proveedor}`);
      }
    } finally {
      lock.release();
    }

    if (maxUidVisto > ultimoUid) {
      await supaPatch(`correo_estado?casilla=eq.${casilla.nombre}`, { ultimo_uid: maxUidVisto });
      console.log(`[${casilla.nombre}] Último UID revisado actualizado a ${maxUidVisto}.`);
    } else {
      console.log(`[${casilla.nombre}] No había correos nuevos.`);
    }
  } finally {
    await client.logout();
  }
}

async function main() {
  let pedidosActivos = await obtenerPedidosActivos();

  for (const casilla of CASILLAS) {
    try {
      await procesarCasilla(casilla, pedidosActivos);
    } catch (err) {
      // Si una casilla falla (credenciales, conexión, etc.), seguimos
      // con la otra en vez de detener todo el proceso.
      console.error(`Error procesando la casilla "${casilla.nombre}":`, err.message || err);
    }
  }

  console.log('\nListo.');
}

main().catch((err) => {
  console.error('Error en la ejecución:', err);
  process.exit(1);
});
