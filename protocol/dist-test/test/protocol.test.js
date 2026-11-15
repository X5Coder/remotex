"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_1 = require("../src/index");
(0, node_test_1.default)("fast: move round trip", () => {
    const msg = { kind: "move", seq: 7, x: 0.25, y: 0.75 };
    const bytes = (0, index_1.encodeFast)(msg);
    strict_1.default.equal(bytes.length, 7);
    const back = (0, index_1.decodeFast)(bytes);
    strict_1.default.equal(back?.kind, "move");
    if (back?.kind === "move") {
        strict_1.default.equal(back.seq, 7);
        strict_1.default.ok(Math.abs(back.x - 0.25) < 1 / 65535);
        strict_1.default.ok(Math.abs(back.y - 0.75) < 1 / 65535);
    }
});
(0, node_test_1.default)("fast: scroll round trip (signed)", () => {
    const msg = { kind: "scroll", seq: 65535, dx: -120, dy: 240 };
    const back = (0, index_1.decodeFast)((0, index_1.encodeFast)(msg));
    strict_1.default.deepEqual(back, msg);
});
(0, node_test_1.default)("fast: scroll clamps out-of-range deltas", () => {
    const back = (0, index_1.decodeFast)((0, index_1.encodeFast)({ kind: "scroll", seq: 1, dx: 99999, dy: -99999 }));
    strict_1.default.equal(back?.kind, "scroll");
    if (back?.kind === "scroll") {
        strict_1.default.equal(back.dx, 32767);
        strict_1.default.equal(back.dy, -32768);
    }
});
(0, node_test_1.default)("fast: cur round trip at boundaries", () => {
    for (const [x, y] of [[0, 0], [1, 1], [0.5, 0.5]]) {
        const back = (0, index_1.decodeFast)((0, index_1.encodeFast)({ kind: "cur", seq: 3, x, y }));
        strict_1.default.equal(back?.kind, "cur");
    }
});
(0, node_test_1.default)("fast: ping round trip and echo semantics", () => {
    const msg = { kind: "ping", seq: 42, t: 1700000000 };
    const bytes = (0, index_1.encodeFast)(msg);
    const back = (0, index_1.decodeFast)(bytes);
    strict_1.default.deepEqual(back, msg);
    // pong echoes the same 7 bytes verbatim
    strict_1.default.deepEqual((0, index_1.decodeFast)(bytes), (0, index_1.decodeFast)(bytes));
});
(0, node_test_1.default)("fast: decode rejects short/garbage buffers", () => {
    strict_1.default.equal((0, index_1.decodeFast)(new Uint8Array(3)), null);
    strict_1.default.equal((0, index_1.decodeFast)(new Uint8Array([0x09, 0, 0, 0, 0, 0, 0])), null);
});
(0, node_test_1.default)("seq: accepts increasing seq", () => {
    const t = new index_1.SeqTracker();
    strict_1.default.equal(t.accept(100), true);
    strict_1.default.equal(t.accept(101), true);
    strict_1.default.equal(t.accept(200), true);
});
(0, node_test_1.default)("seq: drops duplicates and older messages", () => {
    const t = new index_1.SeqTracker();
    strict_1.default.equal(t.accept(500), true);
    strict_1.default.equal(t.accept(500), false); // duplicate
    strict_1.default.equal(t.accept(499), false); // older
    strict_1.default.equal(t.accept(600), true);
});
(0, node_test_1.default)("seq: handles u16 wraparound", () => {
    const t = new index_1.SeqTracker();
    strict_1.default.equal(t.accept(65534), true);
    strict_1.default.equal(t.accept(65535), true);
    strict_1.default.equal(t.accept(0), true); // wrapped forward
    strict_1.default.equal(t.accept(1), true);
    strict_1.default.equal(t.accept(65535), false); // now in the past
    strict_1.default.equal(t.accept(0), false); // duplicate
});
(0, node_test_1.default)("ctl: hello round trip + version gate", () => {
    const hello = (0, index_1.makeHello)({
        screen: { width: 2560, height: 1440 },
        displays: [{ id: 1, width: 2560, height: 1440, primary: true }],
        cursor: { x: 0.1, y: 0.2 },
        platform: "windows",
    });
    const back = (0, index_1.decodeCtl)((0, index_1.encodeCtl)(hello));
    strict_1.default.equal(back.kind, "hello");
    if (back.kind === "hello") {
        strict_1.default.equal(back.version, index_1.PROTOCOL_VERSION);
        strict_1.default.equal((0, index_1.isVersionMismatch)(back), false);
        strict_1.default.equal((0, index_1.isVersionMismatch)({ ...back, version: index_1.PROTOCOL_VERSION + 1 }), true);
        strict_1.default.equal(back.screen.width, 2560);
        strict_1.default.equal(back.displays.length, 1);
    }
});
(0, node_test_1.default)("ctl: every pointer message carries x,y and validates", () => {
    for (const kind of ["down", "up", "click", "dblclick"]) {
        const msg = { kind, button: "left", x: 0.5, y: 0.25 };
        const back = (0, index_1.decodeCtl)((0, index_1.encodeCtl)(msg));
        strict_1.default.deepEqual(back, msg);
    }
    // missing x,y must be rejected
    strict_1.default.throws(() => (0, index_1.decodeCtl)(JSON.stringify({ kind: "click", button: "left" })));
    // out of range rejected
    strict_1.default.throws(() => (0, index_1.decodeCtl)(JSON.stringify({ kind: "click", button: "left", x: 1.5, y: 0 })));
    strict_1.default.throws(() => (0, index_1.decodeCtl)(JSON.stringify({ kind: "down", button: "side", x: 0.5, y: 0.5 })));
});
(0, node_test_1.default)("ctl: key message round trip and validation", () => {
    const msg = { kind: "key", code: "KeyA", key: "a", down: true, ctrl: true, alt: false, shift: false, meta: false };
    strict_1.default.deepEqual((0, index_1.decodeCtl)((0, index_1.encodeCtl)(msg)), msg);
    strict_1.default.throws(() => (0, index_1.decodeCtl)(JSON.stringify({ kind: "key", code: "KeyA", key: "a", down: "yes", ctrl: false, alt: false, shift: false, meta: false })));
});
(0, node_test_1.default)("ctl: text/paste/clipboard round trip; Arabic + emoji survive", () => {
    for (const text of ["مرحبا بالعالم", "emoji 🎉🚀", "multi\nline\ntext", "a".repeat(10 * 1024)]) {
        for (const kind of ["text", "paste", "clipboard"]) {
            const msg = { kind, text };
            const back = (0, index_1.decodeCtl)((0, index_1.encodeCtl)(msg));
            strict_1.default.deepEqual(back, msg);
        }
    }
});
(0, node_test_1.default)("ctl: bye round trip, unknown kind rejected", () => {
    strict_1.default.deepEqual((0, index_1.decodeCtl)({ kind: "bye" }), { kind: "bye" });
    strict_1.default.throws(() => (0, index_1.decodeCtl)({ kind: "definitely-not-a-kind" }));
    strict_1.default.throws(() => (0, index_1.decodeCtl)("{not json"));
});
(0, node_test_1.default)("chunk: small messages pass through un-chunked", () => {
    const frames = (0, index_1.packCtl)({ kind: "text", text: "hello" });
    strict_1.default.equal(frames.length, 1);
    strict_1.default.equal((0, index_1.decodeCtl)(frames[0]).kind, "text");
});
(0, node_test_1.default)("chunk: 100 KB multiline text round trips through the assembler", () => {
    const text = ("سطر عربي طويل يحتوي على كلام كتير يحاكي بيانات حقيقية\n").repeat(3000); // ~ >100 KB
    const frames = (0, index_1.packCtl)({ kind: "paste", text });
    strict_1.default.ok(frames.length > 3, `expected multiple chunks, got ${frames.length}`);
    strict_1.default.ok(frames.every((f) => new TextEncoder().encode(f).length <= 16 * 1024));
    const asm = new index_1.ChunkAssembler();
    let result = null;
    for (const f of frames) {
        const decoded = (0, index_1.decodeCtl)(f);
        result = asm.push(decoded);
    }
    strict_1.default.equal(result?.kind, "paste");
    if (result?.kind === "paste")
        strict_1.default.equal(result.text, text);
});
(0, node_test_1.default)("chunk: out-of-order chunks reassemble", () => {
    const text = "X".repeat(50 * 1024);
    const frames = (0, index_1.packCtl)({ kind: "text", text });
    const shuffled = [...frames].reverse();
    const asm = new index_1.ChunkAssembler();
    let result = null;
    for (const f of shuffled)
        result = asm.push((0, index_1.decodeCtl)(f));
    strict_1.default.equal(result?.kind, "text");
});
(0, node_test_1.default)("chunk: total-byte cap rejects a hostile flood", () => {
    const asm = new index_1.ChunkAssembler();
    const big = Buffer.alloc(1200000, 65).toString("base64"); // decodes to ~1.2 MB > cap
    strict_1.default.throws(() => asm.push({ kind: "chunk", id: "x", index: 0, total: 3, data: big }));
});
(0, node_test_1.default)("ack: round trips and carries an error reason", () => {
    strict_1.default.deepEqual((0, index_1.decodeCtl)({ kind: "ack", ok: true }), { kind: "ack", ok: true });
    strict_1.default.deepEqual((0, index_1.decodeCtl)({ kind: "ack", ok: false, error: "protocol-mismatch" }), {
        kind: "ack",
        ok: false,
        error: "protocol-mismatch",
    });
});
