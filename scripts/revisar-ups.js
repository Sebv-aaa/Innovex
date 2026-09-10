// ============================================================
// Innovex — Adquisiciones
// Revisa el estado de los pedidos con courier "UPS" contra la
// API oficial de UPS (Tracking API) y actualiza la base de datos
// (Supabase) cuando el estado cambió.
//
// A diferencia de DHL, UPS no tiene una clave de prueba gratuita
// tipo "demo-key" — hay que crear una cuenta en developer.ups.com
// (gratis) para obtener un Client ID y Client Secret, incluso para
// probar en su entorno de pruebas (CIE).
//
// Se ejecuta automáticamente vía GitHub Actions (ver el archivo
// .github/workflows/revisar-ups.yml), pero también puedes
// correrlo a mano con: node scripts/revisar-ups.js
//
// Variables de entorno necesarias:
//   SUPABASE_URL      -> igual que en el resto del sistema
//   SUPABASE_SERVICE_KEY -> la clave "service_role" (secreta) de Supabase — NO la publishable
//   UPS_CLIENT_ID, UPS_CLIENT_SECRET -> de developer.ups.com
//   UPS_AUTH_URL (opcional)   -> por defecto producción (onlinetools.ups.com).
//                                 Para probar en el entorno de pruebas de UPS,
//                                 usa: https://wwwcie.ups.com/security/v1/oauth/token
//   UPS_API_URL (opcional)    -> mismo criterio, por defecto producción.
//                                 Pruebas: https://wwwcie.ups.com/api/track/v1/details
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;
const UPS_AUTH_URL = process.env.UPS_AUTH_URL || 'https://onlinetools.ups.com/security/v1/oauth/token';
const UPS_API_URL = process.env.UPS_API_URL || 'https://onlinetools.ups.com/api/track/v1/details';

for (const [nombre, valor] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, UPS_CLIENT_ID, UPS_CLIENT_SECRET })) {
  if (!valor) {
    console.error(`Falta la variable de entorno: ${nombre}`);
    process.exit(1);
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function obtenerPedidosUPS() {
  const url = `${SUPABASE_URL}/rest/v1/pedidos?courier=eq.UPS&estado=neq.Recibido&select=id,proveedor,numero_seguimiento,estado`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`No se pudo leer los pedidos de Supabase (código ${res.status})`);
  return res.json();
}

async function obtenerTokenUPS() {
  const credenciales = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(UPS_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credenciales}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`No se pudo obtener el token de UPS (código ${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// Traduce el estado de UPS a los que usa el dashboard. UPS entrega un
// código corto (type) y una descripción en texto — usamos ambos para
// ser más confiables ante variaciones de redacción.
function mapearEstadoUPS(currentStatus) {
  if (!currentStatus) return null;
  const tipo = (currentStatus.type || '').toUpperCase();
  const desc = (currentStatus.description || '').toLowerCase();

  if (tipo === 'D' || desc.includes('delivered')) return 'Recibido';
  if (tipo === 'I' || desc.includes('transit') || desc.includes('out for delivery')) return 'En tránsito';
  if (tipo === 'M' || desc.includes('label') || desc.includes('order processed') || desc.includes('billing information')) return 'En proceso';
  // Excepciones (tipo "X") u otros casos no mapeados: se dejan para revisión manual.
  return null;
}

async function consultarUPS(numeroSeguimiento, token) {
  const url = `${UPS_API_URL}/${encodeURIComponent(numeroSeguimiento)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    console.warn(`  UPS respondió con código ${res.status} para ${numeroSeguimiento}`);
    return null;
  }
  const data = await res.json();
  const paquete = data.trackResponse && data.trackResponse.shipment && data.trackResponse.shipment[0]
    && data.trackResponse.shipment[0].package && data.trackResponse.shipment[0].package[0];
  return paquete ? paquete.currentStatus : null;
}

async function actualizarEstado(id, nuevoEstado) {
  const url = `${SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ estado: nuevoEstado, fecha_ultima_actualizacion: todayISO() }),
  });
  if (!res.ok) throw new Error(`No se pudo actualizar el pedido ${id} (código ${res.status})`);
}

async function main() {
  const pedidos = await obtenerPedidosUPS();
  console.log(`Pedidos UPS activos a revisar: ${pedidos.length}`);

  if (pedidos.length === 0) {
    console.log('Listo.');
    return;
  }

  const token = await obtenerTokenUPS();

  for (const pedido of pedidos) {
    if (!pedido.numero_seguimiento) {
      console.log(`- ${pedido.proveedor}: sin número de seguimiento, se omite.`);
      continue;
    }
    console.log(`- ${pedido.proveedor} (${pedido.numero_seguimiento})...`);

    let currentStatus;
    try {
      currentStatus = await consultarUPS(pedido.numero_seguimiento, token);
    } catch (err) {
      console.warn(`  Error consultando UPS: ${err.message}`);
      continue;
    }
    if (!currentStatus) {
      console.log('  Sin respuesta útil de UPS, se deja igual.');
      continue;
    }

    const nuevoEstado = mapearEstadoUPS(currentStatus);
    if (!nuevoEstado) {
      console.log(`  Estado UPS "${currentStatus.description || currentStatus.type}" no mapeado, se deja igual.`);
      continue;
    }
    if (nuevoEstado === pedido.estado) {
      console.log(`  Sin cambios (${nuevoEstado}).`);
      continue;
    }

    await actualizarEstado(pedido.id, nuevoEstado);
    console.log(`  Actualizado: ${pedido.estado} → ${nuevoEstado}`);
  }

  console.log('Listo.');
}

main().catch((err) => {
  console.error('Error en la ejecución:', err);
  process.exit(1);
});
