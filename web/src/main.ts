/**
 * RemoteX web client — bootstrap & screen orchestration.
 * Connect screen ⇄ Remote surface. One session at a time.
 */
import { RemoteSurface } from "./remote";
import { ConnectController } from "./connect";
import { Session } from "./session";

const $ = (id: string) => document.getElementById(id)!;

const appEl = $("app");
const dockEl = $("dock");
const toastEl = $("toast");

let remote: RemoteSurface | null = null;
let session: Session | null = null;
let wakeLock: { release: () => Promise<void> } | null = null;
let inRemote = false;

const connect = new ConnectController((roomId, password) => startSession(roomId, password));

/* ---------- toast ---------- */
let toastT = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => toastEl.classList.remove("show"), 4000);
}

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
        remote?.setStream(stream);
      },

      onRtt(_ms) { /* overlay removed — RTT kept internal for the adaptive bitrate ladder */ },
      onHello(hello) {
        toast(`Connected — ${hello.screen.width}×${hello.screen.height}`);
        remote?.setCursor(hello.cursor.x, hello.cursor.y); // sync phone cursor to the host cursor immediately
      },
      onClipboard(text) {
        void remote?.handleRemoteClipboard(text);
      },
      onVersionMismatch() {
        toast("Update the agent — protocol version mismatch");
      },
    },
  });
  session = s;
  s.start();
}

function enterRemote() {
  inRemote = true;
  connect.hide();
  appEl.hidden = false;
  remote = new RemoteSurface({ sink: session! });
  dockEl.hidden = remote.device !== "tablet";
  session!.setCursorCorrector((x, y) => remote?.setCursor(x, y));
  remote.attach();
  void requestWakeLock();
}

function leaveRemote() {
  inRemote = false;
  releaseWakeLock();
  session = null;
  remote?.setStream(null);
  remote?.detach();
  remote = null;
  appEl.hidden = true;
  dockEl.hidden = true;
  connect.show();
  connect.reset();
}

// no floating disconnect button on the video — end the session from the RemoteX window's "Stop session"
document.addEventListener("fullscreenchange", () => remote?.onFullscreenChange());
document.addEventListener("webkitfullscreenchange", () => remote?.onFullscreenChange());
