/** Copies static window assets into dist/ (loaded via loadFile). */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
fs.copyFileSync(path.join(root, "src", "window.html"), path.join(root, "dist", "window.html"));
const fontsSrc = path.join(root, "src", "fonts");
const fontsDst = path.join(root, "dist", "fonts");
fs.mkdirSync(fontsDst, { recursive: true });
for (const file of fs.readdirSync(fontsSrc)) {
  if (file.endsWith(".woff2")) fs.copyFileSync(path.join(fontsSrc, file), path.join(fontsDst, file));
}
console.log("dist/window.html written, fonts copied");
