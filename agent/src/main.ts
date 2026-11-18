/**
 * RemoteX — Electron main process.
 *
 * Small visible window with:
 *   - the PERMANENT Device ID (created once, saved in userData)
 *   - the per-launch RANDOM password (memory only; rotatable from the window)
 *   - connection status only — nothing else
 *   - a "Terminate" button (drops the connected user, re-arms the room)
 *
 * A hidden window (dist/hidden.html) owns WebRTC + capture; this process owns
 * the OS: input injection, clipboard, power settings, tray.
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, powerSaveBlocker, screen, nativeImage, desktopCapturer, session, Notification, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import { loadOrCreateIdentity, createLaunchPassword, regeneratePassword } from "./config";
import { createDriver, clipboardHash, type InputDriver } from "./input";
import { startLanServer, stopLanServer } from "./lan";
import { verifyTurn, buildTurnUrls, waitForTurnCredential } from "./turn-verify";
import { loadMailConfig, runTurnSignup, TurnSignupError, type MailConfig } from "./turn-signup";
import { syncTurnNow, verifyAndHealTurnJson } from "./turn-sync";

// --------------------------------------------------------------- singleton --
// Tell Windows who we are so the taskbar AND toast notifications use RemoteX's own icon
// instead of Electron's generic one (dev runs and unpackaged builds otherwise blend in).
app.setAppUserModelId("com.remotex.app");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ------------------------------------------------------------------- state --

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let hidden: BrowserWindow | null = null;
let driver: InputDriver | null = null;
let keepAwake: { status: string; detail: string; isAdmin: boolean; stop(): void } | null = null;
let powerSaveBlockerIds: number[] = [];

/**
 * One-time userData migration (v6.0.0 rebrand): the package name changed from
 * "remotex-agent" to "remotex", which would point userData at a fresh empty
 * folder — and orphan the user's PERMANENT Device ID and the power-settings
 * backup. Carry both over before anything reads them.
 */
function migrateLegacyUserData() {
  const legacyDir = path.join(app.getPath("appData"), "remotex-agent");
  const newDir = app.getPath("userData");
  if (legacyDir === newDir) return;
  for (const file of ["remotex-agent.json", "power-backup-windows.json", "turn.json"]) {
    const src = path.join(legacyDir, file);
    const dst = path.join(newDir, file);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(newDir, { recursive: true });
        fs.copyFileSync(src, dst);
        console.log(`[config] migrated legacy ${file} to the new userData path`);
      }
    } catch { /* soft-fail — a fresh Device ID will be generated */ }
  }
}

migrateLegacyUserData();

const identity = loadOrCreateIdentity();
/** per-launch password — mutable so the window's refresh button can rotate it */
let password = createLaunchPassword();

/** clipboard-sync echo guards */
let lastClipboardHash: string | null = null;
let lastAgentClipboardWrite = 0;

/** 5-hour auto-renew clock: rotates the password + re-arms the room with zero user action */
const AUTO_RENEW_MS = 5 * 60 * 60 * 1000;
let renewAt = Date.now() + AUTO_RENEW_MS;
let renewTimer: ReturnType<typeof setInterval> | null = null;
let renewInFlight = false;

function autoRenew() {
  password = regeneratePassword();
  void syncTurnNow(app.getPath("userData"), identity.roomId, password);
  try { hidden?.webContents.send("session:new-password", password); } catch (err) { console.error("[renew] re-arm failed:", err); }
  try { win?.webContents.send("session:renewed", { password }); } catch { /* window hidden/closing */ }
  try { win?.webContents.send("status:update", { tone: "waiting", text: "Auto-renewed — password rotated. Reconnect with the new password." }); } catch { /* ignore */ }
  notify("RemoteX — auto-renewed", "The session renewed itself and the password changed.");
  renewAt = Date.now() + AUTO_RENEW_MS;
  console.log("[renew] auto-renewed — password rotated, room re-armed");
}

