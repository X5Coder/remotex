/**
 * RemoteX web client — bootstrap & screen orchestration.
 * Connect screen ⇄ Remote surface. One session at a time.
 */
import { RemoteSurface } from "./remote";
import { ConnectController } from "./connect";
import { Session, TURN_STORE_KEY, parseTurnFragment } from "./session";
import { initPrefs } from "./prefs";

const $ = (id: string) => document.getElementById(id)!;

const appEl = $("app");
const dockEl = $("dock");
const toastEl = $("toast");

initPrefs();

/* ---------- keep the focused field visible above the on-screen keyboard ---------- */
const keepFieldVisible = () => {
  const el = document.activeElement as HTMLElement | null;
  if (el && el.tagName === "INPUT") {
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* old browsers */ }
  }
};
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", keepFieldVisible);
  window.visualViewport.addEventListener("scroll", keepFieldVisible);
}
window.addEventListener("focusin", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.tagName === "INPUT") window.setTimeout(keepFieldVisible, 280);
});

let remote: RemoteSurface | null = null;
let session: Session | null = null;
let pendingStream: MediaStream | null = null;
let wakeLock: { release: () => Promise<void> } | null = null;
let inRemote = false;

const connect = new ConnectController((roomId, password) => startSession(roomId, password));

/* ---------- soft entrance for the connect card (transform only) ---------- */
(() => {
  const card = document.querySelector("#connectScreen .connectCard");
  if (!card) return;
  try {
    (card as HTMLElement).animate(
      [{ opacity: 0, transform: "translateY(18px) scale(.97)" }, { opacity: 1, transform: "none" }],
      { duration: 480, easing: "cubic-bezier(.32,.72,.25,1)" }
    );
  } catch { /* older browsers — static card is fine */ }
})();

/* ---------- hardware/browser Back → return to the connect screen (don't exit the site) ---------- */
try { history.replaceState({ screen: "connect" }, "", location.href); } catch { /* private mode */ }
let skipPop = false;
window.addEventListener("popstate", () => {
  if (!inRemote) return;
  skipPop = true;
  leaveRemote(); // back to the connect screen — the entry we pushed is consumed by the browser
});

/* ---------- toast ---------- */
let toastT = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => toastEl.classList.remove("show"), 4000);
}

/* ---------- one-time setup link from the RemoteX window (#turn=…) ----------
   The fragment never leaves this device — it is not part of any HTTP request —
   and we strip it from the URL as soon as it is read. Storing the relay
   credential in localStorage makes it apply to every future session on THIS
   browser only (private and public devices each need the one-time link). */
(() => {
  try {
    const m = /(?:^|[#&])turn=([A-Za-z0-9_-]+)/.exec(location.hash || "");
    if (!m) return;
    const cfg = parseTurnFragment(m[1]!);
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* private mode */ }
    if (!cfg) { toast("That setup link is invalid — copy it again from the RemoteX window."); return; }
    try {
      localStorage.setItem(TURN_STORE_KEY, JSON.stringify(cfg));
    } catch {
      toast("Could not save the relay on this device.");
      return;
    }
    toast("Remote access enabled on this device — works from any network.");
  } catch { /* malformed link — nothing to apply */ }
})();

/* ---------- screen wake lock ---------- */
async function requestWakeLock() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void>; addEventListener?: (t: string, cb: () => void) => void }> } };
    const wl = (await nav.wakeLock?.request("screen")) ?? null;
    wakeLock = wl;
    wl?.addEventListener?.("release", () => { wakeLock = null; });
  } catch { /* not supported / denied — session still works, screen may dim */ }
}
function releaseWakeLock() {
  const wl = wakeLock;
  wakeLock = null;
  wl?.release().catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && inRemote) void requestWakeLock();
});

