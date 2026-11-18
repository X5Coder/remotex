/**
 * RemoteX — remote surface (touchpad / mouse / tablet modes).
 *
 * Ported from the v1 prototype (docs/prototype-index.html) with fixes per master.md:
 *   - tap = IMMEDIATE click (no 240 ms tap delay); OS merges double-clicks
 *   - touch sends ABSOLUTE normalized moves, coalesced per rAF (never dx/dy deltas)
 *   - every pointer command carries x,y (agent moves first, then presses)
 *   - the decorative local context menu was removed — the real menu appears on the remote machine
 *   - drag works in portrait focus mode too; long-press (550 ms) toggles expand/collapse
 *   - keys carry the PHYSICAL code (KeyboardEvent.code) + down/up edges
 */
import type { MouseButton } from "@remotex/protocol";

export interface CommandSink {
  move(x: number, y: number): void;
  scroll(dx: number, dy: number): void;
  pointer(kind: "down" | "up" | "click" | "dblclick", button: MouseButton, x: number, y: number): void;
  key(code: string, key: string, down: boolean, mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): void;
  text(text: string): void;
  paste(text: string): void;
}

export interface RemoteSurfaceOptions {
  sink: CommandSink;
  onExpandChange?: (expanded: boolean) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const GAIN = 2;
const LAND_GAIN = 1.7;
const ACCEL = 0.5;
const ANIM_MS = 380;
const LONG_PRESS_MS = 550;

function detectDevice(): "phone" | "tablet" | "desktop" {
  const ua = navigator.userAgent || "";
  const pts = navigator.maxTouchPoints || 0;
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && pts > 1)) return "tablet";
  if (matchMedia("(hover:hover) and (pointer:fine)").matches) return "desktop";
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return "tablet";
  if (Math.min(screen.width, screen.height) >= 600) return "tablet";
  return "phone";
}

export class RemoteSurface {
  readonly device = detectDevice();
  private mode: "touch" | "mouse" | "tablet" =
    this.device === "desktop" ? "mouse" : this.device === "tablet" ? "tablet" : "touch";

  private sink: CommandSink;
  private video = $<HTMLVideoElement>("remote-screen" as never) as HTMLVideoElement;
  private app = $("app");
  private panel = $("panel");
  private screenEl = $("screen");
  private wrap = $("screenWrap");
  private backdrop = $("backdrop");
  private canvas = $<HTMLCanvasElement>("glow" as never) as HTMLCanvasElement;
  private ctx = this.canvas.getContext("2d")!;
  private cursor = $("cursor");
  private shade = $("shade");
  private toastEl = $("toast");
  private dock = $("dock");
  private kbInput = $<HTMLInputElement>("kbInput" as never) as HTMLInputElement;

  private ar = 16 / 9;
  private SW = 1;
  private SH = 1;
  private W = 1;
  private H = 1;
  private running = false;

  // synced=true → host cursor is the authority (snap exactly); false → local drag prediction (lerp)
  private S = { down: false, fx: 0, fy: 0, a: 0, cx: 0.5, cy: 0.5, tx: 0.5, ty: 0.5, synced: true, htx: 0.5, hty: 0.5 };
  private lastPointerType: 'mouse' | 'touch' = 'touch';
  private ring: { x: number; y: number; p: number } | null = null;

  private kbOpen = false;
  private full = false;
  private land = false;
  private cur: { cx: number; cy: number; w: number; h: number; rot: number } | null = null;
  private anim: Animation | null = null;
  private busy = false;
  private pend = false;

  private prev = "";
  private h0 = 0;
  private kbSeen = false;

  private pid: number | null = null;
  private lx = 0;
  private ly = 0;
  private moved = 0;
  private tStart = 0;
  private onScreen = false;
  private vidTapAt = 0;
  private lastRemoteClip: string | null = null;

  private tp = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private tDrag = false;
  private tLong = false;
  private tScroll = false;
  private tTimer = 0;

  private toastT = 0;
  private toastFn: (() => void) | null = null;

  private mvPending: { x: number; y: number } | null = null;
  private mvRaf = 0;

  private boundHandlers: Array<[EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];

  constructor(private opts: RemoteSurfaceOptions) {
    this.sink = opts.sink;
  }

  /* ---------- lifecycle ---------- */

