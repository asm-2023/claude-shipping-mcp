module.exports = (req, res) => {
  const origin = `https://${req.headers.host}`;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
  });
};
