/**
 * Pluggable mailbox transports for the automatic Metered signup.
 *
 * Default: mail.tm's free REST API — no account, no browser, one disposable
 * address per attempt. A deployment that already has an inbox service can set
 * `provider: "http"` in `<userData>/mail.json` (or the REMOTEX_MAIL_* env vars)
 * and point RemoteX at its create/list endpoints. The signup flow only needs:
 *   - an address it can receive mail on,
 *   - a way to poll that inbox,
 *   - the Metered verification message.
 */
import * as fs from "fs";
import * as path from "path";
import type { HttpMailConfig, MailConfig, MailInbox, MailProvider, MailTmConfig, MaildropConfig, VerificationMessage } from "./types";
import {
  expandUrl,
  fetchWithTimeout,
  normalizeText,
  randomToken,
  readJson,
  sleep,
  stripTags,
  throwIfAborted,
} from "./util";

const MAIL_CONFIG_FILE = "mail.json";
const DEFAULT_MAILTM_BASE = "https://api.mail.tm";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a mail config file, then env overrides, then the mail.tm default. */
export function loadMailConfig(userDataDir?: string, configFile?: string): MailConfig {
  let fromFile: Partial<MailConfig> = {};
  const file = configFile ?? (userDataDir ? path.join(userDataDir, MAIL_CONFIG_FILE) : undefined);
  if (file) {
    try {
      if (configFile && !fs.existsSync(file)) {
        throw new Error(`mail config file not found: ${file}`);
      }
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        const rec = asRecord(parsed);
        if (rec) fromFile = rec as unknown as Partial<MailConfig>;
      }
    } catch (err) {
      throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const envProvider = (process.env.REMOTEX_MAIL_PROVIDER ?? "").trim().toLowerCase();
  const provider = (envProvider || asString((fromFile as Record<string, unknown>).provider) || "mailtm").toLowerCase();

  if (provider === "maildrop") {
    const apiUrl = asString(process.env.REMOTEX_MAIL_API_URL) ?? asString((fromFile as Record<string, unknown>).apiUrl);
    const domain = asString(process.env.REMOTEX_MAIL_DOMAIN) ?? asString((fromFile as Record<string, unknown>).domain);
    const cfg: MaildropConfig = {
      provider: "maildrop",
      ...(apiUrl ? { apiUrl } : {}),
      ...(domain ? { domain } : {}),
    };
    return cfg;
  }

  if (provider === "http") {
    const createUrl = asString(process.env.REMOTEX_MAIL_CREATE_URL) ?? asString((fromFile as Record<string, unknown>).createUrl);
    const messagesUrl = asString(process.env.REMOTEX_MAIL_MESSAGES_URL) ?? asString((fromFile as Record<string, unknown>).messagesUrl);
    const messageUrl = asString(process.env.REMOTEX_MAIL_MESSAGE_URL) ?? asString((fromFile as Record<string, unknown>).messageUrl);
    if (!createUrl || !messagesUrl) {
      throw new Error(
        "HTTP mail provider needs REMOTEX_MAIL_CREATE_URL and REMOTEX_MAIL_MESSAGES_URL " +
          "(or createUrl/messagesUrl in <userData>/mail.json)",
      );
    }
    let headers = asRecord((fromFile as Record<string, unknown>).headers) as Record<string, string> | undefined;
    if (process.env.REMOTEX_MAIL_HEADERS) {
      try {
        headers = JSON.parse(process.env.REMOTEX_MAIL_HEADERS) as Record<string, string>;
      } catch {
        throw new Error("REMOTEX_MAIL_HEADERS is not valid JSON");
      }
    }
    const auth = asString(process.env.REMOTEX_MAIL_AUTH);
    if (auth) headers = { ...(headers ?? {}), Authorization: auth };
    const cfg: HttpMailConfig = {
      provider: "http",
      createUrl,
      messagesUrl,
      ...(messageUrl ? { messageUrl } : {}),
      ...(headers ? { headers } : {}),
    };
    return cfg;
  }

  const apiBase = asString(process.env.REMOTEX_MAIL_API_BASE) ?? asString((fromFile as Record<string, unknown>).apiBase);
  const domain = asString(process.env.REMOTEX_MAIL_DOMAIN) ?? asString((fromFile as Record<string, unknown>).domain);
  const cfg: MailTmConfig = {
    provider: "mailtm",
    ...(apiBase ? { apiBase } : {}),
    ...(domain ? { domain } : {}),
  };
  return cfg;
}

export function createMailProvider(config: MailConfig): MailProvider {
  if (config.provider === "http") return new HttpMailProvider(config);
  if (config.provider === "maildrop") return new MaildropProvider(config);
  return new MailTmProvider(config);
}

// ------------------------------------------------------------------ mail.tm --

interface MailTmMessage {
  id?: unknown;
  from?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  createdAt?: unknown;
}

class MailTmProvider implements MailProvider {
  readonly name = "mail.tm";
  private readonly base: string;
  private readonly fixedDomain?: string;
  private domain: string | null = null;

  constructor(config: MailTmConfig) {
    this.base = (config.apiBase ?? DEFAULT_MAILTM_BASE).replace(/\/+$/, "");
    this.fixedDomain = config.domain;
  }

  async createInbox(signal?: AbortSignal): Promise<MailInbox> {
    const domain = this.fixedDomain ?? (await this.pickDomain(signal));
    let address = "";
    let password = "";
    let lastError: unknown = null;

    // A freshly generated local part can collide; retry a few times before
    // giving up on this provider.
    for (let i = 0; i < 4; i++) {
      const local = `remotex${Date.now().toString(36)}${randomToken(4)}`;
      address = `${local}@${domain}`.toLowerCase();
      password = `Rx-${randomToken(20, "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")}!`;
      try {
        const res = await fetchWithTimeout(
          `${this.base}/accounts`,
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ address, password }),
          },
          20_000,
          signal,
        );
        if (res.ok) break;
        const body = await readJson<{ message?: unknown; "hydra:description"?: unknown }>(res);
        lastError = new Error(
          asString(body?.message) ?? asString(body?.["hydra:description"]) ?? `mail.tm answered HTTP ${res.status}`,
        );
        address = "";
      } catch (err) {
        lastError = err;
        address = "";
      }
      await sleep(700, signal);
    }
    if (!address) {
      throw new Error(`Could not create a mail.tm inbox: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }

    const tokenRes = await fetchWithTimeout(
      `${this.base}/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ address, password }),
      },
      20_000,
      signal,
    );
    const tokenBody = await readJson<{ token?: unknown; message?: unknown }>(tokenRes);
    const token = asString(tokenBody?.token);
    if (!tokenRes.ok || !token) {
      throw new Error(
        `Could not open the mail.tm inbox: ${asString(tokenBody?.message) ?? `HTTP ${tokenRes.status}`}`,
      );
    }

    return new MailTmInbox(this.base, address, token);
  }

  private async pickDomain(signal?: AbortSignal): Promise<string> {
    if (this.domain) return this.domain;
    const res = await fetchWithTimeout(
      `${this.base}/domains`,
      { headers: { accept: "application/json" } },
      20_000,
      signal,
    );
    const body = await readJson<unknown>(res);
    if (!res.ok) throw new Error(`mail.tm domains answered HTTP ${res.status}`);
    const bodyRec = asRecord(body);
    const listRaw = Array.isArray(body) ? body : bodyRec?.["hydra:member"] ?? bodyRec?.member;
    const list = Array.isArray(listRaw) ? listRaw : [];
    const domains = list
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .filter((item) => item.isActive !== false && item.isPrivate !== true)
      .map((item) => asString(item.domain))
      .filter((d): d is string => !!d);
    const domain = domains[0];
    if (!domain) throw new Error("mail.tm returned no active public domain");
    this.domain = domain;
    return domain;
  }
}

