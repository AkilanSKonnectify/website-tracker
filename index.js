require("dotenv").config();

const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 3001;

// LRU Cache for IP enrichment
const cache = new Map();
const MAX_CACHE_SIZE = process.env.MAX_CACHE_SIZE || 1000;

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

  // Check cache first
  if (cache.has(ip)) {
    const data = cache.get(ip);
    // Move to end (most recently used)
    cache.delete(ip);
    cache.set(ip, data);
    return data;
  }

  const enrichBase = process.env.IP_ENRICH_BASE_URL;
  const token = process.env.IPINFO_TOKEN;
  if (!enrichBase || !token)
    return { ip, enriched: null, error: "No token or enrich base url in env" };

  const target = `${enrichBase}/${encodeURIComponent(ip)}?token=${token}`;

  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`enrich API status ${res.status}`);
    }
    const data = await res.json();
    const result = { ip, ...data };

    // Cache the result if successful
    if (cache.size >= MAX_CACHE_SIZE) {
      // Remove the least recently used (first in map)
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(ip, result);

    return result;
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
    if (enrichment.error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, ...enrichment }));
      return;
    }

    console.log(payload);
    if (!payload?.event?.events) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Events not found" }));
      return;
    }

    const webhookUrls = [
      //   "https://konnectify-qa.konnectifyapp.co/webhook/1992",
      //   "https://konnectify-qa.konnectifyapp.co/webhook/1993",
      //   "https://konnectify-qa.konnectifyapp.co/webhook/2234",
    ];

    let promisedAllEvents = [];
    for (let event of payload.event.events) {
      const eventBody = { event, enrichment };
      webhookUrls.forEach((url) =>
        promisedAllEvents.push(
          sendToWebhook(url, eventBody).catch((error) => ({
            url,
            status: "failed",
            error: error.message,
          })),
        ),
      );
    }
    const results = await Promise.all(promisedAllEvents);

    if (res.headersSent) return;
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
    if (res.headersSent) return;

    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request error", details: err.message }));
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-Forwarded-For, CF-Connecting-IP",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/notification") {
    await handleNotification(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  server.close(() => {
    process.exit(0);
  });
});

server
  .listen(PORT, () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  })
  .on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error("Port already in use");
    }
  });
