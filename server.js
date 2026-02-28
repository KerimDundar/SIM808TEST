// server.js
const net = require("net");
const express = require("express");
const cors = require("cors");

const HTTP_PORT = Number(process.env.PORT || 8080);
const RAW_TCP_PORT = Number(process.env.RAW_TCP_PORT || 9000);
const ONLINE_WINDOW_MS = 60_000;

const app = express();
app.use(cors());
app.use(express.json());

const devices = new Map();

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function upsertDevice(payload, source) {
  const devId = String(payload?.dev || "unknown");
  if (!devices.has(devId)) {
    devices.set(devId, { latest: {}, lastSeen: 0, source: "unknown" });
  }
  const d = devices.get(devId);
  d.latest = payload;
  d.lastSeen = Date.now();
  d.source = source;
  return devId;
}

function deviceView(id, d) {
  return {
    id,
    online: (Date.now() - d.lastSeen) < ONLINE_WINDOW_MS,
    lastSeen: d.lastSeen,
    source: d.source,
    latest: d.latest
  };
}

// ---------- HTTP ROUTES ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, httpPort: HTTP_PORT, rawTcpPort: RAW_TCP_PORT });
});

app.post("/device/telemetry", (req, res) => {
  const body = req.body || {};
  const devId = upsertDevice(body, "http");
  console.log("HTTP telemetry:", devId, body);
  res.json({ ok: true, dev: devId });
});

app.get("/devices", (_req, res) => {
  const list = Array.from(devices.entries()).map(([id, d]) => deviceView(id, d));
  res.json(list);
});

app.get("/devices/:id/latest", (req, res) => {
  const id = String(req.params.id);
  if (!devices.has(id)) {
    return res.status(404).json({ error: "unknown device" });
  }
  return res.json(deviceView(id, devices.get(id)));
});

app.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`HTTP API listening on 0.0.0.0:${HTTP_PORT}`);
});

// ---------- RAW TCP SERVER ----------
function handleTcpPayload(raw, socket) {
  const line = raw.trim();
  if (!line) return false;

  const obj = safeJsonParse(line);
  if (!obj || typeof obj !== "object") {
    console.log("TCP non-JSON:", line);
    return false;
  }

  const devId = upsertDevice(obj, "tcp");
  console.log("TCP telemetry:", devId, obj);

  // İstersen kaldırabilirsin, debug için faydalı:
  socket.write("OK\n");
  return true;
}

const tcpServer = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log("TCP client connected:", remote);

  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    // 1) NDJSON satırları
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const p of parts) {
      handleTcpPayload(p, socket);
    }

    // 2) Satır sonu yoksa ama tam JSON geldiyse
    const t = buffer.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      if (handleTcpPayload(t, socket)) {
        buffer = "";
      }
    }

    // güvenlik: aşırı buffer büyümesini kes
    if (buffer.length > 8192) {
      console.log("TCP buffer overflow reset:", remote);
      buffer = "";
    }
  });

  socket.on("end", () => {
    if (buffer.trim()) handleTcpPayload(buffer, socket);
    console.log("TCP client ended:", remote);
  });

  socket.on("error", (err) => {
    console.log("TCP socket error:", remote, err.message);
  });

  socket.on("close", () => {
    console.log("TCP client closed:", remote);
  });
});

tcpServer.listen(RAW_TCP_PORT, "0.0.0.0", () => {
  console.log(`RAW TCP listening on 0.0.0.0:${RAW_TCP_PORT}`);
});
