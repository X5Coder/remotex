"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAST_MESSAGE_SIZE = exports.FastType = exports.CTL_CHUNK_TTL_MS = exports.CTL_MAX_BYTES = exports.CTL_CHUNK_THRESHOLD = exports.NORM_MAX = exports.PROTOCOL_VERSION = void 0;
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
exports.PROTOCOL_VERSION = 1;
/** Max normalized coordinate value (x/y are sent as normalized * 65535). */
exports.NORM_MAX = 65535;
/** Max bytes for a single ctl payload before it is chunked. */
exports.CTL_CHUNK_THRESHOLD = 16 * 1024;
/** Max reassembled ctl payload (wire cap, matches the 1 MB text limit). */
exports.CTL_MAX_BYTES = 1024 * 1024 + 64 * 1024;
/** Chunks older than this are discarded by the assembler. */
exports.CTL_CHUNK_TTL_MS = 30000;
/** fast channel message types (first byte). */
exports.FastType = {
    Move: 0x01,
    Scroll: 0x02,
    Cur: 0x03, // agent -> client: true cursor position
    Ping: 0x04, // ping / pong (pong echoes the exact 7 bytes)
};
exports.FAST_MESSAGE_SIZE = 7;
