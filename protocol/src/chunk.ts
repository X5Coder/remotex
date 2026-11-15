import { CTL_CHUNK_THRESHOLD, CTL_CHUNK_TTL_MS, CTL_MAX_BYTES } from "./constants";
import { CtlMessage, decodeCtl, encodeCtl, ChunkMessage } from "./ctl";

const b64 = {
  encode(bytes: Uint8Array): string {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return btoa(s);
  },
  decode(s: string): Uint8Array {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};

/** Random chunk-group id (uuid-ish, good enough for one session). */
function newChunkId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Serialize a ctl message to one or more wire frames.
 * Small messages pass through as plain JSON; large ones (> 16 KB) are
 * split into chunk frames of <= CTL_CHUNK_THRESHOLD bytes of source.
 */
export function packCtl(msg: CtlMessage): string[] {
  const json = encodeCtl(msg);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length <= CTL_CHUNK_THRESHOLD || msg.kind === "chunk") return [json];

  const id = newChunkId();
  // keep the full JSON frame (uuid, indices, base64 overhead) under the threshold
  const sliceLen = Math.floor(((CTL_CHUNK_THRESHOLD - 512) * 3) / 4);
  const frames: string[] = [];
  const total = Math.ceil(bytes.length / sliceLen);
  for (let index = 0; index < total; index++) {
    const slice = bytes.subarray(index * sliceLen, (index + 1) * sliceLen);
    frames.push(encodeCtl({ kind: "chunk", id, index, total, data: b64.encode(slice) }));
  }
  return frames;
}

interface PendingGroup {
  total: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  started: number;
}

/**
 * Reassembles ctl messages that were split by packCtl.
 * Feed every decoded ctl message to `push`; call `tryUnpack` per incoming frame.
 */
export class ChunkAssembler {
  private pending = new Map<string, PendingGroup>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Feed one decoded ctl frame.
   * Returns the reassembled message when complete, or null if not ready.
   * Throws on corrupted/oversized groups.
   */
  push(frame: CtlMessage): CtlMessage | null {
    this.evictStale();
    if (frame.kind !== "chunk") return frame;

    const g = this.pending.get(frame.id) ?? { total: frame.total, parts: new Map(), bytes: 0, started: this.now() };
    if (g.total !== frame.total) throw new Error("chunk group total mismatch");
    if (!g.parts.has(frame.index)) {
      const slice = b64.decode(frame.data);
      g.bytes += slice.length;
      if (g.bytes > CTL_MAX_BYTES) {
        this.pending.delete(frame.id);
        throw new Error("chunk group exceeded max size");
      }
      g.parts.set(frame.index, slice);
    }
    this.pending.set(frame.id, g);

    if (g.parts.size !== g.total) return null;

    this.pending.delete(frame.id);
    const out = new Uint8Array(g.bytes);
    let off = 0;
    for (let i = 0; i < g.total; i++) {
      const part = g.parts.get(i);
      if (!part) throw new Error("chunk group missing part");
      out.set(part, off);
      off += part.length;
    }
    return decodeCtl(new TextDecoder().decode(out));
  }

  /** Drop partial groups older than CTL_CHUNK_TTL_MS. */
  evictStale(): void {
    const cutoff = this.now() - CTL_CHUNK_TTL_MS;
    for (const [id, g] of this.pending) {
      if (g.started < cutoff) this.pending.delete(id);
    }
  }
}
