/**
 * RemoteX — Electron main process.
 *
 * Small visible window with:
 *   - the PERMANENT Room ID (created once, saved in userData)
 *   - the per-launch RANDOM password (memory only)
 *   - connection status, keep-awake status, fps/bitrate telemetry
 *   - a "Stop session" button (drops the client, re-arms the room)
 *
 * A hidden window (dist/hidden.html) owns WebRTC + capture; this process owns
 * the OS: input injection, clipboard, power settings, tray.
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, powerSaveBlocker, screen, nativeImage, desktopCapturer, session } from "electron";
import * as path from "path";
import * as fs from "fs";
import { loadOrCreateIdentity, createLaunchPassword } from "./config";
import { createDriver, clipboardHash, type InputDriver } from "./input";
import { startLanServer, lanInfo, stopLanServer } from "./lan";
import { startLocalMouseWatch, type LocalMouseWatch } from "./local-mouse-watch";

// --------------------------------------------------------------- singleton --
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ------------------------------------------------------------------- state --
let quitting = false;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let hidden: BrowserWindow | null = null;
let localMouseWatch: LocalMouseWatch | null = null;
let driver: InputDriver | null = null;
let keepAwake: { status: string; detail: string; isAdmin: boolean; stop(): void } | null = null;
let powerSaveBlockerIds: number[] = [];

const identity = loadOrCreateIdentity();
const password = createLaunchPassword();

/** clipboard-sync echo guards */
let lastClipboardHash: string | null = null;
let lastAgentClipboardWrite = 0;
let lastStats: { fps: number; mbps: number; encoder: string; rung: number; rttMs: number | null } = { fps: 0, mbps: 0, encoder: "", rung: 0, rttMs: null };

// ------------------------------------------------------------ window & tray --
function createMainWindow() {
  win = new BrowserWindow({
    width: 470,
    height: 640,
    minWidth: 420,
    minHeight: 600,
    resizable: true,
    maximizable: false,
    frame: false,
    title: "RemoteX",
    backgroundColor: "#eceff3",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(__dirname, "window.html"));
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => { win = null; });
}

function ensureWindow() {
  if (!win) createMainWindow();
  win?.show();
  win?.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("RemoteX — click to show Device ID");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show RemoteX", click: () => ensureWindow() },
      { label: "Stop session", click: () => stopSession() },
      { type: "separator" },
      { label: "Quit RemoteX", click: () => app.quit() },
    ])
  );
  tray.on("click", () => {
    if (win?.isVisible()) win.hide(); else ensureWindow();
  });
}

function createHiddenWindow() {
  hidden = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needs mediaDevices + RTCPeerConnection; no node APIs from remote content
    },
  });
  void hidden.loadFile(path.join(__dirname, "hidden.html"), {
    query: { roomId: identity.roomId, password },
  });
  hidden.webContents.on("console-message", ((event: { message?: string } | unknown) => {
    const msg = typeof (event as { message?: string })?.message === "string" ? (event as { message: string }).message : String(event);
    console.log("[hidden-ui]", msg);
  }) as never);
  hidden.webContents.on("render-process-gone", (_e, details) => {
    console.error("[hidden] renderer gone:", details.reason);
    stopPower();
  });
  hidden.on("closed", () => { hidden = null; });
}

// ------------------------------------------------------------------- power --
function startPower() {
  for (const type of ["prevent-display-sleep", "prevent-app-suspension"] as const) {
    try {
      powerSaveBlockerIds.push(powerSaveBlocker.start(type));
    } catch (err) {
      console.error("[power] powerSaveBlocker failed:", err);
    }
  }
  const platformDir = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(__dirname, "..", "platform", platformDir, "power.js"));
    keepAwake = mod.keepAwake({ userData: app.getPath("userData"), log: (m: string) => console.log("[power]", m) });
  } catch (err) {
    keepAwake = {
      status: "unavailable",
      detail: `Keep-awake module failed to load: ${err instanceof Error ? err.message : String(err)}`,
      isAdmin: false,
      stop: () => {},
    };
  }
}

