const fetch = require("node-fetch");

const BASE = "https://apiv2.shiprocket.in/v1/external";

let cachedToken = null;
let cachedTokenExpiry = 0;

// Shiprocket bearer tokens are long-lived (~10 days) but we re-auth defensively.
async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_API_EMAIL,
      password: process.env.SHIPROCKET_API_PASSWORD,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shiprocket auth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = data.token;
  // Re-auth every 9 days to stay well within the ~10 day expiry.
  cachedTokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

async function authedGet(path) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Shiprocket GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Diagnostic tool: fetch one page of raw orders so you can confirm the exact
// field names your account's API returns for shipping charges before trusting
// the aggregation below. Shiprocket's per-order cost field naming has varied
// across accounts/plans historically (e.g. shipping_charges vs freight_charges),
// so this is deliberately exposed as its own MCP tool.
async function fetchRawOrderSample() {
  return authedGet("/orders?per_page=3&page=1");
}

// Pulls orders in [start, end] (YYYY-MM-DD, inclusive) across pages and extracts
// a per-day cost series. Adjust FIELD candidates below once you've confirmed
// the real field name via fetchRawOrderSample().
const MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// Shiprocket returns dates like "5 Jul 2026, 06:06 PM" — not ISO. Parse
// manually rather than trusting Date.parse with a non-standard format.
function parseShiprocketDate(raw) {
  if (!raw) return null;
  const match = /^(\d{1,2}) (\w{3}) (\d{4})/.exec(raw);
  if (!match) return null;
  const [, day, mon, year] = match;
  const month = MONTHS[mon];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

function extractCharge(order) {
  // Actual freight charge only exists once a courier/AWB has been assigned.
  // Orders that are brand new (no courier yet) or fulfilled outside
  // Shiprocket ("SELF FULFILLED") will legitimately have no charge here.
  const shipment = order.shipments && order.shipments[0];
  const shipmentCharge = shipment && parseFloat(shipment.shipping_charges);
  if (!isNaN(shipmentCharge) && shipmentCharge > 0) return shipmentCharge;

  const awbCharge =
    order.awb_data && order.awb_data.charges && parseFloat(order.awb_data.charges.freight_charges);
  if (!isNaN(awbCharge) && awbCharge > 0) return awbCharge;

  return 0;
}

function extractDate(order) {
  return parseShiprocketDate(order.created_at);
}

async function fetchDailyCosts(start, end) {
  const entries = [];
  let page = 1;
  const perPage = 100;
  const MAX_PAGES = 20; // safety cap regardless of total order count

  while (page <= MAX_PAGES) {
    const data = await authedGet(`/orders?per_page=${perPage}&page=${page}`);
    const orders = data.data || [];
    if (orders.length === 0) break;

    let sawInRange = false;
    let allOlderThanStart = true;

    for (const order of orders) {
      const date = extractDate(order);
      if (!date) continue;
      if (date >= start && date <= end) {
        entries.push({ date, amount: extractCharge(order) });
        sawInRange = true;
      }
      if (date >= start) allOlderThanStart = false;
    }

    // Orders come back newest-first by default. Once a whole page is older
    // than our window, every later page will be too — stop early instead of
    // paging through the entire order history every time.
    if (allOlderThanStart && !sawInRange) break;

    const meta = data.meta && data.meta.pagination;
    if (!meta || page >= meta.total_pages) break;
    page += 1;
  }

  return entries;
}

module.exports = { fetchRawOrderSample, fetchDailyCosts };
