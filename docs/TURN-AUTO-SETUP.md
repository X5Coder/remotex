# Automatic TURN setup (Metered free account)

RemoteX can now create the free [Metered](https://dashboard.metered.ca/signup)
account, verify its email, accept the terms, create an app, and extract a TURN
credential — without asking the user for an API key or showing a form.

The window shows only a spinner and a one-line progress message. If the run
fails, the spinner disappears and a **Retry automatic setup** button appears
with the error. Diagnostics are written to disk.

## What happens in one run

1. A fresh disposable inbox is created (`mail.tm` by default).
2. A fresh headless Chrome/Edge profile is launched from a random temporary
   `userDataDir`.
3. The Metered signup form is filled and submitted through its real
   reCAPTCHA-v3 button. Newly created Metered credentials can take up to **2
   minutes** to propagate, so RemoteX polls the real `TURN Allocate` before
   declaring the setup usable.
4. The latest `donotreply@metered.ca` email ("Metered Email Verification
   Code") is polled; the 5–6 digit code is applied.
5. Terms are accepted and an app is created.
6. **TURN credentials** are created from the TURN page; the username, password,
   and `<pre>` snippet are read.
7. RemoteX runs a real TURN `Allocate` (UDP/TCP/TLS) to prove the credential
   works from this machine.
8. `turn.json` is written atomically:

```json
{
  "urls": ["turn:global.relay.metered.ca:80", "turns:global.relay.metered.ca:443?transport=tcp"],
  "username": "…",
  "credential": "…"
}
```

The signup stage is retried up to **5 times** with a fresh inbox, a fresh
profile, and fresh random data. Once Metered accepts the signup, the flow is
**not** retried — any later failure dumps a masked screenshot, logs the
diagnostic, and aborts. Ordinary steps time out after 30 s, the signup POST
after 45 s, and the verification email after 120 s.

## Requirements

- Google Chrome, Chromium, Microsoft Edge, or Brave installed locally.
  RemoteX uses `puppeteer-core` and does **not** download a browser.
- Internet access to `dashboard.metered.ca`, `api.mail.tm` (or your own mail
  provider), and the TURN relay.
- The agent must be allowed to start a local browser process.

If the browser is in a non-standard location, set:

```powershell
$env:REMOTEX_CHROME_PATH = "C:\path\to\chrome.exe"
```

## Using the agent UI

Open the RemoteX agent window → **Remote Access · Any Network** →
**Set up automatically — free**.

While it runs, the card shows a spinner, the current step, and the attempt
number. The only user action available is **Cancel**. There is no manual
API-key form.

Once `turn.json` exists, the card shows **Connected — works from any network**
and the main interface opens directly (no wizard, no removal UI).

## CLI / diagnostics

Build once, then run the same flow outside Electron:

```powershell
cd agent
npm run build
npm run turn:signup -- --out "$env:APPDATA\remotex\turn.json"
```

Options:

| Option | Meaning |
| --- | --- |
| `--out <file>` | Output `turn.json` (default `./turn.json`). |
| `--log <dir>` | Logs/screenshots directory (default `./turn-signup-logs`). |
| `--attempts <n>` | Retry count (default 5). |
| `--email-timeout <ms>` | Wait for the verification email per attempt (default 120000). |
| `--mail-config <file>` | Use a specific mailbox config JSON. |
| `--no-verify` | Save without the real TURN Allocate check. |
| `--headed` | Show the browser (debugging only). |

In the agent, logs go to `%APPDATA%\remotex\turn-signup-logs\<timestamp>\`.
Each failed attempt contains `failure.png`, `failure.html`, and `error.txt`.
The flow logs only a masked email address. Before writing `error.txt`, `failure.html`, or `failure.png`, it redacts credentials, tokens, and verification codes when they are detectable, and the flow log redacts the same values. Review diagnostics before sharing; treat them as potentially sensitive.

## Email service configuration

This repository does not contain an existing email-service integration — the
only `mail`/`email` code was added for this flow. If your deployment already
has one, use the HTTP adapter below. Otherwise RemoteX defaults to `mail.tm`.

### Default: mail.tm

No configuration is required. `api.mail.tm` is used to create a disposable
address for each signup attempt.

Optional overrides:

```powershell
$env:REMOTEX_MAIL_PROVIDER = "mailtm"
$env:REMOTEX_MAIL_API_BASE = "https://api.mail.tm"
$env:REMOTEX_MAIL_DOMAIN = "euploading.com"
```

### Fallback: Maildrop (free, no key)

The default remains `mail.tm` because it produces an isolated random inbox per
run, but Maildrop is also supported and can be selected without changing any
code:

```powershell
$env:REMOTEX_MAIL_PROVIDER = "maildrop"
```

Each signup address is a random `rx<timestamp><token>@maildrop.cc` mailbox.
No API key is required. Maildrop is rate-limited and public (anyone can read
the mailbox if they know its name), so it is intended for one-off setup flows.

### Using your existing inbox service

Create `%APPDATA%\remotex\mail.json`:

```json
{
  "provider": "http",
  "createUrl": "https://mail.example.com/api/inbox",
  "messagesUrl": "https://mail.example.com/api/inbox/{address}/messages",
  "messageUrl": "https://mail.example.com/api/inbox/{address}/messages/{id}",
  "headers": {
    "Authorization": "Bearer YOUR_TOKEN"
  }
}
```

Contract:

- `POST createUrl` → `{ "address": "..." }` (or `{ "email": "..." }`).
- `GET messagesUrl` (`{address}` expanded) → an array, `{ "messages": [...] }`,
  or `{ "data": [...] }`.
- Each message: `id`, `from`, `subject`, `text` and/or `html`.
- If the list does not include bodies, `GET messageUrl` (`{id}` expanded) must
  return one message.
- `headers` are added to every request.

Environment variables can replace the file:

```powershell
$env:REMOTEX_MAIL_PROVIDER = "http"
$env:REMOTEX_MAIL_CREATE_URL = "https://mail.example.com/api/inbox"
$env:REMOTEX_MAIL_MESSAGES_URL = "https://mail.example.com/api/inbox/{address}/messages"
$env:REMOTEX_MAIL_MESSAGE_URL = "https://mail.example.com/api/inbox/{address}/messages/{id}"
$env:REMOTEX_MAIL_AUTH = "Bearer YOUR_TOKEN"
# or a full JSON object:
$env:REMOTEX_MAIL_HEADERS = '{"X-Api-Key":"..."}'
```

The flow waits for the newest message from `donotreply@metered.ca` whose
subject is (or contains) `Metered Email Verification Code`, then extracts the
first 5–6 digit code after `verification code is:`. Links on `metered.ca` /
`dashboard.metered.ca` are accepted as a fallback; unsubscribe, privacy, and
login links are ignored.

## Manual API-key path

The old `turn:setup` IPC handler is still present for compatibility, but the
window no longer exposes it. It remains useful for support scripts that already
have an account-level Metered API key.

## Limits and expectations

- Metered's free plan is currently 500 MB/month.
- Automated signup depends on Metered's public form and reCAPTCHA score. If the
  score is rejected, the flow fails **without trying to solve or bypass the
  challenge**, writes a screenshot, and offers a retry.
- Metered may refuse disposable-mail domains. If `mail.tm` is rejected, point
  RemoteX at your own inbox service with `mail.json` (above); the rest of the
  flow is unchanged.
- Do not run many setups in parallel. The agent allows one automatic job at a
  time; the CLI should be used serially.
- Media stays end-to-end encrypted (DTLS-SRTP); the TURN relay only sees
  encrypted packets.

---

## TURN sync via Google Apps Script (auto relay for the web client)

The web client is a static site on GitHub Pages � it cannot ask the agent for the
credential out of band, and it may not carry it publicly. The optional Apps Script
bridge solves that with per-install opt-in:

1. Paste ` docs/apps-script-turn-sync.gs ` into a new Apps Script project and deploy
   it as a web app (Execute as: Me, access: Anyone). No Google Sheet is involved �
   bindings live only in the script's Script Properties.
2. On the PC, create ` %APPDATA%\\remotex\\turn-sync.json `:
   `json
   { "url": "https://script.google.com/macros/s/�/exec" }
   `
   The write key is generated automatically on first run.
3. From now on the agent re-registers {roomId, salted password hash, TURN credential}
   on every launch, on password rotation, and after auto-setup. The site exchanges
   Device ID + the password you just typed for the credential � no manual step ever.

Notes:

- Disabled for every install that has no turn-sync.json (e.g. other people's);
  they get exactly the previous behavior.
- The website will therefore call the script for every visitor; unknown Device IDs
  return ` 
ot found ` and the client falls back silently.
- Google Apps Script has **no metering API** (it cannot report consumption, and
  Metered does not expose per-credential quota or expiry either � the 500 MB/month
  free quota is account-level). The only source of truth is a real TURN Allocate:
  the agent runs one at launch (two strikes, spaced by ~8 s) and, if the relay
  *refuses* (never merely times out), renames turn.json to turn.json.stale so the
  built-in automatic setup re-creates it � the auto-renew is reactive by design.