function stopPower() {
  try { keepAwake?.stop(); } catch (err) { console.error("[power] stop failed:", err); }
  for (const id of powerSaveBlockerIds) {
    try { powerSaveBlocker.stop(id); } catch { /* already stopped */ }
  }
  powerSaveBlockerIds = [];
}

/** resolution the screencast is actually captured at (physical pixels of the captured monitor) */
let captureW = 0, captureH = 0;

// ------------------------------------------------------------- video handler --
function installDisplayCaptureHandlers() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "display-capture" || permission === "media");
  });
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
        const primary = screen.getPrimaryDisplay();
        const primaryId = String(primary.id);
        const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
        if (!source) { callback({}); return; }
        callback({ video: source });
      } catch (err) {
        console.error("[capture] handler failed:", err);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

// ----------------------------------------------------------------- clipboard --
function startClipboardPolling() {
  setInterval(() => {
    void (async () => {
      try {
        const text = await clipboard.readText();
        if (!text) return;
        if (text.length > 1024 * 1024) return; // 1 MB cap
        if (Date.now() - lastAgentClipboardWrite < 800) return; // suppress self-echo
        const hash = clipboardHash(text);
        if (hash === lastClipboardHash) return;
        lastClipboardHash = hash;
        hidden?.webContents.send("clipboard-changed", text);
      } catch { /* clipboard locked by another app */ }
    })();
  }, 250);
}

// -------------------------------------------------------------------- input --
// Input commands MUST run strictly in order — text typing is paced (~8ms/char) and an
// out-of-order backspace/enter would corrupt the typed stream. A single serial promise
// chain guarantees this for every command kind.
let inputChain: Promise<void> = Promise.resolve();
/** Enqueue one command; the returned promise resolves when THIS command's turn has run (or failed). */
function injectInputAsync(msg: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    inputChain = inputChain
      .catch(() => { /* a failed command must not poison the chain */ })
      .then(() => injectInputNow(msg))
      .then(() => resolve(), (e) => { console.error("[input] inject failed:", e); resolve(); });
  });
}

async function injectInputNow(msg: any): Promise<void> {
  if (!driver) return;
  switch (msg?.kind) {
    case "move":
      if (process.env.REMOTEX_INPUT_LOG) console.log(`[input ${new Date().toISOString().slice(11,19)}] move x=${Number(msg.x ?? 0).toFixed(4)} y=${Number(msg.y ?? 0).toFixed(4)}`);
      driver.move(Number(msg.x) || 0, Number(msg.y) || 0);
      return;
    case "click":
      if (process.env.REMOTEX_INPUT_LOG) console.log(`[input ${new Date().toISOString().slice(11,19)}] click ${msg.button ?? "left"}${msg.double ? " double" : ""} at (${Number(msg.x ?? 0).toFixed(4)}, ${Number(msg.y ?? 0).toFixed(4)})`);
      if (Number.isFinite(Number(msg.x)) && Number.isFinite(Number(msg.y))) driver.move(Number(msg.x), Number(msg.y));
      driver.click(msg.button ?? "left", !!msg.double);
      return;
    case "button":
      if (process.env.REMOTEX_INPUT_LOG) console.log(`[input ${new Date().toISOString().slice(11,19)}] button ${msg.button ?? "left"} ${msg.down ? "down" : "up"}`);
      if (msg.down) driver.buttonDown(msg.button ?? "left");
      else driver.buttonUp(msg.button ?? "left");
      return;
    case "key":
      if (process.env.REMOTEX_INPUT_LOG) console.log(`[input ${new Date().toISOString().slice(11,19)}] key ${msg.code} down=${!!msg.down}`);
      driver.key(String(msg.code ?? ""), String(msg.key ?? ""), !!msg.down, msg.mods ?? { ctrl: false, alt: false, shift: false, meta: false });
      return;
    case "text":
      if (process.env.REMOTEX_INPUT_LOG) console.log(`[input ${new Date().toISOString().slice(11,19)}] text ${JSON.stringify(String(msg.text ?? ""))}`);
      lastAgentClipboardWrite = Date.now();
      await driver.typeText(String(msg.text ?? ""));
      return;
    case "paste":
      lastAgentClipboardWrite = Date.now();
      console.log("[input] paste from client:", String(msg.text ?? "").length, "chars");
      await driver.pasteText(String(msg.text ?? ""));
      return;
    case "reset":
      driver.reset();
      return;
    default:
      console.warn("[input] unknown message", msg?.kind);
  }
}