class MailTmInbox implements MailInbox {
  private readonly seen = new Set<string>();

  constructor(
    private readonly base: string,
    readonly address: string,
    private readonly token: string,
  ) {}

  async waitForVerification(timeoutMs: number, signal?: AbortSignal): Promise<VerificationMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const res = await fetchWithTimeout(
        `${this.base}/messages?page=1`,
        { headers: { accept: "application/json", authorization: `Bearer ${this.token}` } },
        20_000,
        signal,
      );
      const body = await readJson<unknown>(res);
      if (res.ok) {
        const bodyRec = asRecord(body);
        const listRaw = Array.isArray(body) ? body : bodyRec?.["hydra:member"] ?? bodyRec?.member;
        const list = sortNewestFirst(Array.isArray(listRaw) ? listRaw : []);
        for (const raw of list) {
          const summary = asRecord(raw);
          if (!summary) continue;
          const id = asString(summary.id);
          if (!id || this.seen.has(id)) continue;
          const from = fromAddress(summary.from);
          const subject = normalizeText(summary.subject);
          if (!looksLikeMeteredMail(from, subject)) continue;
          const detail = await this.fetchMessage(id, signal);
          if (detail) {
            this.seen.add(id);
            if (hasVerificationContent(detail)) return detail;
          }
        }
      }
      await sleep(2_500, signal);
    }
    throw new Error(`No Metered verification email arrived within ${Math.round(timeoutMs / 1000)} s`);
  }

  private async fetchMessage(id: string, signal?: AbortSignal): Promise<VerificationMessage | null> {
    const res = await fetchWithTimeout(
      `${this.base}/messages/${encodeURIComponent(id)}`,
      { headers: { accept: "application/json", authorization: `Bearer ${this.token}` } },
      20_000,
      signal,
    );
    const msg = await readJson<MailTmMessage>(res);
    if (!res.ok || !msg) return null;
    return {
      from: fromAddress(msg.from),
      subject: normalizeText(msg.subject),
      text: normalizeText(msg.text),
      html: normalizeText(msg.html),
      receivedAt: asString(msg.createdAt) ?? "",
    };
  }
}

