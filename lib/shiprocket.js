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
const CHARGE_FIELD_CANDIDATES = ["shipping_charges", "freight_charges", "charges"];

function extractCharge(order) {
  for (const field of CHARGE_FIELD_CANDIDATES) {
    if (order[field] != null && !isNaN(parseFloat(order[field]))) {
      return parseFloat(order[field]);
    }
  }
  return 0;
}

function extractDate(order) {
  const raw = order.created_at || order.order_date;
  return raw ? raw.slice(0, 10) : null;
}

async function fetchDailyCosts(start, end) {
  const entries = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const data = await authedGet(
      `/orders?per_page=${perPage}&page=${page}&from=${start}&to=${end}`
    );
    const orders = data.data || [];
    if (orders.length === 0) break;

    for (const order of orders) {
      const date = extractDate(order);
      if (!date) continue;
      entries.push({ date, amount: extractCharge(order) });
    }

    const meta = data.meta && data.meta.pagination;
    if (!meta || page >= meta.total_pages) break;
    page += 1;
  }

  return entries;
}

module.exports = { fetchRawOrderSample, fetchDailyCosts };
