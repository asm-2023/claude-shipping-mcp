const fetch = require("node-fetch");

// IMPORTANT LIMITATION (read before wiring this up):
// Delhivery's public API has no endpoint that lists "my shipments between date X and Y"
// the way Shiprocket's /orders does, and no endpoint that returns actual historical
// billed amounts per shipment — only a live rate-estimate API. That means this module
// can only estimate what a shipment *should* cost, given its weight/pincode/mode — it
// cannot fetch what you were *actually* charged.
//
// To bucket costs by day, you must supply the day's shipments yourself: waybill,
// origin pincode, destination pincode, weight (grams), mode, and payment type. The
// simplest source is your own order records (Shopify export, White Kailash order DB,
// etc.) — anything that has date + destination pincode + weight per shipment.

const BASE = "https://track.delhivery.com/api/kinko/v1/invoice/charges/.json";

async function estimateCharge({ originPin, destPin, weightGrams, mode = "S", paymentMode = "Pre-paid" }) {
  const params = new URLSearchParams({
    cl: process.env.DELHIVERY_CLIENT_NAME,
    ss: "Delivered",
    md: mode, // "S" surface, "E" express
    pt: paymentMode, // "Pre-paid" or "COD"
    d_pin: String(destPin),
    o_pin: String(originPin),
    cgm: String(weightGrams),
  });

  const res = await fetch(`${BASE}?${params.toString()}`, {
    headers: { Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Delhivery invoice estimate failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // Response shape returns an array with a total_amount field (gross + tax approx).
  const entry = Array.isArray(data) ? data[0] : data;
  return parseFloat(entry.total_amount || 0);
}

// shipments: [{ date: 'YYYY-MM-DD', originPin, destPin, weightGrams, mode, paymentMode }]
async function estimateDailyCosts(shipments) {
  const entries = [];
  for (const shipment of shipments) {
    const amount = await estimateCharge(shipment);
    entries.push({ date: shipment.date, amount });
  }
  return entries;
}

module.exports = { estimateCharge, estimateDailyCosts };
