/**
 * RemoteX — TURN credential verifier.
 *
 * The "Set up remote access" flow asks metered for a fresh credential and
 * then proves it actually works from THIS machine before saving turn.json.
 * Without a real Allocate round-trip, a wrong/expired key would look
 * "saved" and every later connection would fail with peer-connect-failed.
 *
 * Tries every transport we can (UDP 443 → UDP 80 → TCP 443 → TCP 80 → TLS 443)
 * and succeeds if ANY of them answers — so a corporate network that blocks
 * UDP doesn't produce a false "broken credential" verdict.
 */
import * as dgram from "dgram";
import * as net from "net";
import * as tls from "tls";
import * as crypto from "crypto";

const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
const REQUESTED_TRANSPORT_UDP = 17;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_USERNAME = 0x0006;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
const MSG_ALLOCATE_REQ = 0x0003;
const MSG_ALLOCATE_SUCCESS = 0x0103;
const MSG_ALLOCATE_ERROR = 0x0113;

export interface HostPort {
  host: string;
  port: number;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
  via?: string;
}

function buildAllocate(nonce: string | null, realm: string | null, username: string, password: string): Buffer {
  const txn = crypto.randomBytes(12);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(MSG_ALLOCATE_REQ, 0);
  COOKIE.copy(header, 4);
  txn.copy(header, 8);

  const attrs: Buffer[] = [];
  const appendAttr = (type: number, body: Buffer) => {
    const pad = (4 - (body.length % 4)) % 4;
    const h = Buffer.alloc(4);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(body.length, 2);
    attrs.push(Buffer.concat([h, body, Buffer.alloc(pad)]));
  };
  const reqTransport = Buffer.alloc(4);
  reqTransport.writeUInt8(REQUESTED_TRANSPORT_UDP, 0);
  appendAttr(ATTR_REQUESTED_TRANSPORT, reqTransport);

  if (nonce && realm) {
    appendAttr(ATTR_REALM, Buffer.from(realm));
    appendAttr(ATTR_NONCE, Buffer.from(nonce));
    appendAttr(ATTR_USERNAME, Buffer.from(username));
    const body = Buffer.concat(attrs);
    const md5Key = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest();
    header.writeUInt16BE(body.length + 24, 2);
    const mi = crypto.createHmac("sha1", md5Key).update(Buffer.concat([header, body])).digest();
    const miAttr = Buffer.alloc(24);
    miAttr.writeUInt16BE(ATTR_MESSAGE_INTEGRITY, 0);
    miAttr.writeUInt16BE(20, 2);
    mi.copy(miAttr, 4);
    return Buffer.concat([header, body, miAttr]);
  }

  const body = Buffer.concat(attrs);
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function parseAttrs(msg: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let off = 20;
  while (off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    out.set(type, msg.slice(off + 4, off + 4 + len));
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return out;
}

function errorCode(msg: Buffer): number | null {
  const ec = parseAttrs(msg).get(ATTR_ERROR_CODE);
  if (!ec || ec.length < 4) return null;
  // TURN stores the code as reserved(2) | class(1) | number(1):
  // class 4 number 1 => 401.
  return ec.readUInt8(2) * 100 + ec.readUInt8(3);
}

function decodeRelayedAddress(msg: Buffer): string | null {
  const xor = parseAttrs(msg).get(ATTR_XOR_RELAYED_ADDRESS);
  if (!xor || xor.length < 8) return null;
  const family = xor.readUInt8(1);
  const port = xor.readUInt16BE(2) ^ 0x2112;
  if (family === 0x01 && xor.length >= 8) {
    const ip = Buffer.from(xor.subarray(4, 8).map((b, i) => (b ^ COOKIE[i]!) & 0xff));
    return `${ip.join(".")}:${port}`;
  }
  if (family === 0x02 && xor.length >= 20) {
    const ip = Buffer.from(xor.subarray(4, 20).map((b, i) => (b ^ COOKIE[i % COOKIE.length]!) & 0xff));
    return `[${ip.toString("hex")}]:${port}`;
  }
  return null;
}

/** One authenticated Allocate over UDP. Resolves true iff the server returns success. */
function allocateUdp(target: HostPort, username: string, password: string, timeoutMs: number): Promise<"success" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let stage = 1;
    const timer = setTimeout(() => { try { sock.close(); } catch { /* ignore */ } resolve("timeout"); }, timeoutMs);
    const finish = (r: "success" | "refused" | "timeout") => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      resolve(r);
    };
    sock.on("message", (msg) => {
      const type = msg.readUInt16BE(0);
      if (type === MSG_ALLOCATE_ERROR && stage === 1 && errorCode(msg) === 401) {
        stage = 2;
        const attrs = parseAttrs(msg);
        const realm = attrs.get(ATTR_REALM)?.toString() ?? "";
        const nonce = attrs.get(ATTR_NONCE)?.toString() ?? "";
        if (!realm || !nonce) return finish("refused");
        sock.send(buildAllocate(nonce, realm, username, password), target.port, target.host);
        return;
      }
      if (type === MSG_ALLOCATE_SUCCESS) return finish("success");
      finish("refused");
    });
    sock.on("error", () => finish("refused"));
    sock.send(buildAllocate(null, null, username, password), target.port, target.host);
  });
}

