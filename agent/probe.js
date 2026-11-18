const puppeteer = require("C:/Users/KIMO/Documents/X5Coder Projects/remotex/agent/node_modules/puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 750 });
  page.on("console", (m) => console.log("[console]", m.type(), m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  console.log("loading LAN page...");
  await page.goto("http://192.168.8.25:4545/", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#roomId", { timeout: 10000 });
  await page.click("#roomId");
  await page.type("#roomId", "387554", { delay: 20 });
  await page.click("#password");
  await page.type("#password", "SMOKETEST", { delay: 20 });
  await page.click("#connectBtn");

  console.log("clicked connect — waiting for stream...");
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return !!(v && v.srcObject);
      },
      { timeout: 30000, polling: 250 }
    );
    console.log("stream attached");
  } catch {
    console.log("stream NEVER attached within 30s");
  }

  await new Promise((r) => setTimeout(r, 8000));

  const info = await page.evaluate(() => {
    const v = document.querySelector("video");
    const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const sw = getComputedStyle(document.getElementById("screenWrap"));
    const app = document.getElementById("app");
    return {
      appHidden: app?.hidden,
      live: document.getElementById("screen")?.classList.contains("live"),
      videoWidth: v?.videoWidth,
      videoHeight: v?.videoHeight,
      readyState: v?.readyState,
      paused: v?.paused,
      srcObject: !!v?.srcObject,
      framesDecoded: q?.totalVideoFrames ?? null,
      framesDropped: q?.droppedVideoFrames ?? null,
      sw: sw.width,
      sh: sw.height,
      placeholderText: document.querySelector(".placeholder span")?.textContent ?? null,
      placeholderVisible: !!document.querySelector(".placeholder") && getComputedStyle(document.querySelector(".placeholder")).display !== "none",
      toast: document.getElementById("toast")?.textContent ?? null,
    };
  });
  console.log("INFO:", JSON.stringify(info, null, 2));
  await page.screenshot({ path: "C:/Users/KIMO/Documents/X5Coder Projects/remotex/agent/remote-probe.png" });
  await browser.close();
  process.exit();
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
