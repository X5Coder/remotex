/**
 * Small, dependency-free helpers shared by the signup flow.
 */
import * as crypto from "crypto";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): Error {
  const err = new Error("RemoteX TURN setup was cancelled");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function randomToken(bytes: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"): string {
  const raw = crypto.randomBytes(bytes);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    out += alphabet[raw[i]! % alphabet.length];
  }
  return out;
}

export function randomPassword(length = 18): string {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*";
  const all = lower + upper + digits + symbols;
  const mandatory = [
    lower[randomInt(lower.length)]!,
    upper[randomInt(upper.length)]!,
    digits[randomInt(digits.length)]!,
    symbols[randomInt(symbols.length)]!,
  ];
  while (mandatory.length < length) mandatory.push(all[randomInt(all.length)]!);
  // Fisher-Yates, seeded by crypto.randomInt.
  for (let i = mandatory.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [mandatory[i], mandatory[j]] = [mandatory[j]!, mandatory[i]!];
  }
  return mandatory.join("");
}

export function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  return crypto.randomInt(0, maxExclusive);
}

export function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)]!;
}

/** fetch() with a hard timeout and outer-signal support. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortError());
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("request timed out")), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function readJson<T>(res: Response): Promise<T | null> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function normalizeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").join("\n");
  return "";
}

export function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Replace {address} / {id} placeholders in a configured provider URL. */
export function expandUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : encodeURIComponent(value);
  });
}
