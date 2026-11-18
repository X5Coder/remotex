/**
 * RemoteX — ICE / TURN configuration.
 *
 * The stock app ships with **Open Relay** as the default TURN relay — a
 * free, public relay run by Metered (the Nextcloud Talk static-auth
 * pattern). It needs no account, so RemoteX connects across symmetric NATs
 * (mobile CGNAT, strict office Wi-Fi) out of the box, including the stock
 * GitHub Pages build. It is best-effort: shared capacity, no SLA, no
 * guaranteed speed, and Metered may change or retire the service — the
 * same trade Nextcloud Talk makes.
 *
 * Users with their own TURN credentials drop a `turn.json` instead:
 *   agent:  <userData>/turn.json     (e.g. %APPDATA%\remotex\turn.json)
 *   web:    turn.json next to index.html  (or injected at Pages CI time)
 * When that file exists it takes OVER the Open Relay pool entirely:
 *   { "urls": [...], "username": "...", "credential": "..." }
 *
 * The relay knowingly sees only DTLS-SRTP-encrypted packets — it cannot read
 * pixels, input, or the password. Signaling still goes over Nostr relays.
 *
 * Self-contained on purpose: no TextEncoder/btoa (Node tests may run with
 * `--lib ES2020` only), and the only runtime dependency is WebCrypto's
 * `crypto.subtle` for the HMAC-SHA1 static-auth secret.
 */

export interface TurnConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

const OPEN_RELAY_SECRET = "openrelayprojectsecret";
const OPEN_RELAY_URLS = [
  "turn:staticauth.openrelay.metered.ca:80",
  "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
  "turn:staticauth.openrelay.metered.ca:443",
  "turn:staticauth.openrelay.metered.ca:443?transport=tcp",
  "turns:staticauth.openrelay.metered.ca:443?transport=tcp", // TLS — survives deep-packet-inspection firewalls
];
const OPEN_RELAY_TTL_S = 24 * 60 * 60; // credential valid for 24 h from the join

/** ASCII bytes (both the secret and the username are ASCII). */
function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Minimal base64 encoder — dependency-free so it works identically in Node and every browser. */
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2];
    out += B64[((a & 0x03) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 0x0f) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 0x3f] : "=";
  }
  return out;
}

/** Derive the public Open Relay credentials (static auth: username = expiry timestamp, credential = base64 HMAC-SHA1). */
export async function openRelayTurn(): Promise<TurnConfig> {
  const username = String(Math.floor(Date.now() / 1000) + OPEN_RELAY_TTL_S);
  const c = (globalThis as unknown as {
    crypto?: {
      subtle?: {
        importKey(format: string, keyData: Uint8Array, algorithm: { name: string; hash: string }, extractable: boolean, keyUsages: string[]): Promise<unknown>;
        sign(algorithm: string, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
      };
    };
  }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto (crypto.subtle) unavailable — cannot derive Open Relay credentials");
  const key = await c.subtle.importKey("raw", asciiBytes(OPEN_RELAY_SECRET), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await c.subtle.sign("HMAC", key, asciiBytes(username));
  const credential = base64(new Uint8Array(sig));
  return { urls: [...OPEN_RELAY_URLS], username, credential };
}

/**
 * Merge the user's turn.json with the public default.
 * Rule: the user's file wins outright; otherwise fall back to Open Relay.
 * Returns `undefined` when neither exists — i.e. keep STUN-only P2P as today.
 */
export async function resolveTurnConfig(userCfg: TurnConfig | null | undefined): Promise<TurnConfig[] | undefined> {
  if (userCfg && Array.isArray(userCfg.urls) && userCfg.urls.length > 0) return [userCfg];
  try {
    return [await openRelayTurn()];
  } catch {
    return undefined; // never let a TURN hiccup kill the join — Trystero still has host/srflx + Google STUN
  }
}
