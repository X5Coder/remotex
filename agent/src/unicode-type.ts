/**
 * Keyboard-level typing (Windows) — types exactly like a REAL physical keyboard.
 *
 * Per character, in order:
 *   1. \\n / \\r            -> physical Enter
 *   2. \\t                 -> physical Tab
 *   3. VkKeyScanExW against the ACTIVE keyboard layout of the foreground window
 *      → a genuine hardware keystroke sequence (Shift/Ctrl/Alt held as appropriate).
 *      Byte-perfect for ANY layout (EN QWERTY, Arabic 101, Russian, Greek, ...),
 *      and reacts to the user toggling the layout on the host with Alt+Shift —
 *      exactly like a real keyboard would.
 *   4. Fallback: KEYEVENTF_UNICODE (wVk = 0) — exact code unit. Sent in a DEDICATED
 *      SendInput call per character (Arabic TIS corrupts big batches).
 *
 * NO clipboard, NO paste — the OS input queue treats every event as hardware input.
 * NOT tied to the agent's layout: the layout is re-read from the foreground thread
 * for every batch.
 *
 * Pacing: every code unit is flushed in its OWN SendInput with ~8 ms between units,
 * because Windows' input queue (and Arabic TIS especially) silently drops the tail
 * of a synchronous burst. Async, so the caller's event loop stays responsive.
 *
 * This module deliberately does NOT import Electron / robotjs so the built output
 * can be required from plain Node for diagnostics.
 */

const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;
const INPUT_KEYBOARD = 1;
const VK_RETURN = 0x0d;
const VK_TAB = 0x09;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12; // Alt

export interface UnicodeTypeResult {
  ok: boolean;
  /** UTF-16 code units handled (physical table or unicode fallback) */
  units: number;
  /** true when the whole batch went through the physical-key path (no unicode fallback used) */
  physical?: boolean;
  error?: string;
}

interface KoffiStruct {
  [k: string]: unknown;
}
type KoffiFunc = (...a: unknown[]) => number;
interface KoffiLib {
  func(name: string, ret: string, args: unknown[]): KoffiFunc;
  struct(name: string, fields: Record<string, unknown>): unknown;
  union(name: string, members: Record<string, unknown>): unknown;
  pointer(t: unknown): unknown;
  sizeof(t: unknown): number;
}
interface KoffiModule extends KoffiLib {
  load(name: string): KoffiLib;
}

let lib: KoffiLib | null = null;
let fgw: KoffiFunc | null = null;
let threadOf: KoffiFunc | null = null;
let layoutOfThread: KoffiFunc | null = null;
let vkKeyScanEx: KoffiFunc | null = null;
let sendInput: KoffiFunc | null = null;
let inputType: unknown = null;
let sizeofINPUT = 0;
let initialized = false;
let loadError: string | null = null;

function init(): void {
  if (initialized) return;
  initialized = true;
  if (process.platform !== "win32") {
    loadError = "keyboard-level typing is Windows-only";
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as KoffiModule;
    const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
      dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr",
    });
    const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
      wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr",
    });
    const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", {
      uMsg: "uint32", wParamL: "uint16", wParamH: "uint16",
    });
    const INPUT_UNION = koffi.union("INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
    inputType = koffi.struct("INPUT", { type: "uint32", u: INPUT_UNION });
    sizeofINPUT = koffi.sizeof(inputType);
    if (sizeofINPUT !== 40) throw new Error(`sizeof(INPUT) = ${sizeofINPUT}, expected 40 (x64 INPUT layout)`);
    const user32 = koffi.load("user32.dll");
    lib = user32;
    fgw = user32.func("GetForegroundWindow", "uintptr", []);
    threadOf = user32.func("GetWindowThreadProcessId", "uint32", ["uintptr", "uintptr*"]);
    layoutOfThread = user32.func("GetKeyboardLayout", "uint32", ["uint32"]);
    vkKeyScanEx = user32.func("VkKeyScanExW", "int16", ["uint16", "uint32"]);
    sendInput = user32.func("SendInput", "uint32", ["uint32", koffi.pointer(INPUT_STRUCT(inputType)), "int32"]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    lib = null;
  }
}

