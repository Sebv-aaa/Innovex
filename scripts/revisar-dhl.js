// ============================================================
// Innovex — Adquisiciones
// Revisa el estado de los pedidos con courier "DHL" contra la
// API oficial de DHL (Shipment Tracking - Unified) y actualiza
// la base de datos (Supabase) cuando el estado cambió.
//
// Se ejecuta automáticamente vía GitHub Actions (ver el archivo
// .github/workflows/revisar-dhl.yml), pero también puedes
// correrlo a mano con: node scripts/revisar-dhl.js
//
// Variables de entorno necesarias:
//   SUPABASE_URL   -> ej: https://wncejgicemnaneptrrsq.supabase.co
//   SUPABASE_KEY   -> la clave "publishable" de Supabase
//   DHL_API_KEY    -> tu clave de developer.dhl.com (o "demo-key" para probar)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DHL_API_KEY = process.env.DHL_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !DHL_API_KEY) {
  console.error('Faltan variables de entorno: SUPABASE_URL, SUPABASE_KEY o DHL_API_KEY.');
  process.exit(1);
}

// Traduce el "statusCode" que entrega DHL a los estados que usa el dashboard.
// DHL no distingue explícitamente "en aduana", así que ese paso se sigue
// marcando manualmente por ahora (o se puede afinar más adelante revisando
// el detalle de "events" de cada envío).
const MAPA_ESTADOS = {
  'pre-transit': 'En proceso',
  'transit': 'En tránsito',
  'delivered': 'Recibido',
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function obtenerPedidosDHL() {
  const url = `${SUPABASE_URL}/rest/v1/pedidos?courier=eq.DHL&estado=neq.Recibido&select=id,proveedor,numero_seguimiento,estado`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`No se pudo leer los pedidos de Supabase (código ${res.status})`);
  return res.json();
}

async function consultarDHL(numeroSeguimiento) {
  const url = `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(numeroSeguimiento)}`;
  const res = await fetch(url, {
    headers: { 'DHL-API-Key': DHL_API_KEY },
  });
  if (!res.ok) {
    console.warn(`  DHL respondió con código ${res.status} para ${numeroSeguimiento}`);
    return null;
  }
  const data = await res.json();
  const envio = data.shipments && data.shipments[0];
  return envio ? envio.status : null;
}

async function actualizarEstado(id, nuevoEstado) {
  const url = `${SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ estado: nuevoEstado, fecha_ultima_actualizacion: todayISO() }),
  });
  if (!res.ok) throw new Error(`No se pudo actualizar el pedido ${id} (código ${res.status})`);
}

async function main() {
  const pedidos = await obtenerPedidosDHL();
  console.log(`Pedidos DHL activos a revisar: ${pedidos.length}`);

  for (const pedido of pedidos) {
    if (!pedido.numero_seguimiento) {
      console.log(`- ${pedido.proveedor}: sin número de seguimiento, se omite.`);
      continue;
    }
    console.log(`- ${pedido.proveedor} (${pedido.numero_seguimiento})...`);

    let status;
    try {
      status = await consultarDHL(pedido.numero_seguimiento);
    } catch (err) {
      console.warn(`  Error consultando DHL: ${err.message}`);
      continue;
    }
    if (!status) {
      console.log('  Sin respuesta útil de DHL, se deja igual.');
      continue;
    }

    const nuevoEstado = MAPA_ESTADOS[status.statusCode];
    if (!nuevoEstado) {
      console.log(`  Estado DHL "${status.statusCode}" no mapeado, se deja igual.`);
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
