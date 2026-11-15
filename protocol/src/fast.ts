import { FAST_MESSAGE_SIZE, FastType, NORM_MAX } from "./constants";

export interface MoveMessage {
  kind: "move";
  seq: number;
  /** normalized 0..1 (absolute) */
  x: number;
  y: number;
}

export interface ScrollMessage {
  kind: "scroll";
  seq: number;
  dx: number;
  dy: number;
}

export interface CurMessage {
  kind: "cur";
  seq: number;
  /** normalized 0..1, the machine's true cursor position */
  x: number;
  y: number;
}

export interface PingMessage {
  kind: "ping";
  seq: number;
  /** sender timestamp in ms (echoed verbatim by pong) */
  t: number;
}

export type FastMessage = MoveMessage | ScrollMessage | CurMessage | PingMessage;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function encodeFast(msg: FastMessage): Uint8Array {
  const buf = new ArrayBuffer(FAST_MESSAGE_SIZE);
  const v = new DataView(buf);
  switch (msg.kind) {
    case "move":
      v.setUint8(0, FastType.Move);
      v.setUint16(1, msg.seq & 0xffff, false);
      v.setUint16(3, Math.round(clamp01(msg.x) * NORM_MAX) & 0xffff, false);
      v.setUint16(5, Math.round(clamp01(msg.y) * NORM_MAX) & 0xffff, false);
      break;
    case "cur":
      v.setUint8(0, FastType.Cur);
      v.setUint16(1, msg.seq & 0xffff, false);
      v.setUint16(3, Math.round(clamp01(msg.x) * NORM_MAX) & 0xffff, false);
      v.setUint16(5, Math.round(clamp01(msg.y) * NORM_MAX) & 0xffff, false);
      break;
    case "scroll":
      v.setUint8(0, FastType.Scroll);
      v.setUint16(1, msg.seq & 0xffff, false);
      v.setInt16(3, Math.max(-0x8000, Math.min(0x7fff, Math.round(msg.dx))), false);
      v.setInt16(5, Math.max(-0x8000, Math.min(0x7fff, Math.round(msg.dy))), false);
      break;
    case "ping":
      v.setUint8(0, FastType.Ping);
      v.setUint16(1, msg.seq & 0xffff, false);
      v.setUint32(3, msg.t >>> 0, false);
      break;
  }
  return new Uint8Array(buf);
}

/** Decode a 7-byte fast-channel message. Returns null for unknown types. */
export function decodeFast(bytes: Uint8Array): FastMessage | null {
  if (bytes.length !== FAST_MESSAGE_SIZE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getUint8(0);
  const seq = v.getUint16(1, false);
  switch (type) {
    case FastType.Move:
      return { kind: "move", seq, x: v.getUint16(3, false) / NORM_MAX, y: v.getUint16(5, false) / NORM_MAX };
    case FastType.Cur:
      return { kind: "cur", seq, x: v.getUint16(3, false) / NORM_MAX, y: v.getUint16(5, false) / NORM_MAX };
    case FastType.Scroll:
      return { kind: "scroll", seq, dx: v.getInt16(3, false), dy: v.getInt16(5, false) };
    case FastType.Ping:
      return { kind: "ping", seq, t: v.getUint32(3, false) };
    default:
      return null;
  }
}

/** Pong = the exact same 7 bytes sent back by the receiver. */
export function isPing(bytes: Uint8Array): boolean {
  return bytes.length === FAST_MESSAGE_SIZE && bytes[0] === FastType.Ping;
}