// ------------------------------------------------------------------ maildrop --

/**
 * Maildrop (maildrop.cc) is a free, keyless public inbox. Any random local
 * part works without registration; the same GraphQL endpoint lists messages
 * and reads a full message. It is rate limited but usable for a one-off
 * Metered signup verification.
 */
class MaildropProvider implements MailProvider {
  readonly name = "maildrop";
  private readonly base: string;
  private readonly domain: string;

  constructor(config: MaildropConfig) {
    this.base = (config.apiUrl ?? "https://api.maildrop.cc/graphql").trim();
    this.domain = (config.domain ?? "maildrop.cc").replace(/^@/, "").toLowerCase();
  }

  async createInbox(): Promise<MailInbox> {
    const local = `rx${Date.now().toString(36)}${randomToken(6)}`.toLowerCase();
    return new MaildropInbox(this.base, local, `${local}@${this.domain}`);
  }
}

class MaildropInbox implements MailInbox {
  private readonly seen = new Set<string>();

  constructor(
    private readonly base: string,
    private readonly mailbox: string,
    readonly address: string,
  ) {}

  async waitForVerification(timeoutMs: number, signal?: AbortSignal): Promise<VerificationMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const data = await this.gql<{ inbox?: unknown[] }>(
        "query Inbox($mailbox: String!) { inbox(mailbox: $mailbox) { id mailfrom headerfrom subject date } }",
        { mailbox: this.mailbox },
        signal,
      );
      const messages = sortNewestFirst(Array.isArray(data.inbox) ? data.inbox : []);
      for (const raw of messages) {
        const summary = asRecord(raw);
        if (!summary) continue;
        const id = asString(summary.id);
        if (!id || this.seen.has(id)) continue;
        const from = fromAddress(summary.headerfrom) || fromAddress(summary.mailfrom);
        const subject = normalizeText(summary.subject);
        if (!looksLikeMeteredMail(from, subject)) {
          this.seen.add(id);
          continue;
        }
        const detail = await this.gql<{ message?: Record<string, unknown> }>(
          "query Message($mailbox: String!, $id: String!) { message(mailbox: $mailbox, id: $id) { id mailfrom headerfrom subject date data html } }",
          { mailbox: this.mailbox, id },
          signal,
        );
        const message = asRecord(detail.message);
        this.seen.add(id);
        if (!message) continue;
        const full: VerificationMessage = {
          from: fromAddress(message.headerfrom) || fromAddress(message.mailfrom) || from,
          subject: normalizeText(message.subject) || subject,
          text: normalizeText(message.data),
          html: normalizeText(message.html),
          receivedAt: asString(message.date) ?? "",
        };
        if (hasVerificationContent(full)) return full;
      }
      await sleep(2_500, signal);
    }
    throw new Error(`No Metered verification email arrived within ${Math.round(timeoutMs / 1000)} s`);
  }

  private async gql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetchWithTimeout(
      this.base,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
      },
      20_000,
      signal,
    );
    const body = await readJson<{ data?: T; errors?: Array<{ message?: unknown }> }>(res);
    const error = body?.errors?.[0];
    const errorMessage = asString(error?.message);
    if (!res.ok || !body?.data || errorMessage) {
      throw new Error(`Maildrop returned ${errorMessage ?? `HTTP ${res.status}`}`);
    }
    return body.data;
  }
}

