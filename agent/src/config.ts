/**
 * Agent identity config — stored in app.getPath('userData').
 *
 * Device ID: generated ONCE on first run, saved forever (like a device address).
 * Password : a NEW 6-letter ALL-CAPS password on every launch (26^6 ≈ 308M — short
 *            by user request; entropy is weak, treat as a convenience PIN).
 *            Passed to Trystero as `password` — it encrypts the SDP handshake.
 *            Never stored, never logged.
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface AgentIdentity {
  roomId: string;
  createdAt: string;
}

/** 6 digits, e.g. "482910" — plain numbers only (user request). */
function generateRoomId(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

/** 6 CAPITAL letters, e.g. "KMQQPV" — short by user request (weak by construction!). */
function generatePassword(): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[crypto.randomInt(0, 26)];
  return out;
}

function configPath(): string {
  return path.join(app.getPath("userData"), "remotex-agent.json");
}

export function loadOrCreateIdentity(): AgentIdentity {
  const file = configPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AgentIdentity>;
    if (typeof raw.roomId === "string" && /^\d{6}$/.test(raw.roomId)) {
      return { roomId: raw.roomId, createdAt: raw.createdAt ?? new Date().toISOString() };
    }
    // legacy alphanumeric id → regenerate once as digits-only
  } catch { /* missing/corrupt — regenerate below */ }
  const identity: AgentIdentity = { roomId: generateRoomId(), createdAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(identity, null, 2), "utf8");
  } catch (err) {
    console.error("[config] could not persist Device ID:", err);
  }
  return identity;
}

/**
 * Fresh password for every launch (dev/test override: set REMOTEX_PASSWORD env
 * to pin one — used by automated smoke tests; never set in production builds).
 */
export function createLaunchPassword(): string {
  const pinned = process.env.REMOTEX_PASSWORD;
  if (pinned && /^[A-Z]{6,24}$/.test(pinned)) {
    console.log("[config] password source: env-pinned, length:", pinned.length);
    return pinned;
  }
  if (pinned) console.log("[config] REMOTEX_PASSWORD set but invalid shape — using random");
  return generatePassword();
}

/**
 * On-demand password rotation (the refresh button in the window). Always a fresh
 * random password — never the env pin, so the user can actually roll the dice.
 */
export function regeneratePassword(): string {
  return generatePassword();
}
