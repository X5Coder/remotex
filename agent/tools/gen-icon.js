/**
 * Generates dist/icon.png (32x32) — dark rounded square with a gold monitor glyph.
 * No external dependencies; used for the tray and window icon.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 32;
const BG = [43, 51, 64]; // #2b3340
const GOLD = [184, 145, 58]; // #b8913a
const RADIUS = 7;

const px = Buffer.alloc(SIZE * SIZE * 4);
const inRoundRect = (x, y) => {
  const minX = 0, minY = 0, maxX = SIZE - 1, maxY = SIZE - 1;
  const cx = Math.min(Math.max(x, minX + RADIUS), maxX - RADIUS);
  const cy = Math.min(Math.max(y, minY + RADIUS), maxY - RADIUS);
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS * RADIUS;
};

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (!inRoundRect(x, y)) { px[i + 3] = 0; continue; }
    // subtle vertical gradient on the dark body
    const t = y / (SIZE - 1);
    px[i] = Math.round(BG[0] + 14 * t);
    px[i + 1] = Math.round(BG[1] + 14 * t);
    px[i + 2] = Math.round(BG[2] + 16 * t);
    px[i + 3] = 255;
    // monitor glyph (gold)
    const inRect = (x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    // screen frame: outer rect 6..26 x 7..21, 2px border
    const outer = inRect(6, 7, 26, 21);
    const inner = inRect(8, 9, 24, 19);
    const screenBorder = outer && !inner;
    const stand = inRect(14, 23, 18, 26) || inRect(10, 27, 22, 28);
    if (screenBorder || stand) {
      px[i] = GOLD[0]; px[i + 1] = GOLD[1]; px[i + 2] = GOLD[2]; px[i + 3] = 255;
    }
  }
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  px.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "dist");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.png"), png);

// same icon file ships as the website favicon (site icon == app icon)
const webPublic = path.join(__dirname, "..", "..", "web", "public");
fs.mkdirSync(webPublic, { recursive: true });
fs.writeFileSync(path.join(webPublic, "icon.png"), png);

// ICO wrapper around the 32x32 PNG (valid for Vista+ — used for the .lnk shortcut)
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = SIZE; ico[7] = SIZE; ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(out, "icon.ico"), Buffer.concat([ico, png]));
console.log("icon.png", png.length, "bytes, icon.ico (png-wrapped) written");