// -------------------------------------------------------------- custom HTTP --

class HttpMailProvider implements MailProvider {
  readonly name = "custom HTTP inbox";

  constructor(private readonly config: HttpMailConfig) {}

  async createInbox(signal?: AbortSignal): Promise<MailInbox> {
    const res = await fetchWithTimeout(
      this.config.createUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(this.config.headers ?? {}) },
        body: JSON.stringify({ purpose: "remotex-turn-signup" }),
      },
      20_000,
      signal,
    );
    const body = await readJson<Record<string, unknown>>(res);
    const data = asRecord(body?.data);
    const address =
      asString(body?.address) ??
      asString(body?.email) ??
      asString(data?.address) ??
      asString(data?.email);
    if (!res.ok || !address) {
      throw new Error(
        `Custom mail provider could not create an inbox: ${asString(body?.message) ?? `HTTP ${res.status}`}`,
      );
    }
    return new HttpInbox(this.config, address);
  }
}

class HttpInbox implements MailInbox {
  private readonly seen = new Set<string>();

  constructor(
    private readonly config: HttpMailConfig,
    readonly address: string,
  ) {}

  async waitForVerification(timeoutMs: number, signal?: AbortSignal): Promise<VerificationMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const url = expandUrl(this.config.messagesUrl, { address: this.address });
      const res = await fetchWithTimeout(
        url,
        { headers: { accept: "application/json", ...(this.config.headers ?? {}) } },
        20_000,
        signal,
      );
      const body = await readJson<unknown>(res);
      if (res.ok) {
        const messages = sortNewestFirst(normalizeMessages(body));
        for (const raw of messages) {
          const rec = asRecord(raw);
          if (!rec) continue;
          const id =
            asString(rec.id) ??
            asString(rec.messageId) ??
            asString(rec.uid) ??
            asString(rec.createdAt) ??
            JSON.stringify(rec).slice(0, 80);
          if (!id || this.seen.has(id)) continue;
          const from = fromAddress(rec.from ?? rec.sender);
          const subject = normalizeText(rec.subject);
          if (!looksLikeMeteredMail(from, subject)) continue;

          let detail = rec;
          const hasBody = normalizeText(rec.text) || normalizeText(rec.html);
          if (!hasBody && this.config.messageUrl) {
            const detailRes = await fetchWithTimeout(
              expandUrl(this.config.messageUrl, { id, address: this.address }),
              { headers: { accept: "application/json", ...(this.config.headers ?? {}) } },
              20_000,
              signal,
            );
            const detailBody = await readJson<unknown>(detailRes);
            const detailRec = asRecord(detailBody);
            const nested = asRecord(detailRec?.data);
            detail = nested ?? detailRec ?? rec;
          }
          this.seen.add(id);
          const message: VerificationMessage = {
            from: fromAddress(detail.from ?? detail.sender ?? rec.from),
            subject: normalizeText(detail.subject ?? rec.subject),
            text: normalizeText(detail.text ?? rec.text ?? detail.body),
            html: normalizeText(detail.html ?? rec.html),
            receivedAt: asString(detail.createdAt ?? rec.createdAt) ?? "",
          };
          if (hasVerificationContent(message)) return message;
        }
      }
      await sleep(2_500, signal);
    }
    throw new Error(`No Metered verification email arrived within ${Math.round(timeoutMs / 1000)} s`);
  }
}

function normalizeMessages(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const rec = asRecord(body);
  if (!rec) return [];
  if (Array.isArray(rec.messages)) return rec.messages;
  if (Array.isArray(rec.items)) return rec.items;
  const data = rec.data;
  if (Array.isArray(data)) return data;
  const dataRec = asRecord(data);
  if (dataRec && Array.isArray(dataRec.messages)) return dataRec.messages;
  // A provider may return one full message object for a filtered inbox.
  if (rec.id || rec.subject || rec.from || rec.html || rec.text) return [rec];
  return [];
}

function fromAddress(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (rec) {
    return asString(rec.address) ?? asString(rec.email) ?? asString(rec.value) ?? normalizeText(rec.name);
  }
  if (Array.isArray(value)) {
    return value.map((v) => fromAddress(v)).filter(Boolean).join(", ");
  }
  return "";
}

