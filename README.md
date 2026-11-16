# RemoteX

**Control your computer from any browser â€” peer-to-peer, end-to-end encrypted, 60 fps target, no account, no server you own.**

[![CI](https://github.com/remotex-p2p/remotex/actions/workflows/ci.yml/badge.svg)](https://github.com/remotex-p2p/remotex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-b8913a.svg)](CONTRIBUTING.md)

---

## What is this?

RemoteX is a **remote desktop** like RustDesk/Sunshine â€” but:

- **No infrastructure to run.** Signaling goes over public Nostr relays (end-to-end encrypted),
  media flows **directly peer-to-peer**. Public relays can see only the encrypted handshake;
  they never see your screen.
- **Two numbers.** On the computer you want to control, launch the agent â€” it shows a
  **Device ID** (permanent, saved per machine) and a **password** (new random one **every launch**).
  Open the web client anywhere, enter both, control starts instantly.
- **One session.** The first device to connect holds the session; all others are refused
  until it disconnects (single-session admission enforced in the room and in command handling).
- **Stays awake.** The agent blocks idle sleep **and** â€” with admin rights per OS â€” blocks
  **lid-close sleep**, even when the lid is shut. Power settings are backed up before changing
  and restored on exit and on next launch (crash-safe).
- **High frame-rate.** Capture requests 60 fps (`contentHint: 'motion'`), hardware H.264 is
  preferred via `setCodecPreferences`, sending is tuned (`maxFramerate=60`,
  `degradationPreference=maintain-framerate`), and bitrate adapts to measured fps/RTT.

## Repository layout

```
â”œâ”€ web/            Web client â€” TypeScript + Vite â†’ deployed to GitHub Pages
â”œâ”€ protocol/       @remotex/protocol â€” shared wire protocol (fast binary + ctl JSON) + tests
â”œâ”€ agent/          Electron agent (the app on the machine being controlled)
â”‚  â”œâ”€ platform/windows/   power/lid-close handling (powercfg)  + README
â”‚  â”œâ”€ platform/macos/     caffeinate + pmset disablesleep      + README
â”‚  â””â”€ platform/linux/     systemd-inhibit                      + README
â”œâ”€ docs/           plan, roadmap-vs-reality, testing guide, v1 prototype UI
â””â”€ .github/workflows/  CI (3 OSes), Pages deploy, agent release packaging
```

## Quick start (local test)

Prerequisites: Node.js â‰¥ 22, npm â‰¥ 9. On Linux, X11 + `libx11-dev libxtst-dev` for input injection.

```bash
# 1) shared protocol (build once)
cd protocol && npm install && npm run build && cd ..

# 2) the web client (the thing you open on the phone/PC)
cd web && npm install && npm run dev      # http://localhost:5173

# 3) the agent (the thing that runs on the computer being controlled)
cd agent && npm install && npm start      # shows Device ID + Password
```

Then: open `http://localhost:5173` (or the GitHub Pages URL), enter the **12-digit Device ID** and the password (12 CAPS letters)
shown in the agent window â€” you're in control.

> On a phone: open `http://<your-pc-lan-ip>:5173` on the same Wi-Fi (dev server),
> or serve the production build (`npm run preview`).

## How it works

```
Browser (client)  <== WebRTC P2P (H.264 video / data) ==>  Electron agent (host PC)
        |
        â””â”€â”€ signaling only at the start, via public Nostr relays
            (SDP encrypted with your password â€” AES-256-GCM via PBKDF2)
```

- **Channels:** one reliable ordered data channel (Trystero â‰¥ 0.27 has no unreliable mode),
  so the client sends **one move per rAF, latest only**; absolute normalized coordinates,
  every pointer event carries `x,y`; clicks are sent **immediately** (no tap delay â€”
  the OS merges double clicks).
- **Cursor feel:** the cursor is drawn locally on the client (0 ms perceived); the agent
  corrects it with `cur` messages at 10 Hz. The host machine's own OS arrow is never hidden —
  it stays on screen the whole time (older builds swapped it with a transparent glyph; that's gone).
- **Keys:** physical `code` + `down/up` edges with modifiers; non-ASCII text goes via
  clipboard+paste, never per-key typing. Clipboard sync is bidirectional (250 ms poll,
  SHA-256 echo guard, saveâ†’Vâ†’restore flow).
- **Versioning:** the protocol has its own version (`hello.version`); mismatch â†’ the client
  tells you to update the agent.

## Security model

- Password is 20 base32 chars (~100 bits) from a CSPRNG, **new on every agent launch**, never stored.
- SDP/ICE is encrypted with the password; wrong password â†’ handshake fails (`decrypt-failed`).
- Single session: `maxUsers=2` at the room layer + seat-holder check in command handling.
- Agent does not open any network port; no inbound listeners.
- Privacy: after connect, nothing passes through a middleman. (STUN sees your public IP;
  relays see encrypted handshake only.)

## Roadmap & status

See **[docs/ROADMAP.md](docs/ROADMAP.md)** for the honest step-by-step status against the plan
(`master.md`), **[docs/TESTING.md](docs/TESTING.md)** for the test matrix, and the plan itself
in **`master.md`**.

## License

MIT â€” see [LICENSE](LICENSE). Do not copy AGPL/GPL code (RustDesk, Sunshine, Apollo) into this project.
