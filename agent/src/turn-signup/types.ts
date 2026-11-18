/**
 * Shared contracts for the automatic Metered signup workflow.
 *
 * The workflow is deliberately split from Electron: the CLI and the main
 * process both drive the same code, and the mail transport is replaceable so a
 * deployment can plug in its existing inbox service instead of the default
 * disposable-mail provider.
 */

export type SignupPhase =
  | "starting"
  | "mailbox"
  | "browser"
  | "signup"
  | "verify-email"
  | "login"
  | "terms"
  | "create-app"
  | "credentials"
  | "done";

export interface SignupProgress {
  phase: SignupPhase;
  message: string;
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
}

export interface VerificationMessage {
  from: string;
  subject: string;
  text: string;
  html: string;
  receivedAt?: string;
}

export interface MailInbox {
  readonly address: string;
  /** Wait for the Metered verification mail. Rejects on timeout/abort. */
  waitForVerification(timeoutMs: number, signal?: AbortSignal): Promise<VerificationMessage>;
  /** Release provider-side resources, if any. */
  dispose?(): Promise<void>;
}

export interface MailProvider {
  readonly name: string;
  createInbox(signal?: AbortSignal): Promise<MailInbox>;
}

export interface MailTmConfig {
  provider: "mailtm";
  apiBase?: string;
  /** Optional fixed domain. When omitted, the first active public domain is used. */
  domain?: string;
}

export interface HttpMailConfig {
  provider: "http";
  /** POST — returns { address } (or { email }). */
  createUrl: string;
  /** GET — {address} is replaced with the inbox address; returns messages or { messages }. */
  messagesUrl: string;
  /** Optional GET — {id} is replaced with the message id; returns one message. */
  messageUrl?: string;
  /** Headers added to every provider request. */
  headers?: Record<string, string>;
}

export interface MaildropConfig {
  provider: "maildrop";
  /** GraphQL endpoint. Defaults to Maildrop's public API. */
  apiUrl?: string;
  /** Domain for generated mailboxes. Defaults to maildrop.cc. */
  domain?: string;
}

export type MailConfig = MailTmConfig | HttpMailConfig | MaildropConfig;

export interface TurnSignupOptions {
  mail?: MailConfig;
  /** Directory for failure screenshots / HTML dumps / flow logs. */
  logDir?: string;
  /** Defaults to 5. */
  attempts?: number;
  /** Timeout for ordinary page steps. Defaults to 30 s. */
  stepTimeoutMs?: number;
  /** Timeout for the signup POST + reCAPTCHA. Defaults to 45 s. */
  signupTimeoutMs?: number;
  /** Time to wait for the verification email. Defaults to 120 s. */
  emailTimeoutMs?: number;
  /** Delay between attempts. Defaults to 5 s. */
  retryDelayMs?: number;
  /** Show the browser window instead of running headless (debugging). */
  headed?: boolean;
  onProgress?: (progress: SignupProgress) => void;
  signal?: AbortSignal;
}

export interface TurnSignupResult {
  username: string;
  credential: string;
  /** TURN/STUN URLs scraped from Metered's snippet. May be empty. */
  urls: string[];
  email: string;
  attempts: number;
}

export class TurnSignupError extends Error {
  readonly attempt: number;
  readonly logDir?: string;
  readonly cancelled: boolean;

  constructor(message: string, opts: { attempt?: number; logDir?: string; cancelled?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "TurnSignupError";
    this.attempt = opts.attempt ?? 0;
    this.logDir = opts.logDir;
    this.cancelled = opts.cancelled ?? false;
  }
}
