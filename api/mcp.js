const shiprocket = require("../lib/shiprocket");
const delhivery = require("../lib/delhivery");
const { getDateRange, aggregateDaily } = require("../lib/dateBuckets");

const VIEWS = ["yesterday", "last_7_days", "last_30_days", "mtd"];

const TOOLS = [
  {
    name: "shiprocket_cost_summary",
    description:
      "Get actual Shiprocket freight costs (from live order data) for a named view: yesterday, last_7_days, last_30_days, or mtd. Returns total INR and a daily breakdown.",
    inputSchema: {
      type: "object",
      properties: { view: { type: "string", enum: VIEWS } },
      required: ["view"],
    },
  },
  {
    name: "shiprocket_raw_order_sample",
    description:
      "Diagnostic tool: returns 3 raw Shiprocket orders as-is from the API, so you can confirm the exact field name used for shipping charge on your account before trusting shiprocket_cost_summary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delhivery_cost_estimate",
    description:
      "Estimate Delhivery costs (proxy, not actual billed amount — Delhivery's API only exposes rate estimates, not historical invoices) for a list of shipments you supply. Each shipment needs date, originPin, destPin, weightGrams, and optionally mode ('S' surface / 'E' express) and paymentMode ('Pre-paid'/'COD').",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: VIEWS },
        shipments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              originPin: { type: "string" },
              destPin: { type: "string" },
              weightGrams: { type: "number" },
              mode: { type: "string" },
              paymentMode: { type: "string" },
            },
            required: ["date", "originPin", "destPin", "weightGrams"],
          },
        },
      },
      required: ["view", "shipments"],
    },
  },
  {
    name: "combined_cost_summary",
    description:
      "Combined Shiprocket (actual) + Delhivery (estimated proxy) cost view for a named window. Delhivery shipments must be supplied since there's no by-date listing API for it.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: VIEWS },
        delhivery_shipments: {
          type: "array",
          items: { type: "object" },
        },
      },
      required: ["view"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "shiprocket_cost_summary": {
      const { start, end } = getDateRange(args.view);
      const entries = await shiprocket.fetchDailyCosts(start, end);
      return aggregateDaily(entries, start, end);
    }
    case "shiprocket_raw_order_sample": {
      return shiprocket.fetchRawOrderSample();
    }
    case "delhivery_cost_estimate": {
      const { start, end } = getDateRange(args.view);
      const entries = await delhivery.estimateDailyCosts(args.shipments || []);
      return aggregateDaily(entries, start, end);
    }
    case "combined_cost_summary": {
      const { start, end } = getDateRange(args.view);
      const srEntries = await shiprocket.fetchDailyCosts(start, end);
      const dlEntries = args.delhivery_shipments
        ? await delhivery.estimateDailyCosts(args.delhivery_shipments)
        : [];
      const shiprocketResult = aggregateDaily(srEntries, start, end);
      const delhiveryResult = aggregateDaily(dlEntries, start, end);
      return {
        start,
        end,
        shiprocket: shiprocketResult,
        delhivery_estimate: delhiveryResult,
        combined_total:
          Math.round((shiprocketResult.total + delhiveryResult.total) * 100) / 100,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = async (req, res) => {
  // CORS preflight — some clients send this before the real request.
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.status(204).end();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Token auth via query param, same pattern as the Meta Ads connector.
  // IMPORTANT: we deliberately never return HTTP 401 here. Claude's custom
  // connector UI treats a 401 as a signal that the server requires OAuth and
  // tries (and fails) to negotiate a sign-in handshake, since the UI has no
  // field for a plain query-param/Bearer token — only OAuth Client ID/Secret.
  // So on a bad token we still respond 200, just with an error payload, and
  // never execute the tool.
  const authorized = req.query.token === process.env.MCP_ACCESS_TOKEN;

  // Some MCP clients probe with a plain GET before POSTing. Respond with a
  // simple health payload instead of falling through to "unsupported method",
  // which some clients read as "not a valid MCP server" and give up.
  if (req.method === "GET") {
    res.status(200).json({ status: "ok", server: "shipping-cost-mcp" });
    return;
  }

  const body = req.body || {};

  if (!authorized) {
    res.status(200).json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32001, message: "unauthorized: bad or missing token" },
    });
    return;
  }

  try {
    if (body.method === "tools/list") {
      res.json({ jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } });
      return;
    }

    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params || {};
      const result = await callTool(name, args || {});
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
      return;
    }

    if (body.method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "shipping-cost-mcp", version: "0.1.0" },
          capabilities: { tools: {} },
        },
      });
      return;
    }

    res.status(400).json({ error: "unsupported method" });
  } catch (err) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32000, message: err.message },
    });
  }
};
