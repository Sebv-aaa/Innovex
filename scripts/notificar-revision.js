// ============================================================
// Innovex — Adquisiciones
// Envía por correo la tabla de UNA revisión de pedidos hecha por Claude
// (la revisión diaria de las 8:57 y 16:58: correos + seguimiento en
// DHL, UPS y FedEx).
//
// Cómo se dispara: el Claude de Antoniela guarda la revisión en la tabla
// `revisiones_pedidos` de Supabase; un disparador de la base
// (`disparar_notificar_revision`) llama a la API de GitHub y corre el workflow
// .github/workflows/notificar-revision.yml con el número de la revisión.
// También se puede correr a mano desde la pestaña «Actions» (pide el número).
//
// Se envía siempre, aunque la revisión diga «Sin cambios». Si la revisión ya
// fue enviada (enviado_en con fecha), no se vuelve a enviar.
//
// La revisión de la MAÑANA (antes de las 13:00, hora de Chile) agrega al final
// «Pendientes en la plataforma»: pedidos vencidos, sin novedades hace 5+ días,
// incompletos e insumos con stock bajo. Reemplaza al resumen de las 8:15
// (notificar-alertas.js), con las mismas reglas.
//
// Variables de entorno (las mismas del resumen de las 8:15, más una):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   SMTP_EMAIL, SMTP_PASSWORD (cuenta Gmail dedicada, contraseña de aplicación)
//   NOTIFICAR_EMAIL           -> destinatario (hoy, el correo de Antoniela)
//   SMTP_HOST, SMTP_PORT      -> opcionales (smtp.gmail.com, 587)
//   REVISION_ID               -> número de la revisión (lo pone el workflow)
// ============================================================

import 'dotenv/config';
import nodemailer from 'nodemailer';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SMTP_EMAIL = process.env.SMTP_EMAIL;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const NOTIFICAR_EMAIL = process.env.NOTIFICAR_EMAIL;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const REVISION_ID = String(process.env.REVISION_ID || '').trim();

for (const [nombre, valor] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, NOTIFICAR_EMAIL, SMTP_EMAIL, SMTP_PASSWORD })) {
  if (!valor) {
    console.error(`Falta la variable de entorno: ${nombre}`);
    process.exit(1);
  }
}
if (!/^\d+$/.test(REVISION_ID)) {
  console.error(`REVISION_ID no válido: «${REVISION_ID}» (debe ser un número)`);
  process.exit(1);
}

const HEADERS = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}`);
  return res.json();
}
async function supaPatch(path, datos) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(datos),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} -> ${res.status}`);
}

