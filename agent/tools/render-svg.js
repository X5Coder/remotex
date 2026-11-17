/**
 * One-shot rasterizer: renders tools/icon-master.svg to PNG at the requested
 * size using the already-installed Electron (no new dependencies).
 * Usage: npx electron tools/render-svg.js <out.png> <size>
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const outPath = process.argv[process.argv.length - 2];
const size = Number(process.argv[process.argv.length - 1]) || 512;
const svgPath = path.join(__dirname, "icon-master.svg");

void app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(svgPath, "utf8");
    const html =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" +
      `html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}` +
      `svg{width:${size}px;height:${size}px;display:block}` +
      "</style></head><body>" + svg + "</body></html>";
    const win = new BrowserWindow({
      show: false,
      width: size,
      height: size,
      useContentSize: true,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true },
    });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 400)); // let fonts/filters settle
    const img = await win.webContents.capturePage();
    fs.writeFileSync(outPath, img.toPNG());
    console.log("written", outPath, `${size}x${size}`, fs.statSync(outPath).size, "bytes");
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
