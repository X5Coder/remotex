"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeFast = encodeFast;
exports.decodeFast = decodeFast;
exports.isPing = isPing;
const constants_1 = require("./constants");
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function encodeFast(msg) {
    const buf = new ArrayBuffer(constants_1.FAST_MESSAGE_SIZE);
    const v = new DataView(buf);
    switch (msg.kind) {
        case "move":
            v.setUint8(0, constants_1.FastType.Move);
            v.setUint16(1, msg.seq & 0xffff, false);
            v.setUint16(3, Math.round(clamp01(msg.x) * constants_1.NORM_MAX) & 0xffff, false);
            v.setUint16(5, Math.round(clamp01(msg.y) * constants_1.NORM_MAX) & 0xffff, false);
            break;
        case "cur":
            v.setUint8(0, constants_1.FastType.Cur);
            v.setUint16(1, msg.seq & 0xffff, false);
            v.setUint16(3, Math.round(clamp01(msg.x) * constants_1.NORM_MAX) & 0xffff, false);
            v.setUint16(5, Math.round(clamp01(msg.y) * constants_1.NORM_MAX) & 0xffff, false);
            break;
        case "scroll":
            v.setUint8(0, constants_1.FastType.Scroll);
            v.setUint16(1, msg.seq & 0xffff, false);
            v.setInt16(3, Math.max(-0x8000, Math.min(0x7fff, Math.round(msg.dx))), false);
            v.setInt16(5, Math.max(-0x8000, Math.min(0x7fff, Math.round(msg.dy))), false);
            break;
        case "ping":
            v.setUint8(0, constants_1.FastType.Ping);
            v.setUint16(1, msg.seq & 0xffff, false);
            v.setUint32(3, msg.t >>> 0, false);
            break;
    }
    return new Uint8Array(buf);
}
/** Decode a 7-byte fast-channel message. Returns null for unknown types. */
function decodeFast(bytes) {
    if (bytes.length !== constants_1.FAST_MESSAGE_SIZE)
        return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = v.getUint8(0);
    const seq = v.getUint16(1, false);
    switch (type) {
        case constants_1.FastType.Move:
            return { kind: "move", seq, x: v.getUint16(3, false) / constants_1.NORM_MAX, y: v.getUint16(5, false) / constants_1.NORM_MAX };
        case constants_1.FastType.Cur:
            return { kind: "cur", seq, x: v.getUint16(3, false) / constants_1.NORM_MAX, y: v.getUint16(5, false) / constants_1.NORM_MAX };
        case constants_1.FastType.Scroll:
            return { kind: "scroll", seq, dx: v.getInt16(3, false), dy: v.getInt16(5, false) };
        case constants_1.FastType.Ping:
            return { kind: "ping", seq, t: v.getUint32(3, false) };
        default:
            return null;
    }
}
/** Pong = the exact same 7 bytes sent back by the receiver. */
function isPing(bytes) {
    return bytes.length === constants_1.FAST_MESSAGE_SIZE && bytes[0] === constants_1.FastType.Ping;
}
