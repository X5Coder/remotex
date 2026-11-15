import { PROTOCOL_VERSION } from "./constants";

export type MouseButton = "left" | "middle" | "right";

export interface DisplayInfo {
  id: string | number;
  width: number;
  height: number;
  primary?: boolean;
}

export interface HelloMessage {
  kind: "hello";
  /** must equal PROTOCOL_VERSION or the client shows "update the agent" */
  version: number;
  /** primary screen size in physical pixels */
  screen: { width: number; height: number };
  displays: DisplayInfo[];
  /** true cursor position, normalized 0..1 of the primary screen */
  cursor: { x: number; y: number };
  platform: "windows" | "macos" | "linux" | string;
}

export interface PointerMessage {
  kind: "down" | "up" | "click" | "dblclick";
  button: MouseButton;
  /** normalized 0..1 — ALWAYS present; the agent moves first, then presses */
  x: number;
  y: number;
}

export interface KeyMessage {
  kind: "key";
  /** physical key code, e.g. "KeyA", "F5", "Enter" (KeyboardEvent.code) */
  code: string;
  /** logical key, e.g. "a", "Enter" */
  key: string;
  down: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface TextMessage {
  kind: "text";
  text: string;
}

export interface PasteMessage {
  kind: "paste";
  text: string;
}

export interface ClipboardMessage {
  kind: "clipboard";
  text: string;
}

export interface ByeMessage {
  kind: "bye";
}

/** Chunk frame for messages > 16 KB (see chunk.ts). */
export interface ChunkMessage {
  kind: "chunk";
  /** chunk group id (uuid) */
  id: string;
  index: number;
  total: number;
  /** base64 of this slice */
  data: string;
}

/** Hello/ack exchanged when a session starts (gate of master.md Step 7). */
export interface AckMessage {
  kind: "ack";
  ok: boolean;
  /** set when ok=false, e.g. "protocol-mismatch", "session-busy" */
  error?: string;
}

export type CtlMessage =
  | HelloMessage
  | AckMessage
  | PointerMessage
  | KeyMessage
  | TextMessage
  | PasteMessage
  | ClipboardMessage
  | ByeMessage
  | ChunkMessage;

const BUTTONS: readonly MouseButton[] = ["left", "middle", "right"];
const isButton = (v: unknown): v is MouseButton => typeof v === "string" && BUTTONS.includes(v as MouseButton);
const isNorm = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

const MAX_TEXT = 1024 * 1024; // 1 MB text cap (master.md §6 Step 6)

export function makeHello(msg: Omit<HelloMessage, "kind" | "version">): HelloMessage {
  return { kind: "hello", version: PROTOCOL_VERSION, ...msg };
}

/** Validate + decode a ctl JSON payload (string or pre-parsed object). Throws on invalid input. */
export function decodeCtl(input: string | unknown): CtlMessage {
  const msg: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (typeof msg !== "object" || msg === null) throw new Error("ctl: not an object");
  const m = msg as Record<string, unknown>;
  const kind = m.kind;

  switch (kind) {
    case "hello": {
      if (typeof m.version !== "number") throw new Error("hello.version must be a number");
      const scr = m.screen as Record<string, unknown> | undefined;
      if (!scr || typeof scr.width !== "number" || typeof scr.height !== "number")
        throw new Error("hello.screen must have numeric width/height");
      const displays = Array.isArray(m.displays) ? m.displays : [];
      for (const d of displays) {
        const dd = d as Record<string, unknown>;
        if (typeof dd.width !== "number" || typeof dd.height !== "number")
          throw new Error("hello.displays[] entries need numeric width/height");
      }
      const cur = (m.cursor ?? { x: 0.5, y: 0.5 }) as Record<string, unknown>;
      if (!isNorm(cur.x) || !isNorm(cur.y)) throw new Error("hello.cursor must be normalized 0..1");
      return {
        kind: "hello",
        version: m.version,
        screen: { width: Math.max(0, Math.floor(scr.width)), height: Math.max(0, Math.floor(scr.height)) },
        displays: displays.map((d) => {
          const dd = d as Record<string, unknown>;
          return { id: (dd.id as string | number) ?? "", width: dd.width as number, height: dd.height as number, primary: !!dd.primary };
        }),
        cursor: { x: cur.x, y: cur.y },
        platform: typeof m.platform === "string" ? m.platform : "unknown",
      };
    }
    case "ack":
      return { kind: "ack", ok: !!m.ok, ...(typeof m.error === "string" ? { error: m.error } : {}) };
    case "down":
    case "up":
    case "click":
    case "dblclick": {
      if (!isButton(m.button)) throw new Error(`${kind}.button must be left|middle|right`);
      if (!isNorm(m.x) || !isNorm(m.y)) throw new Error(`${kind}.x/y must be normalized 0..1`);
      return { kind, button: m.button, x: m.x, y: m.y };
    }
    case "key": {
      if (!isStr(m.code, 64) || !isStr(m.key, 64)) throw new Error("key.code/key must be short strings");
      if (!isBool(m.down) || !isBool(m.ctrl) || !isBool(m.alt) || !isBool(m.shift) || !isBool(m.meta))
        throw new Error("key.down/ctrl/alt/shift/meta must be booleans");
      return { kind: "key", code: m.code, key: m.key, down: m.down, ctrl: m.ctrl, alt: m.alt, shift: m.shift, meta: m.meta };
    }
    case "text":
      if (!isStr(m.text, MAX_TEXT)) throw new Error("text.text missing or too large");
      return { kind: "text", text: m.text };
    case "paste":
      if (!isStr(m.text, MAX_TEXT)) throw new Error("paste.text missing or too large");
      return { kind: "paste", text: m.text };
    case "clipboard":
      if (!isStr(m.text, MAX_TEXT)) throw new Error("clipboard.text missing or too large");
      return { kind: "clipboard", text: m.text };
    case "bye":
      return { kind: "bye" };
    case "chunk": {
      if (!isStr(m.id, 64)) throw new Error("chunk.id missing");
      if (typeof m.index !== "number" || typeof m.total !== "number") throw new Error("chunk.index/total must be numbers");
      if (typeof m.data !== "string") throw new Error("chunk.data must be base64");
      const index = Math.floor(m.index), total = Math.floor(m.total);
      if (total < 1 || index < 0 || index >= total || total > 1024) throw new Error("chunk.index/total out of range");
      return { kind: "chunk", id: m.id, index, total, data: m.data };
    }
    default:
      throw new Error(`unknown ctl kind: ${String(kind)}`);
  }
}

export function encodeCtl(msg: CtlMessage): string {
  return JSON.stringify(msg);
}

/** True when the peer must be asked to update: protocol major mismatch. */
export function isVersionMismatch(hello: HelloMessage): boolean {
  return hello.version !== PROTOCOL_VERSION;
}