  attach() {
    const $id = (id: string) => document.getElementById(id)!;
    const listen = (t: EventTarget, ev: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
      t.addEventListener(ev, fn, o);
      this.boundHandlers.push([t, ev, fn, o]);
    };
    const video = this.video;
    video.addEventListener("loadedmetadata", this.vidAR);
    video.addEventListener("resize", this.vidAR);

    listen(window, "resize", () => this.fit());
    listen(window, "orientationchange", () => window.setTimeout(() => this.fit(), 300));
    listen(window, "scroll", () => window.scrollTo(0, 0));
    listen(window, "resize", this.checkKb as EventListener);
    listen(document, "keydown", this.onDocKeydown as EventListener, true);
    listen(document, "keyup", this._keyUp as EventListener, true);
    listen(document, "paste", this.onDocPaste as EventListener);
    listen(document, "pointerdown", this.onDocPointer as EventListener, true);
    listen(document, "pointermove", ((e: PointerEvent) => { if (e.pointerType === "mouse") this.setMode("mouse"); }) as EventListener, true);

    // touch / pen relative mode (on the app container)
    listen(this.app, "pointerdown", this.onTouchDown as EventListener);
    listen(this.app, "pointermove", this.onTouchMove as EventListener, { passive: false } as AddEventListenerOptions);
    listen(this.app, "pointerup", this.onUp as EventListener);
    listen(this.app, "pointercancel", this.onUp as EventListener);

    // when the tab comes back to the foreground, the decoder/track pipeline may need a nudge
    listen(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.video.srcObject) void this.video.play().catch(() => { /* watchdog will recover if frames stay dead */ });
    });

    // desktop (mouse) direct mapping
    listen(this.screenEl, "pointermove", this.onMouseMove as EventListener);
    listen(this.screenEl, "pointerdown", this.onMouseDown as EventListener);
    listen(this.screenEl, "pointerup", this.onMouseUp as EventListener);
    listen(this.screenEl, "wheel", this.onWheel as EventListener, { passive: false } as AddEventListenerOptions);

    // tablet direct-touch mode
    listen(this.screenEl, "pointerdown", this.onTabletDown as EventListener);
    listen(this.screenEl, "pointermove", this.onTabletMove as EventListener);
    listen(this.screenEl, "pointerup", this.tabletUp as EventListener);
    listen(this.screenEl, "pointercancel", this.tabletUp as EventListener);

    // side rail buttons (left/right click, keyboard, exit) - the only chrome left on the remote screen
    // bottom bar buttons (grid) + floating overlay buttons (land/fullscreen)
    this.holdButton($id("leftBtn") as HTMLButtonElement, "left");
    this.holdButton($id("rightBtn") as HTMLButtonElement, "right");
    this.bindKb($id("kbBtn") as HTMLButtonElement);
    this.holdButton($id("leftBtn2") as HTMLButtonElement, "left");
    this.holdButton($id("rightBtn2") as HTMLButtonElement, "right");
    this.bindKb($id("kbBtn2") as HTMLButtonElement);
    $id("exitBtn").addEventListener("click", () => { if (this.kbOpen) this.closeKb(); if (this.land) void this.rotateFull(); else if (this.full) this.closeFull(); });
    $id("backdrop").addEventListener("click", () => this.closeFull());

    // keyboard input for phones/tablets
    this.kbInput.addEventListener("input", this.onKbInput);
    this.kbInput.addEventListener("keydown", this.onKbKeydown);
    this.kbInput.addEventListener("paste", this.onKbPaste);
    this.kbInput.addEventListener("blur", this.onKbBlur);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", this.checkKb);
    try {
      const vk = (navigator as Navigator & { virtualKeyboard?: { overlaysContent: boolean; boundingRect: { height: number }; addEventListener?: (t: string, cb: () => void) => void } }).virtualKeyboard;
      if (vk) { vk.overlaysContent = true; vk.addEventListener?.("geometrychange", this.checkKb); }
    } catch { /* not supported */ }

    // context menu suppression
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    // toast
    this.toastEl.addEventListener("click", this.onToastClick);

    // F5/F12 passthrough etc. — allow browser escape hatches
    this.fit();
  }

  /**
   * Auto-activate the fullscreen (land) mode right after a successful connect on touch devices.
   * The site itself enters fullscreen — no gesture needed. Exits only via the on-screen X button.
   */
  autoEnterFullscreen() {
    if (this.mode !== "touch" || this.full) return;
    this.openFull();
    // let the focus FLIP settle (340ms), then widen into land fullscreen — same battle-tested path X uses in reverse
    window.setTimeout(() => { if (!this.land) void this.rotateFull(); }, 620);
  }

  detach() {
    for (const [t, ev, fn, o] of this.boundHandlers) t.removeEventListener(ev, fn, o);
    this.boundHandlers = [];
    this.stopFrameWatch();
    this.video.removeEventListener("loadedmetadata", this.vidAR);
    this.video.removeEventListener("resize", this.vidAR);
  }

  /* ---------- video / stream ---------- */

  setStream(stream: MediaStream | null) {
    if (stream) {
      this.video.srcObject = stream;
      this.startFrameWatch();
      this.armFirstFrame();
      void this.video.play().catch(() => { /* autoplay will retry via onStream */ });
    } else {
      this.video.srcObject = null;
      this.screenEl.classList.remove("live");
      this.stopFrameWatch();
    }
  }

  /** Only declare the stream "live" once a REAL frame has been painted — until then the
   *  placeholder stays visible, so a stalled/black stream is never a silent black screen. */
  private armFirstFrame() {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const onFrame = () => {
      this.screenEl.classList.add("live");
      console.log("[remote] first video frame decoded — stream is live");
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback(onFrame);
      // belt-and-braces: rVFC can be flaky on some builds — also accept currentTime>0
      const guard = window.setInterval(() => {
        if (v.currentTime > 0) { window.clearInterval(guard); onFrame(); }
      }, 500);
      return;
    }
    const onTime = () => {
      if (v.currentTime > 0) {
        v.removeEventListener("timeupdate", onTime);
        onFrame();
      }
    };
    v.addEventListener("timeupdate", onTime);
  }

  /* ---------- stale-frame watchdog (auto re-sync when backgrounded tabs freeze) ---------- */

  /** Register a callback invoked when the stream delivers NO new frames for ~2.5s. */
  private staleCb: (() => void) | null = null;
  private lastFrameAt = 0;
  private staleTimer = 0;
  private lastCt = -1;
  private watching = false;

  setStaleHandler(cb: (() => void) | null) { this.staleCb = cb; }

  /** Public: used by the session's recovery path — true when frames are flowing right now. */
  framesFlowing() { return performance.now() - this.lastFrameAt < 8000; }

  private startFrameWatch() {
    this.lastFrameAt = performance.now(); // fresh stream = fresh clock, even when re-armed on silent rejoin
    this.lastCt = -1;
    if (this.watching) return;
    this.watching = true;
    const video = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void };
    if (typeof video.requestVideoFrameCallback === "function") {
      const tick = () => {
        this.lastFrameAt = performance.now();
        try { video.requestVideoFrameCallback!(tick); } catch { /* stream replaced — onStream re-arms */ }
      };
      try { video.requestVideoFrameCallback(tick); } catch { /* fall back to the interval check */ }
    }
    window.clearInterval(this.staleTimer);
    this.staleTimer = window.setInterval(() => {
      if (!this.staleCb) return;
      if (document.visibilityState !== "visible") return; // suspended by the OS — not a fault
      if (typeof this.video.requestVideoFrameCallback !== "function") {
        // fallback freshness probe: currentTime only advances when decoding real frames
        if (this.video.currentTime !== this.lastCt) { this.lastFrameAt = performance.now(); this.lastCt = this.video.currentTime; }
      }
      if (performance.now() - this.lastFrameAt > 12000) this.staleCb();
    }, 1000);
  }

  private stopFrameWatch() {
    this.watching = false;
    window.clearInterval(this.staleTimer);
    this.staleTimer = 0;
  }

  /** host beacon: record it, but never fight the local pointer/finger (that was the jitter) */
  setCursor(x: number, y: number) {
    const nx = clamp(x, 0, 1), ny = clamp(y, 0, 1);
    this.S.htx = nx;
    this.S.hty = ny;
    if (this.lastPointerType === "mouse") return; // overlay IS the local pointer - host echo trails and would jitter
    if (this.S.down) return; // dragging - local prediction leads; eased into the host truth on release
    this.S.tx = nx;
    this.S.ty = ny;
    // glide to the host truth instead of teleporting - on weak links a hard snap made the arrow step visibly
    this.S.synced = false;
    this.kick();
  }


  private vidAR = () => {
    if (this.video.videoWidth && this.video.videoHeight) {
      const n = this.video.videoWidth / this.video.videoHeight;
      if (Math.abs(n - this.ar) > 0.005) { this.ar = n; this.fit(); }
    }
  };

  /* ---------- layout ---------- */

  private fit = () => {
    if (this.kbOpen) return;
    const vh = window.innerHeight, vw = window.innerWidth, st = this.app.style;
    const focus = this.mode !== "touch";
    document.body.classList.toggle("focus", focus);
    document.body.classList.toggle("tablet", this.mode === "tablet");
    document.body.classList.toggle("mouse", this.mode === "mouse");
    document.body.classList.toggle("land", this.land);
    st.setProperty("--h", vh + "px");
    let sw: number, sh: number;
    if (focus) {
      sh = Math.min(vw / this.ar, vh); sw = sh * this.ar;
    } else {
      const padTop = parseFloat(getComputedStyle(this.app).paddingTop) || 6;
      const barH = (document.getElementById("rToolbar")?.offsetHeight || 0) + 6; // main-page toolbar height + margin (0 when hidden in focus/land)
      const maxSh = Math.max(80, vh - padTop - 6 - 30 - 52 - 70 - barH);
      sh = Math.min((vw - 24) / this.ar, maxSh); sw = sh * this.ar;
    }
    st.setProperty("--sw", Math.floor(sw) + "px");
    st.setProperty("--sh", Math.floor(sh) + "px");
    window.scrollTo(0, 0);
    requestAnimationFrame(() => { if (this.full) this.applyTarget(); this.measure(); });
  };

  private measure = () => {
    if (!this.full) { this.SW = this.screenEl.clientWidth; this.SH = this.screenEl.clientHeight; }
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.W = window.innerWidth; this.H = window.innerHeight;
    this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.kick();
  };

  /* ---------- glow / cursor loop ---------- */

  private kick() {
    if (!this.running) { this.running = true; requestAnimationFrame(this.tick); }
  }

  /** rect of the video content inside the (possibly letterboxed) screen element — in FULLSCREEN the 16:9 video is letterboxed top/bottom */
  private contentRect() {
    const W = this.SW, H = this.SH, ar = this.ar;
    let cw = W, ch = cw / ar;
    if (ch > H) { ch = H; cw = ch * ar; }
    return { ox: (W - cw) / 2, oy: (H - ch) / 2, cw, ch };
  }

  private tick = () => {
    if (this.S.synced) {
      // host is authoritative — snap exactly, zero lag / zero drift
      this.S.cx = this.S.tx;
      this.S.cy = this.S.ty;
    } else {
      this.S.cx += (this.S.tx - this.S.cx) * 0.4;
      this.S.cy += (this.S.ty - this.S.cy) * 0.4;
    }
    const cr = this.contentRect();
    this.cursor.style.transform = `translate3d(${(cr.ox + this.S.cx * cr.cw).toFixed(1)}px,${(cr.oy + this.S.cy * cr.ch).toFixed(1)}px,0)`;

    this.ctx.clearRect(0, 0, this.W, this.H);
    this.S.a += ((this.S.down && !this.full ? 1 : 0) - this.S.a) * 0.1;
    if (this.S.a > 0.01) {
      const R = 90, g = this.ctx.createRadialGradient(this.S.fx, this.S.fy, 0, this.S.fx, this.S.fy, R);
      g.addColorStop(0, `rgba(255,255,255,${0.7 * this.S.a})`);
      g.addColorStop(0.5, `rgba(255,255,255,${0.3 * this.S.a})`);
      g.addColorStop(0.85, `rgba(140,150,170,${0.06 * this.S.a})`);
      g.addColorStop(1, "rgba(140,150,170,0)");
      this.ctx.fillStyle = g;
      this.ctx.beginPath(); this.ctx.arc(this.S.fx, this.S.fy, R, 0, 6.283); this.ctx.fill();
    }
    if (this.ring) {
      this.ring.p += 1;
      const t = this.ring.p / 60;
      if (t >= 1) this.ring = null;
      else {
        const rad = 20 + 70 * (1 - Math.pow(1 - t, 3));
        this.ctx.strokeStyle = `rgba(130,142,162,${0.3 * (1 - t)})`;
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath(); this.ctx.arc(this.ring.x, this.ring.y, rad, 0, 6.283); this.ctx.stroke();
      }
    }
    const idle = !this.S.down && this.S.a <= 0.01 && !this.ring &&
      Math.abs(this.S.tx - this.S.cx) < 0.0005 && Math.abs(this.S.ty - this.S.cy) < 0.0005;
    if (idle) { this.running = false; this.ctx.clearRect(0, 0, this.W, this.H); return; }
    requestAnimationFrame(this.tick);
  };

  /* ---------- mode switching ---------- */

  private setMode(m: "touch" | "mouse" | "tablet") {
    if (m === this.mode) return;
    this.mode = m;
    this.tabletReset();
    if (this.kbOpen) this.closeKb();
    if (this.full) { this.closeFull(); window.setTimeout(this.fit, 480); } else this.fit();
  }

  private onDocPointer = (e: PointerEvent) => {
    if (e.pointerType === "mouse") this.setMode("mouse");
    else if (e.pointerType === "touch" || e.pointerType === "pen") this.setMode(this.device === "phone" ? "touch" : "tablet");
  };

  /* ---------- touch (relative touchpad) mode ---------- */

  private onTouchDown = (e: PointerEvent) => {
    if (this.mode !== "touch" || e.pointerType === "mouse" || this.pid !== null || this.anim || this.busy) return;
    if ((e.target as HTMLElement).closest(".tray, .foldTab, #kbInput, .btns, .lui, .dock, button")) return; // buttons own their gestures - never the background tap-to-click
    e.preventDefault();
    this.pid = e.pointerId;
    this.onScreen = !!(e.target as HTMLElement).closest("#screen");
    this.tStart = performance.now();
    this.moved = 0;
    this.lx = e.clientX; this.ly = e.clientY;
    this.app.setPointerCapture(this.pid);
    this.S.down = true;
    this.S.fx = e.clientX; this.S.fy = e.clientY;
    this.kick();
  };

  private onTouchMove = (e: PointerEvent) => {
    if (!this.S.down || e.pointerId !== this.pid) return;
    this.lastPointerType = "touch";
    this.S.synced = false; // local drag prediction (host echo will re-snap to the truth)
    const rx = e.clientX - this.lx, ry = e.clientY - this.ly;
    this.lx = e.clientX; this.ly = e.clientY;
    this.moved += Math.abs(rx) + Math.abs(ry);
    const dx = rx, dy = ry; // land mode no longer rotates the video — same 1:1 mapping everywhere
    this.S.fx += (e.clientX - this.S.fx) * 0.3;
    this.S.fy += (e.clientY - this.S.fy) * 0.3;
    const sp = Math.hypot(rx, ry);
    const cr = this.contentRect();
    const g = (this.land ? LAND_GAIN : GAIN) * (1 + Math.min(sp / 20, ACCEL));
    this.S.tx = clamp(this.S.tx + (dx * g) / cr.cw, 0, 1);
    this.S.ty = clamp(this.S.ty + (dy * g) / cr.ch, 0, 1);
    // coalesced absolute move (spec: touch sends absolute, latest-only, 1 per rAF)
    this.mvPending = { x: this.S.tx, y: this.S.ty };
    if (!this.mvRaf) this.mvRaf = requestAnimationFrame(this.flushMove);
    this.kick();
    e.preventDefault();
  };

  private flushMove = () => {
    this.mvRaf = 0;
    if (this.mvPending) { this.sink.move(+this.mvPending.x.toFixed(4), +this.mvPending.y.toFixed(4)); this.mvPending = null; }
  };

  /* ---------- video double-tap = focus cycle; taps on empty area = click / double-click (Windows folds) — NO long-press ---------- */

  /** video double-tap cycle: small -> focus (portrait) -> landscape (fullscreen) -> small */
  private expandCycle = () => {
    if (!this.full) { this.openFull(); return; }   // small -> focus
    if (!this.land) { void this.rotateFull(); return; } // focus -> landscape (fullscreen)
    this.closeFull();                               // landscape -> small (cycle complete)
  };

  private fireClick(button: MouseButton = "left") {
    this.ring = { x: this.S.fx, y: this.S.fy, p: 0 };
    this.clickFx("l");
    this.sink.pointer("click", button, +this.S.tx.toFixed(4), +this.S.ty.toFixed(4));
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pid) return;
    this.pid = null;
    const wasCursorDown = this.S.down;
    const isTap = this.moved < 8 && performance.now() - this.tStart < 280;
    this.S.down = false;
    // finger released - ease into the host truth accumulated while dragging (gliding, not teleporting)
    if (this.lastPointerType !== "mouse") {
      this.S.tx = this.S.htx;
      this.S.ty = this.S.hty;
      this.S.synced = false;
    }
    this.kick();
    if (!wasCursorDown || !isTap || e.type !== "pointerup") return;

    // taps ON THE VIDEO never click. A DOUBLE-TAP on the video cycles focus mode
    // (small -> focus -> landscape -> small) - exactly like the original prototype gesture.
    // taps ON THE VIDEO inside FULLSCREEN = a normal click (two fast taps become a double-click).
    // In focus/small the video taps stay silent; a double-tap there widens to fullscreen via the cycle.
    if (this.onScreen && this.land) {
      this.fireClick("left");
      return;
    }
    if (this.onScreen) {
      const now = performance.now();
      if (now - this.vidTapAt < 500) {
        this.vidTapAt = 0;
        try { navigator.vibrate?.(20); } catch { /* no haptics */ }
        this.expandCycle();
        return;
      }
      this.vidTapAt = now;
      return;
    }

    // taps on the empty area below the video/buttons = REAL click; two quick taps =
    // double-click (Windows folds two fast clicks into one double-click) - like a touchpad
    this.fireClick("left");
  };

  /* ---------- hold buttons ---------- */

  private holdButton(btn: HTMLButtonElement, kind: MouseButton) {
    btn.addEventListener("pointerdown", (e) => {
      if (btn.classList.contains("down")) return;
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      btn.classList.add("down");
      if (kind === "right") this.clickFx("r"); else this.clickFx("l");
      this.sink.pointer("down", kind, +this.S.tx.toFixed(4), +this.S.ty.toFixed(4));
    });
    const release = () => {
      if (!btn.classList.contains("down")) return;
      btn.classList.remove("down");
      this.sink.pointer("up", kind, +this.S.tx.toFixed(4), +this.S.ty.toFixed(4));
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private clickFx(kind: "l" | "r", x?: number, y?: number) {
    const f = document.createElement("div");
    f.className = "fx" + (kind === "r" ? " r" : "");
    f.style.left = (x ?? this.contentRect().ox + this.S.tx * this.contentRect().cw) + "px";
    f.style.top = (y ?? this.contentRect().oy + this.S.ty * this.contentRect().ch) + "px";
    this.screenEl.appendChild(f);
    f.animate(
      [{ transform: "scale(.3)", opacity: 0.9 }, { transform: "scale(4)", opacity: 0 }],
      { duration: 600, easing: "ease-out" }
    ).onfinish = () => f.remove();
  }

  /* ---------- desktop (mouse) mode ---------- */

  private norm(e: PointerEvent | WheelEvent) {
    const r = this.screenEl.getBoundingClientRect();
    const c = this.contentRect();
    return {
      x: clamp((e.clientX - r.left - c.ox) / c.cw, 0, 1),
      y: clamp((e.clientY - r.top - c.oy) / c.ch, 0, 1),
    };
  }

  private onMouseMove = (e: PointerEvent) => {
    if (this.mode !== "mouse" || e.pointerType !== "mouse") return;
    this.lastPointerType = "mouse";
    const p = this.norm(e);
    this.mvPending = p;
    // the OS mouse IS the remote cursor here — map 1:1 and snap the overlay instantly (no prediction lag)
    this.S.synced = true;
    this.S.tx = p.x;
    this.S.ty = p.y;
    this.kick();
    if (!this.mvRaf) this.mvRaf = requestAnimationFrame(this.flushMove);
  };

  private BTN: MouseButton[] = ["left", "middle", "right"];

  private onMouseDown = (e: PointerEvent) => {
    if (this.mode !== "mouse" || e.pointerType !== "mouse") return;
    e.preventDefault();
    this.screenEl.setPointerCapture(e.pointerId);
    const p = this.norm(e);
    this.sink.pointer("down", this.BTN[e.button] ?? "left", +p.x.toFixed(4), +p.y.toFixed(4));
  };

  private onMouseUp = (e: PointerEvent) => {
    if (this.mode !== "mouse" || e.pointerType !== "mouse") return;
    const p = this.norm(e);
    this.sink.pointer("up", this.BTN[e.button] ?? "left", +p.x.toFixed(4), +p.y.toFixed(4));
  };

  private onWheel = (e: WheelEvent) => {
    if (this.mode !== "mouse") return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : 1;
    this.sink.scroll(Math.round(e.deltaX * k), Math.round(e.deltaY * k));
  };

  private onDocKeydown = (e: KeyboardEvent) => {
    if (e.target === this.kbInput) return; // hidden input owns the keyboard while it is focused
    if (["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"].includes(e.key)) return;
    const k = e.key.toLowerCase();
    const cmd = e.ctrlKey || e.metaKey;
    if (cmd && k === "v") return; // native paste event will fire
    if (!/^(F5|F11|F12)$/.test(e.key)) e.preventDefault();
    const mod = e.ctrlKey || e.altKey || e.metaKey;
    const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
    if (e.key.length === 1 && !mod) this.sink.text(e.key);
    else this.sink.key(e.code, k, true, mods);
  };

  // physical key release
  private _keyUp = (e: KeyboardEvent) => {
    if (e.target === this.kbInput) return; // hidden input owns the keyboard while it is focused
    const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
    this.sink.key(e.code, e.key.toLowerCase(), false, mods);
  };

  private onDocPaste = (e: ClipboardEvent) => {
    if (e.target === this.kbInput) return; // hidden input owns the keyboard while it is focused
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    e.preventDefault();
    if (text) this.sink.paste(text);
  };

  /* ---------- tablet (direct touch) mode ---------- */

  private tabletOn = (e: PointerEvent) => this.mode === "tablet" && e.pointerType !== "mouse";

  private tabletReset = () => {
    window.clearTimeout(this.tTimer);
    if (this.tDrag) this.sink.pointer("up", "left", +this.S.tx.toFixed(4), +this.S.ty.toFixed(4));
    this.tp.clear();
    this.tDrag = this.tLong = this.tScroll = false;
  };

  private onTabletDown = (e: PointerEvent) => {
    if (!this.tabletOn(e)) return;
    e.preventDefault();
    this.screenEl.setPointerCapture(e.pointerId);
    this.tp.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (this.tp.size === 1) {
      this.tDrag = this.tLong = this.tScroll = false;
      const p = this.norm(e);
      this.sink.move(+p.x.toFixed(4), +p.y.toFixed(4));
      window.clearTimeout(this.tTimer);
      this.tTimer = window.setTimeout(() => {
        if (this.tp.size === 1 && !this.tDrag) {
          this.tLong = true;
          const r = this.screenEl.getBoundingClientRect();
          this.clickFx("r", e.clientX - r.left, e.clientY - r.top);
          try { navigator.vibrate?.(15); } catch { /* no haptics */ }
          this.sink.pointer("click", "right", +p.x.toFixed(4), +p.y.toFixed(4));
        }
      }, 500);
    } else {
      window.clearTimeout(this.tTimer);
      if (this.tDrag) { this.sink.pointer("up", "left", +this.S.tx.toFixed(4), +this.S.ty.toFixed(4)); this.tDrag = false; }
      this.tScroll = true;
    }
  };

  private onTabletMove = (e: PointerEvent) => {
    if (!this.tabletOn(e)) return;
    this.lastPointerType = "touch";
    const p = this.tp.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.tScroll) {
      if (dx || dy) this.sink.scroll(Math.round(-dx), Math.round(-dy));
      return;
    }
    if (this.tLong) return;
    if (!this.tDrag && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 10) {
      window.clearTimeout(this.tTimer);
      this.tDrag = true;
      const n = this.norm(e);
      this.sink.pointer("down", "left", +n.x.toFixed(4), +n.y.toFixed(4));
    }
    if (this.tDrag) {
      const n = this.norm(e);
      this.sink.move(+n.x.toFixed(4), +n.y.toFixed(4));
    }
  };

  private tabletUp = (e: PointerEvent) => {
    if (!this.tabletOn(e) || !this.tp.has(e.pointerId)) return;
    this.tp.delete(e.pointerId);
    window.clearTimeout(this.tTimer);
    if (this.tp.size === 0) {
      if (this.tDrag) this.sink.pointer("up", "left", +this.S.tx.toFixed(4), +this.S.ty.toFixed(4));
      else if (!this.tLong && !this.tScroll && e.type === "pointerup") {
        const n = this.norm(e);
        const r = this.screenEl.getBoundingClientRect();
        this.clickFx("l", e.clientX - r.left, e.clientY - r.top);
        this.sink.pointer("click", "left", +n.x.toFixed(4), +n.y.toFixed(4));
      }
      this.tDrag = this.tLong = this.tScroll = false;
    }
    if (this.lastPointerType !== "mouse") { this.S.tx = this.S.htx; this.S.ty = this.S.hty; this.S.synced = false; this.kick(); }
  };

  /* ---------- toast / clipboard ---------- */

  private toast(msg: string, fn?: () => void) {
    this.toastEl.textContent = msg;
    this.toastFn = fn ?? null;
    this.toastEl.style.pointerEvents = fn ? "auto" : "none";
    this.toastEl.classList.add("show");
    window.clearTimeout(this.toastT);
    this.toastT = window.setTimeout(() => this.toastEl.classList.remove("show"), fn ? 7000 : 2200);
  }

  private onToastClick = () => {
    if (!this.toastFn) return;
    const f = this.toastFn;
    this.toastFn = null;
    this.toastEl.classList.remove("show");
    f();
  };

  handleRemoteClipboard = async (text: string) => {
    this.lastRemoteClip = text; // keep as offline-paste fallback for insecure origins
    const ok = await this.writeClip(text);
    const preview = text.length > 48 ? text.slice(0, 48) + "…" : text;
    if (ok) this.toast(`Copied: ${preview}`);
    else this.toast("Tap to copy to device clipboard", () =>
      void this.writeClip(this.lastRemoteClip!).then((k) => this.toast(k ? "Copied to device clipboard" : "Copy failed"))
    );
  };

  private legacyCopy(text: string): boolean {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;-webkit-user-select:text;user-select:text";
    document.body.appendChild(t);
    t.focus(); t.select(); t.setSelectionRange(0, t.value.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    t.remove();
    if (this.kbOpen) this.kbInput.focus({ preventScroll: true });
    return ok;
  }

  private async writeClip(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through to legacy */ }
    return this.legacyCopy(text);
  }

  pasteFromPhone = async () => {
    let text = "";
    try {
      if (!navigator.clipboard?.readText) throw new Error("no clipboard api");
      text = await navigator.clipboard.readText();
    } catch {
      if (this.lastRemoteClip) {
        // fallback: paste the last text the PC copied over the wire
        text = this.lastRemoteClip;
      } else {
        this.toast("Clipboard blocked here. Use your keyboard's clipboard key.");
        if (!this.kbOpen) this.openKb();
        return;
      }
    }
    if (!text) {
      if (this.lastRemoteClip) text = this.lastRemoteClip;
      else { this.toast("Clipboard is empty"); return; }
    }
    this.sink.paste(text);
    this.toast("Pasted to computer");
  };

  /* ---------- hidden mobile keyboard ---------- */

  private openKb() {
    this.h0 = window.innerHeight;
    this.kbSeen = false;
    this.kbOpen = true;
    document.querySelectorAll(".kb").forEach((b) => b.classList.add("on"));
    this.kbInput.style.pointerEvents = "auto";
    this.kbInput.focus({ preventScroll: true });
  }

  private closeKb() {
    this.kbOpen = false;
    this.kbInput.blur();
    this.kbInput.style.pointerEvents = "none";
    document.querySelectorAll(".kb").forEach((b) => b.classList.remove("on"));
    this.kbInput.value = "";
    this.prev = "";
    window.setTimeout(() => this.fit(), 300);
  }

  private kbHeight(): number {
    const nav = navigator as Navigator & { virtualKeyboard?: { boundingRect: { height: number } } };
    const vk = nav.virtualKeyboard ? nav.virtualKeyboard.boundingRect.height : 0;
    const vv = window.visualViewport ? Math.max(0, this.h0 - window.visualViewport.height - window.visualViewport.offsetTop) : 0;
    return Math.max(vk, vv, this.h0 - window.innerHeight);
  }

  private checkKb = () => {
    if (!this.kbOpen) return;
    if (this.kbHeight() > 120) this.kbSeen = true;
    else if (this.kbSeen) this.closeKb();
  };

  private bindKb(btn: HTMLButtonElement) {
    let hold = 0, long = false;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      long = false;
      window.clearTimeout(hold);
      hold = window.setTimeout(() => { long = true; void this.pasteFromPhone(); }, LONG_PRESS_MS);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => btn.addEventListener(ev, () => window.clearTimeout(hold)));
    btn.addEventListener("click", () => {
      if (long) { long = false; return; }
      this.kbOpen ? this.closeKb() : this.openKb();
    });
  }

  private onKbInput = () => {
    const cur = this.kbInput.value;
    let i = 0;
    while (i < this.prev.length && i < cur.length && this.prev[i] === cur[i]) i++;
    for (let k = 0; k < this.prev.length - i; k++) {
      this.sink.key("Backspace", "backspace", true, { ctrl: false, alt: false, shift: false, meta: false });
      this.sink.key("Backspace", "backspace", false, { ctrl: false, alt: false, shift: false, meta: false });
    }
    const add = cur.slice(i);
    if (add) this.sink.text(add);
    this.prev = cur;
  };

  private onKbKeydown = (e: KeyboardEvent) => {
    const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
    const k = e.key.toLowerCase();
    if (e.key === "Enter") {
      e.preventDefault();
      this.sink.key("Enter", "enter", true, mods);
      this.sink.key("Enter", "enter", false, mods);
      this.kbInput.value = "";
      this.prev = "";
      return;
    }
    // Backspace (plain or word-delete) is delivered through the input-diff — never double it up here
    if (e.code === "Backspace") return;
    // Ctrl/Cmd+V without Alt: let the native paste event fire so we can mirror the phone clipboard
    const cmd = e.ctrlKey || e.metaKey || e.altKey;
    if (cmd && k === "v" && !e.altKey) return;
    const isFKey = /^F([1-9]|1[0-2])$/.test(e.code);
    const FUNCTIONAL = new Set([
      "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      "Home", "End", "Delete", "PageUp", "PageDown", "Insert",
    ]);
    // pure functional keys (Tab/arrows/…) are forwarded with preventDefault, so the input never
    // mutates and the diff stays silent — the host is the single editor of those keys.
    // Ctrl/Alt/Meta + single letter/digit shortcuts go straight to the host.
    let forward = isFKey || FUNCTIONAL.has(e.code);
    if (cmd && /^[a-z0-9]$/.test(k) && k !== "v") forward = true;
    if (forward) {
      e.preventDefault();
      this.sink.key(e.code, k, true, mods);
      this.sink.key(e.code, k, false, mods);
    }
  };

  private onKbPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    e.preventDefault();
    if (text) this.sink.paste(text);
  };

  private onKbBlur = () => {
    if (this.kbOpen) window.setTimeout(() => { if (document.activeElement !== this.kbInput) this.closeKb(); }, 200);
  };

  /* ---------- fullscreen / FLIP ---------- */

  private target() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!this.land) {
      const w = Math.min(vw - 16, (vh - 16) * this.ar), h = w / this.ar;
      return { left: (vw - w) / 2, top: (vh - h) / 2, w, h, rot: 0 };
    }
    // land = fullscreen fill: screen element covers the viewport; the 16:9 video is letterboxed inside it.
    // Cursor/click/drag mapping uses the video content rect (see contentRect) so coordinates stay 1:1.
    return { left: 0, top: 0, w: vw, h: vh, rot: 0 };
  }

  private stateOfRect(r: DOMRect) {
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, rot: 0 };
  }

  private stateOfT(t: { left: number; top: number; w: number; h: number; rot: number }) {
    return { cx: t.left + t.w / 2, cy: t.top + t.h / 2, w: t.w, h: t.h, rot: t.rot };
  }

  private place(t: { left: number; top: number; w: number; h: number; rot: number }) {
    const s = this.screenEl.style;
    s.position = "fixed"; s.right = "auto"; s.bottom = "auto";
    s.left = t.left + "px"; s.top = t.top + "px"; s.width = t.w + "px"; s.height = t.h + "px";
    s.transform = `rotate(${t.rot}deg)`;
    this.SW = t.w; this.SH = t.h;
    const h = this.shade.style;
    h.left = s.left; h.top = s.top; h.width = s.width; h.height = s.height;
    h.transform = s.transform; h.opacity = this.land ? "0" : "1";
  }

  private flip(L: { cx: number; cy: number; w: number; h: number; rot: number }, from: typeof L, done?: () => void, ms?: number, o0?: number, o1?: number) {
    const kw = (s: typeof L) => `translate(${(s.cx - L.cx).toFixed(2)}px,${(s.cy - L.cy).toFixed(2)}px) rotate(${s.rot}deg) scale(${(s.w / L.w).toFixed(4)},${(s.h / L.h).toFixed(4)})`;
    if (o0 == null) { o0 = o1 = +this.shade.style.opacity || 0; }
    const opt: KeyframeAnimationOptions = { duration: ms ?? ANIM_MS, easing: "cubic-bezier(.32,.72,.25,1)", fill: "forwards" };
    this.anim = this.screenEl.animate([{ transform: kw(from) }, { transform: kw(L) }], opt);
    const sa = this.shade.animate([{ transform: kw(from), opacity: o0 }, { transform: kw(L), opacity: o1 }], opt);
    this.anim.onfinish = () => {
      const a = this.anim!;
      this.anim = null;
      if (done) done();
      a.cancel(); sa.cancel();
      if (this.pend) { this.pend = false; if (this.full) this.applyTarget(); }
    };
  }

  private applyTarget = () => {
    if (this.anim) { this.pend = true; return; }
    const t = this.target(), L = this.stateOfT(t), from = this.cur;
    this.place(t); this.cur = L;
    if (from && !this.busy && (Math.abs(from.cx - L.cx) > 1 || Math.abs(from.cy - L.cy) > 1 || Math.abs(from.w - L.w) > 1 || Math.abs(from.h - L.h) > 1))
      this.flip(L, from, undefined, 240, L.rot ? 0 : 1, L.rot ? 0 : 1);
  };

  private fsRoot = document.documentElement;
  private inFs = () => !!(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);

  private async enterBrowserFs() {
    // touch mode: NEVER trigger the browser's real fullscreen. Android Chrome eats taps in
    // fullscreen (shows/hides its own chrome on tap and swallows double-taps), which broke
    // every gesture for the video. The CSS-only "land fullscreen" (.screen.full + body.land)
    // fills the viewport exactly the same and leaves the tap pipeline intact.
    if (this.mode === "touch") return;
    try {
      if (this.inFs()) return;
      const f = this.fsRoot.requestFullscreen || (this.fsRoot as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen;
      if (f) {
        await f.call(this.fsRoot);
        try { (navigator as Navigator & { keyboard?: { lock?: (k: string[]) => Promise<void> } }).keyboard?.lock?.(["Escape"]); } catch { /* optional */ }
        await wait(150);
      }
    } catch { /* browser refused — landscape via CSS rotate still works */ }
  }

  private async exitBrowserFs() {
    if (this.mode === "touch") return; // touch never enters browser fullscreen — nothing to exit
    try {
      if (!this.inFs()) return;
      const f = document.exitFullscreen || (document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen;
      if (f) { await f.call(document); await wait(150); }
    } catch { /* ignore */ }
  }

  openFull() {
    if (this.full || this.anim || this.busy) return;
    const from = this.stateOfRect(this.screenEl.getBoundingClientRect());
    const t = this.target(), L = this.stateOfT(t);
    this.full = true; this.land = false;
    document.body.classList.remove("land");
    this.place(t);
    this.screenEl.classList.add("full");
    this.backdrop.classList.add("show");
    this.cur = L;
    this.opts.onExpandChange?.(true);
    this.flip(L, from, undefined, undefined, 0, 1);
  }

  closeFull() {
    if (!this.full || this.anim || this.busy) return;
    const wrap = this.wrap.getBoundingClientRect();
    const from = this.cur!;
    this.land = false;
    document.body.classList.remove("land");
    this.screenEl.classList.remove("land");
    this.backdrop.classList.remove("show");
    // shade starts at its CURRENT opacity (0 in land, 1 in focus) — never resurrects a hidden shade
    const so = +(this.shade.style.opacity || 0);
    // REAL FLIP: park the element at its FINAL (small) rect first, then animate from the OLD visual
    // state back to identity — the screen never jumps, it glides home (no layout snap, no "drop")
    const t = { left: wrap.left, top: wrap.top, w: wrap.width, h: wrap.height, rot: 0 };
    const L = this.stateOfT(t);
    this.place(t);
    this.cur = L;
    this.shade.style.opacity = String(so); // keep it hidden until the fade-out animation runs
    this.flip(L, from, () => {
      this.full = false;
      this.screenEl.classList.remove("full");
      const s = this.screenEl.style;
      s.position = s.left = s.top = s.width = s.height = s.right = s.bottom = s.transform = "";
      this.cur = null;
      this.measure();
      this.shade.style.cssText = "";
      this.opts.onExpandChange?.(false);
      void this.exitBrowserFs();
    }, undefined, so, 0);
  }

  async rotateFull() {
    if (!this.full || this.anim || this.busy) return;
    if (this.land) {
      if (this.kbOpen) this.closeKb();
      const back = this.cur!;
      this.land = false;
      document.body.classList.remove("land");
      this.screenEl.classList.remove("land");
      const tb = this.target(), Lb = this.stateOfT(tb);
      this.place(tb); this.cur = Lb;
      this.flip(Lb, back, () => void this.exitBrowserFs(), undefined, 0, 1);
      return;
    }
    this.busy = true;
    await this.enterBrowserFs();
    const from = this.stateOfT(this.target());
    this.land = true;
    document.body.classList.add("land");
    this.screenEl.classList.toggle("land", true);
    const t = this.target(), L = this.stateOfT(t);
    this.place(t); this.cur = L;
    this.busy = false;
    this.flip(L, from, undefined, undefined, 1, 0);
  }

  // fullscreenchange → if we left fullscreen while in landscape, rotate back to portrait focus
  onFullscreenChange = () => {
    if (this.mode === "touch") return; // touch never exits via browser FS gestures — only the X button closes land
    if (!this.inFs() && this.land && !this.busy && !this.anim) void this.rotateFull();
  };
}