// Fecha y hora en Chile.
function partesChile(iso) {
  const f = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const p = Object.fromEntries(f.map((x) => [x.type, x.value]));
  return { fecha: `${p.day}-${p.month}-${p.year}`, hora: `${p.hour}:${p.minute}`, h: parseInt(p.hour, 10) };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// --- Pendientes en la plataforma (mismas reglas que notificar-alertas.js) ---
function hoyChileISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
}
function diasDesde(iso, hoy) {
  if (!iso) return 0;
  const d = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  const t = Date.parse(hoy + 'T00:00:00Z');
  if (Number.isNaN(d)) return 0;
  return Math.max(0, Math.round((t - d) / 86400000));
}
function fechaCL(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || '');
}
function camposFaltantes(p) {
  const faltan = [];
  if (!p.proveedor || /^por confirmar/i.test(String(p.proveedor).trim())) faltan.push('proveedor');
  if (p.monto == null || Number.isNaN(Number(p.monto)) || Number(p.monto) <= 0) faltan.push('monto');
  if (!p.destino) faltan.push('destino');
  if (!p.fecha_estimada) faltan.push('fecha estimada');
  return faltan;
}
async function pendientesPlataforma() {
  const hoy = hoyChileISO();
  const pedidos = await supaGet('pedidos?estado=neq.Recibido&eliminado=eq.false&select=proveedor,estado,fecha_estimada,fecha_ultima_actualizacion');
  const todos = await supaGet('pedidos?eliminado=eq.false&select=proveedor,estado,courier,numero_seguimiento,monto,destino,fecha_estimada,pendiente_revision');
  const insumos = await supaGet('inventario?stock_minimo=not.is.null&select=nombre,ubicacion,cantidad,stock_minimo');
  const secciones = [];
  const vencidos = pedidos.filter((p) => p.fecha_estimada && p.fecha_estimada < hoy);
  if (vencidos.length) secciones.push({ titulo: `Pedidos vencidos (ya pasó la fecha estimada, ${vencidos.length})`,
    items: vencidos.map((p) => `${p.proveedor} (estado: ${p.estado}, debía llegar el ${fechaCL(p.fecha_estimada)})`) });
  const atrasados = pedidos.filter((p) => diasDesde(p.fecha_ultima_actualizacion, hoy) >= 5);
  if (atrasados.length) secciones.push({ titulo: `Pedidos sin novedades hace 5+ días (${atrasados.length})`,
    items: atrasados.map((p) => `${p.proveedor} (estado: ${p.estado}, sin actualizar hace ${diasDesde(p.fecha_ultima_actualizacion, hoy)} días)`) });
  const incompletos = todos.map((p) => ({ ...p, faltan: camposFaltantes(p) })).filter((p) => p.faltan.length > 0);
  if (incompletos.length) secciones.push({ titulo: `Pedidos incompletos (faltan datos, ${incompletos.length}) — complétalos en «Actualizar estado»`,
    items: incompletos.map((p) => {
      const envio = [p.courier, p.numero_seguimiento].filter(Boolean).join(' ');
      const extra = p.pendiente_revision ? ', creado por Claude, sin revisar' : '';
      return `${p.proveedor}${envio ? ' — ' + envio : ''} (estado: ${p.estado}${extra}; falta: ${p.faltan.join(', ')})`;
    }) });
  const stockBajo = insumos.filter((i) => parseFloat(i.cantidad) < parseFloat(i.stock_minimo));
  if (stockBajo.length) secciones.push({ titulo: `Insumos con stock bajo (${stockBajo.length})`,
    items: stockBajo.map((i) => `${i.nombre} en ${i.ubicacion}: quedan ${i.cantidad} (mínimo ${i.stock_minimo})`) });
  const total = vencidos.length + atrasados.length + incompletos.length + stockBajo.length;
  return { total, secciones };
}

const txt = (s) => (s === null || s === undefined || s === '' ? '—' : String(s));

const RESULTADO = {
  'aplicado': 'Cambios aplicados con la confirmación de Antoniela.',
  'parcial': 'Se aplicó parte de los cambios (ver columna «Resultado»).',
  'no aplicado': 'Antoniela no aprobó los cambios: no se guardó nada.',
  'sin cambios': 'Sin cambios.',
};

const COLUMNAS = [
  ['origen', 'Origen'],
  ['accion', 'Acción'],
  ['proveedor', 'Proveedor'],
  ['courier_guia', 'Courier y guía'],
  ['courier_dice', 'Lo que dice el courier'],
  ['antes', 'Antes'],
  ['despues', 'Después'],
  ['resultado', 'Resultado'],
];

function courierGuia(f) {
  if (f.courier_guia) return f.courier_guia;
  return [f.courier, f.guia].filter(Boolean).join(' ');
}

