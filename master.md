REMOTE-CONTROL FROM BROWSER - PLAN v4 (final, simplified)

Goal: control your PC from any browser, instant feel, no server you own,

exactly ONE session at a time, works on phone/tablet/PC.



======================================================================

0\. TARGETS (measure, do not assume)

======================================================================

Connect time        LAN <= 3 s | Internet <= 8 s

Video FPS           60 fps target, 30 fps floor (1080p)

Click-to-photon     LAN <= 80 ms | Internet <= 150 ms (Electron agent)

Cursor feel         0 ms perceived (cursor drawn locally on client)

Input accuracy      +-1 px over 1000 random commands

Honest note: Chromium WebRTC usually lands around 50-100 ms on LAN.

If Step 9 misses the target, move to the native agent (Step 12).

Distance adds latency that no code can remove.



======================================================================

1\. LANGUAGES AND STACK

======================================================================

Web client (phone/tablet/PC)   TypeScript + HTML/CSS, bundled with Vite.

Protocol package (shared)      TypeScript (Node + browser).

Agent v1                       Electron (TypeScript/Node). Electron is

&#x20;                              only a tool: it captures the FULL SCREEN

&#x20;                              of the machine (all monitors) through

&#x20;                              desktopCapturer. Its own window is hidden

&#x20;                              and only runs WebRTC. It does NOT capture

&#x20;                              a browser.

Input driver                   @jitsi/robotjs (MIT) behind an

&#x20;                              InputDriver interface.

&#x20;                              Fallback: enigo (Rust) via napi-rs.

Agent v2 (only if targets      Rust (webrtc-rs + OS capture APIs)

missed)                        or C++ (libdatachannel).

Signaling                      Trystero (MIT): Nostr/MQTT/BitTorrent.

Build/CI                       GitHub Actions, electron-builder.

License                        MIT, open source. Never copy code from

&#x20;                              AGPL/GPL projects (RustDesk, Sunshine,

&#x20;                              Apollo, Reminal). Read for ideas only.



Client devices (browser only, no install):

\- Android: Chrome, Edge, Firefox (latest 2 versions)

