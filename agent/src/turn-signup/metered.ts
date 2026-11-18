/**
 * The Metered.ca browser flow.
 *
 * The dashboard is a server-rendered Tailwind/Alpine app. The signup button and
 * the verification/TO-DO actions are ordinary submit buttons enhanced by
 * reCAPTCHA v3 and Alpine state bindings, so the automation drives the real
 * page controls instead of reverse-engineering private endpoints.
 *
 * Two hard boundaries are deliberate:
 *   - signup is the only stage that is retried (fresh inbox + fresh profile);
 *   - once the signup has been accepted, any page failure aborts the run.
 * No CAPTCHA is solved, spoofed, or bypassed.
 */
import type { ElementHandle, Page } from "puppeteer-core";
import type { SignupIdentity } from "./data";
import type { VerificationMessage } from "./types";
import { extractVerification } from "./mail";
import { sleep, stripTags, throwIfAborted } from "./util";

export const METERED_SIGNUP_URL = "https://dashboard.metered.ca/signup";
export const METERED_OVERVIEW_URL = "https://dashboard.metered.ca/v2/overview";
export const METERED_TURN_URL = "https://dashboard.metered.ca/v2/turn/credentials";
export const METERED_RELAY_HOST = "global.relay.metered.ca";

const DIALOG_SCOPE = '[role="dialog"], dialog, [class*="modal" i], [class*="drawer" i]';

export interface MeteredFlowContext {
  page: Page;
  identity: SignupIdentity;
  /** Timeout for ordinary page steps. Defaults to 30 s in the caller. */
  stepTimeoutMs: number;
  /** Timeout for the signup POST and its reCAPTCHA. Defaults to 45 s. */
  signupTimeoutMs: number;
  signal?: AbortSignal;
  onStep?: (message: string) => void;
  waitForVerification?: () => Promise<VerificationMessage>;
}

export interface ExtractedCredential {
  username: string;
  credential: string;
  urls: string[];
  /** Full <pre> snippet, kept inside the module so main.ts can parse the URLs but does not persist it. */
  snippet: string;
}

/** Fill the form and submit once. Throws if the account is not accepted. */
export async function runMeteredSignup(ctx: MeteredFlowContext): Promise<void> {
  const { page, identity, signal } = ctx;
  const step = (message: string) => ctx.onStep?.(message);

  step("Opening the Metered signup page…");
  await prepareSignupPage(page, ctx);

  step("Filling the signup form…");
  await fill(page, "#firstName", identity.firstName);
  await fill(page, "#lastName", identity.lastName);
  await fill(page, "#company", identity.company);
  try {
    await page.select("#companySize", "1-2");
  } catch {
    // A future form may drop the size field; the rest of the form is enough.
  }
  await fill(page, "#email", identity.email);
  // Metered has TWO fields with id="password" (password + retype). Use names.
  await fill(page, 'input[name="password"]', identity.password);
  await fill(page, 'input[name="retypePassword"]', identity.password);

  // reCAPTCHA v3 attaches to the submit button. Give the script a short,
  // slightly human pause to settle, then click the real button so the token
  // callback runs and submits the form.
  await waitForFunction(
    page,
    () => typeof (window as unknown as { grecaptcha?: unknown }).grecaptcha !== "undefined",
    20_000,
    signal,
  ).catch(() => false);
  await sleep(900 + Math.floor(Math.random() * 900), signal);

  step("Waiting for Metered to accept the signup…");
  // Metered may submit with a full navigation or with Alpine's in-place state
  // update; track both instead of relying only on waitForNavigation.
  const nav = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: ctx.signupTimeoutMs }).catch(() => null);
  const clicked = await clickAny(page, ["button.g-recaptcha", 'button[type="SIGNUP"]'], 10_000);
  if (!clicked) throw new Error("the Metered signup button was not found");

  const deadline = Date.now() + ctx.signupTimeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const error = await findSignupError(page);
    if (error) throw new Error(`Metered rejected the signup: ${error}`);
    if (await isSignupComplete(page)) {
      await sleep(800, signal);
      return;
    }
    await sleep(500, signal);
  }
  await nav;
  if (await isSignupComplete(page)) return;

  const hint = (await pageText(page)).slice(0, 600);
  throw new Error(
    `the signup did not complete after ${Math.round(ctx.signupTimeoutMs / 1000)} s ` +
      `(the reCAPTCHA score is the usual cause)${hint ? ` — page said: ${hint}` : ""}`,
  );
}

