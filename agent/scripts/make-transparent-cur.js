/** Generate a fully-transparent 32x32 arrow .cur file — bulletproof replacement for a hand-built mask pair. */
const fs = require("fs");
const path = require("path");

const W = 32, H = 32;

// ICONDIR: reserved(2) type(2) count(1)
const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0);
iconDir.writeUInt16LE(2, 2); // 2 = .CUR
iconDir.writeUInt16LE(1, 4);

// XOR pixels (32bpp ARGB, all zero alpha = fully transparent)
const xor = Buffer.alloc(W * H * 4, 0);

// AND mask: monochrome, 1 bit per pixel; 4 bytes per row (32 bits) x 32 rows = 128 bytes; all 0xFF = "irrelevant" for alpha cursors but keep it sane
const andBytesPerRow = ((W + 31) >> 5) * 4; // 4
const andMask = Buffer.alloc(andBytesPerRow * H, 0xff);

const bmpInfoHeader = Buffer.alloc(40);
bmpInfoHeader.writeUInt32LE(40, 0);       // biSize
bmpInfoHeader.writeInt32LE(W, 4);         // biWidth
bmpInfoHeader.writeInt32LE(H * 2, 8);     // biHeight (2x => XOR + AND)
bmpInfoHeader.writeUInt16LE(1, 12);       // biPlanes
bmpInfoHeader.writeUInt16LE(32, 14);      // biBitCount
bmpInfoHeader.writeUInt32LE(0, 16);       // biCompression (BI_RGB)
bmpInfoHeader.writeUInt32LE(xor.length + andMask.length, 20); // biSizeImage
bmpInfoHeader.writeInt32LE(0, 24);        // biXPelsPerMeter
bmpInfoHeader.writeInt32LE(0, 28);        // biYPelsPerMeter
bmpInfoHeader.writeUInt32LE(0, 32);       // biClrUsed
bmpInfoHeader.writeUInt32LE(0, 36);       // biClrImportant

// hotspot (.cur repurposes wPlanes/wBitCount) then byte size and image offset
const iconEntry = Buffer.alloc(16);
iconEntry.writeUInt8(W, 0);   // bWidth
iconEntry.writeUInt8(H, 1);   // bHeight
iconEntry.writeUInt8(0, 2);   // bColorCount
iconEntry.writeUInt8(0, 3);   // bReserved
iconEntry.writeUInt16LE(0, 4); // xHotSpot
iconEntry.writeUInt16LE(0, 6); // yHotSpot
iconEntry.writeUInt32LE(bmpInfoHeader.length + xor.length + andMask.length, 8); // dwBytesInRes
iconEntry.writeUInt32LE(6 + 16, 12);      // dwImageOffset

const out = Buffer.concat([iconDir, iconEntry, bmpInfoHeader, xor, andMask]);
const outPath = path.join(__dirname, "..", "src", "transparent-arrow.cur");
fs.writeFileSync(outPath, out);
console.log("wrote", outPath, out.length, "bytes");
