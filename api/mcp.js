const shiprocket = require("../lib/shiprocket");
const delhivery = require("../lib/delhivery");
const dlops = require("../lib/delhiveryOps");
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
  {
    name: "delhivery_connection_check",
    description:
      "Check the Delhivery connection: which env vars are set and whether the API token works. Run this first if any Delhivery tool errors.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delhivery_track_shipments",
    description:
      "Live Delhivery tracking for up to hundreds of shipments (batched 50 per call). Pass waybills (AWBs) and/or order_ids (the order number sent to Delhivery, e.g. Shopify order name or Wix order number). Returns current status, status_type (UD undelivered, DL delivered, RT return/RTO, PP pickup pending, CN cancelled), last scan, pickup date, promised delivery date, RTO flags and a by_status count. Set include_scans for full scan history.",
    inputSchema: {
      type: "object",
      properties: {
        waybills: { type: "array", items: { type: "string" } },
        order_ids: { type: "array", items: { type: "string" } },
        include_scans: { type: "boolean" },
      },
    },
  },
  {
    name: "delhivery_check_pincodes",
    description:
      "Check whether Delhivery serves one or more Indian pincodes, and whether prepaid, COD, pickup and reverse pickup are available there.",
    inputSchema: {
      type: "object",
      properties: { pincodes: { type: "array", items: { type: "string" } } },
      required: ["pincodes"],
    },
  },
  {
    name: "delhivery_create_shipments",
    description:
      "Book (manifest) one or more Delhivery forward shipments from a single pickup location; Delhivery assigns the waybills. pickup_location must exactly match a pickup location name registered in Delhivery (e.g. 'Mumbai Residence' or 'Pune Residence'); if omitted it defaults to DELHIVERY_PICKUP_LOCATION or 'Mumbai Residence'. Without confirm: true this is a DRY RUN that returns the exact payload and books nothing; always show the dry run to the user and get their go-ahead before calling again with confirm: true. weight_grams is the packed weight; dimensions in cm.",
    inputSchema: {
      type: "object",
      properties: {
        pickup_location: { type: "string", description: "Defaults to 'Mumbai Residence'" },
        confirm: { type: "boolean" },
        shipments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              order: { type: "string", description: "Order number, used as Delhivery reference" },
              name: { type: "string" },
              address: { type: "string" },
              pin: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              phone: { type: "string" },
              payment_mode: { type: "string", enum: ["Prepaid", "COD"] },
              total_amount: { type: "number" },
              cod_amount: { type: "number" },
              products_desc: { type: "string" },
              quantity: { type: "number" },
              weight_grams: { type: "number" },
              length_cm: { type: "number" },
              width_cm: { type: "number" },
              height_cm: { type: "number" },
              hsn_code: { type: "string", description: "Overrides DELHIVERY_HSN_CODE, e.g. 4901 books, 6205 shirts" },
              shipping_mode: { type: "string", enum: ["Surface", "Express"] },
            },
            required: ["order", "name", "address", "pin", "phone", "weight_grams"],
          },
        },
      },
      required: ["shipments"],
    },
  },
  {
    name: "delhivery_create_reverse_pickups",
    description:
      "Book Delhivery reverse pickups (RVP): Delhivery collects a parcel from the CUSTOMER's address and returns it to pickup_location (your warehouse, default 'Mumbai Residence'). Use for returns and exchange pickups. name/address/pin/phone are the customer's details. Use the order number with a suffix as the reference (e.g. 'WK1631-R') so it can be tracked. Without confirm: true this is a DRY RUN that returns the exact payload and books nothing; always show the dry run to the user and get their go-ahead before calling again with confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        pickup_location: { type: "string", description: "Warehouse the parcel returns to. Defaults to 'Mumbai Residence'" },
        confirm: { type: "boolean" },
        shipments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              order: { type: "string", description: "Reference, e.g. 'WK1631-R'" },
              name: { type: "string", description: "Customer name" },
              address: { type: "string", description: "Customer address to collect from" },
              pin: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              phone: { type: "string" },
              total_amount: { type: "number", description: "Declared value of the item being returned" },
              products_desc: { type: "string" },
              quantity: { type: "number" },
              weight_grams: { type: "number" },
              length_cm: { type: "number" },
              width_cm: { type: "number" },
              height_cm: { type: "number" },
              hsn_code: { type: "string" },
            },
            required: ["order", "name", "address", "pin", "phone", "weight_grams"],
          },
        },
      },
      required: ["shipments"],
    },
  },
  {
    name: "delhivery_find_shipments",
    description:
      "List every shipment booked on this Delhivery account in a window of waybills, without knowing the AWBs or the reference they were booked under (forward shipments and reverse pickups). Delhivery has no 'list shipments' API, so this scans sequential AWBs starting at from_waybill (any recent AWB from this account). direction 'forward' finds newer bookings and stops after stop_after_misses empty AWBs; 'backward' looks at older ones. Optional filters: name_contains, phone_contains (customer name/phone from the consignee record), order_contains, destination_contains, status (e.g. 'Manifested', 'Not Picked', 'Pending', or status_type 'UD'/'DL'/'PP'), reverse_only, exclude_delivered. Results include customer_name, customer_phone and customer_pin.",
    inputSchema: {
      type: "object",
      properties: {
        from_waybill: { type: "string", description: "Any valid recent AWB from this account" },
        direction: { type: "string", enum: ["forward", "backward"] },
        count: { type: "number", description: "How many AWBs to scan (max 400, default 100)" },
        stop_after_misses: { type: "number", description: "Forward scans stop after this many empty AWBs in a row (default 20)" },
        order_contains: { type: "string" },
        destination_contains: { type: "string" },
        status: { type: "string" },
        reverse_only: { type: "boolean" },
        exclude_delivered: { type: "boolean" },
        name_contains: { type: "string", description: "Match customer (consignee) name" },
        phone_contains: { type: "string", description: "Match customer phone (last 10 digits compared)" },
      },
      required: ["from_waybill"],
    },
  },
  {
    name: "delhivery_edit_shipment",
    description:
      "Edit a booked Delhivery shipment by waybill: customer name, address, phone, product description, weight, dimensions, payment mode (Prepaid/COD) or COD amount. Delhivery only accepts edits before the shipment is in transit (payment mode, weight, dimensions) or before it is out for delivery (address, phone). Only pass the fields you want to change. Without confirm: true it is a DRY RUN; show it to the user and get their go-ahead first.",
    inputSchema: {
      type: "object",
      properties: {
        waybill: { type: "string" },
        name: { type: "string" },
        address: { type: "string" },
        phone: { type: "string" },
        products_desc: { type: "string" },
        weight_grams: { type: "number" },
        length_cm: { type: "number" },
        width_cm: { type: "number" },
        height_cm: { type: "number" },
        payment_mode: { type: "string", enum: ["Prepaid", "COD"] },
        cod_amount: { type: "number" },
        confirm: { type: "boolean" },
      },
      required: ["waybill"],
    },
  },
  {
    name: "delhivery_ndr_action",
    description:
      "Act on failed deliveries (NDR: consignee unavailable, address issue, etc.). For each waybill choose action: 'RE-ATTEMPT' (try delivery again), 'DEFER_DLV' (deliver on deferred_date, YYYY-MM-DD) or 'EDIT_DETAILS' (correct name/address/phone, then Delhivery re-attempts). Delhivery allows up to 3 attempts before RTO. Processed asynchronously; re-track afterwards. Without confirm: true it is a DRY RUN; show it to the user and get their go-ahead first.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              waybill: { type: "string" },
              action: { type: "string", enum: ["RE-ATTEMPT", "DEFER_DLV", "EDIT_DETAILS"] },
              deferred_date: { type: "string", description: "YYYY-MM-DD, for DEFER_DLV" },
              name: { type: "string" },
              address: { type: "string" },
              phone: { type: "string" },
            },
            required: ["waybill", "action"],
          },
        },
        confirm: { type: "boolean" },
      },
      required: ["actions"],
    },
  },
  {
    name: "delhivery_cancel_shipment",
    description:
      "Cancel a Delhivery shipment by waybill (only works before it is picked up). Without confirm: true it is a dry run; get the user's go-ahead first.",
    inputSchema: {
      type: "object",
      properties: { waybill: { type: "string" }, confirm: { type: "boolean" } },
      required: ["waybill"],
    },
  },
  {
    name: "delhivery_schedule_pickup",
    description:
      "Raise a Delhivery pickup request for a pickup location on a date. pickup_time is HH:MM (24h). Without confirm: true it is a dry run; get the user's go-ahead first.",
    inputSchema: {
      type: "object",
      properties: {
        pickup_location: { type: "string", description: "Defaults to 'Mumbai Residence'" },
        pickup_date: { type: "string", description: "YYYY-MM-DD" },
        pickup_time: { type: "string", description: "HH:MM, default 14:00" },
        expected_package_count: { type: "number" },
        confirm: { type: "boolean" },
      },
      required: ["pickup_date", "expected_package_count"],
    },
  },
  {
    name: "delhivery_shipping_labels",
    description:
      "Get printable shipping label PDFs for booked waybills. pdf_size '4R' (4x6 thermal, default) or 'A4'. Returns a PDF link per waybill.",
    inputSchema: {
      type: "object",
      properties: {
        waybills: { type: "array", items: { type: "string" } },
        pdf_size: { type: "string", enum: ["4R", "A4"] },
      },
      required: ["waybills"],
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
    case "delhivery_connection_check":
      return dlops.connectionCheck();
    case "delhivery_track_shipments":
      return dlops.trackShipments(args);
    case "delhivery_check_pincodes":
      return dlops.checkPincodes(args);
    case "delhivery_create_shipments":
      return dlops.createShipments(args);
    case "delhivery_create_reverse_pickups":
      return dlops.createReversePickups(args);
    case "delhivery_find_shipments":
      return dlops.findShipments(args);
    case "delhivery_edit_shipment":
      return dlops.editShipment(args);
    case "delhivery_ndr_action":
      return dlops.ndrAction(args);
    case "delhivery_cancel_shipment":
      return dlops.cancelShipment(args);
    case "delhivery_schedule_pickup":
      return dlops.schedulePickup(args);
    case "delhivery_shipping_labels":
      return dlops.shippingLabels(args);
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
  // Auth: accept either the query-param token (manual/browser testing) or a
  // Bearer token from the Authorization header (what the OAuth flow issues).
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const bearerToken = bearerMatch ? bearerMatch[1] : null;
  const authorized =
    req.query.token === process.env.MCP_ACCESS_TOKEN ||
    bearerToken === process.env.MCP_ACCESS_TOKEN;

  // Some MCP clients probe with a plain GET before POSTing. Respond with a
  // simple health payload instead of falling through to "unsupported method",
  // which some clients read as "not a valid MCP server" and give up.
  if (req.method === "GET") {
    res.status(200).json({ status: "ok", server: "shipping-cost-mcp" });
    return;
  }

  const body = req.body || {};
  console.log(`[shipping-mcp] ${req.method} method=${body.method} id=${body.id}`);

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
      let result;
      try {
        result = await callTool(name, args || {});
      } catch (toolErr) {
        res.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: toolErr.message, details: toolErr.details || null }, null, 2) }],
          },
        });
        return;
      }
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
          serverInfo: { name: "shipping-cost-mcp", version: "0.4.0" },
          capabilities: { tools: {} },
        },
      });
      return;
    }

    // Notifications (e.g. "notifications/initialized") have no "id" and
    // expect no response body at all per JSON-RPC spec.
    if (body.method && body.method.startsWith("notifications/")) {
      res.status(202).end();
      return;
    }

    // Some MCP clients probe for optional capabilities (resources/list,
    // prompts/list, ping, etc.) that this server doesn't implement. Respond
    // with an empty-but-valid result rather than a hard error — a 400 here
    // can cause the client to treat the whole connection as broken, even
    // though tools/list works fine.
    res.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {},
    });
  } catch (err) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32000, message: err.message },
    });
  }
};
