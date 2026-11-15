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
        video: { frameRate: { ideal: 60, max: 60 } },
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
      const settings = track?.getSettings() ?? {};
      if (settings.width && settings.height) log(`capture: native physical ${settings.width}x${settings.height}`);
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
        void bridge.invoke("input:inject", { kind: "move", x: msg.x, y: msg.y });
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
        // but never let a second peer through even so
        log("refusing second peer", peerId);
        try { this.ctl?.send(encodeCtl({ kind: "bye" }), { target: peerId } as never); } catch { /* ignore */ }
        return;
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
    switch (msg.kind) {
      case "down": case "up": {
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
        await bridge.invoke("input:inject", { kind: "click", button: msg.button, x: msg.x, y: msg.y, double: false });
        return;
      }
      case "dblclick": {
        await bridge.invoke("input:inject", { kind: "click", button: msg.button, x: msg.x, y: msg.y, double: true });
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
      case "bye":
        await bridge.invoke("session:ended-by-user");
        return;
      default:
        return; // hello/clipboard/ack are not inputs
    }
  }

  private async rearmTracks() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.stream = null;
  }

  private async injectAbs(x: number, y: number) {
    await bridge.invoke("input:inject", { kind: "move", x, y });
  }

  /** Stop current session, then re-arm the room for the next device. */
  async rearm() {
    this.stopLoops();
    const peer = this.peerId;
    this.peerId = null;
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
