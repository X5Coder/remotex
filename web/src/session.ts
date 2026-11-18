/**
 * RemoteX — WebRTC session (web client side).
 *
 * Signaling: Trystero (Nostr by default). The password derives the AES-256-GCM
 * signaling key (PBKDF2) — the SDP handshake is end-to-end encrypted and public
 * relays never see your screen. After connect, everything is direct P2P.
 *
 * Single session: maxUsers = 2 (agent + you). The first valid peer holds the
 * seat; anyone else gets "room-full". The agent additionally refuses any command
 * coming from a peer other than the first one.
 *
 * Channel reality (trystero >= 0.27): ONE ordered, reliable data channel shared by the
 * binary `fast` actions and the JSON `ctl` actions. ON TOP of that, the peer connection
 * carries N=10 redundant unreliable negotiated lanes (ids 2-11, unordered,
 * maxRetransmits: 0) - every binary `fast` frame is replicated onto all of them and the
 * far end dedups by 16-bit seq, so the first copy to land wins and the rest are dropped.
 * The cursor beacon (`cur`) is also broadcast on the JSON ctl line with one shared
 * 16-bit sequence number - if every lane stalls, the ctl line delivers it and the
 * duplicate is dropped here.
 * A 1 Hz watchdog asks the agent to force-republish the cursor whenever no beacon
 * has arrived on either line within ~400 ms - if one line fails, the other compensates.
 */
import { joinRoom } from "trystero";
import { fetchSyncedTurn } from "./turn-sync";
import {
  PROTOCOL_VERSION,
  SeqCounter,
  SeqTracker,
  encodeFast,
  decodeFast,
  isPing,
  decodeCtl,
  packCtl,
  encodeCtl,
  ChunkAssembler,
  isVersionMismatch,
  resolveTurnConfig,
  type MouseButton,
  type HelloMessage,
} from "@remotex/protocol";
import type { CommandSink } from "./remote";

type Room = ReturnType<typeof joinRoom>;

const APP_ID = "remotex-1"; // namespace shared with the agent; change = everyone must upgrade
const STORE_KEY = "remotex.turn.v1"; // relay credential persisted by a one-time #turn= setup link
const CONNECT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const SESSION_LIMIT_MS = 5 * 60 * 60 * 1000; // 5 hours — then auto-disconnect; reconnect with the same password
// Public Nostr relays verified live from this network (2026-11-15): all accepted
// Trystero's discovery kinds and completed WebSocket handshakes. relay.damus.io is
// down for this user (HTTP 520/521) and relay.nos.social refuses Trystero's message
// kinds — both excluded.
const IS_LAN_HOST = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(window.location.hostname);

/** probe the agent's LAN relay on the single fixed port (4545) */
async function probeLanRelay(host: string): Promise<string | null> {
  const port = 4545;
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const ws = new WebSocket(`ws://${host}:${port}`);
      const timer = window.setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 700);
      ws.onopen = () => { window.clearTimeout(timer); try { ws.close(); } catch {} resolve(true); };
      ws.onerror = () => { window.clearTimeout(timer); resolve(false); };
    } catch {
      resolve(false);
    }
  });
  return ok ? `ws://${host}:4545` : null;
}

const NOSTR_RELAYS = [
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://yabu.me",
  "wss://nostr-relay-production.up.railway.app",
];

async function buildRelayUrls(): Promise<string[]> {
  if (!IS_LAN_HOST) return NOSTR_RELAYS;
  const lan = await probeLanRelay(window.location.hostname);
  return lan ? [lan, ...NOSTR_RELAYS] : NOSTR_RELAYS;
}

export type SessionPhase = "connecting" | "connected" | "failed" | "closed";

/** localStorage key for the per-device relay credential (shared with main.ts's #turn= handler). */
export const TURN_STORE_KEY = STORE_KEY;

