/**
 * Host cursor restore (Windows) — SetSystemCursor(IDC_ARROW, OCR_NORMAL) with fresh handles only.
 *
 * The host machine's OS arrow is ALWAYS VISIBLE on the host PC. It is never swapped or hidden
 * by this build — the remote (web) client draws its own overlay arrow on top of the video.
 *
 * This module only provides a belt-and-braces at agent startup/exit: if for ANY reason the
 * system arrow ever ends up in a broken state (e.g. the agent was killed without cleanup),
 * the arrow is re-asserted from fresh handles (never the stale ones the system destroys).
 *
 * This module deliberately does NOT import Electron so the built output can be
 * required from plain Node for diagnostics.
 */

const OCR_NORMAL = 32512; // OCR_NORMAL == IDC_ARROW resource ordinal

let user32: { func(name: string, ret: string, args: unknown[]): (...a: unknown[]) => number } | null = null;
let loadError: string | null = null;
let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;
  if (process.platform !== "win32") {
    loadError = "host cursor restore is Windows-only";
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as { load(name: string): { func(name: string, ret: string, args: unknown[]): (...a: unknown[]) => number } };
    user32 = koffi.load("user32.dll");
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    user32 = null;
  }
}

function loadCurrentArrow(): number {
  if (!user32) return 0;
  try {
    // 1) the machine's own registered arrow (HKCU\Control Panel\Cursors\Arrow) — visible, user-chosen
    const encoded = Buffer.from(
      "(Get-ItemProperty -Path 'HKCU:\\Control Panel\\Cursors' -Name Arrow -ErrorAction SilentlyContinue).Arrow",
      "utf16le"
    ).toString("base64");
    const out = String(require("child_process").execSync(
      "powershell -NoProfile -EncodedCommand " + encoded,
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    ).trim());
    if (out && require("fs").existsSync(out)) {
      const h = user32.func("LoadCursorFromFileW", "uintptr", ["str16"])(out) as unknown as number;
      if (h) return h;
    }
  } catch { /* fall through to the stock aero arrow */ }
  try {
    // 2) stock aero arrow, which is always present on modern Windows
    const stock = (process.env.SystemRoot ?? "C:\\Windows") + "\\Cursors\\aero_arrow.cur";
    if (require("fs").existsSync(stock)) {
      const h = user32.func("LoadCursorFromFileW", "uintptr", ["str16"])(stock) as unknown as number;
      if (h) return h;
    }
  } catch { /* fall through to IDC_ARROW */ }
  try {
    // 3) built-in IDC_ARROW
    const LoadCursorW = user32.func("LoadCursorW", "uintptr", ["uintptr", "uintptr"]);
    return LoadCursorW(0, 32512) as unknown as number;
  } catch {
    return 0;
  }
}

/** Re-assert the machine's system arrow (call at agent startup and at exit — a crash can never leave the machine cursorless). */
export function ensureHostCursorVisible(): void {
  init();
  if (!user32) return;
  const handle = loadCurrentArrow();
  if (!handle) return;
  const SetSystemCursor = user32.func("SetSystemCursor", "int32", ["uintptr", "uint32"]);
  // fresh handle on every call — the system destroys the cursor after SetSystemCursor takes it
  if (SetSystemCursor(handle, OCR_NORMAL) !== 0) return;
  SetSystemCursor(loadCurrentArrow(), OCR_NORMAL); // one retry with a fresh load
}

/** Diagnostics — null when the Win32 path is available. */
export function hostCursorError(): string | null {
  init();
  return loadError;
}
