const fetch = require("node-fetch");

// Delhivery operational tools: tracking, serviceability, shipment booking,
// cancellation, pickup requests and shipping labels.
//
// ENV VARS (set in Vercel project settings, never in code):
//   DELHIVERY_API_TOKEN    - already set for the cost estimator
//   DELHIVERY_BASE_URL     - optional, defaults to https://track.delhivery.com
//   DELHIVERY_SELLER_NAME  - seller name as registered with Delhivery (booking)
//   DELHIVERY_SELLER_GST   - seller GSTIN (booking)
//   DELHIVERY_HSN_CODE     - default HSN if a shipment doesn't pass one (booking)
//
// Every call that creates, cancels or schedules something requires
// confirm: true. Without it the tool returns the exact payload it WOULD send,
// so Claude can show it to you before anything is booked or charged.

const BASE = () => (process.env.DELHIVERY_BASE_URL || "https://track.delhivery.com").replace(/\/$/, "");
const TRACK_BATCH = 50;

function authHeaders(extra = {}) {
  if (!process.env.DELHIVERY_API_TOKEN) {
    throw new Error("DELHIVERY_API_TOKEN is not set in this Vercel project");
  }
  return { Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`, Accept: "application/json", ...extra };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

async function call(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${BASE()}${path}`, { method, headers: authHeaders(headers), body });
  const data = await readJson(res);
  if (!res.ok) {
    const err = new Error(`Delhivery ${method} ${path.split("?")[0]} failed: HTTP ${res.status}`);
    err.details = data;
    throw err;
  }
  return data;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function cleanList(list) {
  return [...new Set((list || []).map((v) => String(v).trim()).filter(Boolean))];
}

// ---------------------------------------------------------------- tracking

function summariseShipment(s, includeScans) {
  const status = s.Status || {};
  const scans = (s.Scans || []).map((x) => x.ScanDetail || x);
  const out = {
    waybill: s.AWB,
    order_id: s.ReferenceNo,
    status: status.Status,
    status_type: status.StatusType, // UD undelivered, DL delivered, RT return, PP pickup pending, CN cancelled
    status_at: status.StatusDateTime,
    status_location: status.StatusLocation,
    instructions: status.Instructions,
    origin: s.Origin,
    destination: s.Destination,
    pickup_date: s.PickUpDate,
    promised_delivery: s.PromisedDeliveryDate || s.ExpectedDeliveryDate,
    delivered_at: s.DeliveryDate,
    rto: Boolean(s.ReturnedDate || s.RTOStartedDate || status.StatusType === "RT"),
    rto_started: s.RTOStartedDate,
    returned_at: s.ReturnedDate,
    payment_mode: s.OrderType,
    cod_amount: s.CODAmount,
    attempts: scans.filter((x) => /attempt|undelivered|not delivered/i.test(`${x.Scan} ${x.Instructions}`)).length,
    last_scan: scans.length ? scans[scans.length - 1] : null,
  };
  if (includeScans) out.scans = scans;
  return out;
}

async function trackShipments({ waybills, order_ids, include_scans = false }) {
  const wbns = cleanList(waybills);
  const refs = cleanList(order_ids);
  if (!wbns.length && !refs.length) throw new Error("Pass waybills and/or order_ids");

  const results = [];
  const errors = [];
  const run = async (param, list) => {
    for (const batch of chunk(list, TRACK_BATCH)) {
      try {
        const data = await call(`/api/v1/packages/json/?${param}=${encodeURIComponent(batch.join(","))}`);
        for (const item of data.ShipmentData || []) {
          results.push(summariseShipment(item.Shipment || item, include_scans));
        }
        if (data.Error) errors.push({ batch, error: data.Error });
      } catch (e) {
        errors.push({ batch, error: e.message, details: e.details });
      }
    }
  };
  if (wbns.length) await run("waybill", wbns);
  if (refs.length) await run("ref_ids", refs);

  const found = new Set(results.flatMap((r) => [r.waybill, r.order_id].map(String)));
  const not_found = [...wbns, ...refs].filter((x) => !found.has(x));

  const by_status = {};
  for (const r of results) by_status[r.status || "Unknown"] = (by_status[r.status || "Unknown"] || 0) + 1;

  return { count: results.length, by_status, shipments: results, not_found, errors };
}

// ---------------------------------------------------------- serviceability

async function checkPincodes({ pincodes }) {
  const pins = cleanList(pincodes);
  if (!pins.length) throw new Error("Pass at least one pincode");
  const out = [];
  for (const pin of pins) {
    const data = await call(`/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pin)}`);
    const entry = (data.delivery_codes || [])[0];
    const pc = entry && (entry.postal_code || entry);
    out.push(
      pc
        ? {
            pincode: pin,
            serviceable: true,
            prepaid: pc.pre_paid === "Y",
            cod: pc.cod === "Y",
            pickup: pc.pickup === "Y",
            reverse_pickup: pc.repl === "Y",
            city: pc.city,
            district: pc.district,
            state: pc.state_code,
            remarks: pc.remarks || null, // "Embargo" etc.
          }
        : { pincode: pin, serviceable: false }
    );
  }
  return { results: out };
}

// ---------------------------------------------------------------- booking

function buildShipment(s) {
  const qty = s.quantity || 1;
  const paymentMode = /cod/i.test(s.payment_mode || "") ? "COD" : "Prepaid";
  const total = Number(s.total_amount || 0);
  return {
    name: s.name,
    add: s.address,
    pin: String(s.pin),
    city: s.city || "",
    state: s.state || "",
    country: "India",
    phone: String(s.phone || ""),
    order: String(s.order),
    payment_mode: paymentMode,
    cod_amount: paymentMode === "COD" ? String(s.cod_amount ?? total) : "",
    total_amount: String(total),
    products_desc: s.products_desc || "",
    quantity: String(qty),
    weight: String(s.weight_grams),
    shipment_length: s.length_cm != null ? String(s.length_cm) : "",
    shipment_width: s.width_cm != null ? String(s.width_cm) : "",
    shipment_height: s.height_cm != null ? String(s.height_cm) : "",
    hsn_code: s.hsn_code || process.env.DELHIVERY_HSN_CODE || "",
    seller_name: process.env.DELHIVERY_SELLER_NAME || "",
    seller_gst_tin: process.env.DELHIVERY_SELLER_GST || "",
    shipping_mode: /express/i.test(s.shipping_mode || "") ? "Express" : "Surface",
    waybill: "",
  };
}

async function createShipments({ pickup_location, shipments, confirm }) {
  if (!pickup_location) throw new Error("pickup_location is required (must match a pickup location name in Delhivery exactly)");
  if (!Array.isArray(shipments) || !shipments.length) throw new Error("Pass at least one shipment");
  const missing = [];
  shipments.forEach((s, i) => {
    for (const f of ["order", "name", "address", "pin", "phone", "weight_grams"]) {
      if (s[f] == null || s[f] === "") missing.push(`shipments[${i}].${f}`);
    }
  });
  if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}`);

  const payload = { pickup_location: { name: pickup_location }, shipments: shipments.map(buildShipment) };
  const warnings = [];
  if (!process.env.DELHIVERY_SELLER_GST) warnings.push("DELHIVERY_SELLER_GST is not set — Delhivery may reject the booking");
  if (!process.env.DELHIVERY_SELLER_NAME) warnings.push("DELHIVERY_SELLER_NAME is not set");

  if (confirm !== true) {
    return { dry_run: true, note: "Nothing was booked. Call again with confirm: true to create these shipments.", warnings, payload };
  }

  const form = new URLSearchParams();
  form.set("format", "json");
  form.set("data", JSON.stringify(payload));
  const data = await call("/api/cmu/create.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  return {
    success: Boolean(data.success),
    booked: (data.packages || []).map((p) => ({
      order_id: p.refnum,
      waybill: p.waybill,
      status: p.status,
      remarks: p.remarks,
    })),
    package_count: data.package_count,
    errors: data.rmk || data.error || null,
    warnings,
  };
}

async function cancelShipment({ waybill, confirm }) {
  if (!waybill) throw new Error("waybill is required");
  if (confirm !== true) {
    return { dry_run: true, note: `Would cancel waybill ${waybill}. Call again with confirm: true to cancel.` };
  }
  const data = await call("/api/p/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ waybill: String(waybill), cancellation: "true" }),
  });
  return { waybill, result: data };
}

// ----------------------------------------------------------------- pickups

async function schedulePickup({ pickup_location, pickup_date, pickup_time = "14:00:00", expected_package_count, confirm }) {
  if (!pickup_location || !pickup_date || !expected_package_count) {
    throw new Error("pickup_location, pickup_date (YYYY-MM-DD) and expected_package_count are required");
  }
  const time = /^\d{2}:\d{2}$/.test(pickup_time) ? `${pickup_time}:00` : pickup_time;
  const payload = {
    pickup_location,
    pickup_date,
    pickup_time: time,
    expected_package_count: Number(expected_package_count),
  };
  if (confirm !== true) {
    return { dry_run: true, note: "No pickup requested. Call again with confirm: true.", payload };
  }
  const data = await call("/fm/request/new/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { requested: payload, result: data };
}

// ------------------------------------------------------------------ labels

async function shippingLabels({ waybills, pdf_size = "4R" }) {
  const wbns = cleanList(waybills);
  if (!wbns.length) throw new Error("Pass at least one waybill");
  const labels = [];
  const errors = [];
  for (const batch of chunk(wbns, 25)) {
    try {
      const data = await call(
        `/api/p/packing_slip?wbns=${encodeURIComponent(batch.join(","))}&pdf=true&pdf_size=${encodeURIComponent(pdf_size)}`
      );
      for (const p of data.packages || []) {
        labels.push({ waybill: p.wbn || p.waybill, order_id: p.oid || p.refnum, pdf_url: p.pdf_download_link || null });
      }
      if (!data.packages) errors.push({ batch, response: data });
    } catch (e) {
      errors.push({ batch, error: e.message, details: e.details });
    }
  }
  return { count: labels.length, labels, errors };
}

// ------------------------------------------------------------ health check

async function connectionCheck() {
  const env = {
    DELHIVERY_API_TOKEN: Boolean(process.env.DELHIVERY_API_TOKEN),
    DELHIVERY_CLIENT_NAME: Boolean(process.env.DELHIVERY_CLIENT_NAME),
    DELHIVERY_SELLER_NAME: Boolean(process.env.DELHIVERY_SELLER_NAME),
    DELHIVERY_SELLER_GST: Boolean(process.env.DELHIVERY_SELLER_GST),
    DELHIVERY_HSN_CODE: Boolean(process.env.DELHIVERY_HSN_CODE),
    base_url: BASE(),
  };
  let token_works = false;
  let error = null;
  try {
    const r = await checkPincodes({ pincodes: ["400042"] });
    token_works = r.results.length > 0;
  } catch (e) {
    error = e.message;
  }
  return {
    env,
    token_works,
    error,
    note: "Delhivery's API has no endpoint for wallet balance or a list of all shipments; check those on one.delhivery.com.",
  };
}

module.exports = {
  trackShipments,
  checkPincodes,
  createShipments,
  cancelShipment,
  schedulePickup,
  shippingLabels,
  connectionCheck,
};