export interface StoredTurnConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Parse a #turn= payload (base64url JSON {urls, username, credential}) into a safe config, or null. */
export function parseTurnFragment(payload: string): StoredTurnConfig | null {
  try {
    if (!payload || payload.length > 8192) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const j = JSON.parse(new TextDecoder().decode(bytes)) as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = Array.isArray(j?.urls) ? j.urls.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
    if (urls.length === 0) return null;
    const cfg: StoredTurnConfig = { urls: urls.slice(0, 5) };
    if (typeof j.username === "string" && j.username) cfg.username = j.username;
    if (typeof j.credential === "string" && j.credential) cfg.credential = j.credential;
    return cfg;
  } catch {
    return null;
  }
}

export interface SessionCallbacks {
  onPhase(phase: SessionPhase, reason?: string): void;
  onStream(stream: MediaStream): void;
  onHello(hello: HelloMessage): void;
  /** RTT in ms — UI layer may ignore it (video overlay is gone); kept mandatory for future overlay-free HUD */
  onRtt(ms: number): void;
  onClipboard(text: string): void;
  /** true when the remote said the version is mismatched (agent asks user to update) */
  onVersionMismatch(): void;
}

export class Session implements CommandSink {
  private room: Room | null = null;
  private fast: { send: (d: Uint8Array) => Promise<void>; onMessage: (h: (d: unknown, ctx: { peerId: string }) => void) => () => void } | null = null;
  private ctl: { send: (d: string) => Promise<void>; onMessage: (h: (d: unknown, ctx: { peerId: string }) => void) => () => void } | null = null;
  private lastCurAt = 0;
  private curLine1 = 0;
  private curLine2 = 0;
  private seq = new SeqCounter();
  private tracker = new SeqTracker();
  private assembler = new ChunkAssembler();
  private peerId: string | null = null;
  private connectTimer: number | null = null;
  private rttTimer: number | null = null;
  private sessionLimitTimer: number | null = null;
  private disposed = false;
  private recovering = false;
  private staleFrameProbe: (() => boolean) | null = null;

  setStaleFrameProbe(fn: (() => boolean) | null) {
    this.staleFrameProbe = fn;
  }

  constructor(private opts: { roomId: string; password: string; cb: SessionCallbacks }) {}

  /** Synchronous read of this device's saved credential — the instant path (no network). */
  private loadStoredTurn(): StoredTurnConfig | null {
    try {
      const stored = localStorage.getItem(STORE_KEY);
      if (stored) {
        const j = JSON.parse(stored) as { urls?: unknown; username?: unknown; credential?: unknown };
        const urls = Array.isArray(j?.urls)
          ? j.urls.filter((u): u is string => typeof u === "string" && u.length > 0)
          : typeof j?.urls === "string" && j.urls ? [j.urls] : [];
        if (urls.length > 0) {
          const cfg: StoredTurnConfig = { urls: urls.slice(0, 5) };
          if (typeof j.username === "string") cfg.username = j.username;
          if (typeof j.credential === "string") cfg.credential = j.credential;
          return cfg;
        }
      }
    } catch { /* private mode or corrupt entry — fall through */ }
    return null;
  }

