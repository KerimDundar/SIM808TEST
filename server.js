// server.js

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json()); // body'i JSON olarak parse et

// ---------------- In-Memory Device Store ----------------
const devices = new Map();

// Helper: güvenli JSON parse
function safeJsonParse(s) {
  try { return JSON.parse(s); }
  catch { return null; }
}

// ---------------- HTTP ROUTES ----------------

// health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Telemetry POST endpoint (STM32’den)
app.post("/device/telemetry", (req, res) => {
  console.log("📬 Received telemetry:", req.body);

  const devId = req.body.dev || "unknown";

  if (!devices.has(devId)) {
    devices.set(devId, { latest: {}, lastSeen: Date.now() });
  }

  const d = devices.get(devId);
  d.latest = req.body;
  d.lastSeen = Date.now();

  res.json({ ok: true });
});

// Devices list
app.get("/devices", (_req, res) => {
  const list = Array.from(devices.keys()).map((id) => {
    const d = devices.get(id);
    return {
      id,
      online: true,
      lastSeen: d.lastSeen,
      latest: d.latest
    };
  });
  res.json(list);
});

// Latest device data
app.get("/devices/:id/latest", (req, res) => {
  const id = String(req.params.id);
  if (!devices.has(id)) {
    return res.status(404).json({ error: "unknown device" });
  }
  const d = devices.get(id);
  res.json({
    id,
    online: true,
    lastSeen: d.lastSeen,
    latest: d.latest
  });
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`HTTP API listening on port ${port}`);
});
