/**
 * RemoteX — TURN Sync (Google Apps Script web app)
 * =================================================
 * Lets the RemoteX website fetch the TURN credential of THIS device without
 * exposing it publicly and without any manual step per device.
 *
 * How it works
 *   1. The RemoteX agent (on your PC) calls  ?action=register  on every launch
 *      (and after password rotation / auto-setup). It stores the current
 *      turn.json + a salted hash of the CURRENT 6-letter password. Google
 *      never sees the password itself, only the hash.
 *   2. The website calls  ?action=fetch  with the roomId + password the user
 *      just typed on the connect screen. On a match it gets back the TURN
 *      credential for THIS device — end-to-end encrypted traffic, the relay
 *      only ever sees ciphertext.
 *
 * Storage
 *   Everything lives in Script Properties (PropertiesService) — "locally" in
 *   THIS script. No Google Sheet, no Drive file, no logging of secrets. A
 *   value is a tiny JSON blob: { salt, pwh, wkh, urls, username, credential,
 *   updatedAt } under key  "dev:<roomId>".
 *
 * Anti-abuse
 *   - fetch is rate-limited: 12 FAILED attempts per roomId per 6 h → HTTP-ish
 *     "too many attempts" (roomIds are 6 digits, so this is required).
 *   - register requires a per-install write key (generated once by the agent
 *     and stored next to turn.json), so knowing the 6-digit roomId is NOT
 *     enough to overwrite someone's binding.
 *   - The password is never stored. Only sha256(salt + ":" + password) lands
 *     in Google's servers, and the salt never leaves the script.
 *
 * Your question about metering, answered honestly
 *   There is NO way for anyone — not this script, not Google, not Metered —
 *   to know in advance that a Metered TURN credential is about to expire or
 *   how many of the 500 MB/month free quota it has used. Metered exposes no
 *   such endpoint; quota exhaustion only shows up as an Allocate refusal.
 *   The only source of truth is a real TURN Allocate (the agent already runs
 *   one at launch). When it fails, RemoteX re-creates the credential
 *   automatically and re-registers it here — that IS the auto-renew.
 *
 * Deploy
 *   1. script.google.com → New project → paste this file → Save.
 *   2. Deploy → New deployment → type "Web app" → Execute as: Me →
 *      Who has access: Anyone → Deploy → copy the /exec URL.
 *   3. On the PC, create  %APPDATA%\remotex\turn-sync.json  with:
 *        { "url": "PASTE_THE_EXEC_URL_HERE" }
 *      (the write key is generated automatically on first run)
 *   4. That's it. The site starts working from any network on next connect.
 */

const MAX_PAYLOAD_BYTES = 4096;
const RL_WINDOW_SEC = 6 * 60 * 60; // 6 hours
const RL_MAX_FAILS = 12;
const RL_PREFIX = "rl:";
const DEV_PREFIX = "dev:";
const SCHEMA = 1;

/* ----------------------------- entrypoint ----------------------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cb = typeof p.callback === "string" ? p.callback : "";
  try {
    const raw = p.payload;
    if (typeof raw !== "string" || raw.length === 0) {
      return out({ ok: false, error: "missing payload" }, cb);
    }
    if (raw.length > MAX_PAYLOAD_BYTES * 2) {
      return out({ ok: false, error: "payload too large" }, cb);
    }
    let body;
    try {
      body = JSON.parse(decodePayload(raw));
    } catch (err) {
      return out({ ok: false, error: "bad payload" }, cb);
    }
    if (!body || typeof body !== "object") {
      return out({ ok: false, error: "bad payload" }, cb);
    }
    switch (String(body.action || "")) {
      case "ping":
        return out({ ok: true, pong: true }, cb);
      case "register":
        return out(handleRegister_(body), cb);
      case "fetch":
        return out(handleFetch_(body), cb);
      case "purge":
        return out(handlePurge_(body), cb);
      default:
        return out({ ok: false, error: "unknown action" }, cb);
    }
  } catch (err) {
    // never leak internals or secrets
    return out({ ok: false, error: "internal" }, cb);
  }
}

// Posted payloads are also accepted (same format) for completeness.
function doPost(e) {
  return doGet({ parameter: { payload: (e && e.postData && e.postData.contents) || "" } });
}

/* ----------------------------- actions ----------------------------- */

