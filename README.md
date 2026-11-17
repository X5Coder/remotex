<p align="center"><img src="icon.svg" width="96" height="96" alt="RemoteX — laptop and phone, the same screen in your hands"></p>

# RemoteX

**Control your computer from any browser — peer-to-peer, end-to-end encrypted, no account, no server you own.**

[![CI](https://github.com/X5Coder/remotex/actions/workflows/ci.yml/badge.svg)](https://github.com/X5Coder/remotex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

---

## Download

Three builds — one per platform, nothing else:

| Build | File | Short note |
|---|---|---|
| **Windows** (10/11, x64) | [RemoteX-Setup.exe](https://github.com/X5Coder/remotex/releases/latest/download/RemoteX-Setup.exe) | One-click installer, desktop shortcut |
| **macOS** (12+, Intel + Apple Silicon) | [RemoteX.dmg](https://github.com/X5Coder/remotex/releases/latest/download/RemoteX.dmg) | Universal dmg, drag to Applications |
| **Linux** (x64) | [RemoteX.AppImage](https://github.com/X5Coder/remotex/releases/latest/download/RemoteX.AppImage) | No install needed — `chmod +x` and run |

Everything else — full history, checksums — lives in [Releases](https://github.com/X5Coder/remotex/releases).

> Unsigned builds: on Windows, SmartScreen may warn once — click *More info → Run anyway*.
> On macOS, right-click the app → **Open** the first time. On Linux, `chmod +x RemoteX.AppImage`.

## What is this?

RemoteX is a **remote desktop** like RustDesk/Sunshine — but:

- **No infrastructure to run.** Signaling goes over public Nostr relays (end-to-end encrypted);
  media flows **directly peer-to-peer**. Public relays can see only the encrypted handshake —
  they never see your screen.
- **Two numbers.** On the computer you want to control, launch RemoteX — it shows a
  **Device ID** (permanent, saved per machine) and a **Password** (new random one **every launch**).
  Open the web client anywhere, enter both, control starts instantly.
- **One session.** The first device to connect holds the session; all others are refused
  until it disconnects.
- **Stays awake.** The agent blocks idle sleep **and** — with a one-shot admin prompt — blocks
  **lid-close sleep**, even with the lid shut. Power settings are backed up before changing
  and restored on exit and on next launch (crash-safe).
- **Sessions end on their own.** A session is capped at **5 hours**; after that it closes and
  you can simply reconnect with the same password.

## How it works

```
Browser (client)  <== WebRTC P2P (H.264 video / data) ==>  RemoteX app (host PC)
        |
        └── signaling only at the start, via public Nostr relays
            (SDP encrypted with your password — AES-256-GCM via PBKDF2)
```

- **Cursor feel:** the cursor is drawn locally on the client (0 ms perceived); the agent
  corrects it with `cur` beacons at 50 Hz on two lines.
- **One session:** `maxUsers = 2` at the room layer plus a seat-holder check in command handling.
- **Controls:** move/click/drag/scroll, physical-key codes, non-ASCII text via clipboard+paste,
  bidirectional clipboard sync.
- **Keep-awake:** `powerSaveBlocker` + an optional one-shot elevated helper patches the
  lid-close action and restores your previous setting on quit (and on next launch after a crash).

## Quick start (build from source)

Prerequisites: Node.js ≥ 22, npm ≥ 9. On Linux, X11 + `libx11-dev libxtst-dev` for input injection.

```bash
# 1) shared protocol (build once)
cd protocol && npm install && npm run build && cd ..

# 2) the web client (the thing you open on the phone/PC)
cd web && npm install && npm run dev      # http://localhost:5173

# 3) the agent (the thing that runs on the computer being controlled)
cd agent && npm install && npm start      # shows Device ID + Password
```

Then open `http://localhost:5173` (or the GitHub Pages URL), enter the **6-digit Device ID** and the
**6-letter password** shown in the app window — you're in control.

## Repository layout

```
├─ web/            Web client — TypeScript + Vite → deployed to GitHub Pages
├─ protocol/       @remotex/protocol — shared wire protocol (binary fast + JSON ctl) + tests
├─ agent/          RemoteX agent (Electron app on the machine being controlled)
│  ├─ platform/windows/   lid-close power handling (powercfg, one-shot elevated helper)
│  ├─ platform/macos/     caffeinate + pmset disablesleep
│  └─ platform/linux/     systemd-inhibit
├─ docs/           plan, roadmap-vs-reality, testing guide, v1 prototype UI
└─ .github/workflows/  CI (3 OSes), Pages deploy, 3-artifact release packaging
```

## Security model

- Password is 6 CAPS letters generated from a CSPRNG **on every launch** (short by design,
  treat like a per-session PIN); the Refresh icon rotates it instantly.
- SDP/ICE is encrypted with the password (`decrypt-failed` → wrong password).
- The agent opens no network port and listens on nothing inbound.
- Privacy: public relays see the encrypted handshake only; after connect, nothing passes
  through a middleman. (STUN sees your public IP.)
- External notifications: the host machine alerts you when someone connects, disconnects,
  or is refused — even if the window is hidden.

## Roadmap & status

See **[docs/ROADMAP.md](docs/ROADMAP.md)** for the honest step-by-step status against the plan
(`master.md`), **[docs/TESTING.md](docs/TESTING.md)** for the test matrix, and the plan itself
in **`master.md`**.

## License

MIT — see [LICENSE](LICENSE). Do not copy AGPL/GPL code (RustDesk, Sunshine, Apollo) into this project.
