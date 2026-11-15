# Windows — privilege & power model (privilege-separated)

## Why the GUI never runs elevated
Chromium's screen capture is broken under elevation: `getDisplayMedia` is refused with
"Could not start video source". So RemoteX runs as a **normal user process** — no UAC on the app itself.

## What happens at launch instead (ONE UAC prompt, optional)
1. RemoteX opens normally (no console/PowerShell window, ever).
2. `platform/windows/power.js` reads the current lid-close setting (`LIDACTION`) — reading needs no admin.
3. It backs the current value up to `%APPDATA%\@remotex\agent\power-backup-windows.json`, then launches a
   **one-shot elevated helper** (a hidden PowerShell that runs three `powercfg` commands and exits):
   `LIDACTION=0` for AC and DC. UAC appears once. The GUI stays unelevated; capture keeps working.
4. If you **decline** the prompt, RemoteX still works — the window honestly shows idle keep-awake is on
   but the lid-close block is not.

On quit, a second one-shot elevated helper restores your previous lid setting. If RemoteX crashed,
the next launch restores the backup first (crash-safe; the backup file is kept until a restore succeeds).

## powercfg helper details
- `SUB_BUTTONS` / `5ca83367-6e45-459f-a27b-476b1d01c936` (LIDACTION)
- AC: `/setacvalueindex`, DC: `/setdcvalueindex` (0 = Do nothing, 1 = Sleep, 2 = Hibernate, 3 = Shutdown)
- Reads are **locale-proof** (works on Arabic/other localized Windows — parses the last two hex values, not English text)

## Related settings that do NOT need admin
- Idle keep-awake: Electron `powerSaveBlocker` (`prevent-display-sleep`, `prevent-app-suspension`).
- `SetThreadExecutionState` cannot override the lid action — that's why the lid path uses powercfg.

## Install / packaging
- The NSIS installer (`perMachine`) elevates at **install time only**; the app installs to Program Files.
- The app itself never requires admin at runtime; elevation is narrowly scoped to the powercfg helper.

## If the UAC prompt never appears
The helper starts minimized/hidden; check your notifications for the consent dialog. If it was declined,
lid-close simply stays off and RemoteX still functions — the agent window tells you exactly what is on/off.
