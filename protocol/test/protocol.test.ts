import test from "node:test";
import assert from "node:assert/strict";
import {
  SeqTracker,
  PROTOCOL_VERSION,
  makeHello,
  isVersionMismatch,
  decodeFast,
  encodeFast,
  decodeCtl,
  encodeCtl,
  packCtl,
  ChunkAssembler,
  type FastMessage,
  type CtlMessage,
} from "../src/index";

test("fast: move round trip", () => {
  const msg: FastMessage = { kind: "move", seq: 7, x: 0.25, y: 0.75 };
  const bytes = encodeFast(msg);
  assert.equal(bytes.length, 7);
  const back = decodeFast(bytes);
  assert.equal(back?.kind, "move");
  if (back?.kind === "move") {
    assert.equal(back.seq, 7);
    assert.ok(Math.abs(back.x - 0.25) < 1 / 65535);
    assert.ok(Math.abs(back.y - 0.75) < 1 / 65535);
  }
});

test("fast: scroll round trip (signed)", () => {
  const msg: FastMessage = { kind: "scroll", seq: 65535, dx: -120, dy: 240 };
  const back = decodeFast(encodeFast(msg));
  assert.deepEqual(back, msg);
});

test("fast: scroll clamps out-of-range deltas", () => {
  const back = decodeFast(encodeFast({ kind: "scroll", seq: 1, dx: 99999, dy: -99999 }));
  assert.equal(back?.kind, "scroll");
  if (back?.kind === "scroll") {
    assert.equal(back.dx, 32767);
    assert.equal(back.dy, -32768);
  }
});

test("fast: cur round trip at boundaries", () => {
  for (const [x, y] of [[0, 0], [1, 1], [0.5, 0.5]] as const) {
    const back = decodeFast(encodeFast({ kind: "cur", seq: 3, x, y }));
    assert.equal(back?.kind, "cur");
  }
});

test("fast: ping round trip and echo semantics", () => {
  const msg: FastMessage = { kind: "ping", seq: 42, t: 1_700_000_000 };
  const bytes = encodeFast(msg);
  const back = decodeFast(bytes);
  assert.deepEqual(back, msg);
  // pong echoes the same 7 bytes verbatim
  assert.deepEqual(decodeFast(bytes), decodeFast(bytes));
});

test("fast: decode rejects short/garbage buffers", () => {
  assert.equal(decodeFast(new Uint8Array(3)), null);
  assert.equal(decodeFast(new Uint8Array([0x09, 0, 0, 0, 0, 0, 0])), null);
});

test("seq: accepts increasing seq", () => {
  const t = new SeqTracker();
  assert.equal(t.accept(100), true);
  assert.equal(t.accept(101), true);
  assert.equal(t.accept(200), true);
});

test("seq: drops duplicates and older messages", () => {
  const t = new SeqTracker();
  assert.equal(t.accept(500), true);
  assert.equal(t.accept(500), false); // duplicate
  assert.equal(t.accept(499), false); // older
  assert.equal(t.accept(600), true);
});

test("seq: handles u16 wraparound", () => {
  const t = new SeqTracker();
  assert.equal(t.accept(65534), true);
  assert.equal(t.accept(65535), true);
  assert.equal(t.accept(0), true);  // wrapped forward
  assert.equal(t.accept(1), true);
  assert.equal(t.accept(65535), false); // now in the past
  assert.equal(t.accept(0), false);     // duplicate
});

test("ctl: hello round trip + version gate", () => {
  const hello = makeHello({
    screen: { width: 2560, height: 1440 },
    displays: [{ id: 1, width: 2560, height: 1440, primary: true }],
    cursor: { x: 0.1, y: 0.2 },
    platform: "windows",
  });
  const back = decodeCtl(encodeCtl(hello));
  assert.equal(back.kind, "hello");
  if (back.kind === "hello") {
    assert.equal(back.version, PROTOCOL_VERSION);
    assert.equal(isVersionMismatch(back), false);
    assert.equal(isVersionMismatch({ ...back, version: PROTOCOL_VERSION + 1 }), true);
    assert.equal(back.screen.width, 2560);
    assert.equal(back.displays.length, 1);
  }
});

test("ctl: every pointer message carries x,y and validates", () => {
  for (const kind of ["down", "up", "click", "dblclick"] as const) {
    const msg: CtlMessage = { kind, button: "left", x: 0.5, y: 0.25 };
    const back = decodeCtl(encodeCtl(msg));
    assert.deepEqual(back, msg);
  }
  // missing x,y must be rejected
  assert.throws(() => decodeCtl(JSON.stringify({ kind: "click", button: "left" })));
  // out of range rejected
  assert.throws(() => decodeCtl(JSON.stringify({ kind: "click", button: "left", x: 1.5, y: 0 })));
  assert.throws(() => decodeCtl(JSON.stringify({ kind: "down", button: "side", x: 0.5, y: 0.5 })));
});

