/**
 * Chromium launcher for the signup worker.
 *
 * We use puppeteer-core (no bundled browser) and the Chrome/Chromium/Edge the
 * user already has. Every attempt gets a brand-new temporary profile so no
 * cookie, cache or session from a previous attempt can leak into the next one.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const WINDOWS_CANDIDATES = [
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
];

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
];

export interface LaunchedBrowser {
  browser: Browser;
  page: Page;
  userDataDir: string;
  executablePath: string;
}

export function findBrowserExecutable(): string | null {
  const explicit = process.env.REMOTEX_CHROME_PATH?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates =
    process.platform === "win32"
      ? WINDOWS_CANDIDATES
      : process.platform === "darwin"
        ? MAC_CANDIDATES
        : LINUX_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function hasSupportedBrowser(): boolean {
  return findBrowserExecutable() !== null;
}

export async function launchSignupBrowser(headed = false): Promise<LaunchedBrowser> {
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No Chrome, Chromium or Edge installation was found. Install one, or set REMOTEX_CHROME_PATH to the browser executable.",
    );
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remotex-turn-signup-"));
  const browser = await puppeteer.launch({
    executablePath,
    headless: !headed,
    userDataDir,
    defaultViewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--password-store=basic",
      "--use-mock-keychain",
      "--lang=en-US",
    ],
  });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.setViewport({ width: 1280, height: 800 });

  // Keep the browser from advertising itself as automated. The launch flag
  // removes Chrome's own --enable-automation switch; this covers the JS
  // surface as well.
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    } catch {
      // some pages lock the prototypes — not fatal
    }
  });

  return { browser, page, userDataDir, executablePath };
}

export async function closeSignupBrowser(launched: LaunchedBrowser): Promise<void> {
  const child = launched.browser.process();
  try {
    await launched.browser.close();
  } catch {
    // already gone
  }
  try {
    child?.kill();
  } catch {
    // the browser process is already gone
  }
  try {
    fs.rmSync(launched.userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  } catch {
    // Windows can keep a lock for a moment; the OS temp cleaner gets it later.
  }
}

export const __browserInternals = { WINDOWS_CANDIDATES, MAC_CANDIDATES, LINUX_CANDIDATES };
