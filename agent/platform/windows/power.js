/**
 * Windows power management for RemoteX — privilege-separated design.
 *
 * Why not elevate the whole app? Chromium's screen capture is broken under
 * elevation (getDisplayMedia is refused with "Could not start video source"),
 * so the GUI NEVER runs elevated. Instead, the lid-close power operation runs
 * inside a tiny one-shot elevated helper that does its job and exits:
 *
 *   GUI (unelevated)  ── Start-Process -Verb RunAs ──▶  powershell -File helper.ps1
 *                                                          powercfg /set… LIDACTION 0
 *                                                          writes result to a marker file
 *   UAC prompt appears once at launch (and once at quit for restore) — exactly the
 *   "ask first" experience without breaking capture.
 *
 * If the user DECLINES the UAC prompt, the app still works fully EXCEPT the
 * lid-close block (window shows partial/unavailable status honestly).
 *
 * Crash safety: the previous LIDACTION (AC+DC) is backed up to
 * <userData>/power-backup-windows.json BEFORE any change and restored on quit,
 * and on next launch if a previous run died unexpectedly.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LID_GUID = "5ca83367-6e45-459f-a27b-476b1d01c936"; // SUB_BUTTONS / LIDACTION

function run(args) {
  const r = spawnSync("powercfg", args, { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

/** unelevated read — works without admin. Returns {exists:false} when the machine has no lid setting (desktops). */
function readLidValues() {
  const r = run(["/query", "SCHEME_CURRENT", "SUB_BUTTONS", LID_GUID]);
  if (!r.ok) return { exists: false };
  // the query only prints the scheme header when the setting does not exist (e.g. desktops)
  if (!r.out.toLowerCase().includes(LID_GUID.toLowerCase())) return { exists: false };
  // locale-proof: output lists AC hex before DC hex, always the last two 0x… values
  const hexes = [...r.out.matchAll(/0x([0-9a-fA-F]{8})/g)].map((m) => parseInt(m[1], 16));
  if (hexes.length >= 2) return { exists: true, ac: hexes[hexes.length - 2], dc: hexes[hexes.length - 1] };
  return { exists: false };
}

/** write helper ps1 to a temp file, run it elevated, read back its result marker */
function runElevatedHelper(psBody) {
  const stamp = `${process.pid}-${Date.now()}`;
  const file = path.join(os.tmpdir(), `remotex-power-${stamp}.ps1`);
  const marker = `${file}.result`;
  const script = `$ErrorActionPreference = 'Stop'
try {
${psBody}
  'OK' | Out-File -FilePath '${marker.replace(/\\/g, "\\\\")}' -Encoding ascii
} catch {
  Write-Output $_ | Out-File -FilePath '${marker.replace(/\\/g, "\\\\")}' -Encoding ascii
}
`;
  try {
    fs.writeFileSync(file, script, "utf8");
  } catch (err) {
    return { ok: false, error: `could not write helper: ${err.message}` };
  }
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Start-Process -Verb RunAs -Wait -WindowStyle Hidden -ExecutionPolicy Bypass -File "${file}"`],
    { encoding: "utf8", windowsHide: true }
  );
  let result = null;
  try { result = fs.readFileSync(marker, "utf8").trim(); } catch { /* no marker */ }
  try { fs.rmSync(file, { force: true }); fs.rmSync(marker, { force: true }); } catch { /* best effort */ }
  if (r.status !== 0 && !result) return { ok: false, error: "elevation declined or helper failed" };
  return { ok: result === "OK", error: result && result !== "OK" ? result : null };
}

function backupFile(userData) {
  return path.join(userData, "power-backup-windows.json");
}

function backupLidSetting(userData, values) {
  fs.writeFileSync(backupFile(userData), JSON.stringify(values, null, 2), "utf8");
}

function staleBackupExists(userData) {
  try { return fs.statSync(backupFile(userData)).isFile(); } catch { return false; }
}

function restoreStaleBackup(userData) {
  const file = backupFile(userData);
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(saved.ac) || !Number.isFinite(saved.dc)) {
      fs.rmSync(file, { force: true });
      return { ok: false, error: "backup file is corrupt — deleted it" };
    }
    const r = runElevatedHelper(
      `& powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION ${saved.ac}
& powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION ${saved.dc}
& powercfg /setactive SCHEME_CURRENT`
    );
    if (r.ok) fs.rmSync(file, { force: true });
    return r;
  } catch {
    return { ok: false, error: "no stale backup" };
  }
}

module.exports.id = "windows";

/**
 * @param {{ userData: string, log?: (msg: string) => void }} ctx
 */
module.exports.keepAwake = function keepAwake(ctx) {
  const log = ctx.log || (() => {});
  const userData = ctx.userData;

  // 0) crash recovery: restore a stale backup from a previous run before doing anything
  if (staleBackupExists(userData)) {
    log("found stale power backup from an interrupted run — restoring it first");
    restoreStaleBackup(userData);
  }

  // 1) read the current lid action (unelevated)
  const original = readLidValues();
  if (!original.exists) {
    return {
      status: "unavailable",
      detail: "This machine has no lid-close power setting (typical for desktops) — the lid block is not applicable. Idle sleep is still prevented while RemoteX runs.",
      isAdmin: false,
      stop() {},
    };
  }

  // 2) back the current value up BEFORE changing anything
  try {
    backupLidSetting(userData, original);
  } catch {
    return {
      status: "unavailable",
      detail: "Could not write the power backup — lid handling disabled for safety. Idle sleep is still blocked.",
      isAdmin: false,
      stop() {},
    };
  }

  // 3) apply LIDACTION=0 via the one-shot elevated helper (this shows the UAC prompt)
  log("requesting one-shot elevated helper to block lid-close sleep (user may see a UAC prompt)");
  const r = runElevatedHelper(
    `& powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
& powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
& powercfg /setactive SCHEME_CURRENT`
  );

  if (!r.ok) {
    return {
      status: "partial",
      detail: "Lid-close block not active — the admin prompt was declined or failed. Idle sleep is still blocked; closing the lid will sleep normally.",
      isAdmin: false,
      stop() {
        // nothing to restore beyond the backup file, which crash-recovery handles
      },
    };
  }

  log("lid-close action set to 'Do nothing' (AC+DC), previous values backed up");

  return {
    status: "active",
    detail: "Lid-close sleep is blocked (power scheme patched via one-shot admin helper). Your previous setting is restored when you quit, and on next launch after a crash.",
    isAdmin: true,
    stop() {
      const r2 = restoreStaleBackup(userData);
      if (r2.ok) log("windows: lid action restored to previous value");
      else log("windows: restore helper failed — will retry on next launch: " + (r2.error || ""));
    },
  };
};
