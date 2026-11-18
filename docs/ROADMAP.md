# RemoteX — roadmap vs reality

Source of truth for the plan: `master.md` (v4, final). This file tracks **what actually works today**.
Legend: ✅ done · 🟡 partial/wired but unverified · ⬜ not started

## Step 0 — Repo scaffold ✅
`web/`, `protocol/`, `agent/`, `docs/`, MIT license, CI on 3 OSes (`.github/workflows/ci.yml`),
GitHub Pages deploy workflow, release packaging workflow. Not pushed anywhere yet — add the remote,
enable Pages (Settings → Pages → GitHub Actions), and CI goes green.

## Step 1 — Signaling spike 🟡
Trystero is **integrated** (nostr default; mqtt/torrent swap is one import line). Verified:
room join, `maxUsers=2` single session, password-encrypted SDP, `onPeerJoin/Leave`, `onError` codes,
`ping()`, `onPeerStream`. **Not yet measured:** 3 s LAN / 8 s internet connect-time on real networks
(needs two physical machines). Trystero 0.27.0 notes: `onPeerHandshake` is gone (replaced by
`maxUsers` + automatic DTLS-identitied handshake); there is **no unreliable/unordered data channel** —
the fast channel relies on latest-only coalescing over the reliable channel instead.

## Step 2 — Protocol package ✅
`@remotex/protocol`: fast binary messages (move/scroll/cur/ping, big-endian, 7 bytes), 16-bit
sequence wraparound, ctl JSON validation, 16 KB chunking with reassembly, ping/pong echo.
**19 unit tests pass** on 3 OSes in CI (`npm test` in `protocol/`).

## Step 3 — Agent shell ✅ (verify locally)
Electron window shows the permanent Device ID (generated once, saved in userData) and a fresh
random password every launch, connection status, keep-awake status, fps/bitrate telemetry,
"Stop session" (drops the client, re-arms the room), tray icon, single instance. Second peer refused
(seat logic + `maxUsers=2`). **Unverified:** everything that needs a GUI and a second machine.

## Step 4 — Capture & streaming 🟡
Primary screen via `getDisplayMedia` + `setDisplayMediaRequestHandler` (60 fps request,
`contentHint='motion'`), H.264 preferred codec, `maxBitrate` ladder 20/12/8/4 Mbps,
`maxFramerate=60`, `maintain-framerate`, fps-based adaptive down/up-switch, encoder implementation
reported via stats. **Unverified:** real fps on target hardware; Wayland portal path; multi-monitor
(currently captures **primary monitor only**); hidden-cursor capture is impossible on stable Electron
(documented risk #2) — the client draws its predicted cursor, agent corrects it at 10 Hz.

## Step 5 — Input injection 🟡
`@jitsi/robotjs` behind `InputDriver` (`src/input.ts`), absolute normalized mapping, click-on-move
ordering, down/up with physical `code` + modifiers, non-ASCII → clipboard paste, Arabic/emoji safe,
`reset()` on session end (no stuck Ctrl). **Unverified:** the 1000-command ±1 px accuracy gate;
multi-monitor offsets; DPI scaling (uses logical pixels today); Wayland input (X11 only).

## Step 6 — Clipboard 🟡
Both directions implemented with echo guard (SHA-256 + 800 ms self-suppression), 1 MB cap,
chunked transfer, Arabic/emoji/multiline/10 KB safe (unit-tested protocol-side). Flow:
page→PC via save→Ctrl/Cmd+V→restore-400 ms; PC→page via 250 ms poll. **Unverified:** gate
("Arabic, English, emoji, multiline, 10 KB, 1 MB all pass") on a real pair of machines.

## Step 7 — Wire the page 🟡
Connect screen with two fields (Device ID + Password), connect/connecting/connected/failed+reason,
RTT display (ping pill), wake lock, hidden mobile input, pointer events + `touch-action:none`,
rAF coalesced moves, immediate click, `x,y` on all button events, physical key down/up edges,
full-screen landscape touch UX. **Known gap:** multi-monitor, window-level capture, and the
"update the agent" version-mismatch banner is wired logically (ack/hello) — UI toast only.

## Step 8 — Power / lid-close 🟡
Per-OS `platform/*/power.js` with backup→change→restore-on-exit **and crash recovery on next launch**:
Windows `powercfg LIDACTION=0` (AC+DC, admin; not elevated → partial + clear message),
macOS `pmset -a disablesleep 1` + `caffeinate -dims` (admin), Linux `systemd-inhibit --mode=block`
(no root needed from the seat session). Electron `powerSaveBlocker` always on. **Unverified:**
real 30-minute lid-closed session per OS.

## Step 9 — Measure & tune ⬜
No measurements yet. Requires: two machines, `getStats` logging (already wired — see agent stats line),
RTT p50/p95 collection, LAN + WiFi↔mobile-data runs. Gate: targets met or documented decision for
the native agent.

## Step 11 — Packaging & release 🟡
`electron-builder.yml` (NSIS x64/arm64 per-machine installer, DMG universal, AppImage/deb/rpm),
release workflow on `v*` tags with GitHub Releases + checksums (electron-builder generates).
**Unsigned** — SmartScreen on Windows, right-click→Open on macOS. Signing = SignPath (free OSS) or
paid certs; Apple Developer ID for notarization. Documented in README; not yet published.

## Step 12 — Optional ⬜
TURN fallback (Cloudflare Realtime TURN, OFF by default, env-provided creds), native Rust/C++ agent
(if Electron misses the latency target), audio, file transfer, image clipboard, Wayland input
(libei/RemoteDesktop portal).

## Known risks (from master.md, unchanged)
1. Electron may miss latency targets → Step 12 native agent.
2. Hidden cursor capture may fail → video shows the OS cursor; client's predicted cursor coexists.
3. macOS Apple Silicon lid-closed is unproven.
4. Safari lacks low-latency knobs → ~1–2 extra frames of jitter buffer.
5. Lock screen / secure desktop not controllable in v1.
6. Public relays can be down/slow → `redundancy: 4`; treat `relay-failed` as the signal.
7. Strict NAT/corporate WiFi without TURN will fail.
8. Password changes each launch → clients re-enter it (by design).
