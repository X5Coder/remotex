/**
 * RemoteX — TURN sync: ask the Google Apps Script bridge for THIS device's credential.
 *
 * The agent on this machine registers {roomId → turn.json + salted password hash} on
 * every launch (see agent/src/turn-sync.ts and docs/apps-script-turn-sync.gs). Here,
 * at connect time, we hand the roomId + the password the user just typed back to the
 * script — and it answers with the TURN credential for THIS device.
 *
 * Notes:
 *   - transport is a plain GET with credentials in the query (Apps Script 302-redirects
 *     make POST unusable from browsers); the payload is base64url JSON and the password
 *     travels only inside TLS to script.google.com — exactly like the password itself
 *     going to Nostr relays, except E2E-encrypted there vs. server-checked here.
 *   - the script rate-limits WRONG-password attempts per roomId, so the public 6-digit
 *     ID space is not brute-forceable through it.
 *   - ANY failure (offline, script down, PASTE_YOUR_EXEC_URL_HERE left in place, wrong
 *     password, quota) returns null and the session falls back to stored credentials /
 *     ./turn.json / the built-in Open Relay — i.e. today's behavior, unchanged.
 */
const SYNC_EXEC_URL = "https://script.google.com/macros/s/AKfycbyBzqplhVvUhUwvP0pkQdVqG1s414feczzbMg87qfrtwJ8ClFy_YLIS3SJz2Ih9Cln7FQ/exec";

export interface SyncedTurnConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

function syncUrl(payload: string): string {
  return `${SYNC_EXEC_URL}?payload=${payload}`;
}

function b64urlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseSyncResponse(raw: unknown): SyncedTurnConfig | null {
  const data = raw as { ok?: unknown; config?: { urls?: unknown; username?: unknown; credential?: unknown } } | null;
  if (!data || data.ok !== true || !data.config) return null;
  const urls = Array.isArray(data.config.urls)
    ? data.config.urls.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];
  if (urls.length === 0) return null;
  const cfg: SyncedTurnConfig = { urls: urls.slice(0, 5) };
  if (typeof data.config.username === "string" && data.config.username) cfg.username = data.config.username;
  if (typeof data.config.credential === "string" && data.config.credential) cfg.credential = data.config.credential;
  return cfg;
}

/** JSONP call — Apps Script cannot set CORS headers, so a <script> tag is the one reliable transport.
 *  NOTE: Apps Script cold-starts routinely exceed 5 s, so the timeout is generous. The callback is
 *  NEVER deleted before the script has executed — otherwise the response throws
 *  "rxsync_... is not defined" (which is exactly what happened in production). */
function jsonp(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cb = `rxsync_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const script = document.createElement("script");
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      fn();
    };
    const timer = window.setTimeout(() => settle(() => reject(new Error("sync timeout"))), timeoutMs);
    (window as unknown as Record<string, unknown>)[cb] = (data: unknown) => {
      settle(() => resolve(data));
      // the script has now executed — safe to remove
      script.remove();
      delete (window as unknown as Record<string, unknown>)[cb];
    };
    script.onerror = () => settle(() => { script.remove(); reject(new Error("sync unreachable")); });
    script.src = `${url}&callback=${cb}`;
    document.head.appendChild(script);
  });
}

/** True when the bridge URL has been configured (PASTE_YOUR_EXEC_URL_HERE replaced). */
export function syncEnabled(): boolean {
  return !SYNC_EXEC_URL.includes("PASTE_YOUR_EXEC_URL_HERE");
}

export async function fetchSyncedTurn(roomId: string, password: string, timeoutMs = 20_000): Promise<SyncedTurnConfig | null> {
  if (!syncEnabled()) return null;
  try {
    const payload = b64urlEncode(JSON.stringify({ action: "fetch", roomId, password }));
    const raw = await jsonp(syncUrl(payload), timeoutMs);
    return parseSyncResponse(raw);
  } catch {
    return null; // offline / script down / malformed — caller falls back
  }
}
