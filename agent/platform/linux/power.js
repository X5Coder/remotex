/**
 * Linux power management for RemoteX Agent.
 *
 * Two layers:
 *   1. Idle keep-awake — Electron's powerSaveBlocker (via logind on most DEs).
 *   2. Sleep/lid inhibit — a long-lived `systemd-inhibit --mode=block` child
 *      covering idle, sleep, shutdown and handle-lid-switch. logind honours it
 *      for the whole lifetime of the child process; we kill the child on exit.
 *      No root needed for lid-switch inhibit from the active seat session.
 *      For a hard guarantee, install a logind.conf drop-in (see README.md).
 */
const { spawn, spawnSync } = require("child_process");

function isAdmin() {
  try {
    if (typeof process.getuid === "function") return process.getuid() === 0;
  } catch { /* ignore */ }
  return false;
}

function hasSystemdInhibit() {
  const r = spawnSync("systemd-inhibit", ["--version"], { encoding: "utf8" });
  return r.status === 0 || r.error == null;
}

module.exports.id = "linux";

/**
 * @param {{ userData: string, log?: (msg: string) => void }} ctx
 */
module.exports.keepAwake = function keepAwake(ctx) {
  const log = ctx.log || (() => {});
  const admin = isAdmin();

  if (!hasSystemdInhibit()) {
    return {
      status: "unavailable",
      detail: "systemd-inhibit not found. Idle sleep is blocked via powerSaveBlocker; sleep/lid are not. See platform/linux/README.md.",
      isAdmin: admin,
      stop() {},
    };
  }

  // If running as root (AgentLaunched via pkexec), the inhibit may need to be
  // taken before privilege drop; from a user session this just works.
  const child = spawn(
    "systemd-inhibit",
    ["--what=idle:sleep:shutdown:handle-lid-switch", "--mode=block", "--who=RemoteX Agent", "--why=Remote control session", "sleep", "infinity"],
    { stdio: "ignore" }
  );

  child.on("error", (err) => log("systemd-inhibit error: " + err.message));

  return {
    status: "active",
    detail: "Sleep and lid-close are inhibited for the whole session (systemd-inhibit --mode=block, who='RemoteX Agent'). Guard lifts automatically when the agent exits.",
    isAdmin: admin,
    stop() {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      log("linux: systemd-inhibit released");
    },
  };
};
