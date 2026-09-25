// ============================================================
// Innovex — Adquisiciones
// Manda TODOS LOS DÍAS (lunes a viernes) un resumen con pedidos
// vencidos, pedidos atrasados e insumos con stock bajo — si no hay
// nada pendiente, igual manda el correo, avisando que está todo al día.
//
// Reutiliza la casilla "principal" (la misma que usa lector-correo.js como
// primera casilla), pero para ENVIAR en vez de leer.
//
// Se ejecuta automáticamente vía GitHub Actions (ver el archivo
// .github/workflows/notificar-alertas.yml), pero también puedes
// correrlo a mano con: node scripts/notificar-alertas.js
//
// Variables de entorno necesarias:
//   SUPABASE_URL          -> igual que en el resto del sistema
//   SUPABASE_SERVICE_KEY  -> la clave "service_role" (secreta) de Supabase
//   IONOS_EMAIL_1, IONOS_PASSWORD_1 -> la casilla "principal" (compartida con lector-correo.js)
//   NOTIFICAR_EMAIL (opcional) -> a quién se le manda el resumen. Si no
//                                  se define, se manda a la misma IONOS_EMAIL_1.
//   SMTP_HOST (opcional)  -> por defecto smtp.ionos.com. Para probar con Gmail: smtp.gmail.com
//   SMTP_PORT (opcional)  -> por defecto 587
// ============================================================

import nodemailer from 'nodemailer';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const IONOS_EMAIL = process.env.IONOS_EMAIL_1;
const IONOS_PASSWORD = process.env.IONOS_PASSWORD_1;
const NOTIFICAR_EMAIL = process.env.NOTIFICAR_EMAIL || IONOS_EMAIL;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.ionos.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);

for (const [nombre, valor] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!valor) {
    console.error(`Falta la variable de entorno: ${nombre}`);
    process.exit(1);
  }
}
if (!IONOS_EMAIL || !IONOS_PASSWORD) {
  console.error('Faltan las variables de entorno: IONOS_EMAIL_1 / IONOS_PASSWORD_1');
  process.exit(1);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysSince(iso) {
  if (!iso) return 0;
  const d = new Date(iso + 'T00:00:00'); const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((t - d) / 86400000));
}

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}`);
  return res.json();
}

async function main() {
  const pedidos = await supaGet('pedidos?estado=neq.Recibido&select=proveedor,estado,fecha_estimada,fecha_ultima_actualizacion');
  const insumos = await supaGet('inventario?stock_minimo=not.is.null&select=nombre,ubicacion,cantidad,stock_minimo');

  const hoy = todayISO();
  const vencidos = pedidos.filter((p) => p.fecha_estimada && p.fecha_estimada < hoy);
  const atrasados = pedidos.filter((p) => daysSince(p.fecha_ultima_actualizacion) >= 5);
  const stockBajo = insumos.filter((i) => parseFloat(i.cantidad) < parseFloat(i.stock_minimo));
  const totalPendientes = vencidos.length + atrasados.length + stockBajo.length;

  const lineas = [];
  lineas.push(`Resumen del día — Innovex Adquisiciones (${hoy})`);
  lineas.push('');

  if (totalPendientes === 0) {
    lineas.push('Todo al día — sin pedidos vencidos, sin atrasos y sin insumos con stock bajo.');
    lineas.push('');
  } else {
    if (vencidos.length > 0) {
      lineas.push(`PEDIDOS VENCIDOS (ya pasó la fecha estimada, ${vencidos.length}):`);
      vencidos.forEach((p) => lineas.push(`  - ${p.proveedor} (estado: ${p.estado}, debía llegar el ${p.fecha_estimada})`));
      lineas.push('');
    }
    if (atrasados.length > 0) {
      lineas.push(`PEDIDOS SIN NOVEDADES HACE 5+ DÍAS (${atrasados.length}):`);
      atrasados.forEach((p) => lineas.push(`  - ${p.proveedor} (estado: ${p.estado}, sin actualizar hace ${daysSince(p.fecha_ultima_actualizacion)} días)`));
      lineas.push('');
    }
    if (stockBajo.length > 0) {
      lineas.push(`INSUMOS CON STOCK BAJO (${stockBajo.length}):`);
      stockBajo.forEach((i) => lineas.push(`  - ${i.nombre} en ${i.ubicacion}: quedan ${i.cantidad} (mínimo ${i.stock_minimo})`));
      lineas.push('');
    }
  }

  lineas.push('Revísalo en el dashboard: https://sebv-aaa.github.io/Innovex/');

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: IONOS_EMAIL, pass: IONOS_PASSWORD },
  });

  await transporter.sendMail({
    from: IONOS_EMAIL,
    to: NOTIFICAR_EMAIL,
    subject: totalPendientes > 0
      ? `Resumen Innovex — ${totalPendientes} pendientes (${hoy})`
      : `Resumen Innovex — todo al día (${hoy})`,
    text: lineas.join('\n'),
  });

  console.log(`Correo enviado a ${NOTIFICAR_EMAIL} — ${vencidos.length} vencidos, ${atrasados.length} atrasados, ${stockBajo.length} con stock bajo.`);
}

main().catch((err) => {
  console.error('Error en la ejecución:', err);
  process.exit(1);
});
