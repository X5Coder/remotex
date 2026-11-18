/**
 * Automatic TURN setup orchestrator.
 *
 * Signup is the only retried stage: each attempt gets a fresh inbox, a fresh
 * Chromium profile, and a fresh identity. Once Metered accepts the signup the
 * flow runs exactly once — leaking a partially verified account into another
 * attempt would do more harm than good.
 *
 * The returned credential is NOT saved here; the caller verifies it with a
 * real TURN Allocate and writes turn.json atomically.
 */
import * as fs from "fs";
import * as path from "path";
import type { Page } from "puppeteer-core";
import { closeSignupBrowser, launchSignupBrowser, type LaunchedBrowser } from "./browser";
import { makeSignupIdentity } from "./data";
import { createMailProvider, loadMailConfig } from "./mail";
import { METERED_RELAY_HOST, runMeteredPostSignup, runMeteredSignup } from "./metered";
import {
  TurnSignupError,
  type MailConfig,
  type MailInbox,
  type SignupPhase,
  type SignupProgress,
  type TurnSignupOptions,
  type TurnSignupResult,
} from "./types";
import { isAbortError, sleep, throwIfAborted } from "./util";

export { loadMailConfig, createMailProvider } from "./mail";
export { METERED_RELAY_HOST } from "./metered";
export { TurnSignupError } from "./types";
export type {
  MailConfig,
  MailInbox,
  MailProvider,
  SignupPhase,
  SignupProgress,
  TurnSignupOptions,
  TurnSignupResult,
} from "./types";

const DEFAULTS = {
  attempts: 5,
  stepTimeoutMs: 30_000,
  signupTimeoutMs: 45_000,
  emailTimeoutMs: 120_000,
  retryDelayMs: 5_000,
};

export async function runTurnSignup(options: TurnSignupOptions = {}): Promise<TurnSignupResult> {
  const attempts = clamp(options.attempts ?? DEFAULTS.attempts, 1, 10);
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULTS.stepTimeoutMs;
  const signupTimeoutMs = options.signupTimeoutMs ?? DEFAULTS.signupTimeoutMs;
  const emailTimeoutMs = options.emailTimeoutMs ?? DEFAULTS.emailTimeoutMs;
  const retryDelayMs = options.retryDelayMs ?? DEFAULTS.retryDelayMs;
  const signal = options.signal;

  const runDir = path.join(
    options.logDir ?? path.join(process.cwd(), "turn-signup-logs"),
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const logFile = path.join(runDir, "flow.log");
  ensureDir(runDir);

  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    try {
      fs.appendFileSync(logFile, stamped + "\n", "utf8");
    } catch {
      // logging must never take the flow down
    }
    if (process.env.REMOTEX_TURN_DEBUG) console.log(`[turn-signup] ${line}`);
  };

  const mailConfig: MailConfig = options.mail ?? loadMailConfig();
  const mailProvider = createMailProvider(mailConfig);
  log(`mail provider: ${mailProvider.name}`);
  log(`browser profile: fresh temporary profile per signup attempt`);

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfAborted(signal);
    if (lastError) {
      log(`signup attempt ${attempt}/${attempts} starts in ${Math.round(retryDelayMs / 1000)} s after: ${errorText(lastError)}`);
      await sleep(retryDelayMs, signal);
    }

    const progress = (phase: SignupPhase, message: string) => {
      const p: SignupProgress = { phase, message, attempt, maxAttempts: attempts };
      log(`attempt ${attempt}/${attempts} · ${phase} · ${message}`);
      try {
        options.onProgress?.(p);
      } catch (err) {
        log(`progress callback failed: ${errorText(err)}`);
      }
    };

    let inbox: MailInbox | null = null;
    let launched: LaunchedBrowser | null = null;
    let page: Page | null = null;
    let signupAccepted = false;
    const attemptDir = path.join(runDir, `attempt-${attempt}`);

    try {
      progress("mailbox", `Creating a fresh inbox for signup attempt ${attempt}…`);
      inbox = await mailProvider.createInbox(signal);
      const identity = makeSignupIdentity(inbox.address);
      log(`inbox: ${maskEmail(inbox.address)}`);

      progress("browser", "Starting a clean browser profile…");
      launched = await launchSignupBrowser(options.headed === true);
      page = launched.page;
      attachPageLogging(page, log);

      progress("signup", "Creating a Metered account…");
      await runMeteredSignup({
        page,
        identity,
        stepTimeoutMs,
        signupTimeoutMs,
        signal,
        onStep: (message) => progress("signup", message),
      });
      signupAccepted = true;
      progress("signup", "Metered accepted the signup — verifying the email…");

      const credential = await runMeteredPostSignup({
        page,
        identity,
        stepTimeoutMs,
        signupTimeoutMs,
        signal,
        onStep: (message) => progress(phaseForStep(message), message),
        waitForVerification: () => inbox!.waitForVerification(emailTimeoutMs, signal),
      });

      log(`setup succeeded on signup attempt ${attempt} (username length ${credential.username.length})`);
      progress("done", "Credentials extracted — testing the relay next…");
      return {
        username: credential.username,
        credential: credential.credential,
        urls: credential.urls,
        email: inbox.address,
        attempts: attempt,
      };
    } catch (err) {
      lastError = err;

      if (isAbortError(err) || signal?.aborted) {
        log(`attempt ${attempt} cancelled${signupAccepted ? " after the account was created" : ""}`);
        throw new TurnSignupError("TURN setup was cancelled", {
          attempt,
          logDir: runDir,
          cancelled: true,
          cause: err,
        });
      }

      const message = errorText(err);
      const canRetrySignup = !signupAccepted && attempt < attempts;
      log(
        `${signupAccepted ? "post-signup" : "signup"} attempt ${attempt} failed${canRetrySignup ? " — retrying with fresh data" : ""}: ${message}`,
      );

      // Capture the page exactly as it failed, but never leave secrets on disk.
      if (page) await dumpFailure(page, attemptDir, message, log);
      else {
        ensureDir(attemptDir);
        writeText(path.join(attemptDir, "error.txt"), message + "\n");
      }

      if (canRetrySignup) continue;

      throw new TurnSignupError(
        signupAccepted
          ? `The Metered account was created, but ${message}`
          : `Automatic setup failed after ${attempts} signup attempts: ${message}`,
        { attempt, logDir: runDir, cause: err },
      );
    } finally {
      if (launched) await closeSignupBrowser(launched);
      if (inbox?.dispose) {
        try {
          await inbox.dispose();
        } catch {
          // provider cleanup is best-effort
        }
      }
    }
  }

  // Unreachable while the catch block throws on the last attempt; kept as a
  // defensive backstop for future changes.
  const detail = errorText(lastError);
  throw new TurnSignupError(`Automatic setup failed after ${attempts} attempts: ${detail}`, {
    attempt: attempts,
    logDir: runDir,
    cause: lastError,
  });
}

