# Linux — privilege & power model

## What the agent does automatically
1. **Idle keep-awake**: Electron `powerSaveBlocker` (routes through logind on systemd systems).
2. **Sleep / lid inhibit**: a long-lived child process
   `systemd-inhibit --what=idle:sleep:shutdown:handle-lid-switch --mode=block --who="RemoteX Agent" sleep infinity`.
   logind honours the block for as long as the child lives; the guard lifts automatically on exit.
   Works from the active seat session, no root required.

## Wayland vs X11
- **Capture (X11)**: Chromium/Electron captures the X11 screen directly. Works out of the box.
- **Capture (Wayland)**: requires `xdg-desktop-portal` with a ScreenCast backend
  (`xdg-desktop-portal-gtk` / `-kde` / `-wlr`) + PipeWire. The **portal's own picker** UI appears
  on first capture — the agent gets one source (the user's selection), not monitor enumeration.
  Wayland is therefore documented as *experimental in v1* — same warning as master.md.
- **Input (X11)**: XTest via `@jitsi/robotjs`. Works as your normal user with an X session.
- **Input (Wayland)**: RemoteDesktop portal + libei, or `uinput` (root). Not implemented in v1.
- **Encode**: VA-API (`--enable-features=VaapiVideoEncoder`) where available; x264 software
  fallback is acceptable for 1080p30.

## Hard lid-close guarantee (admin, optional)
`systemd-inhibit` covers the session only. For a machine-wide guarantee, an admin can set
`HandleLidSwitch=ignore` (+ `HandleLidSwitchExternalPower=ignore`) in
`/etc/systemd/logind.conf` and `systemctl restart systemd-logind`. Do not set this from the app —
it's a one-time system change documented here for the sysadmin.

## Packaging notes
- AppImage cannot be setuid — elevation must come from the **host system** (`.deb`/`.rpm` with a
  polkit policy, or pkexec re-exec with a `.policy` file) or a systemd unit + helper.
- v1 keeps the app unprivileged; `handle-lid-switch` inhibit works without root from the seat.
- If you want the root model: ship a `.deb` with a polkit action `com.remotex.agent.keep-awake`
  granting the active user the lid-inhibit, or run a small root helper service. Document at release.

## Restore guarantee
Nothing persistent is changed by default — the inhibit child dies with the app. No restore needed.
