/**
 * Generates dist/icon.png (512x512) + dist/icon.ico (256x256) — light "site" icon:
 * a silver-to-white rounded square with a dark-slate glyph: a monitor (left)
 * and a phone (right, filled with a light screen) joined by a faint dotted
 * wireless arc above them. Matches the web client's favicon (same file ships).
 * No external dependencies; used for the tray, the window/taskbar icon, and by
 * electron-builder (mac/linux require >=512px).
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BG_TOP = [255, 255, 255]; // #ffffff (top of the silver gradient)
const BG_BOT = [217, 222, 229]; // #d9dee5 (bottom)
const INK = [31, 39, 51];       // #1f2733 (the glyph)
const SOFT = [91, 102, 118];    // #5b6676 (dotted arc)
const SCREEN = [236, 239, 243]; // #eceff3 (phone screen — the site's page color)
const BIG = 512; // electron-builder floor for mac (512x512) and linux
const ICO = 256; // Vista+ shortcut icon
const BASE = 32; // geometry is authored for a 32px grid, scaled by s = SIZE/BASE

function render(SIZE) {
  const s = SIZE / BASE;
  const RADIUS = Math.round(7 * s);
  const MAX = SIZE - 1;
  // same clamp + squared-distance rounded-rect test the body mask uses
  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const R = (v) => v * s;
  const inRect = (x, y, x0, y0, x1, y1) => x >= R(x0) && x <= R(x1) && y >= R(y0) && y <= R(y1);
  const fillCircle = (cx, cy, r) => (x, y) =>
    (x - R(cx)) ** 2 + (y - R(cy)) ** 2 <= R(r) * R(r);
  // rounded-rect outline = outer rounded rect minus concentric inner rounded rect
  const outline = (x, y, x0, y0, x1, y1, r, border) =>
    inRoundRect(x, y, R(x0), R(y0), R(x1), R(y1), R(r)) &&
    !inRoundRect(x, y, R(x0 + border), R(y0 + border), R(x1 - border), R(y1 - border), Math.max(0, R(r - border)));
  // shallow "remote link" arc above the two devices: P0 -> C -> P1 (quadratic bezier)
  const ARC_P0 = [5, 6.2];
  const ARC_C = [16, 0.2];
  const ARC_P1 = [27, 8.6];
  const ARC_DOT_T = [0.08, 0.24, 0.4, 0.56, 0.72, 0.88];
  const quad = (t, p0, c, p1) => {
    const u = 1 - t;
    return [
      u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
      u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
    ];
  };
  const dotCenters = ARC_DOT_T.map((t) => quad(t, ARC_P0, ARC_C, ARC_P1));
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (!inRoundRect(x, y, 0, 0, MAX, MAX, RADIUS)) { px[i + 3] = 0; continue; }
      // subtle vertical gradient on the silver body (white at the top)
      const t = y / (SIZE - 1);
      px[i] = Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t);
      px[i + 1] = Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t);
      px[i + 2] = Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t);
      px[i + 3] = 255;
      // glyph: monitor (outline, left) + phone (filled, right) + faint dotted arc above
      let ink =
        outline(x, y, 2.5, 6.5, 19, 17.5, 2.4, 2.3) || // monitor frame (hollow)
        inRect(x, y, 10.2, 16.2, 11.8, 22.3) ||       // monitor neck
        inRect(x, y, 6.5, 22.2, 15.5, 23.7) ||        // monitor base
        inRoundRect(x, y, R(21), R(7.5), R(29.3), R(27.5), R(2.7)); // phone body (filled)
      const cut =
        inRoundRect(x, y, R(22.7), R(9.6), R(27.6), R(10.6), R(0.5)) ||  // speaker slit
        inRoundRect(x, y, R(22.7), R(12.8), R(27.6), R(24.9), R(1.3));   // screen cut-out
      if (ink && !cut) {
        px[i] = INK[0]; px[i + 1] = INK[1]; px[i + 2] = INK[2]; px[i + 3] = 255;
        continue;
      }
      if (cut) {
        px[i] = SCREEN[0]; px[i + 1] = SCREEN[1]; px[i + 2] = SCREEN[2]; px[i + 3] = 255;
        continue;
      }
      for (const [cx, cy] of dotCenters) {
        if (fillCircle(cx, cy, 1.0)(x, y)) {
          px[i] = SOFT[0]; px[i + 1] = SOFT[1]; px[i + 2] = SOFT[2]; px[i + 3] = 255;
          break;
        }
      }
    }
  }
  return px;
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

function encodePng(px, SIZE) {
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

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, "..", "dist");
fs.mkdirSync(out, { recursive: true });

// 512x512 PNG — tray, window icon, electron-builder (mac/linux)
const bigPng = encodePng(render(BIG), BIG);
const iconPngPath = path.join(out, "icon.png");
fs.writeFileSync(iconPngPath, bigPng);

// same icon file ships as the website favicon (site icon == app icon)
const webPublic = path.join(__dirname, "..", "..", "web", "public");
fs.mkdirSync(webPublic, { recursive: true });
const webPngPath = path.join(webPublic, "icon.png");
fs.writeFileSync(webPngPath, bigPng);

// ICO wrapper around a 256x256 PNG entry (valid for Vista+ — used for the .lnk shortcut)
const icoPng = encodePng(render(ICO), ICO);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; // 256 is stored as 0 in the 1-byte width/height fields
ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(icoPng.length, 14); ico.writeUInt32LE(22, 18);
const icoPath = path.join(out, "icon.ico");
fs.writeFileSync(icoPath, Buffer.concat([ico, icoPng]));

console.log(`icon.png ${BIG}x${BIG} (${bigPng.length} bytes) written to ${iconPngPath}`);
console.log(`web icon.png ${BIG}x${BIG} written to ${webPngPath}`);
console.log(`icon.ico ${ICO}x${ICO} (png-wrapped, new monitor-phone-link glyph) written to ${icoPath}`);
