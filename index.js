const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

function extractClientIp(headers = {}, fallbackIp) {
  const forwarded = headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const cfIp = headers["cf-connecting-ip"];
  const firstCfIp = Array.isArray(cfIp) ? cfIp[0] : cfIp;

  const ip =
    (firstForwarded && firstForwarded.split(",")[0]?.trim()) ||
    firstCfIp ||
    fallbackIp ||
    "unknown";

  return ip.startsWith("::ffff:") ? ip.replace("::ffff:", "") : ip;
}

async function enrichIp(ip) {
  if (!ip || ip === "unknown") {
    return { ip, enriched: null, error: "no-ip" };
  }

  const enrichBase = process.env.IP_ENRICH_BASE_URL || "https://ipapi.co";
  const target = `${enrichBase}/${encodeURIComponent(ip)}/json`;

  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`enrich API status ${res.status}`);
    }
    const data = await res.json();
    return { ip, enriched: data, error: null };
  } catch (error) {
    return { ip, enriched: null, error: error.message };
  }
}

async function sendToWebhook(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeout: 15000,
  });

  const body = await res.text();
  return { url, status: res.status, body };
}

async function handleNotification(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Only POST is supported" }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    let payload;
    try {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      payload = JSON.parse(raw);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Invalid JSON payload", details: err.message }),
      );
      return;
    }

    const clientIp = extractClientIp(req.headers, req.socket.remoteAddress);
    const enrichment = await enrichIp(clientIp);

    const eventBody = { event: payload, enrichment };
    const webhookUrls = [
      "https://konnectify-qa.konnectifyapp.co/webhook/1992",
      "https://konnectify-qa.konnectifyapp.co/webhook/1993",
      "https://konnectify-qa.konnectifyapp.co/webhook/2234",
    ];

    const results = await Promise.all(
      webhookUrls.map((url) =>
        sendToWebhook(url, eventBody).catch((error) => ({
          url,
          status: "failed",
          error: error.message,
        })),
      ),
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        clientIp,
        enrichment,
        forwardedTo: results,
      }),
    );
  });

  req.on("error", (err) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request error", details: err.message }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/notification") {
    await handleNotification(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, () => {
  console.log(`Notification listener running on http://0.0.0.0:${PORT}`);
});
