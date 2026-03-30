import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "tecit.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS help_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    device TEXT,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT 'medium',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS delete_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const insertHelpRequest = db.prepare(`
  INSERT INTO help_requests (name, email, device, subject, message, urgency)
  VALUES (@name, @email, @device, @subject, @message, @urgency)
`);

const insertDeleteRequest = db.prepare(`
  INSERT INTO delete_requests (email, type)
  VALUES (@email, @type)
`);

const requestLog = new Map();

const app = express();

app.use(express.json({ limit: "200kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.static(__dirname));

const isValidEmail = (value) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const sanitizeText = (value, max = 2000) => {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, max);
};

const sanitizeMessage = (value, max = 10000) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
};

const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
};

const isRateLimited = (req, key = "default", maxRequests = 5, windowMs = 10 * 60 * 1000) => {
  const ip = `${getClientIp(req)}:${key}`;
  const now = Date.now();
  const existing = requestLog.get(ip) || [];
  const recent = existing.filter((timestamp) => now - timestamp < windowMs);

  if (recent.length >= maxRequests) {
    requestLog.set(ip, recent);
    return true;
  }

  recent.push(now);
  requestLog.set(ip, recent);
  return false;
};

const truncate = (value, max = 1000) => {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const sendDiscordWebhook = async (payload) => {
  if (!DISCORD_WEBHOOK_URL) return { ok: false, skipped: true };

  const content = [
    "## Ny TecIT-forespørsel",
    `**Navn:** ${payload.name}`,
    `**E-post:** ${payload.email}`,
    `**Enhet / OS:** ${payload.device || "Ikke oppgitt"}`,
    `**Haster:** ${payload.urgency}`,
    `**Kort oppsummering:** ${payload.subject}`,
    "**Beskrivelse:**",
    truncate(payload.message, 1500),
  ].join("\n");

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${body}`);
  }

  return { ok: true };
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "tecit-backend" });
});

app.post("/api/help-request", async (req, res) => {
  if (isRateLimited(req, "help", 5, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "Too many requests. Try again later." });
  }

  if (typeof req.body?.website === "string" && req.body.website.trim()) {
    return res.status(200).json({ ok: true });
  }

  const payload = {
    name: sanitizeText(req.body?.name, 120),
    email: sanitizeText(req.body?.email, 200).toLowerCase(),
    device: sanitizeText(req.body?.device, 200),
    subject: sanitizeText(req.body?.subject, 200),
    message: sanitizeMessage(req.body?.message, 5000),
    urgency: sanitizeText(req.body?.urgency, 20).toLowerCase() || "medium",
  };

  if (
    !payload.name ||
    payload.name.length < 2 ||
    !payload.subject ||
    payload.subject.length < 3 ||
    !payload.message ||
    payload.message.length < 10 ||
    !isValidEmail(payload.email)
  ) {
    return res.status(400).json({ ok: false, error: "Invalid request payload" });
  }

  if (!["low", "medium", "high"].includes(payload.urgency)) {
    payload.urgency = "medium";
  }

  try {
    const result = insertHelpRequest.run(payload);

    try {
      await sendDiscordWebhook(payload);
    } catch (notifyError) {
      console.error("Saved request, but Discord notify failed:", notifyError);
    }

    return res.status(201).json({ ok: true, id: result.lastInsertRowid });
  } catch (error) {
    console.error("Failed to save help request:", error);
    return res.status(500).json({ ok: false, error: "Failed to save request" });
  }
});

app.post("/api/delete-request", (req, res) => {
  if (isRateLimited(req, "delete", 3, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "Too many requests. Try again later." });
  }

  const payload = {
    email: sanitizeText(req.body?.email, 200).toLowerCase(),
    type: sanitizeText(req.body?.type, 40).toLowerCase() || "all",
  };

  if (!isValidEmail(payload.email)) {
    return res.status(400).json({ ok: false, error: "Invalid email" });
  }

  if (!["all", "requests", "messages"].includes(payload.type)) {
    payload.type = "all";
  }

  try {
    const result = insertDeleteRequest.run(payload);
    return res.status(201).json({ ok: true, id: result.lastInsertRowid });
  } catch (error) {
    console.error("Failed to save delete request:", error);
    return res.status(500).json({ ok: false, error: "Failed to save delete request" });
  }
});

app.listen(PORT, () => {
  console.log(`TecIT backend running on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
