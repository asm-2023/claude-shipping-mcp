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
//   DELHIVERY_PICKUP_LOCATION - default pickup/warehouse name (falls back to "Mumbai Residence")
//
// Every call that creates, cancels or schedules something requires
// confirm: true. Without it the tool returns the exact payload it WOULD send,
// so Claude can show it to you before anything is booked or charged.

const BASE = () => (process.env.DELHIVERY_BASE_URL || "https://track.delhivery.com").replace(/\/$/, "");
const DEFAULT_PICKUP = () => process.env.DELHIVERY_PICKUP_LOCATION || "Mumbai Residence";
// GSTIN is public (it's printed on every invoice), so a code fallback is fine;
// the DELHIVERY_SELLER_GST env var still wins if set.
const SELLER_GST = () => process.env.DELHIVERY_SELLER_GST || "27AAYCA1613L1ZA";
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

function buildShipment(s, { reverse = false } = {}) {
  const qty = s.quantity || 1;
  // Reverse pickups (RVP) use payment_mode "Pickup": the consignee fields are
  // the customer's address the parcel is collected from, and pickup_location is
  // the warehouse it returns to.
  const paymentMode = reverse ? "Pickup" : /cod/i.test(s.payment_mode || "") ? "COD" : "Prepaid";
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
    seller_gst_tin: SELLER_GST(),
    shipping_mode: /express/i.test(s.shipping_mode || "") ? "Express" : "Surface",
    waybill: "",
  };
}

