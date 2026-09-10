// ============================================================
// Innovex — Adquisiciones
// Lee los correos nuevos de la casilla (IONOS), le pregunta a la
// IA si tienen que ver con un pedido, y actualiza/crea registros
// en Supabase. Nunca marca correos como leídos ni los mueve —
// lleva su propio registro de qué ya revisó (tabla correo_estado).
//
// Variables de entorno necesarias:
//   SUPABASE_URL, SUPABASE_KEY   -> igual que en el resto del sistema
//   ANTHROPIC_API_KEY            -> clave de console.anthropic.com
//   IONOS_EMAIL, IONOS_PASSWORD  -> la casilla y su contraseña de buzón (IMAP)
//   IMAP_HOST (opcional)         -> servidor IMAP; por defecto imap.ionos.com.
//                                    Cámbialo para probar con otra casilla (ej. imap.gmail.com).
//   IMAP_PORT (opcional)         -> por defecto 993.
// ============================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IONOS_EMAIL = process.env.IONOS_EMAIL;
const IONOS_PASSWORD = process.env.IONOS_PASSWORD;

for (const [nombre, valor] of Object.entries({ SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY, IONOS_EMAIL, IONOS_PASSWORD })) {
  if (!valor) {
    console.error(`Falta la variable de entorno: ${nombre}`);
    process.exit(1);
  }
}

const CLASIFICAR_PROMPT = `Eres un clasificador de correos para el sistema de seguimiento de pedidos de Innovex (área de Adquisiciones).
Analiza el correo y determina si tiene que ver con un pedido de compra (confirmación de envío, número de seguimiento, aviso de aduana, actualización de un envío, etc.).

Responde ÚNICAMENTE con un objeto JSON, sin texto adicional, sin backticks. Usa exactamente estas claves:
- relevante (true o false)
- proveedor (string o null)
- monto (número o null)
- moneda ("USD", "CLP" o null)
- numero_seguimiento (string o null)
- courier (uno de "DHL", "UPS", "MercadoLibre", "Otro", o null)
- destino ("Puerto Montt", "Valdivia" o null)
- fecha_estimada (YYYY-MM-DD o null)
- estado_sugerido (uno de "En proceso", "En tránsito", "En aduana", "En destino", "Recibido", o null si no queda claro un cambio de estado)

Si el correo no tiene relación con un pedido (spam, boletines, temas internos no relacionados a compras), responde solo {"relevante": false}.
No inventes datos que no aparezcan explícitamente en el texto.`;

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nuevoId() { return 'p' + Date.now() + Math.random().toString(16).slice(2, 7); }

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}`);
  return res.json();
}
async function supaPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} -> ${res.status}: ${await res.text()}`);
}
async function supaPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} -> ${res.status}: ${await res.text()}`);
}

async function clasificarCorreo(asunto, texto) {
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
      system: CLASIFICAR_PROMPT,
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

async function main() {
  const IMAP_HOST = process.env.IMAP_HOST || 'imap.ionos.com';
  const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);

  const [estado] = await supaGet('correo_estado?id=eq.1&select=ultimo_uid');
  const ultimoUid = (estado && estado.ultimo_uid) || 0;

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IONOS_EMAIL, pass: IONOS_PASSWORD },
    logger: false,
  });

  await client.connect();

  try {
    // Primera vez que corre: no queremos procesar todo el historial
    // de la bandeja de golpe. Solo anotamos desde dónde empezar.
    if (ultimoUid === 0) {
      const status = await client.status('INBOX', { uidNext: true });
      const uidInicial = Math.max(0, (status.uidNext || 1) - 1);
      await supaPatch('correo_estado?id=eq.1', { ultimo_uid: uidInicial });
      console.log(`Primera ejecución: punto de partida establecido en UID ${uidInicial}. No se procesan correos antiguos.`);
      return;
    }

    console.log(`Revisando correos con UID mayor a ${ultimoUid}...`);
    let maxUidVisto = ultimoUid;

    const lock = await client.getMailboxLock('INBOX');
    try {
      const mensajes = client.fetch({ uid: `${ultimoUid + 1}:*` }, { uid: true, source: true });

      for await (const msg of mensajes) {
        if (msg.uid <= ultimoUid) continue; // el rango "*" a veces repite el último conocido
        if (msg.uid > maxUidVisto) maxUidVisto = msg.uid;

        const parsed = await simpleParser(msg.source);
        const asunto = parsed.subject || '(sin asunto)';
        const texto = parsed.text || parsed.html || '';
        console.log(`- Correo UID ${msg.uid}: "${asunto}"`);

        const resultado = await clasificarCorreo(asunto, texto);
        if (!resultado.relevante) {
          console.log('  No relacionado con pedidos, se omite.');
          continue;
        }

        let pedidoExistente = null;
        if (resultado.numero_seguimiento) {
          const encontrados = await supaGet(
            `pedidos?numero_seguimiento=eq.${encodeURIComponent(resultado.numero_seguimiento)}&select=id,estado`
          );
          pedidoExistente = encontrados[0] || null;
        }

        if (pedidoExistente) {
          if (resultado.estado_sugerido && resultado.estado_sugerido !== pedidoExistente.estado) {
            await supaPatch(`pedidos?id=eq.${pedidoExistente.id}`, {
              estado: resultado.estado_sugerido,
              fecha_ultima_actualizacion: todayISO(),
            });
            console.log(`  Pedido existente actualizado -> ${resultado.estado_sugerido}`);
          } else {
            console.log('  Pedido existente, sin cambio de estado que aplicar.');
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
          monto_usd: resultado.moneda === 'CLP' ? null : resultado.monto,
          monto_clp: resultado.moneda === 'CLP' ? resultado.monto : null,
          moneda_ingreso: resultado.moneda || null,
          numero_seguimiento: resultado.numero_seguimiento || null,
          courier: resultado.courier || null,
          destino: resultado.destino || null,
          estado: resultado.estado_sugerido || 'En proceso',
          fecha_registro: todayISO(),
          fecha_estimada: resultado.fecha_estimada || null,
          fecha_ultima_actualizacion: todayISO(),
          agente_aduanero: !!(resultado.moneda !== 'CLP' && resultado.monto && resultado.monto > 3000),
          pendiente_revision: true,
        };
        await supaPost('pedidos', nuevoPedido);
        console.log(`  Pedido nuevo creado, pendiente de revisión: ${resultado.proveedor}`);
      }
    } finally {
      lock.release();
    }

    if (maxUidVisto > ultimoUid) {
      await supaPatch('correo_estado?id=eq.1', { ultimo_uid: maxUidVisto });
      console.log(`Último UID revisado actualizado a ${maxUidVisto}.`);
    } else {
      console.log('No había correos nuevos.');
    }
  } finally {
    await client.logout();
  }

  console.log('Listo.');
}

main().catch((err) => {
  console.error('Error en la ejecución:', err);
  process.exit(1);
});
