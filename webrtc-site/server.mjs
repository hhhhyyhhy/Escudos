// Servidor mínimo para o site WebRTC: entrega os arquivos estáticos e faz a
// sinalização (troca de offer/answer/ICE) por Server-Sent Events + POST.
// Não usa dependências externas — apenas módulos nativos do Node.js.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PEERS_PER_ROOM = 2;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** @type {Map<string, Map<string, import("node:http").ServerResponse>>} */
const rooms = new Map();

function sendEvent(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room, exceptPeer, type, payload) {
  for (const [peerId, res] of rooms.get(room) ?? []) {
    if (peerId !== exceptPeer) sendEvent(res, type, payload);
  }
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function handleSubscribe(req, res, room, peerId) {
  const peers = rooms.get(room) ?? new Map();
  if (peers.has(peerId)) return json(res, 409, { error: "peer-id-in-use" });
  if (peers.size >= MAX_PEERS_PER_ROOM) return json(res, 403, { error: "room-full" });

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const others = [...peers.keys()];
  peers.set(peerId, res);
  rooms.set(room, peers);

  sendEvent(res, "welcome", { peerId, peers: others });
  broadcast(room, peerId, "peer-joined", { peerId });

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    const current = rooms.get(room);
    if (current?.get(peerId) !== res) return;
    current.delete(peerId);
    if (current.size === 0) rooms.delete(room);
    else broadcast(room, peerId, "peer-left", { peerId });
  });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleRelay(req, res, room, peerId) {
  const peers = rooms.get(room);
  if (!peers?.has(peerId)) return json(res, 404, { error: "not-in-room" });

  let message;
  try {
    message = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid-body" });
  }
  if (message === null || typeof message !== "object") {
    return json(res, 400, { error: "invalid-body" });
  }

  broadcast(room, peerId, "signal", { from: peerId, data: message });
  return json(res, 202, { ok: true });
}

async function serveStatic(res, pathname) {
  const relative = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  const filePath = join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR) || relative.split(sep).includes("..")) {
    return json(res, 403, { error: "forbidden" });
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    });
    res.end(content);
  } catch {
    json(res, 404, { error: "not-found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = /^\/signal\/([^/]+)$/u.exec(url.pathname);

  if (match) {
    const room = match[1];
    const peerId = url.searchParams.get("peer") ?? "";
    if (!ID_PATTERN.test(room) || !ID_PATTERN.test(peerId)) {
      return json(res, 400, { error: "invalid-room-or-peer" });
    }
    if (req.method === "GET") return handleSubscribe(req, res, room, peerId);
    if (req.method === "POST") return handleRelay(req, res, room, peerId);
    return json(res, 405, { error: "method-not-allowed" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "method-not-allowed" });
  }
  return serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Site WebRTC disponível em http://localhost:${PORT}`);
});
