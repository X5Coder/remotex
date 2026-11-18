/**
 * Headless CLI for the automatic TURN setup.
 *
 *   npm run build
 *   npm run turn:signup -- --out "%APPDATA%\remotex\turn.json"
 *
 * Useful for support, CI smoke tests, and for validating the flow without
 * launching the Electron window.
 */
import * as fs from "fs";
import * as path from "path";
import { buildTurnUrls, waitForTurnCredential } from "../turn-verify";
import { loadMailConfig, METERED_RELAY_HOST, runTurnSignup } from "./index";

interface Args {
  out: string;
  log: string;
  attempts: number;
  emailTimeoutMs: number;
  mailConfig?: string;
  verify: boolean;
  headless: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: path.join(process.cwd(), "turn.json"),
    log: path.join(process.cwd(), "turn-signup-logs"),
    attempts: 5,
    emailTimeoutMs: 120_000,
    verify: true,
    headless: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    switch (arg) {
      case "--out":
        args.out = path.resolve(next() ?? args.out);
        break;
      case "--log":
        args.log = path.resolve(next() ?? args.log);
        break;
      case "--attempts":
        args.attempts = Number(next() ?? args.attempts);
        break;
      case "--email-timeout":
        args.emailTimeoutMs = Number(next() ?? args.emailTimeoutMs);
        break;
      case "--mail-config":
        args.mailConfig = path.resolve(next() ?? "");
        break;
      case "--no-verify":
        args.verify = false;
        break;
      case "--headed":
        args.headless = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(args.attempts) || args.attempts < 1) throw new Error("--attempts must be a positive number");
  if (!Number.isFinite(args.emailTimeoutMs) || args.emailTimeoutMs < 10_000) {
    throw new Error("--email-timeout must be at least 10000 ms");
  }
  return args;
}

function printHelp(): void {
  console.log(`RemoteX automatic TURN setup

Options:
  --out <file>            where to write turn.json (default: ./turn.json)
  --log <dir>             diagnostic logs/screenshots (default: ./turn-signup-logs)
  --attempts <n>          signup attempts (default: 5)
  --email-timeout <ms>    verification-email wait per attempt (default: 120000)
  --mail-config <file>    JSON mailbox config (default: mail.tm)
  --no-verify             save without a real TURN Allocate check
  --headed                show the browser (debugging only)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("RemoteX automatic TURN setup");
  console.log(`  log:   ${args.log}`);
  console.log(`  out:   ${args.out}`);
  console.log(`  tries: ${args.attempts}`);

  const mailConfig = loadMailConfig(undefined, args.mailConfig);
  console.log(`  mail:  ${mailConfig.provider}`);

  const result = await runTurnSignup({
    mail: mailConfig,
    logDir: args.log,
    attempts: args.attempts,
    emailTimeoutMs: args.emailTimeoutMs,
    headed: !args.headless,
    onProgress: (p) => {
      console.log(`[${p.attempt}/${p.maxAttempts}] ${p.phase}: ${p.message}`);
    },
  });

  const urls = result.urls.length > 0 ? result.urls : buildTurnUrls(METERED_RELAY_HOST);
  console.log(`credentials extracted after ${result.attempts} attempt(s)`);

  if (args.verify) {
    console.log("testing the credential with a real TURN Allocate (new credentials can take up to 2 minutes to propagate)…");
    const proof = await waitForTurnCredential(urls, result.username, result.credential, {
      onAttempt: (attempt, detail) => {
        console.log(`  attempt ${attempt}: ${detail}`);
      },
    });
    if (!proof.ok) {
      throw new Error(`the relay rejected the extracted credential: ${proof.detail}`);
    }
    console.log(`relay accepted it via ${proof.via}`);
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const tmp = args.out + ".tmp";
  fs.writeFileSync(
    tmp,
    JSON.stringify({ urls, username: result.username, credential: result.credential }, null, 2) + "\n",
    "utf8",
  );
  fs.renameSync(tmp, args.out);
  console.log(`saved ${args.out}`);
}

main().catch((err) => {
  const e = err as { message?: string; name?: string; logDir?: string; cancelled?: boolean };
  console.error(`\nTURN setup failed: ${e?.message ?? String(err)}`);
  if (e?.logDir) console.error(`diagnostics: ${e.logDir}`);
  process.exitCode = e?.cancelled || e?.name === "AbortError" ? 130 : 1;
});