async function main() {
  const filas = await supaGet(`revisiones_pedidos?id=eq.${REVISION_ID}&select=*`);
  const rev = filas[0];
  if (!rev) throw new Error(`No existe la revisión ${REVISION_ID}`);
  if (rev.enviado_en) {
    console.log(`La revisión ${REVISION_ID} ya se envió el ${rev.enviado_en}; no se envía de nuevo.`);
    return;
  }

  const { fecha, hora, h } = partesChile(rev.creado_en);
  const turno = h < 13 ? 'mañana' : 'tarde';
  const tabla = (Array.isArray(rev.filas) ? rev.filas : []).map((f) => ({ ...f, courier_guia: courierGuia(f) }));
  const alertas = (Array.isArray(rev.alertas) ? rev.alertas : []).map(String);
  const resumen = RESULTADO[rev.resultado] || rev.resultado;
  const pend = turno === 'mañana' ? await pendientesPlataforma() : null;

  // --- Texto plano (para clientes de correo sin HTML) ---
  const t = [];
  t.push(`Revisión de pedidos — ${fecha} (${turno}, ${hora})`);
  t.push('');
  t.push(resumen);
  t.push('');
  if (tabla.length) {
    tabla.forEach((f, i) => {
      t.push(`${i + 1}. ${txt(f.proveedor)} — ${txt(f.courier_guia)}`);
      t.push(`   ${txt(f.origen)} · ${txt(f.accion)} · ${txt(f.antes)} → ${txt(f.despues)} · ${txt(f.resultado)}`);
      if (f.courier_dice) t.push(`   Courier: ${f.courier_dice}`);
    });
    t.push('');
  }
  if (alertas.length) {
    t.push('ALERTAS:');
    alertas.forEach((a) => t.push(`  - ${a}`));
    t.push('');
  }
  if (rev.notas) { t.push(rev.notas); t.push(''); }
  if (pend) {
    t.push('PENDIENTES EN LA PLATAFORMA');
    if (!pend.total) t.push('  Todo al día: sin pedidos vencidos, sin atrasos, sin pedidos incompletos y sin insumos con stock bajo.');
    pend.secciones.forEach((s) => { t.push(`${s.titulo}:`); s.items.forEach((i) => t.push(`  - ${i}`)); });
    t.push('');
  }
  t.push('Revísalo en Adquisiciones: https://sebv-aaa.github.io/Innovex/');

  // --- HTML ---
  const th = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid #ccc;background:#f3f3f0;font-size:13px"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #e3e3e3;font-size:13px;vertical-align:top"';
  let html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222">`;
  html += `<h2 style="margin:0 0 4px;font-size:18px">Revisión de pedidos — ${esc(fecha)}</h2>`;
  html += `<p style="margin:0 0 12px;color:#666;font-size:13px">Revisión de la ${esc(turno)} (${esc(hora)}), hecha por Claude.</p>`;
  html += `<p style="margin:0 0 12px;font-size:14px"><b>${esc(resumen)}</b></p>`;
  if (tabla.length) {
    html += `<table style="border-collapse:collapse;width:100%;max-width:960px"><thead><tr>`;
    html += `<th ${th}>#</th>` + COLUMNAS.map(([, n]) => `<th ${th}>${esc(n)}</th>`).join('');
    html += `</tr></thead><tbody>`;
    tabla.forEach((f, i) => {
      html += `<tr><td ${td}>${i + 1}</td>` + COLUMNAS.map(([k]) => `<td ${td}>${esc(txt(f[k]))}</td>`).join('') + `</tr>`;
    });
    html += `</tbody></table>`;
  }
  if (alertas.length) {
    html += `<p style="margin:16px 0 4px;font-size:14px"><b>Alertas</b></p><ul style="margin:0;padding-left:20px;font-size:13px">`;
    html += alertas.map((a) => `<li>${esc(a)}</li>`).join('');
    html += `</ul>`;
  }
  if (rev.notas) html += `<p style="margin:16px 0 0;font-size:13px;white-space:pre-line">${esc(rev.notas)}</p>`;
  if (pend) {
    html += `<h3 style="margin:24px 0 6px;font-size:16px;border-top:1px solid #ddd;padding-top:14px">Pendientes en la plataforma</h3>`;
    if (!pend.total) html += `<p style="margin:0;font-size:13px">Todo al día: sin pedidos vencidos, sin atrasos, sin pedidos incompletos y sin insumos con stock bajo.</p>`;
    pend.secciones.forEach((s) => {
      html += `<p style="margin:10px 0 4px;font-size:14px"><b>${esc(s.titulo)}</b></p><ul style="margin:0;padding-left:20px;font-size:13px">`;
      html += s.items.map((i) => `<li>${esc(i)}</li>`).join('') + `</ul>`;
    });
  }
  html += `<p style="margin:16px 0 0;font-size:13px"><a href="https://sebv-aaa.github.io/Innovex/">Revisar en Adquisiciones</a></p></div>`;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    authMethod: 'LOGIN',
    auth: { user: SMTP_EMAIL, pass: SMTP_PASSWORD },
  });

  await transporter.sendMail({
    from: SMTP_EMAIL,
    to: NOTIFICAR_EMAIL,
    subject: `Revisión de pedidos — ${fecha} (${turno})` + (pend ? (pend.total ? ` · ${pend.total} pendientes` : ' · todo al día') : ''),
    text: t.join('\n'),
    html,
  });

  await supaPatch(`revisiones_pedidos?id=eq.${REVISION_ID}`, { enviado_en: new Date().toISOString() });
  console.log(`Revisión ${REVISION_ID} enviada — ${tabla.length} filas, ${alertas.length} alertas, resultado «${rev.resultado}»${pend ? `, ${pend.total} pendientes en la plataforma` : ''}.`);
}

main().catch((err) => {
  console.error('Error en la ejecución:', err);
  process.exit(1);
});
