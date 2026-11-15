/**
 * InputDriver — abstraction over the injected OS input backend.
 *
 * v1 backend: @jitsi/robotjs (MIT). If the native module is unavailable
 * (not built, wrong arch, Wayland), a degraded no-op driver is used and the
 * agent reports "input unavailable" instead of crashing.
 *
 * Absolute mapping: normalized 0..1 → primary display pixels.
 * DPI/multi-monitor handling is Step 5 territory (see master.md §6); the
 * math is isolated here so it can be swapped for display-offset/DPI logic.
 */
import { clipboard } from "electron";
import * as crypto from "crypto";

export interface DriverInfo {
  name: string;
  available: boolean;
  detail: string;
}

export interface InputDriver {
  info(): DriverInfo;
  /** normalized 0..1 of the primary display */
  move(x: number, y: number): void;
  /** move then press (down/up cycle) — click semantics; button 'middle'|'left'|'right' */
  click(button: "left" | "middle" | "right", double?: boolean): void;
  buttonDown(button: "left" | "middle" | "right"): void;
  buttonUp(button: "left" | "middle" | "right"): void;
  /** physical code/key press edge — modifiers as given */
  key(code: string, key: string, down: boolean, mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): void;
  /** insert plain text (ASCII via typeString, anything else via clipboard+paste) */
  typeText(text: string): void;
  /** paste arbitrary unicode text via clipboard (saves & restores) */
  pasteText(text: string): Promise<void>;
  /** current cursor in absolute pixels of the primary display */
  cursorPosition(): { x: number; y: number };
  /** primary display size in pixels */
  screenSize(): { width: number; height: number };
  /** clear all held modifiers/buttons — call when a session ends */
  reset(): void;
}

const BTN_MAP = { left: "left", middle: "middle", right: "right" } as const;

/** Physical KeyboardEvent.code → robotjs key name */
const CODE_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i); // A..Z
    m[`Key${ch}`] = ch.toLowerCase();
  }
  for (let i = 0; i <= 9; i++) m[`Digit${i}`] = String(i);
  for (let i = 1; i <= 12; i++) m[`F${i}`] = `f${i}`;
  Object.assign(m, {
    Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "escape", Space: "space",
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    Delete: "delete", Insert: "insert", Home: "home", End: "end",
    PageUp: "pageup", PageDown: "pagedown",
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
    CapsLock: "capslock", NumLock: "num_lock", ScrollLock: "scroll_lock",
    Numpad0: "num_pad0", Numpad1: "num_pad1", Numpad2: "num_pad2", Numpad3: "num_pad3",
    Numpad4: "num_pad4", Numpad5: "num_pad5", Numpad6: "num_pad6", Numpad7: "num_pad7",
    Numpad8: "num_pad8", Numpad9: "num_pad9", NumpadAdd: "num_add", NumpadSubtract: "num_subtract",
    NumpadDecimal: "num_decimal", NumpadEnter: "num_enter", NumpadMultiply: "num_multiply", NumpadDivide: "num_divide",
  });
  return m;
})();

const MOD_KEY = { ctrl: "control", alt: "alt", shift: "shift", meta: "command" } as const;
const MOD_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

export class RobotDriver implements InputDriver {
  private robot: any = null;
  private loadError: string | null = null;
  private heldMods = new Set<string>();
  private size: { width: number; height: number } = { width: 1, height: 1 };

