# macOS — privilege & power model

## What the agent does automatically
1. **Idle keep-awake** (no admin): Electron `powerSaveBlocker` + a `caffeinate -dims` child
   process (prevents idle system and display sleep while the child is alive).
2. **Lid-close keep-awake** (admin required): `pmset -a disablesleep 1` — the only reliable
   mechanism on macOS. The current value is read via `pmset -g` (`SleepDisabled`), backed up to
   `…/power-backup-macos.json`, and restored on exit **and on next launch** (crash recovery).

## Apple Silicon reality (verified, do not promise otherwise)
- Clamshell mode officially requires external power **and** an external display.
- `pmset disablesleep` works around the idle timer on battery too — it is a documented setting,
  but it is not a supported hardware path. If it misbehaves on your machine, the fallback is
  clamshell with display, or a dummy HDMI plug.

## Elevation options (production)
- **SMAppService** (macOS 13+): ship a LaunchDaemon plist + privileged helper, register via
  `SMAppService.daemon(plistName:).register()` — user approves in System Settings → Login Items.
- One-shot: `osascript -e 'do shell script "pmset -a disablesleep 1" with administrator privileges'`
  (an auth dialog each time — fine for occasional use, not per-launch).

## Permissions the app must request from the user
- **Screen Recording** (System Settings → Privacy & Security → Screen Recording) — required for
  capture. The agent opens the pane and asks once.
- **Accessibility** — required for input injection (robotjs uses CGEvent/CoreGraphics events).
- **Cmd+V / Cmd+C** — paste handling uses these (macOS meta key).

## Restore guarantee
`power-backup-macos.json` in userData holds the original `SleepDisabled` value. Deleted only after
a successful restore. Next launch restores first if a backup remains.

## Note on packaging
macOS auto-update requires Developer ID signing + notarization (paid Apple Developer account).
Unsigned builds need right-click → Open. Signing target is a release decision, not a code one.
