/** Bundles src/hidden.ts (renderer for the hidden WebRTC window) into dist/hidden.js */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");

async function main() {
  await esbuild.build({
    entryPoints: [path.join(root, "src/hidden.ts")],
    bundle: true,
    format: "iife",
    target: "chrome120",
    outfile: path.join(root, "dist/hidden.js"),
    sourcemap: true,
    logLevel: "info",
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' blob:; style-src 'unsafe-inline'; connect-src 'self' ws: wss: https:; img-src 'self' data:; worker-src 'self' blob:">
<title>RemoteX capture</title>
</head>
<body style="background:#000">
<script src="./hidden.js"></script>
</body>
</html>`;
  fs.writeFileSync(path.join(root, "dist/hidden.html"), html);
  console.log("dist/hidden.html written");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
