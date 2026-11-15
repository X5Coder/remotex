# Testing RemoteX

## What you can test today (Windows only, this machine)

### 1. Unit tests (no GUI)
```bash
cd protocol && npm test       # 19 tests â€” round-trip, wraparound, chunking, ping/pong
```

### 2. Agent â†’ own-screen smoke test (needs 2 browser-ish peers)
```bash
cd agent && npm start          # window shows Device ID + Password
cd web && npm run dev          # or: npm run preview  (LAN port 4173)
```
Open `http://localhost:5173` in a browser on the SAME machine. Enter Device ID + Password
from the agent window. Expected within ~3 s on LAN: the screen appears, `RTT` pill shows ms,
agent window status flips to "Connected â€” one device is in control".

**Checks:**
- [ ] video appears (primary monitor) at 30â€“60 fps, `statsLine` shows fps + Mbps + encoder
- [ ] tap/click moves the OS cursor (`robotjs` works under your user â€” no admin needed for input)
- [ ] typing sends keys; Arabic text inserts via paste (clipboard)
- [ ] drag scrolls with two fingers on tablet / wheel on desktop
- [ ] agent â†’ client clipboard sync: copy text on the PC, see "Copied to device clipboard" on the page
- [ ] Stop session button drops the page back to the connect screen; reconnecting works immediately
- [ ] close the page â†’ agent status returns to "Waiting for a connectionâ€¦"

### 3. Keep-awake (lid-close) â€” needs ADMIN
- Without admin: agent window shows amber "Not elevatedâ€¦" â€” only idle sleep is blocked.
- With admin (Windows PowerShell as Administrator â†’ `npm start`): shows green
  "Lid-close sleep is blockedâ€¦", `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION` shows `0x00000000` (AC and DC).
  **Quit the agent** â†’ value restored to what it was before.
- **Crash safety:** `%APPDATA%/@remotex/agent/power-backup-windows.json` must be deleted after restore.

## Test matrix (master.md Â§10)

| Area | Windows 11 | Windows 10 | macOS (AS / Intel) | Ubuntu X11 | Ubuntu Wayland |
|------|:---:|:---:|:---:|:---:|:---:|
| capture 1080p30+ | âœ… code-path | âœ… code-path | needs Screen Recording grant | works | ðŸŸ¡ portal picker |
| input injection | âœ… XTest via robotjs | âœ… | needs Accessibility grant | âœ… | âŒ v1 |
| lid-close block | admin (powercfg) | admin (powercfg) | admin (pmset) | seat inhibit | seat inhibit |
| H.264 HW encode | NVENC/QSV via MF | âœ… | VideoToolbox | VA-API | VA-API |

Clients: Android Chrome Â· iPhone Safari (H.264; needs tap to start video) Â· desktop Chrome/Edge/Firefox/Safari.
Networks: same Wi-Fi Â· Wi-Fiâ†’mobile data Â· two ISPs Â· symmetric NAT (expect failure without TURN).
Displays: 1 & 2 monitors Â· DPI 100/150/200 %.

## Known-good smoke: LAN latency targets (master.md Â§0)
- LAN connect â‰¤ 3 s; internet â‰¤ 8 s
- 30 fps floor @1080p (60 target), measured via agent stats line (`outbound-rtp` `framesPerSecond`)
- Click-to-photon â‰¤ 80 ms LAN (measured externally, e.g. hardware timer overlay â€” not yet automated)

## Reporting a failure
Include: agent console output (`[hidden]`, `[status]`, `[power]`, `[input]` lines), browser console,
OS + version, network type, `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION` (Windows).