async function createShipments({ pickup_location, shipments, confirm }, { reverse = false } = {}) {
  pickup_location = pickup_location || DEFAULT_PICKUP();
  if (!Array.isArray(shipments) || !shipments.length) throw new Error("Pass at least one shipment");
  const missing = [];
  shipments.forEach((s, i) => {
    for (const f of ["order", "name", "address", "pin", "phone", "weight_grams"]) {
      if (s[f] == null || s[f] === "") missing.push(`shipments[${i}].${f}`);
    }
  });
  if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}`);

  const payload = {
    pickup_location: { name: pickup_location },
    shipments: shipments.map((s) => buildShipment(s, { reverse })),
  };
  const warnings = [];
  if (!SELLER_GST()) warnings.push("Seller GST is not set — Delhivery may reject the booking");

  if (confirm !== true) {
    const what = reverse ? "reverse pickups" : "shipments";
    return { dry_run: true, note: `Nothing was booked. Call again with confirm: true to create these ${what}.`, warnings, payload };
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

// Reverse pickup: Delhivery collects a parcel from the customer and brings it
// back to pickup_location. Same manifest API as forward shipments, with
// payment_mode "Pickup".
async function createReversePickups(args) {
  return createShipments(args, { reverse: true });
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

// ------------------------------------------------- edit a booked shipment
// Uses the same /api/p/edit endpoint as cancellation. Delhivery only accepts
// edits before the shipment is out for delivery (address/phone) and before it
// is in transit (payment mode, weight, dimensions).
const EDIT_FIELDS = {
  name: "name",
  address: "add",
  phone: "phone",
  products_desc: "products_desc",
  weight_grams: "gm",
  length_cm: "shipment_length",
  width_cm: "shipment_width",
  height_cm: "shipment_height",
};

async function editShipment({ waybill, confirm, payment_mode, cod_amount, ...fields }) {
  if (!waybill) throw new Error("waybill is required");
  const payload = { waybill: String(waybill) };
  for (const [k, apiKey] of Object.entries(EDIT_FIELDS)) {
    if (fields[k] != null && fields[k] !== "") payload[apiKey] = fields[k];
  }
  if (payment_mode) {
    payload.pt = /cod/i.test(payment_mode) ? "COD" : "Pre-paid";
    if (payload.pt === "COD") {
      if (cod_amount == null) throw new Error("cod_amount is required when switching to COD");
      payload.cod = cod_amount;
    }
  } else if (cod_amount != null) {
    payload.cod = cod_amount;
  }
  if (Object.keys(payload).length === 1) throw new Error("Pass at least one field to change");
  if (confirm !== true) {
    return { dry_run: true, note: "Nothing was changed. Call again with confirm: true to apply.", payload };
  }
  const data = await call("/api/p/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { waybill, applied: payload, result: data };
}

// --------------------------------------- failed delivery (NDR) actions
// POST /api/p/update with { data: [{ waybill, act, action_data }] }.
//   RE-ATTEMPT   - try delivering again (no action_data)
//   DEFER_DLV    - deliver on a later date (action_data.deferred_date YYYY-MM-DD)
//   EDIT_DETAILS - correct consignee name / address / phone (action_data)
// Delhivery answers with a request_id ("UPL...") and processes it async.
const NDR_ACTS = ["RE-ATTEMPT", "DEFER_DLV", "EDIT_DETAILS"];

async function ndrAction({ actions, confirm }) {
  if (!Array.isArray(actions) || !actions.length) throw new Error("Pass at least one action");
  const data = actions.map((a, i) => {
    const act = String(a.action || "").toUpperCase().replace(/^REATTEMPT$/, "RE-ATTEMPT");
    if (!a.waybill) throw new Error(`actions[${i}].waybill is required`);
    if (!NDR_ACTS.includes(act)) throw new Error(`actions[${i}].action must be one of ${NDR_ACTS.join(", ")}`);
    const item = { waybill: String(a.waybill), act };
    if (act === "DEFER_DLV") {
      if (!a.deferred_date) throw new Error(`actions[${i}].deferred_date (YYYY-MM-DD) is required for DEFER_DLV`);
      // Delhivery's docs spell this both ways; send both so either is accepted.
      item.action_data = { deferred_date: a.deferred_date, defered_date: a.deferred_date };
    }
    if (act === "EDIT_DETAILS") {
      const ad = {};
      if (a.name) ad.name = a.name;
      if (a.address) ad.add = a.address;
      if (a.phone) ad.phone = String(a.phone);
      if (!Object.keys(ad).length) throw new Error(`actions[${i}] EDIT_DETAILS needs name, address and/or phone`);
      item.action_data = ad;
    }
    return item;
  });
  const payload = { data };
  if (confirm !== true) {
    return { dry_run: true, note: "Nothing was sent. Call again with confirm: true to submit.", payload };
  }
  const res = await call("/api/p/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return {
    submitted: data,
    request_id: res.request_id || null,
    message: res.message || null,
    result: res,
    note: "Delhivery processes this asynchronously. Re-check the shipment with delhivery_track_shipments to see the outcome.",
  };
}

// ------------------------------------------ find shipments by AWB range
// Delhivery has no "list my shipments" API, but an account's waybills are
// issued in sequence: 13-digit serial + 1 check digit = (serial mod 10^6) mod 7.
// Scanning a range of serials and tracking them returns every shipment booked
// in that window, whatever reference it was booked under.
function awbFromBase(base) {
  return `${base}${(base % 1000000) % 7}`;
}
function isValidAwb(awb) {
  const s = String(awb);
  if (!/^\d{14}$/.test(s)) return false;
  const base = Number(s.slice(0, 13));
  return awbFromBase(base) === s;
}

async function findShipments({
  from_waybill,
  direction = "forward",
  count = 100,
  stop_after_misses = 20,
  order_contains,
  destination_contains,
  status,
  reverse_only = false,
  exclude_delivered = false,
}) {
  if (!from_waybill || !isValidAwb(from_waybill)) {
    throw new Error("from_waybill must be a valid 14-digit Delhivery AWB from this account (any recent one)");
  }
  const n = Math.min(Math.max(Number(count) || 100, 1), 400);
  const start = Number(String(from_waybill).slice(0, 13));
  const step = direction === "backward" ? -1 : 1;

  const found = [];
  let scanned = 0;
  let misses = 0;
  let lastFound = null;
  // Scan in batches so we can stop early once we run past the newest AWB.
  for (let offset = 0; offset < n; offset += TRACK_BATCH) {
    const batch = [];
    for (let i = offset; i < Math.min(offset + TRACK_BATCH, n); i++) batch.push(awbFromBase(start + step * i));
    const r = await trackShipments({ waybills: batch });
    scanned += batch.length;
    const byWb = new Map(r.shipments.map((s) => [String(s.waybill), s]));
    for (const wb of batch) {
      const s = byWb.get(wb);
      if (s) {
        found.push(s);
        lastFound = wb;
        misses = 0;
      } else {
        misses++;
      }
    }
    if (step === 1 && misses >= stop_after_misses) break;
  }

  const lc = (v) => String(v || "").toLowerCase();
  const rows = found
    .filter((s) => !order_contains || lc(s.order_id).includes(lc(order_contains)))
    .filter((s) => !destination_contains || lc(s.destination).includes(lc(destination_contains)))
    .filter((s) => !status || lc(s.status) === lc(status) || lc(s.status_type) === lc(status))
    .filter((s) => !reverse_only || lc(s.payment_mode) === "pickup")
    .filter((s) => !exclude_delivered || !(s.status_type === "DL"))
    .map((s) => ({
      waybill: s.waybill,
      order_id: s.order_id,
      type: lc(s.payment_mode) === "pickup" ? "reverse_pickup" : "forward",
      status: s.status,
      status_type: s.status_type,
      instructions: s.instructions,
      status_at: s.status_at,
      origin: s.origin,
      destination: s.destination,
      pickup_date: s.pickup_date,
      promised_delivery: s.promised_delivery,
      delivered_at: s.delivered_at,
      rto: s.rto,
    }));

  const by_status = {};
  for (const r of rows) by_status[r.status || "Unknown"] = (by_status[r.status || "Unknown"] || 0) + 1;

  return {
    scanned,
    shipments_found_in_range: found.length,
    matched: rows.length,
    newest_waybill_seen: step === 1 ? lastFound : null,
    by_status,
    shipments: rows,
    note: "Tracking data has no customer name or phone, so match those via the order number in Shopify.",
  };
}

// ----------------------------------------------------------------- pickups

async function schedulePickup({ pickup_location, pickup_date, pickup_time = "14:00:00", expected_package_count, confirm }) {
  pickup_location = pickup_location || DEFAULT_PICKUP();
  if (!pickup_date || !expected_package_count) {
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
    seller_gst_in_use: SELLER_GST(),
    DELHIVERY_HSN_CODE: Boolean(process.env.DELHIVERY_HSN_CODE),
    default_pickup_location: DEFAULT_PICKUP(),
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
  createReversePickups,
  editShipment,
  ndrAction,
  findShipments,
  cancelShipment,
  schedulePickup,
  shippingLabels,
  connectionCheck,
};