function phaseForStep(message: string): SignupPhase {
  const m = message.toLowerCase();
  if (m.includes("verification email") || m.includes("verifying the email")) return "verify-email";
  if (m.includes("signing in") || m.includes("login")) return "login";
  if (m.includes("terms")) return "terms";
  if (m.includes("app")) return "create-app";
  if (m.includes("turn") || m.includes("credential")) return "credentials";
  return "signup";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // the caller still gets the result; logs are best-effort
  }
}

function writeText(file: string, content: string): void {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, content, "utf8");
  } catch {
    // best-effort
  }
}

async function dumpFailure(page: Page, dir: string, message: string, log: (line: string) => void): Promise<void> {
  ensureDir(dir);
  await maskSecretsOnPage(page);
  const url = redactUrl(page.url());
  writeText(path.join(dir, "error.txt"), `URL: ${url}\n${message}\n`);
  try {
    const html = await page.content();
    writeText(path.join(dir, "failure.html"), redactSecrets(html));
  } catch (err) {
    log(`could not save failure HTML: ${errorText(err)}`);
  }
  try {
    await page.screenshot({ path: path.join(dir, "failure.png"), fullPage: true });
    log(`failure screenshot: ${path.join(dir, "failure.png")}`);
  } catch (err) {
    log(`could not save failure screenshot: ${errorText(err)}`);
  }
}

async function maskSecretsOnPage(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const sensitiveSelector = [
        "input[type=password]",
        'input[name="password"]',
        'input[name="retypePassword"]',
        "#field-username",
        "#field-password",
        'input[name="credential"]',
        'input[name="code"]',
      ].join(",");
      document.querySelectorAll<HTMLInputElement>(sensitiveSelector).forEach((input) => {
        if (input.value) input.value = "[redacted]";
      });
      document.querySelectorAll<HTMLElement>("pre, code").forEach((element) => {
        const text = element.textContent ?? "";
        if (/turn:|credential|password|token=|verification code/i.test(text)) {
          element.textContent = "[redacted]";
        }
      });
    })
    .catch(() => undefined);
}

function attachPageLogging(page: Page, log: (line: string) => void): void {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") {
      const text = redactSecrets(msg.text()).replace(/\s+/g, " ").slice(0, 300);
      log(`page ${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    log(`page exception: ${redactSecrets(message).slice(0, 300)}`);
  });
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "failed";
    log(`request failed: ${reason} ${redactUrl(req.url()).slice(0, 180)}`);
  });
}

function redactUrl(url: string): string {
  return url.replace(/([?&](token|code|key|password|credential|userId|secret)=)[^&\s]+/gi, "$1[redacted]");
}

function redactSecrets(value: string): string {
  return value
    .replace(/([?&](token|code|key|password|credential|userId|secret)=)[^&\s<"']+/gi, "$1[redacted]")
    .replace(/(<input[^>]*(?:name|id)="(?:password|retypePassword|code|userId|credential)"[^>]*value=")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/"(username|credential|password)"\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"')
    .replace(/verification code is[:\s]*[A-Za-z0-9-]+/gi, "verification code is [redacted]");
}

function errorText(err: unknown): string {
  if (err instanceof Error) return redactSecrets(err.message);
  if (typeof err === "string") return redactSecrets(err);
  return String(err);
}

function maskEmail(address: string): string {
  const at = address.indexOf("@");
  if (at <= 3) return address;
  return `${address.slice(0, 3)}***${address.slice(at)}`;
}