function startRenewClock() {
  if (renewTimer) return;
  renewTimer = setInterval(() => {
    const remainingMs = renewAt - Date.now();
    if (remainingMs <= 0) {
      autoRenew();
      return;
    }
    try { win?.webContents.send("session:tick", { remainingMs, renewAt }); } catch { /* window hidden/closing */ }
  }, 1000);
}

/** OS-level external notification — used when someone connects / disconnects, even if the window is hidden */
function notify(title: string, body: string) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: path.join(__dirname, "icon.png") });
    n.show();
  } catch (err) {
    console.error("[notify] failed:", err);
  }
}

// ------------------------------------------------------------ window & tray --
function createMainWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 430,
    minHeight: 720,
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
  win.on("close", () => {
    // the window IS the app — closing it kills the background too (settings restored, fresh password next launch)
    hardShutdown("window closed");
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
      { label: "Terminate", click: () => stopSession() },
      { type: "separator" },
      { label: "Quit RemoteX", click: () => hardShutdown("tray quit") },
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

/** Hard kill: everything the agent started dies with it — no hidden leftovers. */
function hardShutdown(reason = "window closed") {
  try { const { ensureHostCursorVisible } = require("./cursor-visibility") as typeof import("./cursor-visibility"); ensureHostCursorVisible(); } catch { /* ignore */ }
  try { tray?.destroy(); tray = null; } catch { /* ignore */ }
  try { stopLanServer(); } catch { /* ignore */ }
  try { stopPower(); } catch { /* ignore */ }
  console.log("[shutdown] hard exit -", reason);
  app.exit(0);
}

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
  }));

  ipcMain.handle("agent:copy", async (_e, text: unknown) => {
    await clipboard.writeText(String(text ?? ""));
  });

  ipcMain.handle("agent:quit", () => hardShutdown("agent:quit"));

  ipcMain.handle("agent:status", (_e, payload: unknown) => {
    const p = payload as { text?: string; tone?: string };
    if (p?.text) console.log("[status]", p.tone ?? "", "-", p.text);
    win?.webContents.send("status:update", payload);
    if (tray) tray.setToolTip(p?.tone === "connected" ? "RemoteX — someone is connected" : "RemoteX — click to open");
  });

  /** external OS notification requested by the hidden capture window (connect / disconnect / refusal) */
  ipcMain.handle("agent:notify", (_e, payload: unknown) => {
    const p = payload as { title?: string; body?: string };
    notify(typeof p?.title === "string" && p.title.trim() ? p.title.trim() : "RemoteX", typeof p?.body === "string" ? p.body : "");
  });

  /** rotate the password on demand — the hidden window re-arms the room with the new one (old password dies instantly) */
  ipcMain.handle("agent:new-password", () => {
    password = regeneratePassword();
    // manual rotation resets the 5-hour auto-renew clock too — otherwise a renewal could fire minutes later
    renewAt = Date.now() + AUTO_RENEW_MS;
    try { win?.webContents.send("session:tick", { remainingMs: AUTO_RENEW_MS, renewAt }); } catch { /* window hidden */ }
    void syncTurnNow(app.getPath("userData"), identity.roomId, password);
    try { hidden?.webContents.send("session:new-password", password); } catch (err) { console.error("[password] rotation failed:", err); }
    console.log("[password] rotated on user request");
    return { password };
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

  ipcMain.handle("screen:cursorRaw", () => {
    const pos = driver?.cursorPosition() ?? { x: 0, y: 0 };
    return { x: pos.x, y: pos.y };
  });

  ipcMain.handle("platform:info", () => process.platform);

  // resolves only after THIS command has actually been applied by the serial input chain —
  // the hidden window uses this to keep input strictly ordered relative to injected events
  ipcMain.handle("input:inject", (_e, msg: unknown) => injectInputAsync(msg));

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
  ipcMain.handle("win:close", () => hardShutdown("close button"));

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

  // -------------------------------------------------- TURN setup wizard --
  // "Remote access from any network" in one click. The original handler minted
  // a credential from an API key the user pasted; the automatic handler below
  // goes one step further and creates the free Metered account itself in a
  // headless browser, verifies the email, then proves the credential with a
  // real TURN Allocate before writing %APPDATA%/remotex/turn.json. Both paths
  // converge on the same verified file.
  const METERED_API = "https://turn.metered.ca/api/v1";
  const METERED_RELAY = "global.relay.metered.ca";
  const turnJsonPath = () => path.join(app.getPath("userData"), "turn.json");

  type AutoSetupResult =
    | { ok: true; via?: string }
    | { ok: false; error: string; cancelled?: boolean; logDir?: string };
  let autoTurnJob: { controller: AbortController; promise: Promise<AutoSetupResult> } | null = null;

  const sendTurnProgress = (phase: string, message: string, attempt: number, maxAttempts: number) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send("turn:progress", { phase, message, attempt, maxAttempts });
    } catch {
      // the window may be closing — progress is cosmetic
    }
  };

  async function runAutoTurn(signal: AbortSignal, options?: { attempts?: number }): Promise<AutoSetupResult> {
    const userData = app.getPath("userData");
    const logDir = path.join(userData, "turn-signup-logs");
    const attempts = Math.min(10, Math.max(1, Math.round(options?.attempts ?? 5)));
    let mailConfig: MailConfig;
    try {
      mailConfig = loadMailConfig(userData);
    } catch (err) {
      return {
        ok: false as const,
        error: `Mailbox configuration is invalid: ${err instanceof Error ? err.message : String(err)}`,
        logDir,
      };
    }

    try {
      const result = await runTurnSignup({
        mail: mailConfig,
        logDir,
        attempts,
        signal,
        onProgress: (p) => {
          sendTurnProgress(p.phase, p.message, p.attempt, p.maxAttempts);
        },
      });

      const urls = result.urls.length > 0 ? result.urls : buildTurnUrls(METERED_RELAY);
      if (signal.aborted) {
        return { ok: false as const, error: "TURN setup was cancelled", cancelled: true, logDir };
      }
      sendTurnProgress(
        "credentials",
        "Credential created — waiting for Metered’s relay to propagate it…",
        result.attempts,
        result.attempts,
      );
      const proof = await waitForTurnCredential(urls, result.username, result.credential, {
        shouldAbort: () => signal.aborted,
        onAttempt: (attempt) => {
          sendTurnProgress(
            "credentials",
            `Waiting for the relay to accept the credential… (${attempt})`,
            result.attempts,
            result.attempts,
          );
        },
      });
      if (signal.aborted) {
        return { ok: false as const, error: "TURN setup was cancelled", cancelled: true, logDir };
      }
      if (!proof.ok) {
        return {
          ok: false as const,
          error: `The account was created and the credential extracted, but the relay refused it from this network: ${proof.detail}`,
          logDir,
        };
      }

      try {
        const tmp = turnJsonPath() + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ urls, username: result.username, credential: result.credential }), "utf8");
        fs.renameSync(tmp, turnJsonPath());
      } catch {
        return { ok: false as const, error: "Could not save turn.json — check disk permissions", logDir };
      }

      console.log(`[turn] automatic setup complete — relay accepted via ${proof.via}`);
      void syncTurnNow(app.getPath("userData"), identity.roomId, password);
      return { ok: true as const, via: proof.via };
    } catch (err) {
      if (err instanceof TurnSignupError) {
        return {
          ok: false as const,
          error: err.message,
          cancelled: err.cancelled || signal.aborted,
          logDir: err.logDir ?? logDir,
        };
      }
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        cancelled: signal.aborted,
        logDir,
      };
    }
  }

  ipcMain.handle("turn:auto-setup", async (_event, hint: unknown) => {
    if (autoTurnJob) return { ok: false as const, error: "Automatic setup is already running" };
    const rawAttempts = (hint as { attempts?: unknown } | null | undefined)?.attempts;
    const attempts = typeof rawAttempts === "number" && Number.isFinite(rawAttempts) ? rawAttempts : 5;
    const controller = new AbortController();
    const job = { controller, promise: runAutoTurn(controller.signal, { attempts }) };
    autoTurnJob = job;
    try {
      return await job.promise;
    } finally {
      if (autoTurnJob === job) autoTurnJob = null;
    }
  });

  ipcMain.handle("turn:auto-cancel", () => {
    if (!autoTurnJob) return { ok: false as const, error: "No automatic setup is running" };
    autoTurnJob.controller.abort();
    return { ok: true as const };
  });

  app.on("before-quit", () => { autoTurnJob?.controller.abort(); });

  const turnStatus = () => {
    try {
      const raw = fs.readFileSync(turnJsonPath(), "utf8");
      const j = JSON.parse(raw) as { urls?: unknown; username?: unknown; credential?: unknown };
      const urls = Array.isArray(j?.urls) ? j.urls.filter((u): u is string => typeof u === "string") : [];
      if (urls.length === 0 || !j?.username || !j?.credential) {
        return { configured: false as const, reason: "turn.json missing credentials — redo the setup" };
      }
      return { configured: true as const, urls: urls.slice(0, 3), hint: "applies from the next connection" };
    } catch {
      return { configured: false as const };
    }
  };
  ipcMain.handle("turn:status", () => turnStatus());

  ipcMain.handle("turn:setup", async (_e, key: unknown) => {
    const secret = String(key ?? "").trim();
    if (secret.length < 8 || secret.length > 128 || /\s/.test(secret)) {
      return { ok: false as const, error: "That does not look like an API key — copy it again from the metered dashboard" };
    }
    // 1) mint a long-lived TURN credential for the remotex account
    let mintUser = "";
    let mintPass = "";
    try {
      const res = await fetch(`${METERED_API}/turn/credential?secretKey=${encodeURIComponent(secret)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "remotex" }),
      });
      const body = (await res.json().catch(() => null)) as { username?: string; password?: string; message?: string } | null;
      if (!res.ok || !body?.username || !body?.password) {
        const msg = body?.message ? String(body.message) : `HTTP ${res.status}`;
        return { ok: false as const, error: `metered refused the key (${msg}) — copy the account-level API key from dashboard.metered.ca → API Keys (not the publishable or a credential-scoped key)` };
      }
      mintUser = String(body.username);
      mintPass = String(body.password);
    } catch {
      return { ok: false as const, error: "Could not reach metered — check your internet connection" };
    }

    // 2) prove the credential actually works from this machine (real Allocate, every transport)
    const urls = buildTurnUrls(METERED_RELAY);
    const proof = await verifyTurn(urls, mintUser, mintPass, 3000);
    if (!proof.ok) {
      return { ok: false as const, error: `Key works, but the relay is refusing connections: ${proof.detail}` };
    }

    // 3) save atomically
    try {
      const tmp = turnJsonPath() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ urls, username: mintUser, credential: mintPass }), "utf8");
      fs.renameSync(tmp, turnJsonPath());
    } catch {
      return { ok: false as const, error: "Could not save turn.json — check disk permissions" };
    }
    console.log(`[turn] setup complete — relay accepted via ${proof.via}`);
    return { ok: true as const, via: proof.via };
  });

  /** The wizard may only open the metered console — nothing else. */
  ipcMain.handle("shell:open-external", (_e, url: unknown) => {
    const u = String(url ?? "");
    if (!/^https:\/\/dashboard\.metered\.ca\//i.test(u)) return { ok: false as const };
    void shell.openExternal(u);
    return { ok: true as const };
  });

  // -------------------------------------------------------- Telegram notify --
  // Optional: link a Telegram bot once; on EVERY launch a message with the
  // Device ID + the CURRENT password + timestamp is sent to the chat.
  // Nothing is sent when unlinked. The token never leaves %APPDATA%/remotex/telegram.json.
  const telegramJsonPath = () => path.join(app.getPath("userData"), "telegram.json");
  const readTelegram = (): { token: string; chatId: string } | null => {
    try {
      const j = JSON.parse(fs.readFileSync(telegramJsonPath(), "utf8")) as { token?: unknown; chatId?: unknown };
      if (typeof j?.token === "string" && typeof j?.chatId === "string" && j.token && j.chatId) {
        return { token: j.token, chatId: j.chatId };
      }
    } catch { /* not linked */ }
    return null;
  };
  const maskChatId = (id: string) => (id.length <= 4 ? "••••" : "••••••" + id.slice(-4));

  async function sendTelegram(token: string, chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
      if (!res.ok || !body?.ok) return { ok: false, error: body?.description ? String(body.description) : `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  ipcMain.handle("telegram:status", () => {
    const tg = readTelegram();
    return tg ? { linked: true as const, chatIdHint: maskChatId(tg.chatId) } : { linked: false as const };
  });

  ipcMain.handle("telegram:link", async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { token?: unknown; chatId?: unknown };
    const token = String(p.token ?? "").trim();
    const chatId = String(p.chatId ?? "").trim();
    if (!/^\d{5,16}:[A-Za-z0-9_-]{30,}$/.test(token)) return { ok: false as const, error: "That token does not look like a bot token (format: 123456:AA-...). Get it from @BotFather." };
    if (!/^(-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId)) return { ok: false as const, error: "That chat ID does not look right (number, or @channelusername). Message the bot once first, then check getUpdates." };
    // proof: send a real test message — link only persists when Telegram accepts it
    const test = await sendTelegram(token, chatId, "<b>RemoteX linked</b>\nYou will get this on every launch: your Device ID, the current password, and the launch time.");
    if (!test.ok) return { ok: false as const, error: `Telegram refused it: ${test.error ?? "unknown error"} — check the token, and that you messaged the bot at least once.` };
    try {
      const tmp = telegramJsonPath() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ token, chatId, linkedAt: new Date().toISOString() }), "utf8");
      fs.renameSync(tmp, telegramJsonPath());
    } catch {
      return { ok: false as const, error: "Could not save telegram.json — check disk permissions." };
    }
    return { ok: true as const, chatIdHint: maskChatId(chatId) };
  });

  ipcMain.handle("telegram:unlink", () => {
    try { fs.unlinkSync(telegramJsonPath()); } catch { /* absent = already unlinked */ }
    return { ok: true as const };
  });

  /** fire-and-forget launch ping — ID + password + timestamp, nothing else */
  const notifyTelegramOnLaunch = () => {
    const tg = readTelegram();
    if (!tg) return;
    const stamp = new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const text = [
      "<b>RemoteX started</b>",
      `Device ID: <code>${identity.roomId}</code>`,
      `Password: <code>${password}</code>`,
      `Launched: ${stamp}`,
    ].join("\n");
    void sendTelegram(tg.token, tg.chatId, text).then((r) => {
      if (r.ok) console.log("[telegram] launch notification sent");
      else console.warn("[telegram] launch notification failed:", r.error);
    });
  };
  setTimeout(notifyTelegramOnLaunch, 2_000); // let the network settle first

}

