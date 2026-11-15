/** Copies static window assets into dist/ (loaded via loadFile). */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
fs.copyFileSync(path.join(root, "src", "window.html"), path.join(root, "dist", "window.html"));
console.log("dist/window.html written");