/** One authenticated Allocate over TCP or TLS. Resolves true iff the server returns success. */
function allocateStream(target: HostPort, username: string, password: string, useTls: boolean, timeoutMs: number): Promise<"success" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let stage = 1;
    let stream: net.Socket | tls.TLSSocket | null = null;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const finish = (r: "success" | "refused" | "timeout") => {
      clearTimeout(timer);
      try { stream?.destroy(); } catch { /* ignore */ }
      resolve(r);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 20) {
        const declared = buf.readUInt16BE(2);
        const total = 20 + declared;
        if (buf.length < total) return;
        const msg = buf.subarray(0, total);
        buf = buf.subarray(total);
        const type = msg.readUInt16BE(0);
        if (stage === 1 && type === MSG_ALLOCATE_ERROR && errorCode(msg) === 401) {
          stage = 2;
          const attrs = parseAttrs(msg);
          const realm = attrs.get(ATTR_REALM)?.toString() ?? "";
          const nonce = attrs.get(ATTR_NONCE)?.toString() ?? "";
          if (!realm || !nonce) return finish("refused");
          stream!.write(buildAllocate(nonce, realm, username, password));
          continue;
        }
        if (type === MSG_ALLOCATE_SUCCESS) return finish("success");
        return finish("refused");
      }
    };
    try {
      stream = useTls
        ? tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: false }, () => stream!.write(buildAllocate(null, null, username, password)))
        : net.connect({ host: target.host, port: target.port }, () => stream!.write(buildAllocate(null, null, username, password)));
    } catch {
      return finish("refused");
    }
    stream.on("data", onData);
    stream.on("error", () => finish("refused"));
    stream.on("close", () => finish("refused"));
  });
}

/** Parse "turn:host:port" / "turns:host:port?transport=tcp" into host+port+kind. */
export function parseTurnUrl(url: string): (HostPort & { kind: "udp" | "tcp" | "tls" }) | null {
  const m = /^(turns?):([^:/?]+)(?::(\d+))?(?:\?([^\s]*))?$/.exec(url.trim());
  if (!m) return null;
  const scheme = m[1]!, host = m[2]!, portStr = m[3], query = m[4] ?? "";
  const tlsTurn = scheme === "turns";
  const tcp = tlsTurn || query.includes("transport=tcp");
  const kind = tlsTurn ? "tls" : tcp ? "tcp" : "udp";
  return { host, port: Number(portStr ?? (tlsTurn ? 5349 : 3478)), kind };
}

/** Poll the relay until a newly-created credential propagates or we run out of time. */
export interface WaitForTurnOptions {
  timeoutMs?: number;
  intervalMs?: number;
  shouldAbort?: () => boolean;
  onAttempt?: (attempt: number, detail: string, elapsedMs: number) => void;
}

export async function waitForTurnCredential(
  urls: string[],
  username: string,
  credential: string,
  options: WaitForTurnOptions = {},
): Promise<VerifyResult> {
  const timeoutMs = options.timeoutMs ?? 150_000;
  const intervalMs = options.intervalMs ?? 15_000;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last: VerifyResult = { ok: false, detail: "credential not propagated yet" };

  for (let attempt = 1; Date.now() < deadline; attempt++) {
    if (options.shouldAbort?.()) return { ok: false, detail: "cancelled" };
    last = await verifyTurn(urls, username, credential, 3_000);
    options.onAttempt?.(attempt, last.detail, Date.now() - started);
    if (last.ok) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  return last;
}

/** Build the ICE-server URL list from host+scheme, ordered by what survives restrictive networks. */
export function buildTurnUrls(host: string): string[] {
  return [
    `stun:${host}:80`,
    `turn:${host}:80`,
    `turn:${host}:443`,
    `turn:${host}:80?transport=tcp`,
    `turn:${host}:443?transport=tcp`,
    `turns:${host}:443?transport=tcp`, // TLS — survives deep-packet-inspection firewalls
  ];
}

/**
 * Try every TURN URL against the given credential. Returns ok=true on the first
 * success (and which URL/transport worked), or the collective failure detail.
 */
export async function verifyTurn(urls: string[], username: string, credential: string, timeoutMs = 3000): Promise<VerifyResult> {
  const attempts: Array<{ kind: "udp" | "tcp" | "tls"; target: HostPort }> = [];
  for (const url of urls) {
    const parsed = parseTurnUrl(url);
    if (!parsed) continue;
    attempts.push({ kind: parsed.kind, target: { host: parsed.host, port: parsed.port } });
  }
  // UDP first (cheaper round trip), then TCP, then TLS
  const rank = (k: string) => (k === "udp" ? 0 : k === "tcp" ? 1 : 2);
  attempts.sort((a, b) => rank(a.kind) - rank(b.kind) || a.target.port - b.target.port);

  if (attempts.length === 0) return { ok: false, detail: "no usable TURN URL in the credential" };

  const failures: string[] = [];
  for (const a of attempts) {
    const r = a.kind === "udp"
      ? await allocateUdp(a.target, username, credential, timeoutMs)
      : await allocateStream(a.target, username, credential, a.kind === "tls", timeoutMs);
    if (r === "success") return { ok: true, detail: `relay accepted the credential`, via: `${a.kind.toUpperCase()} ${a.target.host}:${a.target.port}` };
    failures.push(`${a.kind.toUpperCase()} ${a.target.host}:${a.target.port} → ${r}`);
  }
  return { ok: false, detail: `credential rejected on all transports (${failures.join("; ")})` };
}

/** Kept exported for unit tests / diagnostics. */
export const __internals = { buildAllocate, parseAttrs, parseTurnUrl, buildTurnUrls, decodeRelayedAddress, waitForTurnCredential };
