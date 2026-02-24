// server.js
// TCP:5000 (device) + HTTP:8080 (mobile) + WebSocket:/ws
// Protocol (TCP): newline-delimited JSON (NDJSON)

const net = require("net");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

// ---------------- In-memory storage (prototype) ----------------
// PROD'da bunu Postgres/Supabase'e yazarsın.
const devices = new Map(); // devId -> { latest, socket, lastSeen }
const pendingCommands = new Map(); // devId -> [{id, set, createdAt}]

// Helper: safe JSON parse
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Helper: device registry
function ensureDevice(dev) {
  if (!devices.has(dev)) {
    devices.set(dev, { latest: null, socket: null, lastSeen: null });
  }
  if (!pendingCommands.has(dev)) pendingCommands.set(dev, []);
}

// ---------------- TCP SERVER (Devices) ----------------
const TCP_PORT = Number(process.env.TCP_PORT || 5000);

const tcpServer = net.createServer((socket) => {
  socket.setKeepAlive(true, 30_000);
  socket.setNoDelay(true);

  let devId = null;
  let buf = "";

  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");

    // NDJSON: split by newline
    while (true) {
      const idx = buf.indexOf("\n");
      if (idx < 0) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);

      if (!line) continue;
      const msg = safeJsonParse(line);
      if (!msg || typeof msg !== "object") continue;

      // Expect: msg.dev on hello/telemetry/state
      if (!devId && msg.dev) {
        devId = String(msg.dev);
        ensureDevice(devId);
        devices.get(devId).socket = socket;
        devices.get(devId).lastSeen = Date.now();
        // Send optional hello-ack
        socket.write(JSON.stringify({ type: "hello_ack", ts: Date.now() }) + "\n");
      }

      if (devId) {
        ensureDevice(devId);
        const d = devices.get(devId);
        d.lastSeen = Date.now();

        if (msg.type === "telemetry" || msg.type === "state") {
          d.latest = msg;

          // push to WS clients
          broadcastWS(devId, msg);

          // If there are pending commands, push one (simple policy: 1 per incoming msg)
          const q = pendingCommands.get(devId) || [];
          if (q.length > 0) {
            const cmd = q.shift();
            pendingCommands.set(devId, q);
            socket.write(JSON.stringify({ type: "cmd", id: cmd.id, set: cmd.set }) + "\n");
          }
        } else if (msg.type === "hello") {
          d.latest = msg;
          broadcastWS(devId, msg);
        } else if (msg.type === "ack") {
          // optional: handle ack
          broadcastWS(devId, msg);
        }
      }
    }
  });

  socket.on("close", () => {
    if (devId && devices.has(devId)) {
      const d = devices.get(devId);
      if (d.socket === socket) d.socket = null;
      d.lastSeen = Date.now();
    }
  });

  socket.on("error", () => {
    // ignore
  });
});

tcpServer.listen(TCP_PORT, "0.0.0.0", () => {
  console.log(`TCP listening on ${TCP_PORT}`);
});

// ---------------- HTTP + WS SERVER (Mobile) ----------------
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// list devices
app.get("/devices", (_req, res) => {
  const list = Array.from(devices.keys()).map((id) => {
    const d = devices.get(id);
    return {
      id,
      online: !!d.socket,
      lastSeen: d.lastSeen,
    };
  });
  res.json(list);
});

// latest telemetry/state for a device
app.get("/devices/:id/latest", (req, res) => {
  const id = String(req.params.id);
  if (!devices.has(id)) return res.status(404).json({ error: "unknown device" });
  const d = devices.get(id);
  res.json({
    id,
    online: !!d.socket,
    lastSeen: d.lastSeen,
    latest: d.latest,
  });
});

// send command (valve open/close)
app.post("/devices/:id/command", (req, res) => {
  const id = String(req.params.id);
  ensureDevice(id);

  // body: { valve: 1..6, state: 0/1 }
  const valve = Number(req.body?.valve);
  const state = Number(req.body?.state);

  if (!(valve >= 1 && valve <= 6)) return res.status(400).json({ error: "valve must be 1..6" });
  if (!(state === 0 || state === 1)) return res.status(400).json({ error: "state must be 0 or 1" });

  const cmdId = `c-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const set = { [`v${valve}`]: state };

  // If device online, push immediately, else queue
  const d = devices.get(id);
  if (d.socket) {
    d.socket.write(JSON.stringify({ type: "cmd", id: cmdId, set }) + "\n");
  } else {
    const q = pendingCommands.get(id) || [];
    q.push({ id: cmdId, set, createdAt: Date.now() });
    pendingCommands.set(id, q);
  }

  res.json({ ok: true, id: cmdId, queued: !d.socket });
});

const HTTP_PORT = Number(process.env.PORT || 8080);
const server = http.createServer(app);

// WS: /ws?dev=DEV123  (dev yoksa tüm cihazlar)
const wss = new WebSocket.Server({ server, path: "/ws" });

function broadcastWS(devId, msg) {
  const payload = JSON.stringify({ dev: devId, msg });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const want = client._devFilter;
    if (!want || want === devId) client.send(payload);
  }
}

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const dev = url.searchParams.get("dev");
    ws._devFilter = dev ? String(dev) : null;
  } catch {
    ws._devFilter = null;
  }

  ws.send(JSON.stringify({ type: "ws_ready", ts: Date.now(), filter: ws._devFilter }));

  ws.on("message", () => {
    // Mobile -> server messages not needed now
  });
});

server.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`HTTP listening on ${HTTP_PORT}`);
});