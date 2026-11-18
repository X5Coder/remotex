/**
 * LAN-mode server — turns the agent into a fully self-sufficient peer for the SAME Wi-Fi:
 *
 *   1. HTTP server serving the built web client (phone opens http://<pc-ip>:9190/)
 *   2. A tiny Nostr-compatible (NIP-01) WebSocket relay ON THE SAME PORT so the
 *      UNCHANGED trystero client can signal over the LAN — no public relays needed.
 *
 * No single line of this leaves the LAN. The web client auto-detects a LAN-hosted
 * page and prefers the ws:// relay; public Nostr relays remain the cross-network path.
 *
 * Port: REMOTEX_LAN_PORT (default 9190). If the port is taken, LAN mode is skipped
 * gracefully (public relays still work).
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { app } from "electron";
import { WebSocketServer, WebSocket } from "ws";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function findLanIp(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    // skip virtual adapters (WSL / Hyper-V / VMware / loopback)
    if (/vEthernet|Hyper-V|Loopback|VMware|VirtualBox|WSL|vEthernet/i.test(name)) continue;
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

function webDistDir(): string | null {
  const candidates = [
    path.join(__dirname, "..", "..", "web", "dist"),
    path.join(app.getAppPath(), "..", "web", "dist"),
    path.join(process.cwd(), "web", "dist"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "index.html"))) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

function safeJoin(root: string, urlPath: string): string | null {
  const p = path.normalize(decodeURIComponent(urlPath));
  // strip any leading slashes/drive letters and force containment
  const rel = p.replace(/^([/\\]|[a-zA-Z]:)+/, "");
  const full = path.join(root, rel);
  const rootResolved = path.resolve(root);
  if (!path.resolve(full).startsWith(rootResolved)) return null;
  return full;
}

const PORT_CANDIDATES = [4545] as const; // single fixed LAN port by user decision; if busy → evict whatever owns it

export interface LanInfo {
  port: number;
  url: string | null;
  error?: string;
}
let state: LanInfo = { port: PORT_CANDIDATES[0]!, url: null };
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

/** returns true if a foreign TCP listener owns the port */
function portOwnerPid(port: number): number | null {
  try {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`],
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    const pid = parseInt((r.stdout || "").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True only for processes that belong to this app (kept for diagnostics; the user
 *  explicitly authorized evicting ANY owner of 4545). */
function isOurProcess(pid: number): boolean {
  try {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path)`],
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    const p = (r.stdout || "").trim().toLowerCase();
    return p.includes("remotex") || p.includes("node_modules\\electron");
  } catch {
    return false;
  }
}

function killProcess(pid: number): boolean {
  try {
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    return true;
  } catch {
    return false;
  }
}

/** Pick the one fixed port (4545). If busy, evict its owner (user authorized this). */
function claimPort(): number | null {
  const port = PORT_CANDIDATES[0]!;
  const owner = portOwnerPid(port);
  if (owner === null) return port;
  console.log(`[lan] port ${port} is held by pid ${owner} — evicting it (user authorized killing any process on ${port})`);
  if (!killProcess(owner)) return null;
  spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 700"], { windowsHide: true });
  return portOwnerPid(port) === null ? port : null;
}

export function lanInfo(): LanInfo {
  return { ...state };
}

export function startLanServer(): LanInfo {
  if (httpServer) return lanInfo();
  const portEnv = Number(process.env.REMOTEX_LAN_PORT || 0);
  const port = portEnv > 0 ? portEnv : claimPort();
  if (port === null) {
    state = { port: 0, url: null, error: "could not claim fixed port 4545 (owner refused to die) — LAN mode disabled (public relays still work)" };
    console.warn("[lan] could not claim port 4545 — disable LAN mode");
    return lanInfo();
  }
  state = { port, url: null };

  const dist = webDistDir();
  if (!dist) {
    state.error = "web client build not found";
    console.warn("[lan] web/dist not found — LAN page disabled; signaling still works");
  }

  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    if (!dist) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("RemoteX web client not built yet. Run: cd web && npm install && npm run build");
      return;
    }
    let rel = urlPath === "/" ? "index.html" : urlPath;
    const full = safeJoin(dist, rel);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
      "connection": "close", // free the per-origin pool for WebSocket upgrades instantly
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(full).pipe(res);
  });

  // ---- Nostr-compatible (NIP-01 subset) relay on the same port
  const wssLocal = new WebSocketServer({ server });
  wssLocal.on("connection", (ws, req) => {
    console.log(`[lan] ws client connected from ${req.socket.remoteAddress} (origin ${req.headers.origin})`);
    clients.add(ws);
    ws.on("close", (code, reason) => { console.log(`[lan] ws client closed code=${code} reason=${reason?.toString()}`); clients.delete(ws); });
    ws.on("error", (err) => { console.log("[lan] ws client error:", err.message); clients.delete(ws); });
    ws.on("message", (raw) => {
      const size = typeof (raw as Buffer).length === "number" ? (raw as Buffer).length : (raw as ArrayBuffer).byteLength ?? 0;
      if (size > 1024 * 1024) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed frames
      }
      if (!Array.isArray(msg)) return;
      const [type] = msg as unknown[];
      if (type === "EVENT") {
        const evt = msg[1];
        if (!evt || typeof evt !== "object") return;
        // LAN mini-relay: tiny traffic, broadcast every publish to every other peer
        for (const other of clients) {
          if (other !== ws && other.readyState === WebSocket.OPEN) {
            try { other.send(JSON.stringify(["EVENT", evt])); } catch { /* drop */ }
          }
        }
        return;
      }
      if (type === "REQ") {
        // trystero only needs live events; acknowledge immediately
        try { ws.send(JSON.stringify(["EOSE", msg[1]])); } catch { /* drop */ }
        return;
      }
      // CLOSE / AUTH / anything else — trystero never sends these
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      state.error = `port ${port} is already in use`;
      console.warn(`[lan] port ${port} in use — LAN mode disabled (public relays still work)`);
    } else {
      state.error = String(err.message);
      console.warn("[lan] server error:", err);
    }
    try { server.close(); } catch { /* nothing */ }
    try { wssLocal.close(); } catch { /* nothing */ }
    httpServer = null;
    wss = null;
    clients.clear();
  });

  server.on("upgrade", (req, socket) => {
    console.log(`[lan] upgrade from ${req.socket.remoteAddress} headers:`, JSON.stringify(req.headers));
  });

  server.listen(port, "0.0.0.0", () => {
    const ip = findLanIp();
    state.url = ip ? `http://${ip}:${port}/` : null;
    if (state.url) {
      console.log(`[lan] RemoteX is ready on your network: ${state.url}`);
    } else {
      console.log("[lan] server up, no LAN IPv4 found (local-only?)");
    }
  });

  httpServer = server;
  wss = wssLocal;
  return lanInfo();
}

export function stopLanServer() {
  try { wss?.close(); } catch { /* fine */ }
  try { httpServer?.close(); } catch { /* fine */ }
  wss = null;
  httpServer = null;
  clients.clear();
}