/** Everything after the account exists. Runs exactly once; failures abort the run. */
export async function runMeteredPostSignup(ctx: MeteredFlowContext): Promise<ExtractedCredential> {
  const step = (message: string) => ctx.onStep?.(message);

  step("Waiting for the verification email…");
  if (!ctx.waitForVerification) throw new Error("the signup flow has no verification-mail source");
  const mail = await ctx.waitForVerification();
  const verification = extractVerification(mail);
  if (!verification.code && !verification.link) {
    throw new Error("the Metered verification email arrived but had no code or link");
  }

  step("Verifying the email address…");
  await verifyEmail(ctx.page, verification, ctx);

  step("Signing in to the dashboard…");
  await ensureDashboard(ctx.page, ctx);

  step("Accepting the terms of service…");
  await acceptTerms(ctx.page, ctx);

  step("Creating a Metered app…");
  await createApp(ctx.page, ctx);

  step("Opening TURN credentials…");
  await openTurnCredentials(ctx.page, ctx);

  step("Creating a TURN credential…");
  const credential = await createTurnCredential(ctx.page, ctx);
  step("TURN credential extracted.");
  return credential;
}

/** TURN/STUN URLs scraped from Metered's snippet. */
export function extractTurnUrls(text: string): string[] {
  const matches = text.match(/(?:turns?|stun):[^\s"'<>\\]+/gi) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[),.;]+$/g, "");
    if (!/^(?:turns?|stun):/i.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function parseSnippetCredential(snippet: string): { username?: string; credential?: string } {
  const valueOf = (key: string): string | undefined => {
    const re = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`, "i");
    return re.exec(snippet)?.[1];
  };
  return {
    username: valueOf("username"),
    credential: valueOf("credential") ?? valueOf("password"),
  };
}

// ------------------------------------------------------------------ pages --

async function prepareSignupPage(page: Page, ctx: MeteredFlowContext): Promise<void> {
  // Pre-set the cookie-consent record so the fixed banner cannot cover the
  // sticky signup button. If the domain cookie is rejected, click Reject below.
  try {
    await page.setCookie({
      name: "metered_cookie_consent",
      value: encodeURIComponent("v1:denied"),
      domain: ".metered.ca",
      path: "/",
      secure: true,
      sameSite: "Lax",
    });
  } catch {
    // Cookie API is best-effort; the banner is dismissed by text as a fallback.
  }

  await goto(page, METERED_SIGNUP_URL, ctx);
  await dismissCookies(page);
  const form = await waitForVisible(page, "#signup-form", ctx.stepTimeoutMs, ctx.signal);
  if (!form) {
    const hint = await pageText(page);
    throw new Error(
      `Metered's signup form did not load${/cloudflare|verify you are human|checking your browser/i.test(hint) ? " (Cloudflare challenge)" : ""}`,
    );
  }
}

async function dismissCookies(page: Page): Promise<void> {
  // The real banner is <button data-mtd-cc="reject">Reject</button>. If a
  // future version changes that, the text fallback still works.
  if (await isVisible(page, '[data-mtd-cc="reject"]')) {
    await clickSelector(page, '[data-mtd-cc="reject"]');
    return;
  }
  await clickByText(page, ["reject"], 1_200, true).catch(() => false);
}

async function verifyEmail(page: Page, verification: { code?: string; link?: string }, ctx: MeteredFlowContext): Promise<void> {
  // The normal path is the 5–6 digit code. A link is only a fallback for a
  // future email template that stops sending the code.
  if (verification.code) {
    const codeSelector = await waitForVisible(
      page,
      'input[name="code"], #code, input[autocomplete="one-time-code"], input[inputmode="numeric"]',
      ctx.stepTimeoutMs,
      ctx.signal,
    );
    if (!codeSelector) {
      if (!verification.link) throw new Error("the email verification page did not show a code field");
    } else {
      await fill(page, codeSelector, verification.code);
      const clicked = await clickScopedButton(page, ["form"], ["verify email", "verify"], false, ctx.signal);
      if (!clicked && !(await submitClosestForm(page, codeSelector))) {
        throw new Error("the email verification form had no submit control");
      }
      await sleep(800, ctx.signal);
    }
  }

  if (!verification.code && verification.link) {
    await goto(page, verification.link, ctx, true);
    await clickByText(page, ["verify email", "verify my email", "confirm email"], 1_500, false, ctx.signal).catch(() => false);
  }

  const deadline = Date.now() + ctx.stepTimeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(ctx.signal);
    if (await isVisible(page, "#login-form")) return;
    if (/\/v2\//i.test(page.url()) && !/verify/i.test(page.url())) return;
    if (await isVisible(page, "#agreedToTos") || await isVisible(page, "#appName")) return;
    const text = await pageText(page);
    if (/email verified|verification successful|you'?re verified|check your email/i.test(text)) return;
    if (/invalid|expired|wrong code|incorrect code/i.test(text)) {
      throw new Error("Metered rejected the email verification code");
    }
    await sleep(500, ctx.signal);
  }
  throw new Error("the email verification did not complete");
}

async function ensureDashboard(page: Page, ctx: MeteredFlowContext): Promise<void> {
  await goto(page, METERED_OVERVIEW_URL, ctx);
  await dismissCookies(page);

  if (await isVisible(page, "#login-form")) {
    await login(page, ctx);
    await goto(page, METERED_OVERVIEW_URL, ctx);
  }

  const authed = await waitForAny(
    page,
    [
      "#agreedToTos",
      "#appName",
      'a[href="/v2/turn/credentials"]',
      'a[href^="/v2/"]',
      "tbody tr:first-child button",
      "#login-form",
    ],
    ctx.stepTimeoutMs,
    ctx.signal,
  );
  if (authed === "#login-form") throw new Error("Metered kept the login form after a successful verification");
  if (!authed) {
    throw new Error("the Metered dashboard did not open after login");
  }
}

async function login(page: Page, ctx: MeteredFlowContext): Promise<void> {
  await fill(page, "#email", ctx.identity.email);
  await fill(page, '#login-form input[name="password"], #login-form input#password, input#password', ctx.identity.password);
  await waitForFunction(
    page,
    () => typeof (window as unknown as { grecaptcha?: unknown }).grecaptcha !== "undefined",
    20_000,
    ctx.signal,
  ).catch(() => false);
  const clicked = await clickAny(page, ["#login-form button.g-recaptcha", "#login-form button[type=\"submit\"]", "button[type=\"submit\"]"], 10_000);
  if (!clicked) throw new Error("the Metered login button was not found");

  const deadline = Date.now() + ctx.signupTimeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(ctx.signal);
    if (!(await isVisible(page, "#login-form"))) return;
    const text = await pageText(page);
    if (/invalid|incorrect|wrong password|not verified/i.test(text)) {
      throw new Error("Metered rejected the login after signup");
    }
    await sleep(500, ctx.signal);
  }
  throw new Error("Metered did not accept the login after signup");
}

async function acceptTerms(page: Page, ctx: MeteredFlowContext): Promise<void> {
  const tos = await waitForVisible(page, "#agreedToTos", 10_000, ctx.signal);
  if (!tos) return; // The account is already past the terms screen.

  const checkbox = await page.$("#agreedToTos");
  if (checkbox) {
    const checked = await checkbox.evaluate((el) => (el as HTMLInputElement).checked).catch(() => false);
    if (!checked) await clickSelector(page, "#agreedToTos");
    await sleep(250, ctx.signal);
  }

  // The button lives inside div[x-data] > form, and stays disabled until the
  // checkbox flips. Do not fall back to an unscoped "Continue" click.
  const clicked = await clickScopedButton(
    page,
    ["div[x-data]", "form"],
    ["agree and continue", "agree & continue", "agree"],
    false,
    ctx.signal,
  );
  if (!clicked && !(await submitClosestForm(page, "#agreedToTos"))) {
    throw new Error('the "Agree and Continue" button was not found');
  }

  const done = await waitForCondition(
    page,
    () => {
      const el = document.querySelector("#agreedToTos");
      if (!el) return true;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden";
    },
    ctx.stepTimeoutMs,
    ctx.signal,
  );
  if (!done) {
    const text = await pageText(page);
    if (/agree|continue|terms/i.test(text)) throw new Error("the terms of service page did not advance after clicking Agree and Continue");
  }
}

async function createApp(page: Page, ctx: MeteredFlowContext): Promise<void> {
  // Metered onboarding may already have created the app for us; do not wait
  // for a field that is not coming. If the page is clearly the app step, wait
  // for the real timeout instead of guessing.
  const pageTextNow = await pageText(page);
  const likelyAppStep = /app/i.test(page.url()) || /create a new app/i.test(pageTextNow);
  const appField = await waitForVisible(page, "#appName", likelyAppStep ? ctx.stepTimeoutMs : 5_000, ctx.signal);
  if (!appField) return;

  await fill(page, "#appName", ctx.identity.appName);
  const clicked = await clickScopedButton(page, ["form"], ["create app"], true, ctx.signal);
  if (!clicked && !(await submitClosestForm(page, "#appName"))) {
    throw new Error('the "Create App" button was not found');
  }

  const done = await waitForCondition(
    page,
    () => {
      const el = document.querySelector("#appName");
      if (!el) return true;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden";
    },
    ctx.stepTimeoutMs,
    ctx.signal,
  );
  if (!done) throw new Error("the app was not created after clicking Create App");
}

async function openTurnCredentials(page: Page, ctx: MeteredFlowContext): Promise<void> {
  await goto(page, METERED_OVERVIEW_URL, ctx);
  await dismissCookies(page);

  if (await isVisible(page, "#login-form")) {
    await login(page, ctx);
    await goto(page, METERED_OVERVIEW_URL, ctx);
  }

  // The TURN page is reached from the dashboard navigation, not by trusting a
  // deep link to survive every onboarding redirect.
  if (!/\/v2\/turn\/credentials/i.test(page.url())) {
    const clicked = await clickHref(page, 'a[href="/v2/turn/credentials"]', ctx.stepTimeoutMs, ctx.signal);
    if (!clicked) {
      // Fall back to the deep link if the nav link is missing but we are still
      // on an authenticated dashboard.
      await goto(page, METERED_TURN_URL, ctx);
    } else {
      await waitForCondition(
        page,
        () => /\/v2\/turn\/credentials|plans|pricing|subscribe|activate-turn|choose a plan/i.test(location.href + " " + (document.body?.innerText ?? "")),
        ctx.stepTimeoutMs,
        ctx.signal,
      );
    }
  }

  await dismissCookies(page);

  // Case A: Metered asks for a plan before activating TURN. The first row is
  // the free plan; its action must read exactly "Select".
  await chooseFreePlan(page, ctx);

  if (/plans|pricing|subscribe|checkout|activate-turn/i.test(page.url())) {
    await goto(page, METERED_TURN_URL, ctx);
  }

  // Case B happens after the plan step or when no plan is required. If the
  // account still has no app, Metered routes us back to the app form.
  if (await isVisible(page, "#appName")) {
    await createApp(page, ctx);
    await goto(page, METERED_TURN_URL, ctx);
  }

  if (!/\/v2\/turn\/credentials/i.test(page.url())) {
    await goto(page, METERED_TURN_URL, ctx);
  }

  const clicked = await clickByText(
    page,
    ["create credential", "create turn credential", "create new credential"],
    ctx.stepTimeoutMs,
    false,
    ctx.signal,
  );
  if (!clicked) throw new Error('the "Create credential" button was not found');
  await sleep(500, ctx.signal);
}

async function chooseFreePlan(page: Page, ctx: MeteredFlowContext): Promise<void> {
  const text = await pageText(page);
  const onPlanPage =
    /choose a plan to activate turn|select (a|your) plan|activate turn/i.test(text) ||
    /plans|pricing|subscribe|checkout|activate-turn/i.test(page.url());
  if (!onPlanPage) return;

  // The free trial plan is the first tier; its action reads exactly "Select".
  // The table is not a <table>, so locate the visible exact-match button.
  const clicked = await clickByText(page, ["Select"], ctx.stepTimeoutMs, true, ctx.signal);

  if (!clicked) {
    const hint = (await pageText(page)).slice(0, 400);
    throw new Error(`the TURN plan page appeared but the first-row "Select" button was not found${hint ? ` — page said: ${hint}` : ""}`);
  }

  await sleep(1_000, ctx.signal);
  // A confirmation sheet may follow the row click. This is optional; do not
  // wait long if there isn't one.
  await clickByText(page, ["confirm", "continue", "subscribe"], 3_000, false, ctx.signal).catch(() => false);
  await waitForCondition(
    page,
    () => !/plans|pricing|subscribe|checkout|activate-turn/i.test(location.href) || !!document.querySelector("a[href=\"/v2/turn/credentials\"]"),
    ctx.stepTimeoutMs,
    ctx.signal,
  );
}

async function createTurnCredential(page: Page, ctx: MeteredFlowContext): Promise<ExtractedCredential> {
  const modalReady = await waitForVisible(
    page,
    [DIALOG_SCOPE, "#field-username", "#field-password"],
    ctx.stepTimeoutMs,
    ctx.signal,
  );

  // The page may open a lightweight name dialog before the credential modal.
  // Submitting that dialog is the mint action; do not click a second,
  // page-level "Create credential" on top of it.
  let nameDialogSubmitted = false;
  if (!(await isVisible(page, "#field-username")) && !(await isVisible(page, "#field-password"))) {
    const nameField = await waitForAny(page, ['input[name="name"]', 'input[placeholder*="name" i]'], 2_000, ctx.signal);
    if (nameField) {
      await fill(page, nameField, "remotex");
      let submitted = await clickScopedButton(page, [DIALOG_SCOPE], ["create credential", "create", "save", "generate"], false, ctx.signal);
      if (!submitted) submitted = await submitClosestForm(page, nameField);
      nameDialogSubmitted = submitted;
      await sleep(800, ctx.signal);
    }
  }

  // If the dialog only rendered a generate/confirm button, click it. If the
  // name dialog already minted the credential, fields are already visible and
  // this step is skipped.
  if (!nameDialogSubmitted && !(await isVisible(page, "#field-username"))) {
    const clicked = await clickScopedButton(page, [DIALOG_SCOPE], ["create credential"], true, ctx.signal);
    if (!clicked) {
      // If the dialog already rendered its result, there may be no second button.
      const alreadyDone = await waitForVisible(page, "#field-username", 2_000, ctx.signal);
      if (!alreadyDone && modalReady) throw new Error('the "Create credential" button inside the dialog was not found');
    }
    await sleep(600, ctx.signal);
  }

  const field = await waitForVisible(page, ["#field-username", "#field-password"], ctx.stepTimeoutMs, ctx.signal);
  if (!field) throw new Error("the TURN credential dialog did not show the credential fields");

  // The password is masked until Reveal is pressed; do not read it before that.
  const revealed = await clickScopedButton(page, [DIALOG_SCOPE, "form"], ["reveal password", "reveal", "show password", "show"], false, ctx.signal);
  if (revealed) await sleep(600, ctx.signal);

  const masked = (value: string) => value.length > 0 && /^[•*·\u2022]+$/.test(value.trim());
  let username = (await visibleInputValue(page, "#field-username")) || (await visibleInputValue(page, 'input[name="username"]'));
  let credential =
    (await visibleInputValue(page, "#field-password")) ||
    (await visibleInputValue(page, 'input[name="password"]')) ||
    (await visibleInputValue(page, 'input[name="credential"]'));
  if (masked(credential)) credential = "";

  const snippet = await readSnippet(page);
  if (!username || !credential) {
    // Newer versions render the full config snippet in a <pre>. Parse it as a
    // fallback (and to get the exact relay URLs the account should use).
    const parsed = parseSnippetCredential(snippet);
    username = username || parsed.username || "";
    credential = credential || parsed.credential || "";
  }

  if (!username || !credential) {
    throw new Error("the TURN credential could not be read");
  }

  let urls = extractTurnUrls(snippet);
  if (urls.length === 0) urls = extractTurnUrls(stripTags(await pageText(page)));
  return { username, credential, urls, snippet };
}

// ---------------------------------------------------------------- helpers --

async function goto(page: Page, url: string, ctx: MeteredFlowContext, optional = false): Promise<void> {
  throwIfAborted(ctx.signal);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: ctx.stepTimeoutMs });
    await dismissCookies(page);
  } catch (err) {
    if (optional) return;
    throw new Error(`could not open ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fill(page: Page, selector: string, value: string): Promise<void> {
  const el = await page.$(selector);
  if (!el) throw new Error(`form field ${selector} was not found`);
  await el.evaluate((node) => (node as HTMLElement).scrollIntoView({ block: "center" })).catch(() => undefined);
  try {
    await el.click({ clickCount: 3 });
  } catch {
    await el.evaluate((node) => (node as HTMLElement).click());
  }
  await page.keyboard.press("Backspace");
  await el.type(value, { delay: 30 });
  const actual = await inputValue(el);
  if (actual !== value) {
    // Some password managers / autofill widgets rewrite the value. Set it
    // directly as a last resort, then fire input/change so Vue/Alpine react.
    await el.evaluate((node, next) => {
      const input = node as HTMLInputElement;
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  }
}

async function clickAny(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      if (await clickSelector(page, selector)) return true;
    }
    await sleep(300);
  }
  return false;
}

async function clickSelector(page: Page, selector: string): Promise<boolean> {
  const el = await page.$(selector);
  if (!el) return false;
  try {
    await el.evaluate((node) => (node as HTMLElement).scrollIntoView({ block: "center" })).catch(() => undefined);
    await el.click();
    return true;
  } catch {
    return el
      .evaluate((node) => {
        (node as HTMLElement).click();
        return true;
      })
      .catch(() => false);
  }
}

async function clickHref(page: Page, selector: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const clicked = await page
      .evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") return false;
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return true;
      }, selector)
      .catch(() => false);
    if (clicked) return true;
    await sleep(300, signal);
  }
  return false;
}

/** Click the best visible, enabled button whose trimmed label matches the wanted list. */
async function clickScopedButton(
  page: Page,
  scopeSelectors: string[],
  texts: string[],
  exact: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const wanted = texts.map((text) => text.toLowerCase().replace(/\s+/g, " ").trim());
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const clicked = await page
      .evaluate(
        (args: { scopes: string[]; wanted: string[]; exact: boolean }) => {
          const visible = (el: HTMLElement) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const enabled = (el: HTMLElement) => {
            if (el instanceof HTMLButtonElement && el.disabled) return false;
            if (el instanceof HTMLInputElement && el.disabled) return false;
            const aria = el.getAttribute("aria-disabled");
            if (aria === "true") return false;
            return true;
          };
          const label = (el: HTMLElement) => {
            const raw = el instanceof HTMLInputElement ? el.value : el.textContent ?? "";
            return raw.replace(/\s+/g, " ").trim().toLowerCase();
          };
          const scopes = args.scopes.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)));
          const candidates = scopes.length > 0 ? scopes : [document.body];
          for (const scope of candidates) {
            const buttons = Array.from(scope.querySelectorAll<HTMLElement>('button,[role="button"],input[type="submit"],input[type="button"]'));
            const match = buttons.find((el) => {
              if (!visible(el) || !enabled(el)) return false;
              const text = label(el);
              return args.wanted.some((want) => (args.exact ? text === want : text.includes(want)));
            });
            if (match) {
              match.scrollIntoView({ block: "center", inline: "center" });
              match.click();
              return true;
            }
          }
          return false;
        },
        { scopes: scopeSelectors, wanted, exact },
      )
      .catch(() => false);
    if (clicked) return true;
    await sleep(300, signal);
  }
  return false;
}

async function clickByText(
  page: Page,
  texts: string[],
  timeoutMs: number,
  exact: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const wanted = texts.map((text) => text.toLowerCase().replace(/\s+/g, " ").trim());
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const clicked = await page
      .evaluate(
        (args: { texts: string[]; exact: boolean }) => {
          const nodes = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button,a,[role="button"],input[type="submit"],input[type="button"]',
            ),
          );
          const label = (el: HTMLElement) => {
            const text = el instanceof HTMLInputElement ? el.value : el.textContent ?? "";
            return text.replace(/\s+/g, " ").trim().toLowerCase();
          };
          const visible = nodes.filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          });
          for (const want of args.texts) {
            const match = visible.find((el) => (args.exact ? label(el) === want : label(el).includes(want)));
            if (match) {
              match.scrollIntoView({ block: "center", inline: "center" });
              match.click();
              return true;
            }
          }
          return false;
        },
        { texts: wanted, exact },
      )
      .catch(() => false);
    if (clicked) return true;
    await sleep(350);
  }
  return false;
}

async function waitForAny(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    for (const selector of selectors) {
      if (await isVisible(page, selector)) return selector;
    }
    await sleep(300, signal);
  }
  return null;
}

async function waitForVisible(
  page: Page,
  selectors: string | string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  return waitForAny(page, Array.isArray(selectors) ? selectors : [selectors], timeoutMs, signal);
}

async function waitForCondition(
  page: Page,
  predicate: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (await page.evaluate(predicate).catch(() => false)) return true;
    await sleep(300, signal);
  }
  return false;
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (!el) return false;
    return await el.isVisible();
  } catch {
    return false;
  }
}

async function waitForFunction(
  page: Page,
  fn: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return waitForCondition(page, fn, timeoutMs, signal);
}

async function inputValue(el: ElementHandle): Promise<string> {
  return el.evaluate((node) => (node as HTMLInputElement).value ?? "").catch(() => "");
}

async function visibleInputValue(page: Page, selector: string): Promise<string> {
  const el = await page.$(selector);
  if (!el) return "";
  if (!(await el.isVisible().catch(() => false))) return "";
  return inputValue(el);
}

async function pageText(page: Page): Promise<string> {
  return page
    .evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim())
    .catch(() => "");
}

async function isSignupComplete(page: Page): Promise<boolean> {
  if (await isVisible(page, 'input[name="code"]')) return true;
  if (/verify|confirm/i.test(page.url())) return true;
  if (await isVisible(page, "#agreedToTos") || (await isVisible(page, "#appName"))) return true;
  if (/\/v2\//i.test(page.url())) return true;
  const text = await pageText(page);
  return /check your (inbox|email)|verification email|confirm your email|email has been sent/i.test(text);
}

async function findSignupError(page: Page): Promise<string | null> {
  const text = await pageText(page);
  if (!text) return null;
  const trimmed = text.length > 900 ? text.slice(0, 900) : text;
  if (
    /already (registered|exists|in use)|email is taken|too many (requests|attempts)|something went wrong|invalid email|re-?captcha (verification|check|failed)|verify you are human/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return null;
}

async function submitClosestForm(page: Page, selector: string): Promise<boolean> {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      const form = el?.closest("form");
      if (!form) return false;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    }, selector)
    .catch(() => false);
}

async function readSnippet(page: Page): Promise<string> {
  const scopedPre = DIALOG_SCOPE.split(",").map((selector) => `${selector.trim()} pre`).join(", ");
  const snippets = await page
    .$$eval(`${scopedPre}, pre`, (nodes) =>
      nodes
        .map((node) => {
          const el = node as HTMLElement;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") {
            return "";
          }
          return el.innerText || el.textContent || "";
        })
        .filter(Boolean),
    )
    .catch(() => [] as string[]);
  const useful = snippets.find((s) => /turn:|username|credential/i.test(s));
  return useful ?? snippets.join("\n");
}

/** Exported for diagnostics. */
export const __meteredInternals = {
  extractTurnUrls,
  parseSnippetCredential,
};