function stopSession() {
  driver?.reset();
  hidden?.webContents.send("session:stop");
  win?.webContents.send("status:update", { tone: "waiting", text: "Terminated — ready for a new connection" });
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
  startRenewClock();

  // TURN sync with the Apps Script bridge (optional — only when turn-sync.json exists):
  // verify the stored relay credential, then refresh the roomId↔credential binding.
  // Runs in the background; launch never waits for it.
  void (async () => {
    const userData = app.getPath("userData");
    await verifyAndHealTurnJson(userData);
    await syncTurnNow(userData, identity.roomId, password);
  })();
});

app.on("before-quit", () => {
  // belt-and-braces: restore the original arrow as early as possible on ANY graceful exit path
  try { const { ensureHostCursorVisible } = require("./cursor-visibility") as typeof import("./cursor-visibility"); ensureHostCursorVisible(); } catch { /* fine */ }
});
app.on("will-quit", () => {
  if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
  stopPower();
  stopLanServer();
  try { const { ensureHostCursorVisible } = require("./cursor-visibility") as typeof import("./cursor-visibility"); ensureHostCursorVisible(); } catch { /* fine */ }
  try { tray?.destroy(); } catch { /* fine */ }
});

app.on("activate", () => ensureWindow());

app.on("second-instance", () => ensureWindow());

