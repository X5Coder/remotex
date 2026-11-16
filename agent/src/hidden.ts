/**
 * RemoteX Agent — hidden capture window (renderer, ESM bundled by esbuild).
 *
 * Responsibilities:
 *   1. Capture the primary screen (getDisplayMedia approved by the main-process
 *      display-media handler) at up to 60 fps, contentHint='motion'.
 *   2. Join the Trystero room (password-encrypted SDP) as the host.
 *      Single session: maxUsers=2; the first peer holds the seat.
 *   3. Send `hello` (protocol version, screens, cursor) after handshake.
 *   4. Relay validated ctl commands to the main process for OS injection.
 *   5. Adapt bitrate every ~10 s based on stats (fps / loss / RTT).
 *   6. Keep-awake + power handling live in the main process, not here.
 */
import { joinRoom } from "trystero";
import {
  SeqCounter,
  SeqTracker,
  encodeFast,
  decodeFast,
  decodeCtl,
  encodeCtl,
  packCtl,
  ChunkAssembler,
  makeHello,
  type CtlMessage,
  type HelloMessage,
} from "@remotex/protocol";

/** Hidden window is a plain browser context — `process` may not exist there. Guard every use. */
const debugEnabled = () => typeof process !== "undefined" && !!process.env?.REMOTEX_INPUT_LOG;

const APP_ID = "remotex-1";
const BITRATE_LADDER = [20_000_000, 12_000_000, 8_000_000, 4_000_000];
const FPS_FLOOR = 45;
const RELAY_URLS = [
  "ws://127.0.0.1:4545", // our own LAN relay — single fixed port
  "wss://relay.nostr.net",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://yabu.me",
  "wss://nostr-relay-production.up.railway.app",
];

interface Bridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
}
const bridge = (window as unknown as { remotex: Bridge }).remotex;

const log = (...a: unknown[]) => console.log("[hidden]", ...a);

function getLaunchParam(name: string): string {
  const params = new URLSearchParams(location.search);
  return params.get(name) ?? "";
}

async function reportStatus(text: string, tone: "waiting" | "connected" | "closed" | "error" = "waiting") {
  try { await bridge.invoke("agent:status", { text, tone }); } catch { /* main gone */ }
}

async function reportRtt(ms: number) {
  try { await bridge.invoke("rtt:report", ms); } catch { /* optional */ }
}