test("ctl: key message round trip and validation", () => {
  const msg: CtlMessage = { kind: "key", code: "KeyA", key: "a", down: true, ctrl: true, alt: false, shift: false, meta: false };
  assert.deepEqual(decodeCtl(encodeCtl(msg)), msg);
  assert.throws(() => decodeCtl(JSON.stringify({ kind: "key", code: "KeyA", key: "a", down: "yes", ctrl: false, alt: false, shift: false, meta: false })));
});

test("ctl: text/paste/clipboard round trip; Arabic + emoji survive", () => {
  for (const text of ["مرحبا بالعالم", "emoji 🎉🚀", "multi\nline\ntext", "a".repeat(10 * 1024)]) {
    for (const kind of ["text", "paste", "clipboard"] as const) {
      const msg: CtlMessage = { kind, text } as CtlMessage;
      const back = decodeCtl(encodeCtl(msg));
      assert.deepEqual(back, msg);
    }
  }
});

test("ctl: cur beacon + curping round trip; bad payloads rejected", () => {
  const cur: CtlMessage = { kind: "cur", x: 0.25, y: 0.75, seq: 4242 };
  assert.deepEqual(decodeCtl(encodeCtl(cur)), cur);
  assert.deepEqual(decodeCtl({ kind: "curping" }), { kind: "curping" });
  assert.throws(() => decodeCtl({ kind: "cur", x: 1.5, y: 0.5, seq: 1 }));
  assert.throws(() => decodeCtl({ kind: "cur", x: 0.5, y: 0.5, seq: 70000 }));
  assert.throws(() => decodeCtl({ kind: "cur", x: 0.5, y: 0.5, seq: 1.5 }));
  // boundary: seq wraps at 65535
  const edge: CtlMessage = { kind: "cur", x: 0, y: 1, seq: 65535 };
  assert.deepEqual(decodeCtl(encodeCtl(edge)), edge);
});

test("ctl: bye round trip, unknown kind rejected", () => {
  assert.deepEqual(decodeCtl({ kind: "bye" }), { kind: "bye" });
  assert.throws(() => decodeCtl({ kind: "definitely-not-a-kind" }));
  assert.throws(() => decodeCtl("{not json"));
});

test("chunk: small messages pass through un-chunked", () => {
  const frames = packCtl({ kind: "text", text: "hello" });
  assert.equal(frames.length, 1);
  assert.equal(decodeCtl(frames[0]!).kind, "text");
});

test("chunk: 100 KB multiline text round trips through the assembler", () => {
  const text = ("سطر عربي طويل يحتوي على كلام كتير يحاكي بيانات حقيقية\n").repeat(3000); // ~ >100 KB
  const frames = packCtl({ kind: "paste", text });
  assert.ok(frames.length > 3, `expected multiple chunks, got ${frames.length}`);
  assert.ok(frames.every((f) => new TextEncoder().encode(f).length <= 16 * 1024));

  const asm = new ChunkAssembler();
  let result = null;
  for (const f of frames) {
    const decoded = decodeCtl(f);
    result = asm.push(decoded);
  }
  assert.equal(result?.kind, "paste");
  if (result?.kind === "paste") assert.equal(result.text, text);
});

test("chunk: out-of-order chunks reassemble", () => {
  const text = "X".repeat(50 * 1024);
  const frames = packCtl({ kind: "text", text });
  const shuffled = [...frames].reverse();
  const asm = new ChunkAssembler();
  let result = null;
  for (const f of shuffled) result = asm.push(decodeCtl(f));
  assert.equal(result?.kind, "text");
});

test("chunk: total-byte cap rejects a hostile flood", () => {
  const asm = new ChunkAssembler();
  const big = Buffer.alloc(1_200_000, 65).toString("base64"); // decodes to ~1.2 MB > cap
  assert.throws(() => asm.push({ kind: "chunk", id: "x", index: 0, total: 3, data: big }));
});

test("ack: round trips and carries an error reason", () => {
  assert.deepEqual(decodeCtl({ kind: "ack", ok: true }), { kind: "ack", ok: true });
  assert.deepEqual(decodeCtl({ kind: "ack", ok: false, error: "protocol-mismatch" }), {
    kind: "ack",
    ok: false,
    error: "protocol-mismatch",
  });
});