function looksLikeMeteredMail(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  // The expected sender/subject pair is donotreply@metered.ca +
  // "Metered Email Verification Code". Accept the Metered family loosely for
  // robustness, but do not accept any unrelated email that merely says "code".
  const senderIsMetered = /@([^>\s]+\.)?metered\.ca\b/i.test(fromLower) || fromLower.includes("metered.ca");
  const subjectIsVerification = /metered.*verification.*code|verification.*code/i.test(subjectLower);
  if (senderIsMetered && subjectIsVerification) return true;
  if (senderIsMetered) return true;
  return subjectLower.includes("metered") && subjectLower.includes("verification");
}

/** Sort raw message objects newest-first using common date fields. */
function sortNewestFirst(items: unknown[]): unknown[] {
  const toTime = (value: unknown): number => {
    const record = asRecord(value);
    const raw = record?.createdAt ?? record?.date ?? record?.receivedAt ?? record?.timestamp ?? record?.id;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw < 1e12 ? raw * 1000 : raw;
    }
    if (typeof raw === "string") {
      const asNumber = Number(raw);
      if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
      const parsed = Date.parse(raw);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  };
  return [...items].sort((a, b) => toTime(b) - toTime(a));
}

// ------------------------------------------------------------- extraction --

export interface ExtractedVerification {
  code?: string;
  link?: string;
}

function hasVerificationContent(msg: VerificationMessage): boolean {
  const verification = extractVerification(msg);
  return Boolean(verification.code || verification.link);
}

/**
 * Pull the verification link/code out of a Metered email. The link is
 * restricted to metered.ca hosts — an email is untrusted input, and the
 * automation must never be steered to an arbitrary site.
 */
export function extractVerification(msg: VerificationMessage): ExtractedVerification {
  const html = msg.html || "";
  const text = msg.text || stripTags(html);
  const link = findMeteredLink(html) ?? findMeteredLink(text);

  const haystack = `${text}\n${stripTags(html)}`;
  // The expected wording is "... verification code is: 483920". Prefer a
  // 5–6 digit code from that sentence, then any other 5–6 digit code.
  const patterns = [
    /verification\s+code\s+is\s*:?\s*(\d{5,6})/i,
    /verification\s+code[:\s]+(\d{5,6})/i,
    /\bcode[:\s]+(\d{5,6})\b/i,
    /\b(\d{6})\b/,
    /\b(\d{5})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(haystack);
    if (m?.[1]) return { code: m[1], ...(link ? { link } : {}) };
  }
  return link ? { link } : {};
}

function findMeteredLink(input: string): string | undefined {
  if (!input) return undefined;
  const hrefs: string[] = [];
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(input)) !== null) {
    if (m[1]) hrefs.push(decodeHtml(m[1]));
  }
  const bareRe = /https?:\/\/[^\s<>"')]+/gi;
  while ((m = bareRe.exec(input)) !== null) {
    if (m[0]) hrefs.push(decodeHtml(m[0]));
  }
  let best: { url: string; score: number } = { url: "", score: 0 };
  for (const raw of hrefs) {
    try {
      const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
      if (url.protocol !== "https:") continue;
      const host = url.hostname.toLowerCase();
      if (host !== "metered.ca" && !host.endsWith(".metered.ca")) continue;
      const haystack = `${url.pathname}${url.search}`.toLowerCase();
      // The email contains a logo, footer, privacy and unsubscribe links too.
      // Only a link that looks like the verification action may be followed.
      if (/unsubscribe|preferences|privacy|terms|login|signup|support/.test(haystack)) continue;
      let score = 0;
      if (/verif|confirm|activat|validate/.test(haystack)) score += 10;
      if (host.startsWith("dashboard.")) score += 3;
      if (/[?&](code|token|key|userId)=/.test(url.search)) score += 3;
      if (score > best.score) best = { url: url.toString(), score };
    } catch {
      // not a URL — keep looking
    }
  }
  return best.url;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Exported for unit tests / diagnostics. */
export const __mailInternals = {
  MailTmProvider,
  HttpMailProvider,
  MaildropProvider,
  extractVerification,
  looksLikeMeteredMail,
  fromAddress,
  normalizeMessages,
  findMeteredLink,
};
