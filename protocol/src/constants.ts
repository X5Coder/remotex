/**
 * RemoteX wire protocol — constants.
 *
 * Two logical channels share one RTCPeerConnection (master.md §3):
 *   - "fast": binary, 7 bytes per message, big-endian. For high-frequency,
 *     loss-tolerant traffic (cursor moves, scroll, ping).
 *   - "ctl":  JSON, reliable + ordered. For everything else.
 *
 * Transport note: the web client and Electron agent exchange these over
 * Trystero actions; channel *ordering* is chosen by the transport layer
 * (fast = unordered/maxRetransmits:0, ctl = reliable). This package only
 * defines the byte/JSON formats and helpers — it is transport-agnostic
 * so it can be unit-tested in Node.
 */
export const PROTOCOL_VERSION = 1;

/** Max normalized coordinate value (x/y are sent as normalized * 65535). */
export const NORM_MAX = 65535;

/** Max bytes for a single ctl payload before it is chunked. */
export const CTL_CHUNK_THRESHOLD = 16 * 1024;

/** Max reassembled ctl payload (wire cap, matches the 1 MB text limit). */
export const CTL_MAX_BYTES = 1024 * 1024 + 64 * 1024;

/** Chunks older than this are discarded by the assembler. */
export const CTL_CHUNK_TTL_MS = 30_000;

/** fast channel message types (first byte). */
export const FastType = {
  Move: 0x01,
  Scroll: 0x02,
  Cur: 0x03, // agent -> client: true cursor position
  Ping: 0x04, // ping / pong (pong echoes the exact 7 bytes)
} as const;
export type FastType = (typeof FastType)[keyof typeof FastType];

export const FAST_MESSAGE_SIZE = 7;
