/**
 * RemoteX — TURN sync client (optional, per-install, Google Apps Script).
 *
 * What it does
 *   Pushes THIS machine's turn.json + a salted sha256 of the CURRENT launch
 *   password to the Google Apps Script web app (see docs/apps-script-turn-sync.gs),
 *   so the public web client can exchange roomId + password for the credential
 *   at connect time. No human step on any device, ever.
 *
 * Opt-in only
 *   Disabled unless %APPDATA%/remotex/turn-sync.json exists with
 *     { "url": "https://script.google.com/macros/s/.../exec" }
 *   (or env REMOTEX_TURN_SYNC_URL is set — useful for development).
 *   The write key is generated automatically on first enable and stored in the
 *   same file (never leaves the machine except as a sha256 sent to the script).
 *
 * Guarantees
 *   - never throws — sync must never break launch, capture, or a session;
 *   - the password itself is never sent anywhere (only sha256(salt + ':' + pw));
 *   - re-registers on every launch, on password rotation, and after auto-setup.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { verifyTurn } from "./turn-verify";

export interface TurnSyncConfig {
  url: string;
  writeKey: string;
}

interface SyncFile {
  url?: unknown;
  writeKey?: unknown;
}

function readJsonFile(file: string): SyncFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SyncFile;
  } catch {
    return null;
  }
}

function writeJsonFile(file: string, value: SyncFile): boolean {
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function isValidExecUrl(url: string): boolean {
  return /^https:\/\/script\.google(usercontent)?\.com\/macros\/s\/[^/\s]+\/exec\/?$/.test(url.trim());
}

export function syncFilePath(userData: string): string {
  return path.join(userData, "turn-sync.json");
}

/** Load the sync config (creating the write key on first enable), or null when disabled. */
export function loadTurnSyncConfig(userData: string): TurnSyncConfig | null {
  const file = syncFilePath(userData);
  const fromFile = readJsonFile(file);
  const envUrl = process.env.REMOTEX_TURN_SYNC_URL?.trim() ?? "";
  const url = (typeof fromFile?.url === "string" && fromFile.url.trim()) || envUrl;
  if (!url || !isValidExecUrl(url)) return null;

  let writeKey = typeof fromFile?.writeKey === "string" ? fromFile.writeKey : "";
  if (!/^[0-9a-f]{64}$/i.test(writeKey)) {
    writeKey = crypto.randomBytes(32).toString("hex");
    if (!writeJsonFile(file, { url, writeKey })) {
      console.warn("[turn-sync] could not persist the write key — sync stays enabled for this run only");
    }
    console.log("[turn-sync] enabled — write key generated");
  }
  return { url: url.trim(), writeKey: writeKey.toLowerCase() };
}

function readTurnJson(userData: string): { urls: string[]; username: string; credential: string } | null {
  try {
    const raw = fs.readFileSync(path.join(userData, "turn.json"), "utf8");
    const j = JSON.parse(raw) as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = Array.isArray(j?.urls)
      ? j.urls.filter((u): u is string => typeof u === "string" && u.length > 0)
      : typeof j?.urls === "string" && j.urls
        ? [j.urls]
        : [];
    if (urls.length === 0) return null;
    return {
      urls: urls.slice(0, 5),
      username: typeof j.username === "string" ? j.username : "",
      credential: typeof j.credential === "string" ? j.credential : "",
    };
  } catch {
    return null;
  }
}

/** base64url without padding — same alphabet the Apps Script decodes. */
function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function callSyncScript(cfg: TurnSyncConfig, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `${cfg.url}?payload=${b64urlJson(body)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register (or refresh) the binding roomId → credential with the current password hash.
 * Safe to call any time; silently no-ops when sync is disabled or turn.json is missing.
 */
export async function syncTurnNow(userData: string, roomId: string, password: string): Promise<void> {
  try {
    const cfg = loadTurnSyncConfig(userData);
    if (!cfg) return;
    const turn = readTurnJson(userData);
    if (!turn) {
      console.log("[turn-sync] skipped — turn.json not ready yet");
      return;
    }
    const salt = crypto.randomBytes(16).toString("base64url");
    const pwh = crypto.createHash("sha256").update(`${salt}:${password}`, "utf8").digest("hex");
    const result = await callSyncScript(cfg, {
      action: "register",
      roomId,
      writeKey: cfg.writeKey,
      salt,
      pwh,
      urls: turn.urls,
      username: turn.username,
      credential: turn.credential,
    });
    if (result?.ok) {
      console.log("[turn-sync] device registered — the site can fetch this relay automatically");
    } else {
      console.warn("[turn-sync] registration refused:", String(result?.error ?? "no response"));
    }
  } catch (err) {
    console.warn("[turn-sync] sync failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Launch-time credential check. A Metered credential can only be proven by a real
 * TURN Allocate — there is NO metering/consumption endpoint anywhere (neither Google
 * nor Metered exposes one), quota exhaustion shows up only as a refusal. When the
 * relay refuses on two spaced checks (and never as a network timeout), turn.json is
 * marked stale so the existing automatic setup can re-provision it on the next launch.
 */
export async function verifyAndHealTurnJson(userData: string): Promise<"ok" | "stale" | "unknown"> {
  const file = path.join(userData, "turn.json");
  const turn = readTurnJson(userData);
  if (!turn) return "unknown";
  try {
    const first = await verifyTurn(turn.urls, turn.username, turn.credential, 2_500);
    if (first.ok) return "ok";
    if (!/refused/i.test(first.detail)) return "unknown"; // unreachable relay ≠ dead credential
    await new Promise((r) => setTimeout(r, 8_000));
    const second = await verifyTurn(turn.urls, turn.username, turn.credential, 2_500);
    if (second.ok) return "ok";
    if (/refused/i.test(second.detail)) {
      try {
        fs.renameSync(file, file + ".stale");
        console.warn("[turn-sync] turn.json refused twice by the relay — marked stale (remote access re-provisions on next launch)");
        return "stale";
      } catch {
        return "unknown";
      }
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