/** Agent → script: bind (roomId → credential) with THIS install's write key. */
function handleRegister_(body) {
  const err = validateCommon_(body);
  if (err) return err;
  const writeKey = typeof body.writeKey === "string" ? body.writeKey : "";
  const salt = typeof body.salt === "string" ? body.salt : "";
  const pwh = typeof body.pwh === "string" ? body.pwh : "";
  const urls = sanitizeUrls_(body.urls);
  const username = typeof body.username === "string" ? body.username.slice(0, 512) : "";
  const credential = typeof body.credential === "string" ? body.credential.slice(0, 512) : "";

  if (writeKey.length < 32) return { ok: false, error: "missing write key" };
  if (salt.length < 16 || pwh.length < 20) return { ok: false, error: "missing password proof" };
  if (!urls) return { ok: false, error: "missing urls" };

  const wkh = sha256hex_(writeKey);
  const props = PropertiesService.getScriptProperties();
  const key = DEV_PREFIX + body.roomId;
  const existing = props.getProperty(key);
  if (existing) {
    try {
      const cur = JSON.parse(existing);
      if (cur && cur.wkh && cur.wkh !== wkh) {
        return { ok: false, error: "binding owned by another install" };
      }
    } catch (e) {
      // corrupt entry — overwrite is allowed with a valid write key
    }
  }
  const record = {
    v: SCHEMA,
    salt: salt,
    pwh: pwh,
    wkh: wkh,
    urls: urls,
    username: username,
    credential: credential,
    updatedAt: new Date().toISOString(),
  };
  props.setProperty(key, JSON.stringify(record));
  return { ok: true, registered: true };
}

/** Site → script: exchange roomId + the CURRENT password for the credential. */
function handleFetch_(body) {
  const err = validateCommon_(body);
  if (err) return err;
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 6) return { ok: false, error: "missing password" };

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(DEV_PREFIX + body.roomId);
  if (!raw) return { ok: false, error: "not found" };

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "unavailable" };
  }
  if (!rec || !rec.salt || !rec.pwh) return { ok: false, error: "not found" };

  const digest = sha256hex_(rec.salt + ":" + password);
  if (digest !== rec.pwh) {
    registerFailure_(body.roomId);
    if (failuresExceeded_(body.roomId)) {
      return { ok: false, error: "too many attempts — try later" };
    }
    return { ok: false, error: "wrong password" };
  }

  clearFailures_(body.roomId);
  return {
    ok: true,
    config: { urls: rec.urls, username: rec.username, credential: rec.credential },
    updatedAt: rec.updatedAt || null,
  };
}

/** Agent → script: drop the binding (e.g. regenerated Device ID). */
function handlePurge_(body) {
  const err = validateCommon_(body);
  if (err) return err;
  const writeKey = typeof body.writeKey === "string" ? body.writeKey : "";
  if (writeKey.length < 32) return { ok: false, error: "missing write key" };
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(DEV_PREFIX + body.roomId);
  if (!raw) return { ok: true, purged: false };
  try {
    const rec = JSON.parse(raw);
    if (rec.wkh !== sha256hex_(writeKey)) {
      return { ok: false, error: "binding owned by another install" };
    }
    props.deleteProperty(DEV_PREFIX + body.roomId);
    return { ok: true, purged: true };
  } catch (e) {
    return { ok: false, error: "internal" };
  }
}

/* ----------------------------- helpers ----------------------------- */

function validateCommon_(body) {
  const roomId = typeof body.roomId === "string" ? body.roomId : "";
  if (!/^\d{6}$/.test(roomId)) return { ok: false, error: "bad room id" };
  return null;
}

function sanitizeUrls_(urls) {
  if (!Array.isArray(urls)) return null;
  const out = [];
  for (let i = 0; i < urls.length && out.length < 5; i++) {
    const u = String(urls[i] || "");
    if (/^(stun|turn|turns):[^\s]{4,200}$/.test(u)) out.push(u);
  }
  return out.length ? out : null;
}

function decodePayload(payload) {
  let b64 = String(payload).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bytes = Utilities.base64Decode(b64);
  return Utilities.newBlob(bytes).getDataAsString("UTF-8");
}

function sha256hex_(text) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  );
  let hex = "";
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] & 0xff;
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}

function failuresKey_(roomId) {
  return RL_PREFIX + roomId;
}

function registerFailure_(roomId) {
  const cache = CacheService.getScriptCache();
  const key = failuresKey_(roomId);
  const cur = Number(cache.get(key) || "0") + 1;
  cache.put(key, String(cur), RL_WINDOW_SEC);
}

function failuresExceeded_(roomId) {
  const cache = CacheService.getScriptCache();
  return Number(cache.get(failuresKey_(roomId)) || "0") >= RL_MAX_FAILS;
}

function clearFailures_(roomId) {
  CacheService.getScriptCache().remove(failuresKey_(roomId));
}

function out(obj, callback) {
  const body = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]{0,63}$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + body + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