/* ---------- session lifecycle ---------- */
function startSession(roomId: string, password: string) {
  connect.setBusy(true);

  const s = new Session({
    roomId,
    password,
    cb: {
      onPhase(phase, reason) {
        if (phase === "connected") {
          enterRemote();
        } else if (phase === "failed" || phase === "closed") {
          const why = reason ?? "Connection failed.";
          if (inRemote) {
            toast(why);
            leaveRemote();
          } else {
            connect.setBusy(false);
            toast(why);
          }
        }
      },
      onStream(stream) {
        // The stream can arrive BEFORE the remote surface is constructed — queue it
        // instead of silently dropping the video track (this was the black-screen bug).
        if (remote) remote.setStream(stream);
        else pendingStream = stream;
      },

      onRtt(_ms) { /* overlay removed — RTT kept internal for the adaptive bitrate ladder */ },
      onHello(hello) {
        toast("Connected");
        remote?.setCursor(hello.cursor.x, hello.cursor.y); // sync phone cursor to the host cursor immediately
      },
      onClipboard(text) {
        void remote?.handleRemoteClipboard(text);
      },
      onVersionMismatch() {
        toast("Update the agent — version mismatch");
      },
    },
  });
  session = s;
  s.start();
}

function enterRemote() {
  if (inRemote) return; // silent recovery re-dial fires "connected" again here — keep the existing surface
  inRemote = true;
  // one Back gesture returns to the connect screen instead of leaving the site
  try { history.pushState({ screen: "remote" }, "", location.href); } catch { /* private mode */ }
  // fade the connect screen out first — hide it only when the fade has finished (inline styles are reset so show() works next time)
  const cs = document.getElementById("connectScreen")!;
  cs.animate(
    [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.96)" }],
    { duration: 220, easing: "cubic-bezier(.32,.72,.25,1)" }
  ).onfinish = () => {
    if (inRemote) connect.hide();
    cs.style.opacity = "";
    cs.style.transform = "";
  };
  appEl.hidden = false;
  appEl.animate(
    [{ opacity: 0, transform: "scale(.97) translateY(12px)" }, { opacity: 1, transform: "scale(1) translateY(0)" }],
    { duration: 380, easing: "cubic-bezier(.32,.72,.25,1)" }
  );
  remote = new RemoteSurface({ sink: session! });
  const queued = pendingStream;
  if (queued) {
    remote.setStream(queued);
    pendingStream = null;
  }
  session!.setStaleFrameProbe(() => !!remote?.framesFlowing());
  let lastAutoRecover = 0;
  let lastStaleToast = 0;
  remote.setStaleHandler(() => {
    // at most ONE silent re-dial per 5 minutes; always say plainly what's wrong
    const now = Date.now();
    if (now - lastStaleToast > 4000) {
      lastStaleToast = now;
      toast("No video from the computer — make sure RemoteX is running and capture isn't blocked");
    }
    if (now - lastAutoRecover > 5 * 60 * 1000) {
      lastAutoRecover = now;
      void session?.silentRecover();
    }
  });
  dockEl.hidden = remote.device !== "tablet";
  session!.setCursorCorrector((x, y) => remote?.setCursor(x, y));
  remote.attach();
  remote.autoEnterFullscreen(); // touch: the site itself jumps straight into fullscreen — exits only via the X button
  void requestWakeLock();
}

function leaveRemote() {
  inRemote = false;
  const s = session;
  session = null;
  // Back means goodbye — actually close the room so the agent sees the leave (status flips to waiting)
  if (s) void s.stop();
  // if WE pushed the remote history entry (not the user's Back gesture), pop it without triggering a loop
  const pushed = !skipPop && history.state?.screen === "remote";
  skipPop = false;
  if (pushed) {
    try { history.back(); } catch { /* private mode */ } // back to the connect entry
  }
  releaseWakeLock();
  remote?.setStream(null);
  remote?.detach();
  remote = null;
  appEl.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.97) translateY(12px)" }],
    { duration: 240, easing: "cubic-bezier(.32,.72,.25,1)" }
  ).onfinish = () => { if (!inRemote) appEl.hidden = true; };
  dockEl.hidden = true;
  connect.show();
  // fade the connect screen back in after it is shown again
  const cs = document.getElementById("connectScreen")!;
  cs.animate(
    [{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "scale(1)" }],
    { duration: 380, easing: "cubic-bezier(.32,.72,.25,1)" }
  );
  connect.reset();
}

// no floating disconnect button on the video — end the session from the RemoteX window's "Terminate" button
document.addEventListener("fullscreenchange", () => remote?.onFullscreenChange());
document.addEventListener("webkitfullscreenchange", () => remote?.onFullscreenChange());
