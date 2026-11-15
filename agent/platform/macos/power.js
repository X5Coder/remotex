/**
 * macOS power management for RemoteX Agent.
 *
 * Two layers:
 *   1. Idle keep-awake — Electron's powerSaveBlocker + a `caffeinate -dims`
 *      child process (blocks idle system/display sleep while alive).
 *   2. LID-CLOSE keep-awake — `pmset -a disablesleep 1` (requires admin;
 *      the only reliable mechanism on macOS). The previous value is read
 *      from `pmset -g` (SleepDisabled), backed up, and restored on exit —
 *      and on next launch, in case of a crash.
 *
 * Caveats (documented in README.md):
 *   - Apple Silicon clamshell-mode officially requires external power +
 *     display; disablesleep works around the idle timer but is not a
 *     supported hardware path.
 *   - `pmset disablesleep` persists across reboots until reset — hence the
 *     backup/restore discipline.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function isAdmin() {
  try {
    if (typeof process.getuid === "function") return process.getuid() === 0;
  } catch { /* ignore */ }
  return false;
}

function backupFile(userData) {
  return path.join(userData, "power-backup-macos.json");
}

function readSleepDisabled() {
  const r = spawnSync("pmset", ["-g"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const m = r.stdout.match(/SleepDisabled\s+(\d)/i);
  return m ? parseInt(m[1], 10) : 0;
}

function restoreStaleBackup(userData) {
  const file = backupFile(userData);
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(saved.disablesleep)) {
      spawnSync("pmset", ["-a", "disablesleep", String(saved.disablesleep)], { encoding: "utf8" });
    }
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports.id = "macos";

/**
 * @param {{ userData: string, log?: (msg: string) => void }} ctx
 */
module.exports.keepAwake = function keepAwake(ctx) {
  const log = ctx.log || (() => {});
  const userData = ctx.userData;

  restoreStaleBackup(userData);

  // Layer 1 — caffeinate child (idle only)
  let caffeinate = null;
  try {
    caffeinate = spawn("caffeinate", ["-dims"], { stdio: "ignore" });
    caffeinate.on("error", () => {});
  } catch { /* caffeinate is always present on macOS — if not, PowerSaveBlocker still covers idle */ }

  const admin = isAdmin();
  if (!admin) {
    return {
      status: "partial",
      detail: "Not elevated (uid != 0): idle sleep is blocked via caffeinate + powerSaveBlocker. Closing the lid will still sleep. Run the agent as root (or via a LaunchDaemon) to block lid-close sleep.",
      isAdmin: false,
      stop() { try { caffeinate && caffeinate.kill("SIGTERM"); } catch { /* ignore */ } },
    };
  }

  const original = readSleepDisabled();
  if (original === null) {
    try { caffeinate && caffeinate.kill("SIGTERM"); } catch { /* ignore */ }
    return {
      status: "unavailable",
      detail: "Could not read pmset state. Idle sleep is still blocked; lid-close is not.",
      isAdmin: true,
      stop() {},
    };
  }

  try {
    fs.writeFileSync(backupFile(userData), JSON.stringify({ disablesleep: original }, null, 2), "utf8");
  } catch {
    try { caffeinate && caffeinate.kill("SIGTERM"); } catch { /* ignore */ }
    return { status: "unavailable", detail: "Could not write the power backup — lid handling disabled for safety.", isAdmin: true, stop() {} };
  }

  const r = spawnSync("pmset", ["-a", "disablesleep", "1"], { encoding: "utf8" });
  if (r.status !== 0) {
    restoreStaleBackup(userData);
    return {
      status: "partial",
      detail: "pmset refused the change. Idle sleep is blocked; lid-close is not.",
      isAdmin: true,
      stop() { try { caffeinate && caffeinate.kill("SIGTERM"); } catch { /* ignore */ } },
    };
  }

  log("macos: pmset disablesleep=1 (was " + original + ")");

  return {
    status: "active",
    detail: "Lid-close sleep is blocked (pmset disablesleep=1). Restored to your previous value when the session ends or the app quits.",
    isAdmin: true,
    stop() {
      restoreStaleBackup(userData);
      try { caffeinate && caffeinate.kill("SIGTERM"); } catch { /* ignore */ }
      log("macos: pmset disablesleep restored, caffeinate stopped");
    },
  };
};
