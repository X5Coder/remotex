/**
 * Ships the master icon (tools/icon-master.png, authored in tools/icon-master.svg)
 * to every place that needs it:
 *   - dist/icon.png   (512x512 — tray, window/taskbar, electron-builder mac/linux)
 *   - dist/icon.ico   (256x256 PNG-wrapped — Windows shortcut)
 *   - web/public/icon.png (512x512 — site favicon, same file the app ships)
 * Regeneration is a deterministic copy. To redraw the icon, edit icon-master.svg
 * and re-rasterize on a machine with Electron:
 *   npx electron tools/render-svg.js tools/icon-master.png 512
 *   npx electron tools/render-svg.js tools/icon-master-256.png 256
 */
const fs = require("fs");
const path = require("path");

const tools = __dirname;
const dist = path.join(tools, "..", "dist");
const webPublic = path.join(tools, "..", "..", "web", "public");
const masterPng = path.join(tools, "icon-master.png");
const master256 = path.join(tools, "icon-master-256.png");

for (const f of [masterPng, master256]) {
  if (!fs.existsSync(f)) {
    console.error(`missing ${f} — re-rasterize from tools/icon-master.svg (see header)`);
    process.exit(1);
  }
}

fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(webPublic, { recursive: true });
fs.copyFileSync(masterPng, path.join(dist, "icon.png"));
fs.copyFileSync(masterPng, path.join(webPublic, "icon.png"));

// ICO wrapper around the 256x256 PNG (valid for Vista+ — used for the .lnk shortcut)
const icoPng = fs.readFileSync(master256);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; // 256 is stored as 0 in the 1-byte width/height fields
ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(icoPng.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(dist, "icon.ico"), Buffer.concat([ico, icoPng]));

console.log(`icon.png ${fs.statSync(masterPng).size} bytes -> dist + web/public, icon.ico (256) -> dist`);
