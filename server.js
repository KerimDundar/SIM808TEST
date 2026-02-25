// server.js
const net = require("net");
const http = require("http");
const express = require("express");

// ---------------- In-memory storage ----------------
const devices = new Map();
const pendingCommands = new Map();

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function ensureDevice(dev) {
  if (!devices.has(dev)) devices.set(dev, { latest: null, socket: null, lastSeen: null });
  if (!pendingCommands.has(dev)) pendingCommands.set(dev, []);
}

const app = express();
app.use(express.json());

// HTTP health
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// HTTP devices list
app.get("/devices", (_req, res) => {
  const list = Array.from(devices.keys()).map((id) => {
    const d = devices.get(id);
    return {
      id,
      online: !!d.socket,
      lastSeen: d.lastSeen
    };
  });
  res.json(list);
});

app.get("/devices/:id/latest", (req, res) => {
  const id = String(req.params.id);
  if (!devices.has(id)) return res.status(404).json({ error: "unknown device" });
  const d = devices.get(id);
  res.json({
    id,
    online: !!d.socket,
    lastSeen: d.lastSeen,
    latest: d.latest
  });
});

// Create a raw TCP handler on the same server
const server = http.createServer(app);

// Buffer for partial lines
function handleTCPsocket(socket) {
  let buf = "";
  socket.on("data", (chunk) => {
    console.log("⚡ [TCP] raw chunk:", chunk.toString());

    buf += chunk.toString("utf8");
    while (true) {
      const idx = buf.indexOf("\n");  
      if (idx < 0) break;

      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;

      console.log("📨 [TCP] line:", line);

      const msg = safeJsonParse(line);
      if (!msg || typeof msg !== "object") {
        console.log("⚠ JSON parse failed:", line);
        continue;
      }

      console.log("✔ Parsed JSON:", msg);

      if (msg.dev) {
        ensureDevice(msg.dev);
        const d = devices.get(msg.dev);
        d.latest = msg;
        d.socket = socket;
        d.lastSeen = Date.now();
      }
    }
  });

  socket.on("close", () => {
    // client closed
  });

  socket.on("error", (err) => {
    console.error("⚠ TCP socket error:", err);
  });
}

// Listen for *TCP* “connection” events on the HTTP server
server.on("connection", (socket) => {
  socket.once("data", (chunk) => {
    // Peek at the first byte or buffer
    const text = chunk.toString().trim();

    // If it looks like HTTP (starts with GET/POST), treat as HTTP
    if (text.startsWith("GET") || text.startsWith("POST")) {
      socket.unshift(chunk); // Put the data back
      return;
    }

    // Otherwise treat it as TCP data
    handleTCPsocket(socket);

    // Put the data back so handleTCPsocket can parse it
    socket.unshift(chunk);
  });
});

const PORT = Number(process.env.PORT || 5000);
server.listen(PORT, () => {
  console.log(`Unified server listening on ${PORT}`);
});
