/**
 * Host cursor restore (Windows) — SetSystemCursor(IDC_ARROW, OCR_NORMAL) with fresh handles only.
 *
 * The host machine's OS arrow is ALWAYS VISIBLE on the host PC. It is never swapped or hidden
 * by this build — the remote (web) client draws its own overlay arrow, and that overlay is the
 * ONLY cursor the user sees on the remote display.
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

/**
 * Hide the host arrow system-wide while a remote session is active.
 * The web client draws the ONLY cursor (its overlay follows the local pointer 1:1) —
 * a host arrow baked into the capture just fights it and makes both flicker.
 * Uses CreateCursor with a fully-transparent (AND=0xFF) plane so any app keeps
 * working; restore with ensureHostCursorVisible() at peer-leave/quit.
 */
export function hideHostCursor(): boolean {
  init();
  if (!user32) return false;
  try {
    const CreateCursor = user32.func("CreateCursor", "uintptr", [
      "uintptr", // hInst (NULL)
      "int32",   // xHotSpot
      "int32",   // yHotSpot
      "int32",   // nWidth
      "int32",   // nHeight
      "void*",   // pvANDPlane
      "void*",   // pvXORPlane
    ]);
    const andPlane = Buffer.alloc(32 * 32 / 8, 0xff); // AND mask 1 everywhere = fully transparent
    const xorPlane = Buffer.alloc(32 * 32 / 8, 0x00);
    const h = CreateCursor(0, 0, 0, 32, 32, andPlane, xorPlane) as unknown as number;
    if (!h) return false;
    const SetSystemCursor = user32.func("SetSystemCursor", "int32", ["uintptr", "uint32"]);
    return SetSystemCursor(h, OCR_NORMAL) !== 0;
  } catch (err) {
    console.error("[cursor] hide failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Diagnostics — null when the Win32 path is available. */
export function hostCursorError(): string | null {
  init();
  return loadError;
}
