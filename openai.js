// Simple in-memory rate limiter (best-effort — resets on cold start,
// but still blocks most abuse/bot traffic hitting this endpoint directly).
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 15; // max requests per IP per hour
const hits = new Map();

// Only allow requests coming from your own site.
const ALLOWED_HOSTS = [
  "ilmejafar.com",
  "www.ilmejafar.com",
  "ilme-jafar-six.vercel.app",
];

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function isAllowedOrigin(req) {
  const origin = req.headers["origin"] || req.headers["referer"] || "";
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.includes(host);
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const ip = getClientIp(req);
  const now = Date.now();
  const entry = hits.get(ip);
  if (entry && now - entry.start < RATE_LIMIT_WINDOW_MS) {
    if (entry.count >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: "Too many requests, please try again later." });
    }
    entry.count++;
  } else {
    hits.set(ip, { start: now, count: 1 });
  }

  try {
    const { prompt } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    if (prompt.length > 2000) {
      return res.status(400).json({ error: "prompt too long" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt,
        max_output_tokens: 600,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI API error:", openaiRes.status, errText);
      return res.status(502).json({ error: "OpenAI request failed", details: errText });
    }

    const data = await openaiRes.json();

    // TEMP DEBUG: log the full response so we can see its shape in Vercel logs
    console.log("OpenAI raw response:", JSON.stringify(data));

    return res.status(200).json(data);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