// helper to satisfy TS strictness when passing the opaque INPUT struct value around
function INPUT_STRUCT(t: unknown): unknown { return t; }

const ev = (vk: number, scan: number, flags: number): KoffiStruct =>
  ({ type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
const vkDown = (vk: number) => ev(vk, 0, 0);
const vkUp = (vk: number) => ev(vk, 0, KEYEVENTF_KEYUP);
const uniDown = (unit: number) => ev(0, unit, KEYEVENTF_UNICODE);
const uniUp = (unit: number) => ev(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);

function activeLayout(): number {
  try {
    const hwnd = fgw!();
    const tid = threadOf!(hwnd, null);
    return layoutOfThread!(tid >>> 0) >>> 0;
  } catch {
    return 0x0409; // fall back to en-US if the query fails
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function send(events: KoffiStruct[]): { ok: boolean; error?: string } {
  try {
    const sent = sendInput!(events.length, events, sizeofINPUT);
    return sent === events.length ? { ok: true } : { ok: false, error: `SendInput delivered ${sent}/${events.length} events` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Inject `text` as hardware-grade keyboard input into the foreground window.
 * Returns per-batch diagnostics; `ok=false` means SendInput starved/rejected events.
 */
export async function unicodeType(text: string): Promise<UnicodeTypeResult> {
  init();
  if (!lib || !sendInput) return { ok: false, units: 0, error: loadError ?? "SendInput unavailable" };
  if (!text) return { ok: true, units: 0, physical: true };
  const hkl = activeLayout();
  let fellBackToUnicode = 0;
  let failed = 0;
  let sendErr: string | undefined;

  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0x0a || unit === 0x0d) {
      const r = send([vkDown(VK_RETURN), vkUp(VK_RETURN)]);
      if (!r.ok) { failed++; sendErr = sendErr ?? r.error; }
      await sleep(8);
      continue;
    }
    if (unit === 0x09) {
      const r = send([vkDown(VK_TAB), vkUp(VK_TAB)]);
      if (!r.ok) { failed++; sendErr = sendErr ?? r.error; }
      await sleep(8);
      continue;
    }
    // surrogate pair: both halves go through unicode fallback
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        fellBackToUnicode += 2;
        // one call PER code unit — Arabic TIS corrupts multi-unit unicode batches
        let r = send([uniDown(unit), uniUp(unit)]);
        if (!r.ok) { failed++; sendErr = sendErr ?? r.error; }
        r = send([uniDown(lo), uniUp(lo)]);
        if (!r.ok) { failed++; sendErr = sendErr ?? r.error; }
        i++;
        await sleep(8);
        continue;
      }
    }
    const r = vkKeyScanEx!(unit, hkl);
    if (r === -1) {
      fellBackToUnicode++;
      const rr = send([uniDown(unit), uniUp(unit)]);
      if (!rr.ok) { failed++; sendErr = sendErr ?? rr.error; }
      await sleep(8);
      continue;
    }
    const mods = (r >> 8) & 0xff;
    const vk = r & 0xff;
    const modDowns: number[] = [];
    if (mods & 2) modDowns.push(VK_CONTROL);
    if (mods & 4) modDowns.push(VK_MENU);
    if (mods & 1) modDowns.push(VK_SHIFT);
    const seq: KoffiStruct[] = [];
    for (const m of modDowns) seq.push(vkDown(m));
    seq.push(vkDown(vk), vkUp(vk));
    for (let j = modDowns.length - 1; j >= 0; j--) seq.push(vkUp(modDowns[j]!));
    const rr = send(seq);
    if (!rr.ok) { failed++; sendErr = sendErr ?? rr.error; }
    await sleep(8);
  }

  if (failed) return { ok: false, units: text.length, physical: fellBackToUnicode === 0, error: sendErr ?? `${failed} character(s) rejected` };
  return { ok: true, units: text.length, physical: fellBackToUnicode === 0 };
}

/** For startup diagnostics — null when the path is available. */
export function unicodeTypeError(): string | null {
  init();
  return loadError;
}

/** Diagnostics: active layout HKL of the foreground thread (0x0409 == en-US, 0x0401 == ar). */
export function activeKeyboardLayout(): number {
  init();
  return activeLayout();
}