  constructor(size: { width: number; height: number }) {
    this.size = size;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.robot = require("@jitsi/robotjs");
      // Use robotjs's OWN coordinate space — GetSystemMetrics + GetCursorPos + moveMouse all live in it,
      // so normalization is always consistent no matter which DPI awareness the process has.
      const rs = this.robot.getScreenSize?.();
      if (rs && rs.width > 0 && rs.height > 0) this.size = { width: rs.width, height: rs.height };
      this.robot.setMouseDelay(0);
      this.robot.setKeyboardDelay(0);
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  info(): DriverInfo {
    if (this.robot) return { name: "robotjs", available: true, detail: "@jitsi/robotjs loaded" };
    return { name: "unavailable", available: false, detail: this.loadError ?? "failed to load @jitsi/robotjs" };
  }

  private px(nx: number, ny: number) {
    const w = Math.max(1, this.size.width), h = Math.max(1, this.size.height);
    return { x: Math.round(clamp01(nx) * (w - 1)), y: Math.round(clamp01(ny) * (h - 1)) };
  }

  move(x: number, y: number) {
    if (!this.robot) return;
    const p = this.px(x, y);
    try { this.robot.moveMouse(p.x, p.y); } catch { /* swallowed — next command continues */ }
  }

  private toggle(btn: keyof typeof BTN_MAP, dir: "down" | "up") {
    try { this.robot?.mouseToggle(dir, BTN_MAP[btn]); } catch { /* ignore */ }
  }

  click(button: "left" | "middle" | "right", double = false) {
    if (!this.robot) return;
    const cycles = double ? 2 : 1;
    for (let i = 0; i < cycles; i++) {
      this.toggle(button, "down");
      this.toggle(button, "up");
      if (double && i === 0) this.sleep(60);
    }
  }

  buttonDown(button: "left" | "middle" | "right") { this.toggle(button, "down"); }
  buttonUp(button: "left" | "middle" | "right") { this.toggle(button, "up"); }

  private modsOf(mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): string[] {
    return MOD_ORDER.filter((k) => mods[k]).map((k) => MOD_KEY[k]);
  }

  key(code: string, key: string, down: boolean, mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }) {
    if (!this.robot) return;
    const keyName = CODE_KEY[code] ?? CODE_KEY[`Key${key.toUpperCase()}`] ?? (key.length === 1 ? key.toLowerCase() : key);
    const want = new Set(this.modsOf(mods));
    try {
      if (down) {
        // press newly-needed modifiers in order
        for (const m of this.modsOf(mods)) {
          if (!this.heldMods.has(m)) { this.robot.keyToggle(m, "down"); this.heldMods.add(m); }
        }
        this.robot.keyToggle(keyName, "down");
      } else {
        this.robot.keyToggle(keyName, "up");
        // release modifiers that are no longer wanted (reverse order)
        for (const m of [...this.heldMods].reverse()) {
          if (!want.has(m)) { try { this.robot.keyToggle(m, "up"); } catch { /* already up */ } this.heldMods.delete(m); }
        }
      }
    } catch (err) {
      console.error("[input] key failed:", code, err);
    }
  }

  typeText(text: string) {
    if (!this.robot) return;
    // non-ASCII → clipboard paste (Arabic, emoji) — never per-key typing
    if (!/^[\x20-\x7E\n\t]*$/.test(text)) { void this.pasteText(text); return; }
    try { this.robot.typeString(text); } catch (err) { console.error("[input] typeText failed:", err); }
  }

  async pasteText(text: string): Promise<void> {
    const saved = await safeClipboardRead();
    try {
      await clipboard.writeText(text);
    } catch (err) {
      console.error("[input] clipboard write failed:", err);
      return;
    }
    this.sleep(40);
    const isMac = process.platform === "darwin";
    const mod = isMac ? "command" : "control";
    try {
      this.robot?.keyToggle(mod, "down");
      this.robot?.keyToggle("v", "down");
      this.robot?.keyToggle("v", "up");
      this.robot?.keyToggle(mod, "up");
    } catch { /* best effort */ }
    // restore previous clipboard contents after the paste has been consumed
    setTimeout(() => {
      void (async () => {
        try { if (saved !== null) await clipboard.writeText(saved); } catch { /* clipboard busy */ }
      })();
    }, 400);
  }

  cursorPosition(): { x: number; y: number } {
    if (!this.robot) return { x: 0, y: 0 };
    try { return this.robot.getMousePos(); } catch { return { x: 0, y: 0 }; }
  }

  screenSize() { return { ...this.size }; }

  reset() {
    // release any modifiers we still hold so the host is not left in Ctrl/Alt state
    for (const m of [...this.heldMods].reverse()) {
      try { this.robot?.keyToggle(m, "up"); } catch { /* fine */ }
      this.heldMods.delete(m);
    }
    if (this.robot) {
      for (const btn of ["left", "middle", "right"] as const) {
        try { this.robot.mouseToggle("up", btn); } catch { /* fine */ }
      }
    }
  }

  private sleep(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin — short critical sections only */ }
  }
}

export class NullDriver implements InputDriver {
  private driverInfo: DriverInfo = { name: "unavailable", available: false, detail: "input backend failed to load" };
  info() { return this.driverInfo; }
  private noop() {}
  move = this.noop;
  click() {}
  buttonDown() {}
  buttonUp() {}
  key() {}
  typeText() {}
  async pasteText(): Promise<void> {}
  cursorPosition() { return { x: 0, y: 0 }; }
  screenSize() { return { width: 1, height: 1 }; }
  reset() {}
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

async function safeClipboardRead(): Promise<string | null> {
  try { return await clipboard.readText(); } catch { return null; }
}

export function createDriver(size: { width: number; height: number }): InputDriver {
  const d = new RobotDriver(size);
  return d.info().available ? d : new NullDriver();
}

/** Echo-guard hash for the PC→page clipboard sync. */
export function clipboardHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
