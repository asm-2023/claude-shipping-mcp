const crypto = require("crypto");

// RFC 7591 Dynamic Client Registration. Since this server only ever serves
// one user (you), we don't need to persist real client records — we just
// echo back a generated client_id so Claude's connector flow has something
// to hold onto for the rest of the OAuth dance. No client_secret because
// we register as a public client (token_endpoint_auth_method: "none").
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }

  const body = req.body || {};
  const clientId = crypto.randomBytes(16).toString("hex");

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris || [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
};