  /** TURN relay for THIS device.
   *  1) the credential saved on this device (one-time #turn= link / earlier Apps Script sync),
   *  2) build-time injection next to index.html (self-hosted deployments: ./turn.json);
   *  Falls back to the built-in Open Relay (public static-auth, no account) when absent. */
  private async loadTurnConfig(): Promise<{ urls: string[]; username?: string; credential?: string } | null> {
    const stored = this.loadStoredTurn();
    if (stored) return stored;
    try {
      const res = await fetch("./turn.json", { cache: "no-store" });
      if (!res.ok) return null;
      const j = (await res.json()) as { urls?: unknown; username?: unknown; credential?: unknown };
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
  }

  async start(attempt = 1) {
    const { roomId, password, cb } = this.opts;
    if (attempt > 1) console.log(`[session] retry attempt ${attempt}`);
    // TURN pick — never let the Apps Script bridge decide how long "Connecting…" spins.
    // The credential saved on THIS device is used instantly (the bridge is asked to refresh
    // the cache in the BACKGROUND, for next time). Only when nothing is stored do we wait —
    // and only ~4.5 s instead of 20 s — before joining on the built-in Open Relay anyway.
    // On retries the stored credential is ignored so one bad relay can't stall every attempt.
    let userTurn: StoredTurnConfig | null = null;
    if (attempt === 1) {
      userTurn = this.loadStoredTurn();
      if (userTurn) {
        void fetchSyncedTurn(roomId, password)
          .then((s) => { if (s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode */ } } })
          .catch(() => { /* cache refresh is best-effort */ });
        console.log("[session] TURN: saved on this device (cache hit — refreshing in background)");
      } else {
        const synced = await fetchSyncedTurn(roomId, password, 4500);
        if (synced) {
          try { localStorage.setItem(STORE_KEY, JSON.stringify(synced)); } catch { /* private mode */ }
        }
        userTurn = synced ?? (await this.loadTurnConfig());
        console.log("[session] TURN:", synced ? "auto-sync (apps script)" : userTurn ? "turn.json / saved on this device" : "built-in Open Relay");
      }
    } else {
      console.log("[session] TURN: built-in Open Relay (retry ignores the stored relay)");
    }
    const turnConfig = await resolveTurnConfig(userTurn);
    const relayUrls = await buildRelayUrls();
    console.log("[session] relay urls:", relayUrls.join(", ") || "(none)");
    cb.onPhase("connecting");

    let room: Room;
    try {
      room = joinRoom(
        {
          appId: APP_ID,
          password,
          maxUsers: 2, // agent + this client — single session
          trickleIce: true,
          relayConfig: { urls: relayUrls },
          ...(turnConfig ? { turnConfig } : {}),
        },
        roomId
      );
    } catch {
      if (attempt < MAX_ATTEMPTS) void this.retrySoon(attempt);
      else cb.onPhase("failed", "Could not start the connection (invalid Device ID?)");
      return;
    }
    this.room = room;

    this.fast = room.makeAction<Uint8Array>("fast");
    this.ctl = room.makeAction<string>("ctl");

    this.fast.onMessage((data, ctx) => {
      if (ctx.peerId !== this.peerId) return;
      this.handleFastFrame(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
    });

    this.ctl.onMessage((raw, ctx) => {
      if (ctx.peerId !== this.peerId) return; // refuse non-session peers
      try {
        const decoded = decodeCtl(raw as string);
        const full = this.assembler.push(decoded);
        if (!full) return;
        void this.handleCtl(full);
      } catch { /* malformed frame — drop */ }
    });

    room.onPeerJoin(({ peerId }) => {
      if (this.peerId && this.peerId !== peerId) return; // seat already taken — refuse silently
      this.peerId = peerId;
      window.clearTimeout(this.connectTimer ?? undefined);
      this.openFastLines(peerId);
      cb.onPhase("connected");
      // 5-hour session cap: auto-disconnect — the user can reconnect with the same password
      window.clearTimeout(this.sessionLimitTimer ?? undefined);
      this.sessionLimitTimer = window.setTimeout(() => this.handleClose("Session ended after 5 hours. RemoteX rotates its password automatically — reopen the page with the NEW password shown on the computer."), SESSION_LIMIT_MS);
      this.startRtt();
    });

    room.onPeerLeave(({ peerId }) => {
        // agent vanished WITHOUT a clean bye - no auto re-dial (that was the connect/disconnect churn).
        // Show a clear state instead; the user reconnects manually.
        if (peerId === this.peerId) this.handleClose("Connection lost. Please reconnect.");
    });

    room.onError((err) => {
      const code = (err as { code?: string }).code;
      if (code === "decrypt-failed") this.handleClose("Wrong password for this Device ID.");
      else if (code === "room-full") this.handleClose("This computer already has an active session.");
      else if (code === "peer-connect-failed") this.handleClose("Could not establish a direct connection. Try another network.");
      else if (code === "relay-failed") this.handleClose("All public relays failed. Check your internet connection.");
      else if (code === "handshake-failed") this.handleClose("Security handshake failed. Try again.");
      else if (code === "banned") this.handleClose("This session was refused by the agent.");
    });

    room.onPeerStream((stream, ctx) => {
      if (ctx.peerId !== this.peerId) return;
      this.tuneReceiver(stream);
      cb.onStream(stream);
    });

    this.connectTimer = window.setTimeout(() => {
      if (this.peerId) return;
      if (attempt < MAX_ATTEMPTS) void this.retrySoon(attempt);
      else {
        if (IS_LAN_HOST) {
          const url = `http://${window.location.hostname}:4545/`;
          this.handleClose(`Could not reach — make sure RemoteX is running, then open exactly ${url} and type the CURRENT password shown in the RemoteX window.`);
        } else {
          this.handleClose("Could not reach the computer — check that RemoteX is running and try again.");
        }
      }
    }, CONNECT_TIMEOUT_MS);
  }

  /** Tear down the failed room, then re-try from scratch — backoff so we don't hammer public relays (they rate-limit our shared app key at 60 events/min). Silent — the connect button already says Connecting. */
  private async retrySoon(attempt: number) {
    console.log(`[session] attempt ${attempt} timed out — retrying…`);
    const room = this.room;
    this.room = null;
    if (room) { try { await room.leave(); } catch { /* already gone */ } }
    window.clearTimeout(this.connectTimer ?? undefined);
    const wait = attempt === 1 ? 800 : 1800; // 0.8s, then longer — fewer hammer bursts on shared relays
    window.setTimeout(() => { if (!this.disposed) this.start(attempt + 1); }, wait);
  }

  /** Latest-only cursor correction from the agent (absolute, normalized). */
  setCursorCorrector(fn: (x: number, y: number) => void) {
    this.onCur = fn;
  }
  private onCur: ((x: number, y: number) => void) | null = null;

  private async handleCtl(msg: import("@remotex/protocol").CtlMessage) {
    const cb = this.opts.cb;
    switch (msg.kind) {
      case "cur": // LINE 2 of the sync path - the same beacon arriving on the JSON channel
        if (!this.tracker.accept(msg.seq)) return; // already delivered on the fast line - drop duplicate
        this.curLine2++;
        if (this.curLine2 === 1) console.log("[session] cursor line2 alive (JSON ctl channel)");
        this.lastCurAt = Date.now();
        this.onCur?.(msg.x, msg.y);
        return;
      case "hello":
        this.lastCurAt = Date.now(); // seeds the watchdog baseline (agent sends cur 50 Hz right after)
        if (isVersionMismatch(msg)) cb.onVersionMismatch();
        else cb.onHello(msg);
        return;
      case "clipboard":
        cb.onClipboard(msg.text);
        return;
      case "ack":
        if (!msg.ok && msg.error === "protocol-mismatch") cb.onVersionMismatch();
        return;
      case "bye":
        this.handleClose("The agent ended the session.");
        return;
      default:
        return; // down/up/click/text/paste/key are not expected client-bound
    }
  }

  private tuneReceiver(stream: MediaStream) {
    // ask for the lowest possible jitter buffer (Chromium-only, best-effort)
    try {
      const pc = this.room?.getPeers()?.[this.peerId ?? ""]?.connection;
      const receiver = pc?.getReceivers().find((r) => r.track?.kind === "video");
      const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number } | undefined;
      if (r) {
        r.jitterBufferTarget = 0;
        r.playoutDelayHint = 0;
      }
    } catch { /* Safari/Firefox: use default jitter buffer */ }
    void stream;
  }