async function reportStats(stats: { fps: number; mbps: number; rttMs: number; encoder: string; rung: number }) {
  try { await bridge.invoke("stats:report", stats); } catch { /* optional */ }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

class HiddenAgent {
  private room: ReturnType<typeof joinRoom> | null = null;
  private fast: { send: (d: Uint8Array) => Promise<void>; onMessage: (h: (d: unknown, ctx: { peerId: string }) => void) => () => void } | null = null;
  private ctl: { send: (d: string) => Promise<void>; onMessage: (h: (d: unknown, ctx: { peerId: string }) => void) => () => void } | null = null;
  private peerId: string | null = null;
  private seq = new SeqCounter();
  private tracker = new SeqTracker();
  private assembler = new ChunkAssembler();
  private stream: MediaStream | null = null;
  private sender: RTCRtpSender | null = null;
  private statsTimer: number | null = null;
  private pingTimer: number | null = null;
  private cursorTimer: number | null = null;
  private lastCursor = { x: -1, y: -1 };
  private curPublished = 0;
  /** last position the REMOTE asked us to move to (px, robotjs coordinate space) — null when no remote move is in flight */
  private expectedMovePx: { x: number; y: number } | null = null;
  /**
   * Cursor ownership state machine (replaces per-poll deadband arbitration, which strobed at 50 Hz):
   *   local  — the person at THIS PC is driving: the OS arrow stays visible, forever,
   *            until the next remote input claims the cursor.
   *   remote — a web client is driving: the OS arrow is hidden once, held hidden, and only
   *            a sustained physical mouse grab (3 consecutive polls diverging from the injected
   *            position) hands ownership back to local.
   */
  private cursorMode: "local" | "remote" = "local";
  private cursorMismatchPolls = 0;
  /** last raw sample seen by the poll — divergence reference when no remote target is known */
  private lastRawSample: { x: number; y: number } | null = null;
  /** timestamp of the last REAL remote input (pointer/keyboard command) — drives the idle-restore */
  private lastRemoteInputAt = 0;
  /** ms of remote silence after which the OS arrow is handed back to the local desktop (catch-all for dead sessions / idle browsers) */
  private static readonly REMOTE_IDLE_RESTORE_MS = 3000;
  /** number of cursor-moving commands whose injection has not been applied by the main process yet */
  private inflightMoves = 0;
  private hostCursorVisible = true;
  private bitrateRung = 0;
  private statsStrikes = { lowFps: 0, loss: 0, good: 0 };
  private started = false;

  async start() {
    if (this.started) return;
    this.started = true;
    const password = getLaunchParam("password");
    const roomId = getLaunchParam("roomId");
    if (!password || !roomId) {
      void reportStatus("Launch error: missing credentials", "error");
      return;
    }

    // 1) capture the primary screen at native resolution, up to 60 fps
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // NO width/height constraint — otherwise Chromium captures at DIP resolution and mismatches robotjs
        // cursor: 'never' — the host's own arrow stays visible ON THE MACHINE ONLY; it is NOT baked
        // into the stream, so the overlay cursor in the phone UI is the ONLY cursor the user sees.
        // cursor: 'never' — honored by Chromium for window captures; ignored for whole-screen
        // captures (platform restriction). The captured arrow is ~5-7 px on the phone and is
        // completely covered by our own 1:1 overlay arrow (same position, Windows arrow shape),
        // so the user sees exactly ONE cursor anyway. The host arrow itself is never touched.
        video: { frameRate: { ideal: 60, max: 60 }, cursor: "never" } as unknown as MediaTrackConstraints,
        audio: false,
      });
    } catch (err) {
      // elevated launches sometimes refuse the modern handler — fall back to the
      // legacy (but still supported) chromeMediaSource path
      console.warn("[hidden] getDisplayMedia failed, trying legacy chromeMediaSource:", err);
      try {
        const srcId = String(await bridge.invoke("capture:primary-source"));
        if (!srcId) throw new Error("no screen source available");
        const legacy: MediaStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: srcId, minFrameRate: 60, maxFrameRate: 60 } } as never,
        });
        stream = legacy;
        console.log("[hidden] legacy chromeMediaSource capture active");
      } catch (err2) {
        void reportStatus(`Screen capture was refused: ${err2 instanceof Error ? err2.message : String(err2)}`, "error");
        throw err2;
      }
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = "detail"; // remote desktop = text sharpness, not motion
    track?.addEventListener("ended", () => void reportStatus("Capture stream ended", "error"));

    // optional TURN relay from <userData>/turn.json (Cloudflare TURN free tier works)
    let turnCfg: { urls: string[]; username?: string; credential?: string } | null = null;
    try {
      turnCfg = (await bridge.invoke("turn:config")) as typeof turnCfg;
    } catch { turnCfg = null; }

    // 3) no need for capture dims — we normalize the cursor against the DISPLAY bounds, not the video,
    //    so DPI scaling never breaks it (robotjs returns DIP; Electron bounds are DIP)
    try {
      const track = stream.getVideoTracks()[0];
      const settings = (track?.getSettings() ?? {}) as MediaTrackSettings & { cursor?: string };
      if (settings.width && settings.height) log(`capture: native physical ${settings.width}x${settings.height}`);
      log(`capture cursor setting: ${settings.cursor ?? "unsupported"} (host arrow stays on the machine only)`);
    } catch { /* optional diagnostic */ }

    // 2) join the room (encrypted SDP; maxUsers=2 → single session)
    const room = joinRoom(
      { appId: APP_ID, password, maxUsers: 2, trickleIce: true, relayConfig: { urls: RELAY_URLS }, ...(turnCfg ? { turnConfig: [turnCfg] } : {}) },
      roomId
    );
    this.room = room;
    void reportStatus("Ready — waiting for a connection…", "waiting");

    this.fast = room.makeAction<Uint8Array>("fast");
    this.ctl = room.makeAction<string>("ctl");
    void room.addStream(stream);

    this.fast.onMessage((data, ctx) => {
      if (ctx.peerId !== this.peerId) return;
      const msg = decodeFast(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
      if (!msg) return;
      if (msg.kind === "ping") { void reportRtt(Math.max(0, Math.floor(performance.now() - msg.t))); return; }
      if (msg.kind === "move") {
        if (!this.tracker.accept(msg.seq)) return;
        this.claimRemoteCursor();
        this.noteRemoteMovePx(msg.x, msg.y);
        this.injectCounted({ kind: "move", x: msg.x, y: msg.y });
        return;
      }
    });

    this.ctl.onMessage((raw, ctx) => {
      if (ctx.peerId !== this.peerId) return; // refuse commands from anyone but the seat holder
      try {
        const decoded = decodeCtl(raw as string);
        const full = this.assembler.push(decoded);
        if (full) void this.handleCtl(full);
      } catch (err) {
        console.error("[hidden] bad ctl frame:", err);
      }
    });

    room.onPeerJoin(({ peerId }) => {
      if (this.peerId && this.peerId !== peerId) {
        // belt-and-braces: room-full already refuses at the handshake,
        // but never let a second peer through EVEN SO — unless the current seat holder
        // is provably dead (ICE disconnected/failed/closed), e.g. a crashed/frozen tab
        // that will never send a proper goodbye. In that case the new peer takes the seat.
        const stale = this.seatStale();
        if (stale) {
          log("seat holder appears dead — handing the seat to", peerId);
          void this.releaseSeat();
        } else {
          log("refusing second peer", peerId);
          try { this.ctl?.send(encodeCtl({ kind: "bye" }), { target: peerId } as never); } catch { /* ignore */ }
          return;
        }
      }
      this.peerId = peerId;
      log("peer joined", peerId);
      void room.addStream(stream); // idempotent — make sure the seat holder gets it
      void this.tuneSender(peerId);
      void this.sendHello();
      void reportStatus("Connected — one device is in control", "connected");
      this.startLoops();
    });

    room.onPeerLeave(({ peerId }) => {
      if (peerId !== this.peerId) return;
      log("peer left", peerId);
      this.peerId = null;
      this.stopLoops();
      this.releaseRemoteCursor(); // session ended — the user must see their pointer again
      // release any modifiers held for this session
      void bridge.invoke("input:inject", { kind: "reset" });
      void reportStatus("Session ended — ready for a new connection", "waiting");
    });

    room.onError((err) => {
      const code = (err as { code?: string }).code ?? "unknown";
      console.error("[hidden] room error:", code);
      if (code === "decrypt-failed") void reportStatus("Wrong password from a client", "error");
      else if (code === "relay-failed") void reportStatus("All signaling relays failed — check the network", "error");
      else if (code === "peer-connect-failed") void reportStatus("A direct connection could not be established", "error");
      else if (code === "handshake-failed") void reportStatus("Security handshake failed", "error");
    });
  }

  /** True when the current seat holder's WebRTC connection is provably dead (no goodbye possible). */
  private seatStale(): boolean {
    if (!this.peerId) return true;
    try {
      const pc = this.room?.getPeers?.()?.[this.peerId]?.connection as RTCPeerConnection | undefined;
      if (!pc) return true;
      const s = pc.iceConnectionState;
      return s === "disconnected" || s === "failed" || s === "closed";
    } catch {
      return true;
    }
  }

  /** Release a provably-dead seat so the re-dialing same-device peer can rejoin cleanly. */
  private async releaseSeat() {
    const old = this.peerId;
    if (!old) return;
    log("releasing stale seat", old);
    this.peerId = null;
    this.stopLoops();
    this.releaseRemoteCursor(); // hand the cursor back before the re-dial
    void bridge.invoke("input:inject", { kind: "reset" });
  }

  /**
   * A remote input event claims the cursor: from here on the OS arrow is HIDDEN until
   * a physical mouse grab on THIS machine is proven. Called synchronously on every remote
   * command — the hide never waits for position polling, so the arrow cannot flicker.
   */
  private claimRemoteCursor() {
    this.cursorMode = "remote";
    this.cursorMismatchPolls = 0;
    this.lastRemoteInputAt = performance.now();
    this.setHostCursorVisible(false);
  }

  /** Hand the cursor back to this PC and show the OS arrow — permanent, until the next remote input. */
  private releaseRemoteCursor() {
    this.cursorMode = "local";
    this.expectedMovePx = null;
    this.cursorMismatchPolls = 0;
    this.lastRawSample = null;
    this.setHostCursorVisible(true);
  }

  /**
   * Fire an input:inject and track it as an in-flight cursor move. The promise resolves when the
   * main process has ACTUALLY applied the command (post input-chain), so the ownership poll never
   * mistakes a pending remote jump — delayed behind a typing burst — for a physical mouse grab.
   */
  private injectCounted(msg: Record<string, unknown>) {
    this.inflightMoves++;
    void bridge.invoke("input:inject", msg)
      .catch(() => { /* agent down — the session dies elsewhere */ })
      .finally(() => { this.inflightMoves = Math.max(0, this.inflightMoves - 1); });
  }

  /**
   * Divergence check, remote mode only, called once per poll (50 Hz).
   * A remote injection JUMPS the cursor onto the target (dx≈0). A physical mouse grab on
   * this machine moves it anywhere else; 30 px of slack + 3 consecutive polls (~60 ms) of
   * evidence are required before ownership returns to "local" — one noisy sample can never
   * strobe the global system cursor. In local mode the arrow is NEVER auto-hidden: only a
   * remote input event can hide it.
   */
  private checkCursorOwnership(raw: { x: number; y: number }) {
    if (this.cursorMode !== "remote") {
      this.lastRawSample = raw;
      this.cursorMismatchPolls = 0;
      return;
    }
    // CATCH-ALL: no real remote input for REMOTE_IDLE_RESTORE_MS means nobody is actively driving —
    // a live web session that was left idle, or a dead/frozen browser tab the agent never got a clean
    // bye from. Hand the arrow back to the local desktop; any remote command re-claims it instantly.
    if (performance.now() - this.lastRemoteInputAt > HiddenAgent.REMOTE_IDLE_RESTORE_MS) {
      log("[cursor] remote idle — restoring host arrow for the local desktop");
      this.releaseRemoteCursor();
      return;
    }
    // a cursor-moving command is queued/applying in the main process — the OS cursor may not
    // be at the expected spot yet (typing bursts delay moves). Divergence seen now is ours,
    // never a physical grab.
    if (this.inflightMoves > 0) {
      this.lastRawSample = raw;
      this.cursorMismatchPolls = 0;
      return;
    }
    // reference: the last injected remote target (authoritative). Without one, any sustained
    // movement at all means the local user grabbed the mouse (nobody else moves it in remote mode).
    const ref = this.expectedMovePx ?? this.lastRawSample;
    this.lastRawSample = raw;
    if (!ref) { this.cursorMismatchPolls = 0; return; }
    const dx = Math.abs(raw.x - ref.x), dy = Math.abs(raw.y - ref.y);
    if (dx <= 30 && dy <= 30) { this.cursorMismatchPolls = 0; return; }
    if (++this.cursorMismatchPolls >= 3) {
      log("[cursor] physical mouse grab detected — restoring host arrow for local control");
      this.releaseRemoteCursor();
    }
  }

  private async tuneSender(peerId: string) {
    try {
      const peers = this.room?.getPeers();
      const pc = peers?.[peerId]?.connection;
      const sender = pc?.getSenders().find((s) => s.track?.kind === "video");
      if (!sender) return;
      this.sender = sender;
      // H.264 first → hardware encoder on every platform
      try {
        const caps = RTCRtpSender.getCapabilities("video");
        if (caps) {
          const pref = ["video/H264", "video/VP8", "video/VP9"];
          const sorted = [...caps.codecs].sort((a, b) => pref.indexOf(a.mimeType) - pref.indexOf(b.mimeType));
          const tx = pc?.getTransceivers().find((t) => t.sender === sender);
          tx?.setCodecPreferences(sorted);
        }
      } catch (err) { console.warn("[hidden] codec preference failed:", err); }

      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      const enc = params.encodings[0]!;
      enc.maxBitrate = BITRATE_LADDER[this.bitrateRung]!;
      enc.maxFramerate = 60;
      enc.scaleResolutionDownBy = 1.0;
      // keep resolution (text readability) and let fps adapt — measured on weak encoder HW;
      // 'maintain-framerate' starved the stream to 384x216 and became unusable
      (params as RTCRtpParameters & { degradationPreference: string }).degradationPreference = "maintain-resolution";
      await sender.setParameters(params);
    } catch (err) {
      console.warn("[hidden] setParameters failed:", err);
    }
  }

  /** Send one frame of a clipboard payload (chunked if > 16 KB). Only to the seat holder. */
  async sendClipboardFrame(frame: string) {
    if (!this.ctl) return;
    try {
      if (this.peerId) await this.ctl.send(frame, { target: this.peerId } as never);
      else await this.ctl.send(frame);
    } catch (err) {
      console.warn("[hidden] clipboard send failed:", err);
    }
  }

  private async sendHello() {
    try {
      const info = (await bridge.invoke("screen:info")) as { primary: { width: number; height: number }; displays: { id: string; width: number; height: number; primary?: boolean }[] };
      const raw = (await bridge.invoke("screen:cursorRaw")) as { x: number; y: number };
      const b = (await bridge.invoke("screen:bounds")) as { x: number; y: number; w: number; h: number };
      const nx = clamp01((raw.x - b.x) / Math.max(1, b.w - 1)), ny = clamp01((raw.y - b.y) / Math.max(1, b.h - 1));
      const platform = String(await bridge.invoke("platform:info"));
      const hello: HelloMessage = makeHello({
        screen: { width: info.primary.width, height: info.primary.height },
        displays: info.displays,
        cursor: { x: nx, y: ny },
        platform,
      });
      for (const frame of packCtl(hello)) void this.ctl?.send(frame);
    } catch (err) {
      console.error("[hidden] hello failed:", err);
    }
  }

  private startLoops() {
    this.stopLoops();
    // ping every second on the fast channel (client echoes the 7 bytes)
    this.pingTimer = window.setInterval(() => {
      this.fast?.send(encodeFast({ kind: "ping", seq: this.seq.next(), t: Math.floor(performance.now()) })).catch(() => {});
    }, 1000);

    // true-cursor broadcast at 50 Hz when it moved (corrects client prediction)
    this.cursorTimer = window.setInterval(() => { void this.publishCursor(); }, 20);

    // adaptive bitrate + fps/loss monitoring every 1 s, adjust every 10 s
    this.statsTimer = window.setInterval(() => { void this.sampleStats(); }, 1000);
  }

  private stopLoops() {
    for (const t of [this.pingTimer, this.cursorTimer, this.statsTimer]) {
      if (t !== null) window.clearInterval(t);
    }
    this.pingTimer = this.cursorTimer = this.statsTimer = null;
  }

  private async publishCursor(force = false) {
    if (!this.peerId) return;
    try {
      const raw = (await bridge.invoke("screen:cursorRaw")) as { x: number; y: number };
      // host cursor ownership arbitration — see checkCursorOwnership; never toggles per-poll
      this.checkCursorOwnership(raw);
      const b = (await bridge.invoke("screen:bounds")) as { x: number; y: number; w: number; h: number };
      const nx = clamp01((raw.x - b.x) / Math.max(1, b.w - 1)), ny = clamp01((raw.y - b.y) / Math.max(1, b.h - 1));
      if (!force && Math.abs(nx - this.lastCursor.x) < 0.0008 && Math.abs(ny - this.lastCursor.y) < 0.0008) return;
      this.lastCursor = { x: nx, y: ny };
      const seq = this.seq.next();
      // LINE 1 — binary fast channel (7 bytes)
      await this.fast?.send(encodeFast({ kind: "cur", seq, x: nx, y: ny }));
      // LINE 2 — identical beacon on the reliable JSON ctl channel, SAME seq;
      // the client dedups by seq, so whichever arrives first wins and the other is dropped.
      // If one line stalls, the other compensates.
      await this.ctl?.send(encodeCtl({ kind: "cur", x: nx, y: ny, seq }));
      this.curPublished++;
      if (this.curPublished === 1) log("cursor dual-line beacons active (line1: fast binary + line2: ctl JSON)");
    } catch { /* ignore transient */ }
  }

  private async setHostCursorVisible(visible: boolean) {
    if (this.hostCursorVisible === visible) return;
    this.hostCursorVisible = visible;
    try {
      await bridge.invoke("cursor:host", { visible });
      log(visible ? "[cursor] host arrow SHOWN (local use)" : "[cursor] host arrow HIDDEN (remote control)");
    } catch { /* soft-fail */ }
  }

  private noteRemoteMovePx(x: number, y: number) {
    bridge.invoke("screen:bounds").then((raw) => {
      const b = raw as { x: number; y: number; w: number; h: number };
      this.expectedMovePx = { x: Math.round(clamp01(x) * (b.w - 1)), y: Math.round(clamp01(y) * (b.h - 1)) };
      if (debugEnabled()) console.log(`[cursor-debug] bounds=${b.w}x${b.h} expect=(${this.expectedMovePx.x},${this.expectedMovePx.y})`);
    }).catch((e: unknown) => {
      if (debugEnabled()) console.log("[cursor-debug] screen:bounds failed:", String(e));
      this.expectedMovePx = null;
    });
  }

  private async sampleStats() {
    if (!this.sender || !this.peerId) return;
    try {
      const stats = await this.sender.getStats();
      let fps = 0, loss = 0, bytesSent = 0, encoder = "unknown", rttMs = 0;
      stats.forEach((r) => {
        if (r.type === "outbound-rtp" && r.kind === "video") {
          fps = r.framesPerSecond ?? 0;
          loss = r.packetsLost ?? 0;
          bytesSent = r.bytesSent ?? 0;
          encoder = r.encoderImplementation ?? encoder;
        }
        if (r.type === "candidate-pair" && r.state === "succeeded") {
          rttMs = (r.currentRoundTripTime ?? rttMs) * 1000;
        }
      });
      const mbps = bytesSent * 8 / 1e6;
      void reportStats({ fps, mbps, rttMs: Math.round(rttMs), encoder, rung: this.bitrateRung });

      if (fps > 0 && fps < FPS_FLOOR) this.statsStrikes.lowFps++; else if (fps >= FPS_FLOOR) this.statsStrikes.lowFps = 0;
      // loss is cumulative packetsLost on the report; treat as proportional signal only when rising is internal — v1: fps is the primary gate
      this.statsStrikes.loss = this.statsStrikes.loss; // placeholder for delta accounting

      if (this.statsStrikes.lowFps >= 3 && this.bitrateRung < BITRATE_LADDER.length - 1) {
        this.bitrateRung++;
        this.statsStrikes.lowFps = 0;
        await this.applyBitrate();
        log("bitrate ladder ↓ to rung", this.bitrateRung);
      } else if (fps >= FPS_FLOOR && this.statsStrikes.lowFps === 0 && this.bitrateRung > 0) {
        this.statsStrikes.good++;
        if (this.statsStrikes.good >= 10) {
          this.statsStrikes.good = 0;
          this.bitrateRung--;
          await this.applyBitrate();
          log("bitrate ladder ↑ to rung", this.bitrateRung);
        }
      }
    } catch { /* stats not ready */ }
  }

  private async applyBitrate() {
    if (!this.sender) return;
    try {
      const params = this.sender.getParameters();
      if (params.encodings?.[0]) {
        params.encodings[0].maxBitrate = BITRATE_LADDER[this.bitrateRung]!;
        await this.sender.setParameters(params);
      }
    } catch { /* transient */ }
  }

  private async handleCtl(msg: CtlMessage) {
    // any remote POINTER/KEYBOARD command proves a remote operator is in control → claim the cursor.
    // 'curping' is a client-side 1 Hz keepalive, NOT operator intent — it must never keep the host arrow hidden forever.
    if (msg.kind === "down" || msg.kind === "up" || msg.kind === "click" || msg.kind === "dblclick"
      || msg.kind === "key" || msg.kind === "text" || msg.kind === "paste") this.claimRemoteCursor();
    switch (msg.kind) {
      case "down": case "up": {
        this.noteRemoteMovePx(msg.x, msg.y);
        if (msg.kind === "down") {
          await this.injectAbs(msg.x, msg.y);
          await bridge.invoke("input:inject", { kind: "button", button: msg.button, down: true });
        } else {
          await this.injectAbs(msg.x, msg.y);
          await bridge.invoke("input:inject", { kind: "button", button: msg.button, down: false });
        }
        return;
      }
      case "click": {
        this.noteRemoteMovePx(msg.x, msg.y);
        this.injectCounted({ kind: "click", button: msg.button, x: msg.x, y: msg.y, double: false });
        return;
      }
      case "dblclick": {
        this.noteRemoteMovePx(msg.x, msg.y);
        this.injectCounted({ kind: "click", button: msg.button, x: msg.x, y: msg.y, double: true });
        return;
      }
      case "key":
        await bridge.invoke("input:inject", { kind: "key", code: msg.code, key: msg.key, down: msg.down, mods: { ctrl: msg.ctrl, alt: msg.alt, shift: msg.shift, meta: msg.meta } });
        return;
      case "text":
        await bridge.invoke("input:inject", { kind: "text", text: msg.text });
        return;
      case "paste":
        await bridge.invoke("input:inject", { kind: "paste", text: msg.text });
        return;
      case "curping": {
        // client watchdog: no cur beacon for a while — reply IMMEDIATELY on both lines (force, no dedup)
        await this.publishCursor(true);
        return;
      }
      case "bye": {
        this.releaseRemoteCursor(); // session over — always restore the host arrow
        await bridge.invoke("session:ended-by-user");
        return;
      }
      default:
        return; // hello/clipboard/ack are not inputs
    }
  }

  private async rearmTracks() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.stream = null;
  }

  private async injectAbs(x: number, y: number) {
    this.injectCounted({ kind: "move", x, y });
  }

  /** Stop current session, then re-arm the room for the next device. */
  async rearm() {
    this.stopLoops();
    const peer = this.peerId;
    this.peerId = null;
    this.releaseRemoteCursor(); // rearm — restore the host arrow before the next session can begin
    try {
      if (peer && this.ctl) {
        try { (this.ctl as unknown as { send: (d: string, o?: { target: string }) => Promise<void> }).send(encodeCtl({ kind: "bye" }), { target: peer }); } catch { /* gone */ }
      }
      await this.room?.leave();
    } catch { /* already left */ }
    await this.rearmTracks();
    this.room = null;
    this.fast = null;
    this.ctl = null;
    this.sender = null;
    // rebuild capture stream for the next session
    const password = getLaunchParam("password");
    const roomId = getLaunchParam("roomId");
    if (password && roomId) {
      this.started = false;
      await this.start();
    }
  }
}

const agent = new HiddenAgent();

window.addEventListener("DOMContentLoaded", () => {
  // user pressed "Stop session" in the agent window
  bridge.on("session:stop", () => void agent.rearm());
  // PC clipboard changed → push to the web client (echo-guarded in main)
  bridge.on("clipboard-changed", (text) => {
    if (typeof text !== "string" || !text) return;
    for (const frame of packCtl({ kind: "clipboard", text })) void agent.sendClipboardFrame(frame);
  });
  void agent.start().catch((err) => {
    console.error("[hidden] fatal:", err);
    void reportStatus("Fatal error: " + (err instanceof Error ? err.message : String(err)), "error");
  });
});