\- iPhone/iPad: Safari (H.264 only; video needs playsinline + muted +

&#x20; a user tap to start) \[VERIFY jitterBufferTarget on Safari]

\- Windows/macOS/Linux: Chrome, Edge, Firefox, Safari (mac)

\- Optional: install as PWA for fullscreen on phones.



======================================================================

2\. ARCHITECTURE

======================================================================

Browser (web) <== WebRTC P2P ==> Agent (Electron on target PC)

&#x20;     |

&#x20;     +-- signaling only at the start, through public Nostr/MQTT/

&#x20;         BitTorrent relays (SDP encrypted with the password).

&#x20;         After that everything is direct P2P. No server you own.



"Room ID" = the connection identifier shown like an IP. It is NOT a real

IP address (a real IP would need a public IP + open router ports).



Channels on one RTCPeerConnection:

\- Video track   screen, hardware H.264, cursor hidden

\- fast (id 10)  ordered:false, maxRetransmits:0, negotiated

\- ctl  (id 11)  reliable+ordered, negotiated

Confirm ids 10/11 do not clash with Trystero internals (Step 1).



======================================================================

3\. PROTOCOL

======================================================================

fast channel (binary, 7 bytes each, big-endian):

&#x20; move   \[0x01]\[seq:u16]\[x:u16]\[y:u16]   x,y = normalized \* 65535

&#x20; scroll \[0x02]\[seq:u16]\[dx:i16]\[dy:i16]

&#x20; cur    \[0x03]\[seq:u16]\[x:u16]\[y:u16]   agent -> page (true cursor)

&#x20; ping   \[0x04]\[seq:u16]\[t:u32]          pong echoes same layout

ctl channel (JSON): hello, down, up, click, dblclick, key, text, paste,

&#x20; clipboard, bye. down/up/click/dblclick ALWAYS carry x,y: the agent

&#x20; moves first, then presses.

key = { code (physical), key, down:true/false, ctrl, alt, shift, meta }.

Rules:

\- Agent drops fast messages older than last seq (16-bit wraparound).

\- Client sends ONE move per requestAnimationFrame (latest only).

\- Touch mode sends absolute move, never dx/dy (packet loss = no drift).

\- Send click immediately (no 240 ms tap delay). OS merges double clicks.

\- Messages > 16 KB are chunked on ctl (id, index, total).

\- hello = protocol version, screen size, screen list, cursor position.

&#x20; Version mismatch -> page shows "update the agent".

\- Non-ASCII text (Arabic, emoji) goes via paste (clipboard + Ctrl/Cmd+V),

&#x20; never via per-key typing.



======================================================================

4\. LATENCY AND FPS TUNING

======================================================================

Capture (agent):

\- desktopCapturer / getUserMedia chromeMediaSource:'desktop',

&#x20; frameRate ideal 60 / max 60, cursor hidden ('never') \[VERIFY per OS].

\- contentHint = 'motion' for video/games, 'detail' for text work.

Encode (RTCRtpSender.setParameters):

\- Prefer H.264 via setCodecPreferences (hardware encode, hardware

&#x20; decode on phones). VP8/VP9/AV1 are fallbacks only.

\- maxBitrate: LAN 15-25 Mbps, Internet 4-10 Mbps (adaptive).

\- maxFramerate 60. degradationPreference = 'maintain-framerate'.

\- No simulcast, no B-frames, short GOP, keyframe on PLI request.

\- SDP munging if needed: x-google-start-bitrate / min-bitrate.

Receive (client):

\- receiver.jitterBufferTarget = 0..30 ms (and playoutDelayHint where

&#x20; supported). Test on the real phone.

\- <video playsinline muted autoplay>, no CSS filters/transforms on it.

&#x20; Use requestVideoFrameCallback to measure.

\- Cursor drawn on client from local pointer; corrected by cur messages.

Adaptive logic:

\- getStats() every 1 s: RTT, packetsLost, framesPerSecond,

&#x20; jitterBufferDelay. If loss > 2% or RTT rising: lower bitrate, then

&#x20; resolution (1080 -> 900 -> 720). Recover slowly.

Network:

\- Same LAN: direct host candidates (mDNS may hide them; test).

\- ICE trickle on, public STUN (stun.cloudflare.com).

\- Prefer UDP. Test WiFi 5 GHz vs mobile data.



======================================================================

5\. PER-PLATFORM AGENT SPECS

======================================================================

The agent runs with administrator/root rights on every OS.



\--- WINDOWS 10/11 (x64, arm64) ---

Capture      Chromium desktop capture (DXGI Desktop Duplication).

Encode       Hardware H.264 via Media Foundation: NVENC, QuickSync,

&#x20;            AMF \[VERIFY].

Input        robotjs (SendInput). Absolute coords with DPI factor;

&#x20;            test 100%, 150%, 200% and 2 monitors.

Admin        Runs elevated, so UAC prompts and elevated windows can be

&#x20;            controlled. Lock screen/secure desktop is out of scope v1.

Power        powerSaveBlocker in Electron, or SetThreadExecutionState.

Lid closed   powercfg /setacvalueindex SCHEME\_CURRENT SUB\_BUTTONS

&#x20;            LIDACTION 0, same with /setdcvalueindex, then

&#x20;            powercfg /setactive SCHEME\_CURRENT. Save old values first

&#x20;            (powercfg /query), restore on exit and on next launch.

Black screen Virtual display: winget install

&#x20; with lid   --id=VirtualDrivers.Virtual-Display-Driver -e

Firewall     Allow prompt may show on first WebRTC use.

Package      NSIS installer (+ portable zip), requests admin.

&#x20;            Auto-update: electron-updater.

Signing      Unsigned = SmartScreen warning. Option: SignPath

&#x20;            Foundation (free for OSS, may reject small projects) or a

&#x20;            paid cert.



\--- macOS 12.3+ (Apple Silicon + Intel, universal) ---

Capture      ScreenCaptureKit via Chromium. Permission: Screen

&#x20;            Recording (user grants once; agent opens the Settings page).

Encode       VideoToolbox hardware H.264.

Input        robotjs. Permission: Accessibility (user grants once).

Power        caffeinate stops idle sleep only, NOT lid-close sleep.

Lid closed   sudo pmset -a disablesleep 1 (restore to 0 on exit).

&#x20;            On Apple Silicon this alone may not be enough without an

&#x20;            external display; Apple officially supports clamshell only

&#x20;            with display + power. Separate spike: virtual display or

&#x20;            Dummy HDMI Plug. Do NOT promise this until tested.

Package      DMG, universal build. Auto-update needs signing +

&#x20;            notarization (paid Apple Developer account) \[VERIFY cost].

&#x20;            Unsigned: right-click > Open.

Keys         Cmd+V for paste, Cmd+C for copy detection.



\--- LINUX (Ubuntu/Fedora/Arch, x64 + arm64) ---

X11          Capture: Chromium. Input: XTest through robotjs.

&#x20;            Works directly. Best supported target.

Wayland      Capture: PipeWire via xdg-desktop-portal (permission

&#x20;            dialog, one source). Input: RemoteDesktop portal / libei,

&#x20;            or uinput. Experimental in v1; document it.

Encode       Hardware via VAAPI needs flags, e.g.

&#x20;            --enable-features=VaapiVideoEncoder \[VERIFY per distro/GPU];

&#x20;            software x264 fallback acceptable for 1080p30.

Power        systemd-inhibit --what=handle-lid-switch:sleep:idle as a

&#x20;            child process for the session \[VERIFY syntax], or

&#x20;            HandleLidSwitch=ignore in /etc/systemd/logind.conf.

Package      AppImage, .deb, .rpm. No signing needed.

Clipboard    Electron clipboard; Wayland may need wl-clipboard \[VERIFY].



======================================================================

6\. STEPS (each has a success gate; do not skip ahead)

======================================================================

Step 0  Repo: web/, agent/, protocol/, docs/. MIT. CI builds all three

&#x20;       OS. Gate: green CI on Win/mac/Linux.

Step 1  SPIKE (most important): Trystero in two browsers; compare Nostr

&#x20;       vs MQTT vs BitTorrent (LAN, then WiFi vs mobile data); raw

&#x20;       RTCPeerConnection via getPeers(); create fast/ctl channels;

&#x20;       room.ping(); test codec preference + maxBitrate on addStream;

&#x20;       check trickleIce and relay redundancy options exist in the

&#x20;       installed version \[VERIFY].

&#x20;       Gate: 3 s LAN / 8 s internet, both channels work.

&#x20;       Fallback: own signaling over nostr-tools + plain

&#x20;       RTCPeerConnection (rest of project unchanged).

Step 2  Protocol package + unit tests (round trip every message, seq

&#x20;       wraparound, chunking, ping/pong). Gate: pass in Node + browser.

Step 3  Agent shell: Electron tray + small window showing Room ID,

&#x20;       password, connection status and a "Stop session" button.

&#x20;       Hidden WebRTC window. Room ID generated once and saved.

&#x20;       New password on every launch. Single session via

&#x20;       onPeerHandshake. Gate: ping works; second peer refused while

&#x20;       the first is connected, accepted after it leaves or after

&#x20;       Stop session.

Step 4  Screen streaming with the tuning in section 4.

&#x20;       Gate: 30 fps real at 1080p on LAN, stats logged.

Step 5  Input injection via InputDriver, coordinate mapping

&#x20;       (display select -> offset -> DPI), cur messages.

&#x20;       Gate: 1000 random commands within +-1 px.

Step 6  Clipboard: page->PC (save old, set, Ctrl/Cmd+V, restore after

&#x20;       300-500 ms); PC->page (poll 250 ms, 80 ms after copy shortcut);

&#x20;       echo guard by hash; text only, max 1 MB, chunked.

&#x20;       Gate: Arabic, English, emoji, multiline, 10 KB, 1 MB all pass.

Step 7  Wire the page: sendCommand -> channels, absolute touch move,

&#x20;       rAF coalescing, immediate click, x/y on all button events,

&#x20;       code + down/up keys, hello/cur handling, connect screen with

&#x20;       two fields (Room ID + Password) and clear status

&#x20;       (connecting / connected / failed + reason), RTT display,

&#x20;       pointer events + touch-action:none, hidden input for the mobile

&#x20;       keyboard, Wake Lock API to keep the phone screen on.

&#x20;       Gate: full control from phone: move, click, drag, scroll, type,

&#x20;       copy/paste.

Step 8  Power/lid automation per section 5, applied automatically with

&#x20;       admin rights. Gate: 30 min session with lid closed per OS,

&#x20;       original settings restored on exit.

Step 9  Measure and tune against section 0. Gate: targets met OR

&#x20;       documented decision to build the native agent.

Step 10 (removed - security is only section 7)

Step 11 Packaging and release (section 9).

Step 12 Optional: TURN fallback, native agent (Rust/C++), audio, file

&#x20;       transfer, image clipboard.



======================================================================

7\. ACCESS AND SECURITY (simplified)

======================================================================

\- Room ID: generated once on first run, SAVED, and stays the same for

&#x20; this device forever, across all sessions and restarts.

\- Password: a NEW long random one on every agent launch

&#x20; (16 Base32 chars, \~80 bits, secure RNG), passed to Trystero as

&#x20; password (it encrypts the SDP).

\- Client UI: two fields, Room ID + Password. When both are entered the

&#x20; connection opens and control starts immediately.

\- No approval dialog, no kill-switch shortcut, no red tray icon,

&#x20; no token expiry, no QR code.

\- Single session: the first valid peer is accepted (onPeerHandshake,

&#x20; challenge-response from the password). Any other peer is rejected

&#x20; until the first one leaves.

\- Session ends when: the user presses "Stop session" in the agent, the

&#x20; client closes/disconnects, or the agent is closed or crashes (all

&#x20; connections drop).

\- Agent launched again: same Room ID, new random password.

\- Agent runs with admin/root rights (requested at install/launch) so it

&#x20; can apply power settings and control elevated windows.

\- Open source (MIT).

\- Privacy statement in README: public relays see encrypted negotiation

&#x20; only; STUN servers see your public IP; after connect nothing passes

&#x20; through a middleman.



======================================================================

8\. OPEN-SOURCE REFERENCE MAP

======================================================================

USE AS LIBRARY:  Trystero (MIT), Electron (MIT), @jitsi/robotjs (MIT),

&#x20;                electron-builder / electron-updater (MIT).

BACKUP:          @nut-tree-fork/nut-js (Apache-2.0), enigo (MIT).

INSTALL, NOT BUNDLE: Virtual Display Driver (MIT) on Windows.

LATER:           libdatachannel / node-datachannel (MPL-2.0).

READ ONLY:       RustDesk (AGPL), Sunshine/Apollo (GPLv3),

&#x20;                Reminal (AGPL), Weylus.

REFERENCE:       Selkies-GStreamer (MPL-2.0), Neko (Apache-2.0).

Rule: copying AGPL/GPL code forces your project to the same license.

Rewrite ideas yourself. Not legal advice; read each license.



======================================================================

9\. PUBLISHING

======================================================================

Web: build with Vite in GitHub Actions, deploy to GitHub Pages from the

&#x20; main branch workflow. Pin dependency versions, bundle Trystero.

Agent: electron-builder matrix on windows-latest, macos-latest,

&#x20; ubuntu-latest. Upload to GitHub Releases:

&#x20; Windows .exe (x64, arm64), macOS .dmg (universal), Linux .AppImage,

&#x20; .deb, .rpm. Include SHA-256 checksums. Auto-update through GitHub

&#x20; Releases (electron-updater). Protocol version checked via hello.

Signing: Windows (SignPath/paid cert), macOS (Developer ID + notarize),

&#x20; Linux none. Document unsigned warnings in README.



======================================================================

10\. METRICS AND TEST MATRIX

======================================================================

Log per session: connect time, ICE path (host/srflx/relay), RTT p50/p95,

&#x20; fps, bitrate, resolution, packet loss, jitter buffer delay, agent

&#x20; CPU/GPU %, input-to-pixel latency.

Test matrix:

&#x20; Agent OS:  Windows 11, Windows 10, macOS (Apple Silicon + Intel),

&#x20;            Ubuntu X11, Ubuntu Wayland

&#x20; Clients:   Android Chrome, iPhone Safari, Windows Chrome/Edge/Firefox,

&#x20;            macOS Safari/Chrome, Linux Firefox

&#x20; Networks:  same WiFi, WiFi to mobile data, two different ISPs,

&#x20;            symmetric NAT (expect TURN need)

&#x20; Displays:  1 and 2 monitors, DPI 100/150/200%

Release gate: all section 0 targets met on Windows + one other OS, or

&#x20; the native-agent decision is documented.



======================================================================

11\. TURN FALLBACK (optional, Step 12)

======================================================================

Needed only when direct P2P fails (symmetric NAT, strict corporate

WiFi). Note: this is an external relay, so it is OFF by default and

only added if you decide to allow it later.

Option: Cloudflare Realtime TURN with your own account (reported free

tier 1,000 GB/month, then $0.05/GB; no TCP relaying) \[VERIFY pricing].

Configure via Trystero turnConfig. Credentials never committed to repo.



======================================================================

12\. KNOWN RISKS

======================================================================

1\. Electron may miss the latency target -> native agent (Step 12).

2\. Hidden cursor capture may fail on Wayland/old macOS -> show video

&#x20;  cursor, hide the predicted one.

3\. macOS Apple Silicon lid-closed is unproven -> separate spike.

4\. Safari lacks some low-latency knobs -> accept \~1-2 extra frames.

5\. Lock screen / secure desktop cannot be controlled in v1.

6\. Public relays can be down or slow -> redundancy > 1 + fallback list.

7\. Some networks block direct P2P; with no relay allowed, those

&#x20;  networks will fail to connect.

8\. The password changes on every agent launch, so a client cannot

&#x20;  auto-reconnect after the agent restarts; the user enters the new

&#x20;  password.