  private startRtt() {
    const tick = async () => {
      if (!this.room || !this.peerId) return;
      // heartbeat FIRST — never let a stuck room.ping starve the agent's liveness watchdog
      void this.ctl?.send(encodeCtl({ kind: "hb" })).catch(() => {});
      // ping measurement (best effort; a hung promise must not block the loop)
      this.room.ping(this.peerId)
        .then((ms) => this.opts.cb.onRtt(Math.round(ms)))
        .catch(() => {});
      // watchdog line: if neither the fast nor the ctl cursor beacon has landed for ~400 ms,
      // force the agent to republish the cursor immediately on both lines
      if (this.peerId && this.lastCurAt && Date.now() - this.lastCurAt > 400) {
        void this.ctl?.send(encodeCtl({ kind: "curping" })).catch(() => {});
      }
      this.rttTimer = window.setTimeout(() => void tick(), 1000);
    };
    void tick();
  }

  private handleClose(reason: string) {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.connectTimer ?? undefined);
    window.clearTimeout(this.rttTimer ?? undefined);
    window.clearTimeout(this.sessionLimitTimer ?? undefined);
    this.sessionLimitTimer = null;
    this.opts.cb.onPhase("closed", reason);
    void this.close();
  }

  /** User-initiated disconnect: closes the room without surfacing an error. */
  async stop() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.connectTimer ?? undefined);
    window.clearTimeout(this.rttTimer ?? undefined);
    window.clearTimeout(this.sessionLimitTimer ?? undefined);
    this.sessionLimitTimer = null;
    await this.close();
  }

  async close() {
    this.closeFastLines();
    const room = this.room;
    this.room = null;
    if (room) {
      try { await room.leave(); } catch { /* already gone */ }
    }
  }

  /**
   * Silent recovery for a frozen stream (e.g. the tab was switched away and the WebRTC
   * pipeline choked). First nudges the ICE layer (restartIce) — most of the time the
   * same peer connection just resends a keyframe and frames flow again. If frames are
   * still dead after a grace period, silently re-dials with the SAME credentials
   * (no user interaction) — the agent notices the dead seat and hands it over.
   */
  async silentRecover(): Promise<void> {
    if (this.disposed || this.recovering) return;
    this.recovering = true;
    console.warn("[session] stream froze — trying ICE restart for a silent recovery");
    try {
      const pc = (this.room as unknown as { getPeers?: () => Record<string, { connection?: RTCPeerConnection }> } | null)?.getPeers?.()?.[this.peerId ?? ""]?.connection;
      try { (pc as unknown as { restartIce?: () => void } | undefined)?.restartIce?.(); } catch { /* best effort */ }
      // give the transport a few seconds to re-key + request a keyframe
      await new Promise((r) => window.setTimeout(r, 3000));
      if (this.staleFrameProbe?.()) {
        console.log("[session] ICE restart revived the stream");
        this.recovering = false;
        return;
      }
      console.warn("[session] ICE restart did not revive frames — silently re-dialing with the same credentials");
    } catch (err) {
      console.warn("[session] recovery via ICE restart failed:", err);
    }
    // full silent re-join (room-full on the dead seat is handled by the agent's seatStale())
    const room = this.room;
    this.room = null;
    this.peerId = null;
    this.disposed = false;
    window.clearTimeout(this.connectTimer ?? undefined);
    window.clearTimeout(this.rttTimer ?? undefined);
    this.seq = new SeqCounter();
    this.tracker = new SeqTracker();
    this.assembler = new ChunkAssembler();
    if (room) { try { await room.leave(); } catch { /* already gone */ } }
    await new Promise((r) => window.setTimeout(r, 400)); // let the agent see the leave before we redial
    await this.start(1);
    this.recovering = false;
  }

  /** Shared decoder for both fast paths (trystero reliable + negotiated unreliable). */
  private handleFastFrame(bytes: Uint8Array) {
    const msg = decodeFast(bytes);
    if (!msg) return;
    // pong: echo the exact 7 bytes so the agent can measure RTT
    if (msg.kind === "ping" && isPing(bytes)) { void this.fast?.send(bytes).catch(() => {}); return; }
    if (msg.kind === "cur") {
      if (!this.tracker.accept(msg.seq)) return; // drop stale cursor packets (already delivered on the other line)
      this.curLine1++;
      if (this.curLine1 === 1) console.log("[session] cursor fast line alive (unreliable/reliable link)");
      this.lastCurAt = Date.now();
      this.onCur?.(msg.x, msg.y);
    }
  }

  /** Redundant unreliable lanes (ids 2-11, maxRetransmits: 0, unordered) - EVERY fast
   *  frame rides all of them; the far end dedups by seq, so the first copy to land wins
   *  and the rest are dropped. Loss on any single lane is invisible to the user. */
  private static readonly LANE_IDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  private fastlines: RTCDataChannel[] = [];

  private openFastLines(peerId: string) {
    this.closeFastLines();
    try {
      const pc = this.room?.getPeers?.()?.[peerId]?.connection as RTCPeerConnection | undefined;
      if (!pc) { console.warn("[fastline] no pc yet - staying on the trystero channel"); return; }
      const lanes: RTCDataChannel[] = [];
      for (const id of Session.LANE_IDS) {
        try {
          const dc = pc.createDataChannel(`fastline${id === 2 ? "" : "-" + id}`, { negotiated: true, id, ordered: false, maxRetransmits: 0 });
          dc.binaryType = "arraybuffer";
          dc.onopen = () => console.log(`[fastline] lane ${id} open`);
          dc.onmessage = (ev) => {
            const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBuffer);
            this.handleFastFrame(bytes);
          };
          dc.onclose = () => { this.fastlines = this.fastlines.filter((l) => l !== dc); };
          lanes.push(dc);
        } catch (err) {
          console.warn(`[fastline] lane ${id} open failed - other lanes keep working:`, err);
        }
      }
      this.fastlines = lanes;
      console.log(`[fastline] ${lanes.length} redundant lanes requested (ids ${Session.LANE_IDS[0]}-${Session.LANE_IDS[Session.LANE_IDS.length - 1]})`);
    } catch (err) {
      console.warn("[fastline] lanes unavailable - staying on the trystero channel:", err);
      this.fastlines = [];
    }
  }

  private closeFastLines() {
    const lanes = this.fastlines;
    this.fastlines = [];
    for (const dc of lanes) { try { dc?.close(); } catch { /* already gone */ } }
  }

  /** Replicate every fast frame on ALL open lanes (shared seq; the agent dedups). */
  private fastSend(frame: Uint8Array) {
    for (const dc of this.fastlines) {
      if (dc.readyState === "open") {
        try { dc.send(new Uint8Array(frame).buffer); } catch { /* drop - other lanes carry it */ }
      }
    }
    this.fast?.send(frame).catch(() => {});
  }

  /* ---------- CommandSink (remote.ts calls these) ---------- */

  move(x: number, y: number) {
    this.fastSend(encodeFast({ kind: "move", seq: this.seq.next(), x, y }));
  }

  scroll(dx: number, dy: number) {
    this.fastSend(encodeFast({ kind: "scroll", seq: this.seq.next(), dx, dy }));
  }

  pointer(kind: "down" | "up" | "click" | "dblclick", button: MouseButton, x: number, y: number) {
    for (const frame of packCtl({ kind, button, x, y })) void this.ctl?.send(frame).catch(() => {});
  }

  key(code: string, key: string, down: boolean, mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }) {
    for (const frame of packCtl({ kind: "key", code, key, down, ctrl: mods.ctrl, alt: mods.alt, shift: mods.shift, meta: mods.meta }))
      void this.ctl?.send(frame).catch(() => {});
  }

  text(text: string) {
    for (const frame of packCtl({ kind: "text", text })) void this.ctl?.send(frame).catch(() => {});
  }

  paste(text: string) {
    for (const frame of packCtl({ kind: "paste", text })) void this.ctl?.send(frame).catch(() => {});
  }
}

/** Hello the CLIENT expects (the agent is the sender of hello). */
export function helloOk(hello: HelloMessage): boolean {
  return !isVersionMismatch(hello) && hello.version === PROTOCOL_VERSION;
}