// --------------------------------------------------------------------- ipc --
function registerIpc() {
  ipcMain.handle("agent:identity", () => ({
    roomId: identity.roomId,
    password,
    power: { status: keepAwake?.status ?? "unknown", detail: keepAwake?.detail ?? "unknown", isAdmin: keepAwake?.isAdmin ?? false },
    lan: lanInfo(),
  }));

  ipcMain.handle("agent:copy", async (_e, text: unknown) => {
    await clipboard.writeText(String(text ?? ""));
  });

  ipcMain.handle("agent:quit", () => app.quit());

  ipcMain.handle("agent:status", (_e, payload: unknown) => {
    const p = payload as { text?: string; tone?: string };
    if (p?.text) console.log("[status]", p.tone ?? "", "-", p.text);
    win?.webContents.send("status:update", payload);
    if (tray) tray.setToolTip(p?.tone === "connected" ? "RemoteX Agent — session active" : "RemoteX Agent — waiting");
  });

  ipcMain.handle("session:stop", () => stopSession());

  ipcMain.handle("screen:info", () => {
    const displays = screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      width: d.size.width,
      height: d.size.height,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
    const primary = screen.getPrimaryDisplay();
    return { primary: { width: primary.size.width, height: primary.size.height }, displays };
  });

  ipcMain.handle("screen:bounds", () => {
    // use the SAME coordinate space robotjs reports — DPI-agnostic
    const size = driver?.screenSize() ?? { width: 1536, height: 864 };
    return { x: 0, y: 0, w: size.width, h: size.height };
  });

  ipcMain.handle("cursor:host", (_e, payload: unknown) => {
    const visible = (payload as { visible?: unknown })?.visible !== false; // default true — restore, never trap
    try {
      const { setHostCursorVisible } = require("./cursor-visibility") as typeof import("./cursor-visibility");
      const r = setHostCursorVisible(visible);
      if (!r.ok) console.warn("[cursor] host visibility switch failed:", r.error ?? "?");
      return r;
    } catch (err) {
      console.warn("[cursor] visibility module unavailable:", err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("screen:cursorRaw", () => {
    const pos = driver?.cursorPosition() ?? { x: 0, y: 0 };
    return { x: pos.x, y: pos.y };
  });

  ipcMain.handle("screen:cursor", () => {
    const size = driver?.screenSize() ?? { width: 1, height: 1 };
    const pos = driver?.cursorPosition() ?? { x: 0, y: 0 };
    // normalize against the CAPTURED resolution when known — exact 1:1 with the video pixels;
    // falls back to Electron's DIP-sized primary display otherwise
    const w = captureW || size.width, h = captureH || size.height;
    return { nx: pos.x / Math.max(1, w - 1), ny: pos.y / Math.max(1, h - 1) };
  });

  ipcMain.handle("platform:info", () => process.platform);

  // resolves only after THIS command has actually been applied by the chain — the hidden
  // window uses this to know exactly when the OS cursor jumped (cursor-ownership arbitration)
  ipcMain.handle("input:inject", (_e, msg: unknown) => injectInputAsync(msg));

  ipcMain.handle("capture:dimensions", (_e, dims: unknown) => {
    const d = dims as { width?: number; height?: number };
    if (Number.isFinite(d?.width) && Number.isFinite(d?.height) && (d!.width as number) > 0 && (d!.height as number) > 0) {
      captureW = Math.floor(d!.width as number);
      captureH = Math.floor(d!.height as number);
      console.log(`[capture] dimensions reported: ${captureW}x${captureH}`);
    }
  });

  ipcMain.handle("capture:primary-source", async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      const primary = screen.getPrimaryDisplay();
      const match = sources.find((s) => s.display_id === String(primary.id));
      return (match ?? sources[0])?.id ?? "";
    } catch (err) {
      console.error("[capture] fallback source query failed:", err);
      return "";
    }
  });

  ipcMain.handle("win:minimize", () => { win?.minimize(); });
  ipcMain.handle("win:close", () => { win?.hide(); });

  ipcMain.handle("turn:config", () => {
    try {
      const raw = fs.readFileSync(path.join(app.getPath("userData"), "turn.json"), "utf8");
      const j = JSON.parse(raw) as { urls?: unknown; username?: unknown; credential?: unknown };
      const urls = Array.isArray(j?.urls)
        ? j.urls.filter((u): u is string => typeof u === "string" && u.length > 0)
        : typeof j?.urls === "string" && j.urls ? [j.urls] : [];
      if (urls.length === 0) return null;
      const cfg: { urls: string[]; username?: string; credential?: string } = { urls: urls.slice(0, 5) };
      if (typeof j.username === "string") cfg.username = j.username;
      if (typeof j.credential === "string") cfg.credential = j.credential;
      return cfg;
    } catch {
      return null;
    }
  });

  ipcMain.handle("stats:report", (_e, stats: unknown) => {
    lastStats = { ...lastStats, ...(stats as object) };
    win?.webContents.send("status:update", { ...lastStats, kind: "stats" });
  });

  ipcMain.handle("rtt:report", (_e, ms: unknown) => {
    const rttMs = typeof ms === "number" ? Math.round(ms) : null;
    if (rttMs !== null) lastStats.rttMs = rttMs;
    win?.webContents.send("status:update", { ...lastStats, kind: "stats" });
  });
}

function stopSession() {
  driver?.reset();
  hidden?.webContents.send("session:stop");
  win?.webContents.send("status:update", { tone: "waiting", text: "Session stopped — ready for a new connection" });
}

// ---------------------------------------------------------------- lifecycle --
void app.whenReady().then(() => {
  if (!gotLock) return;
  // normalize the host cursor to VISIBLE at launch — self-heals any stuck session state
  try { const { ensureHostCursorVisible } = require("./cursor-visibility") as typeof import("./cursor-visibility"); ensureHostCursorVisible(); } catch { /* soft-fail */ }
  const size = screen.getPrimaryDisplay().size;
  driver = createDriver({ width: size.width, height: size.height });
  installDisplayCaptureHandlers();
  startPower();
  registerIpc();
  createTray();
  createMainWindow();
  createHiddenWindow();
  startClipboardPolling();
  startLanServer(); // LAN-mode: serves web client + LAN signaling relay
  // Windows-only: WH_MOUSE_LL physical mouse watch — the person at THIS PC always gets
  // the OS arrow back instantly, even while a remote session is driving remotely
  localMouseWatch = startLocalMouseWatch((x, y) => hidden?.webContents.send("local-mouse-activity", { x, y }));
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  stopPower();
  stopLanServer();
  try { localMouseWatch?.stop(); } catch { /* fine */ }
  try { const { ensureHostCursorVisible } = require("./cursor-visibility") as typeof import("./cursor-visibility"); ensureHostCursorVisible(); } catch { /* fine */ }
  try { tray?.destroy(); } catch { /* fine */ }
});

app.on("activate", () => ensureWindow());

app.on("second-instance", () => ensureWindow());
