# Shipping Cost MCP Connector

Pulls Shiprocket (actual) + Delhivery (estimated proxy) shipping costs into Claude,
with Yesterday / Last 7 Days / MTD / Last 30 Days rollups.

## Important limitations (read first)

- **Shiprocket**: costs come from live order data via the documented `/orders` API.
  The exact field name for shipping charge can vary by account/plan. Before trusting
  numbers, run the `shiprocket_raw_order_sample` tool and check which field
  (`shipping_charges`, `freight_charges`, `charges`, etc.) actually holds the value on
  your account, then adjust `CHARGE_FIELD_CANDIDATES` in `lib/shiprocket.js` if needed.
- **Delhivery**: there's no public API that lists your historical shipments by date,
  and no API that returns actual billed amounts — only a live rate-estimate endpoint.
  So `delhivery_cost_estimate` requires *you* to supply the shipment list (date,
  origin/dest pincode, weight) — e.g. exported from your own order records — and it
  estimates what each shipment should cost. It will be close but not exact to the paisa,
  same as your own Delhivery invoice reconciliation would show.

## Setup

1. **Generate Shiprocket API credentials**
   Shiprocket panel → Settings → API → Add New API User → note the email + password
   emailed to that address.

2. **Generate Delhivery API token**
   Delhivery One / CL Panel → Settings → API Setup → copy your static token.

3. **Deploy to Vercel**
   ```bash
   vercel deploy
   ```

4. **Set environment variables in the Vercel project dashboard** (not in code):
   - `SHIPROCKET_API_EMAIL`
   - `SHIPROCKET_API_PASSWORD`
   - `DELHIVERY_API_TOKEN`
   - `DELHIVERY_CLIENT_NAME` (your Delhivery client/company name as registered)
   - `MCP_ACCESS_TOKEN` (any random string you choose — this is what protects your
     `/api/mcp?token=...` endpoint)

5. **Add the connector in Claude** using
   `https://<your-vercel-app>.vercel.app/api/mcp?token=<MCP_ACCESS_TOKEN>`

## Tools exposed

| Tool | What it does |
| --- | --- |
| `shiprocket_cost_summary` | Actual Shiprocket freight cost for yesterday / last_7_days / last_30_days / mtd |
| `shiprocket_raw_order_sample` | Diagnostic — 3 raw orders, to confirm the charge field name |
| `delhivery_cost_estimate` | Estimated Delhivery cost for a shipment list you supply |
| `combined_cost_summary` | Both carriers combined into one INR total |
