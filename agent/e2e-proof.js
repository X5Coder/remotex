const puppeteer = require("C:/Users/KIMO/Documents/X5Coder Projects/remotex/agent/node_modules/puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on("console", (m) => console.log("[console]", m.type(), m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  console.log("goto LAN page");
  await page.goto("http://192.168.8.25:4545/", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#roomId", { timeout: 10000 });
  await page.click("#roomId");
  await page.type("#roomId", "387554", { delay: 15 });
  await page.click("#password");
  await page.type("#password", "SMOKETEST", { delay: 15 });
  await page.click("#connectBtn");

  try {
    await page.waitForFunction(
      () => { const v = document.querySelector("video"); return !!(v && v.srcObject); },
      { timeout: 60000, polling: 250 }
    );
    console.log("stream attached");
  } catch {
    console.log("stream NEVER attached");
  }

  await new Promise((r) => setTimeout(r, 12000));

  const info = await page.evaluate(() => {
    const v = document.querySelector("video");
    const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const screen = document.getElementById("screen");
    const live = screen?.classList.contains("live");
    return {
      live,
      videoWidth: v?.videoWidth,
      videoHeight: v?.videoHeight,
      readyState: v?.readyState,
      framesDecoded: q?.totalVideoFrames ?? null,
      sw: getComputedStyle(document.getElementById("screenWrap")).width,
      sh: getComputedStyle(document.getElementById("screenWrap")).height,
    };
  });
  console.log("INFO:", JSON.stringify(info, null, 2));
  await page.screenshot({ path: "C:/Users/KIMO/Documents/X5Coder Projects/remotex/agent/e2e-proof.png" });
  await browser.close();
  process.exit();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
