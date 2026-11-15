"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeHello = makeHello;
exports.decodeCtl = decodeCtl;
exports.encodeCtl = encodeCtl;
exports.isVersionMismatch = isVersionMismatch;
const constants_1 = require("./constants");
const BUTTONS = ["left", "middle", "right"];
const isButton = (v) => typeof v === "string" && BUTTONS.includes(v);
const isNorm = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const isBool = (v) => typeof v === "boolean";
const MAX_TEXT = 1024 * 1024; // 1 MB text cap (master.md §6 Step 6)
function makeHello(msg) {
    return { kind: "hello", version: constants_1.PROTOCOL_VERSION, ...msg };
}
/** Validate + decode a ctl JSON payload (string or pre-parsed object). Throws on invalid input. */
function decodeCtl(input) {
    const msg = typeof input === "string" ? JSON.parse(input) : input;
    if (typeof msg !== "object" || msg === null)
        throw new Error("ctl: not an object");
    const m = msg;
    const kind = m.kind;
    switch (kind) {
        case "hello": {
            if (typeof m.version !== "number")
                throw new Error("hello.version must be a number");
            const scr = m.screen;
            if (!scr || typeof scr.width !== "number" || typeof scr.height !== "number")
                throw new Error("hello.screen must have numeric width/height");
            const displays = Array.isArray(m.displays) ? m.displays : [];
            for (const d of displays) {
                const dd = d;
                if (typeof dd.width !== "number" || typeof dd.height !== "number")
                    throw new Error("hello.displays[] entries need numeric width/height");
            }
            const cur = (m.cursor ?? { x: 0.5, y: 0.5 });
            if (!isNorm(cur.x) || !isNorm(cur.y))
                throw new Error("hello.cursor must be normalized 0..1");
            return {
                kind: "hello",
                version: m.version,
                screen: { width: Math.max(0, Math.floor(scr.width)), height: Math.max(0, Math.floor(scr.height)) },
                displays: displays.map((d) => {
                    const dd = d;
                    return { id: dd.id ?? "", width: dd.width, height: dd.height, primary: !!dd.primary };
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
            if (!isButton(m.button))
                throw new Error(`${kind}.button must be left|middle|right`);
            if (!isNorm(m.x) || !isNorm(m.y))
                throw new Error(`${kind}.x/y must be normalized 0..1`);
            return { kind, button: m.button, x: m.x, y: m.y };
        }
        case "key": {
            if (!isStr(m.code, 64) || !isStr(m.key, 64))
                throw new Error("key.code/key must be short strings");
            if (!isBool(m.down) || !isBool(m.ctrl) || !isBool(m.alt) || !isBool(m.shift) || !isBool(m.meta))
                throw new Error("key.down/ctrl/alt/shift/meta must be booleans");
            return { kind: "key", code: m.code, key: m.key, down: m.down, ctrl: m.ctrl, alt: m.alt, shift: m.shift, meta: m.meta };
        }
        case "text":
            if (!isStr(m.text, MAX_TEXT))
                throw new Error("text.text missing or too large");
            return { kind: "text", text: m.text };
        case "paste":
            if (!isStr(m.text, MAX_TEXT))
                throw new Error("paste.text missing or too large");
            return { kind: "paste", text: m.text };
        case "clipboard":
            if (!isStr(m.text, MAX_TEXT))
                throw new Error("clipboard.text missing or too large");
            return { kind: "clipboard", text: m.text };
        case "bye":
            return { kind: "bye" };
        case "chunk": {
            if (!isStr(m.id, 64))
                throw new Error("chunk.id missing");
            if (typeof m.index !== "number" || typeof m.total !== "number")
                throw new Error("chunk.index/total must be numbers");
            if (typeof m.data !== "string")
                throw new Error("chunk.data must be base64");
            const index = Math.floor(m.index), total = Math.floor(m.total);
            if (total < 1 || index < 0 || index >= total || total > 1024)
                throw new Error("chunk.index/total out of range");
            return { kind: "chunk", id: m.id, index, total, data: m.data };
        }
        default:
            throw new Error(`unknown ctl kind: ${String(kind)}`);
    }
}
function encodeCtl(msg) {
    return JSON.stringify(msg);
}
/** True when the peer must be asked to update: protocol major mismatch. */
function isVersionMismatch(hello) {
    return hello.version !== constants_1.PROTOCOL_VERSION;
}
