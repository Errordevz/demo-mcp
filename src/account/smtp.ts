/**
 * Minimal, strict SMTP submission client for the Workers runtime.
 *
 * Why this exists: DEMO's required authentication sender identity is a Gmail
 * mailbox (`demomcp7@gmail.com`). A Gmail account cannot be used as the `From`
 * domain of an HTTP email API such as Resend — those providers only send from a
 * domain whose DNS records you control and have verified, and `gmail.com` is not
 * yours. The only way to send *as* that mailbox is SMTP submission against
 * Gmail's own servers with a Google App Password, which is what this module
 * implements.
 *
 * Cloudflare Workers cannot open a raw TCP socket in the Node sense, but the
 * runtime does expose `cloudflare:sockets`' `connect()`. Submission is only
 * attempted on port 465 with implicit TLS (plus an opt-in STARTTLS upgrade on
 * 587): workerd refuses outbound port 25, and implicit TLS is the path Gmail
 * documents for submission.
 *
 * Design constraints:
 *  - never log or return the password or the AUTH payload;
 *  - parse multi-line replies correctly (`250-FOO` continuation vs `250 BAR`);
 *  - fail closed on any unexpected reply code, naming the failing stage;
 *  - never let a network error escape as an exception from `smtpSend`.
 */

/** Structural subset of the `cloudflare:sockets` Socket this module depends on. */
export interface SmtpSocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close?(): void | Promise<void>;
  startTls?(): SmtpSocketLike;
}

export interface SmtpConnectOptions {
  secureTransport: "on" | "starttls" | "off";
}

export type SmtpConnect = (
  address: { hostname: string; port: number },
  options: SmtpConnectOptions,
) => SmtpSocketLike;

export interface SmtpSendOptions {
  host: string;
  port: number;
  secureTransport: "on" | "starttls" | "off";
  /** SMTP AUTH username. For Gmail this is the full mailbox address. */
  username: string;
  /** SMTP AUTH password (a Google App Password). Never logged, never returned. */
  password: string;
  /** Envelope sender (MAIL FROM). Must be the authenticated mailbox on Gmail. */
  envelopeFrom: string;
  recipient: string;
  /** Fully-formed RFC 5322 message, header block first. */
  message: string;
  /** Injected in tests; production resolves `cloudflare:sockets`. */
  connect?: SmtpConnect;
  /** Total conversation budget in milliseconds. */
  timeoutMs?: number;
}

export interface SmtpResult {
  ok: boolean;
  /** Protocol stage that failed, for a precise operator-facing reason. */
  stage: string;
  /** Server reply code, when the server answered. */
  code: number | null;
  detail: string | null;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REPLY_BYTES = 8 * 1024;
const STEP_BUDGET_MS = 5_000;

/**
 * `cloudflare:sockets` is a runtime builtin, not an npm package, so a static
 * import would break the Node test runner. Tests always inject `connect`, so
 * this is only ever reached inside a deployed Worker.
 */
async function defaultConnect(): Promise<SmtpConnect | null> {
  try {
    const module = (await import(/* @vite-ignore */ "cloudflare:sockets")) as unknown as {
      connect?: (address: { hostname: string; port: number }, options: Record<string, unknown>) => unknown;
    };
    if (typeof module.connect !== "function") return null;
    return (address, options) => module.connect!(address, { secureTransport: options.secureTransport, allowHalfOpen: false }) as SmtpSocketLike;
  } catch {
    return null;
  }
}

export class SmtpFailure extends Error {
  constructor(
    readonly stage: string,
    readonly code: number | null,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "SmtpFailure";
  }
}

interface SmtpReply {
  code: number;
  text: string;
}

/** RFC 5321 line discipline, tolerant of bare codes and `\n`-only input. */
function parseReplyLine(line: string): { code: number; separator: string; text: string } | null {
  const match = /^(\d{3})([- ]?)(.*)$/.exec(line);
  if (!match) return null;
  return { code: Number(match[1]), separator: match[2] ?? "", text: match[3] ?? "" };
}

/**
 * One SMTP conversation over a buffered socket. All reads and writes share a
 * total deadline so a stalled server can never hold a request open.
 */
class SmtpSession {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly deadline: number;
  private buffer = "";

  constructor(private readonly socket: SmtpSocketLike, timeoutMs: number) {
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    this.deadline = Date.now() + timeoutMs;
  }

  private async guard<T>(promise: Promise<T>, stage: string): Promise<T> {
    const left = Math.min(STEP_BUDGET_MS, this.deadline - Date.now());
    if (left <= 0) throw new SmtpFailure(stage, null, "The mail server did not respond in time.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SmtpFailure(stage, null, "The mail server did not respond in time.")), left);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Read one full line into the buffer, returning it. */
  private async readLine(stage: string): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return line;
      }
      const chunk = await this.guard(this.reader.read(), stage);
      if (chunk.done) throw new SmtpFailure(stage, null, "The mail server closed the connection unexpectedly.");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      if (this.buffer.length > MAX_REPLY_BYTES) throw new SmtpFailure(stage, null, "The mail server sent an unusable reply.");
    }
  }

  /** Read a complete (possibly multi-line) reply. */
  async reply(stage: string): Promise<SmtpReply> {
    const first = parseReplyLine(await this.readLine(stage));
    if (!first) throw new SmtpFailure(stage, null, "The mail server sent a reply DEMO could not parse.");
    if (first.separator !== "-") return { code: first.code, text: first.text };
    const parts = [first.text];
    for (;;) {
      const next = parseReplyLine(await this.readLine(stage));
      if (!next) throw new SmtpFailure(stage, null, "The mail server sent a reply DEMO could not parse.");
      parts.push(next.text);
      if (next.separator !== "-") return { code: first.code, text: parts.join(" ") };
    }
  }

  async write(payload: string, stage: string): Promise<void> {
    await this.guard(this.writer.write(this.encoder.encode(payload)), stage);
  }

  /** Optionally send a command, then assert the reply code is acceptable. */
  async command(line: string | null, stage: string, expected: readonly number[]): Promise<SmtpReply> {
    if (line !== null) await this.write(`${line}\r\n`, stage);
    const result = await this.reply(stage);
    if (!expected.includes(result.code)) {
      // The server text is safe to surface: AUTH payloads are never echoed back.
      throw new SmtpFailure(stage, result.code, `The mail server rejected this step (${result.code} ${result.text.slice(0, 180)}).`);
    }
    return result;
  }

  async authenticate(username: string, password: string): Promise<void> {
    try {
      await this.command(`AUTH PLAIN ${base64Utf8(`\u0000${username}\u0000${password}`)}`, "auth", [235]);
      return;
    } catch (error) {
      // Only a "command not recognised / not implemented" answer justifies a
      // second credential exchange; a 5xx auth rejection must not be retried.
      const retryable = error instanceof SmtpFailure && error.code !== null && [500, 501, 502, 504].includes(error.code);
      if (!retryable) throw error;
    }
    await this.command("AUTH LOGIN", "auth", [334]);
    await this.command(base64Utf8(username), "auth", [334]);
    await this.command(base64Utf8(password), "auth", [235]);
  }

  /** DATA body: dot-stuffing per RFC 5321 §4.5.2 and a guaranteed final CRLF. */
  async sendMessage(message: string, stage: string): Promise<void> {
    const normalised = message.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
    const body = normalised.endsWith("\r\n") ? `${normalised}.\r\n` : `${normalised}\r\n.\r\n`;
    await this.write(body, stage);
    await this.command(null, stage, [250]);
  }

  async close(): Promise<void> {
    try {
      this.writer.releaseLock();
    } catch { /* already released */ }
    try {
      this.reader.releaseLock();
    } catch { /* already released */ }
    try {
      await this.socket.close?.();
    } catch { /* the conversation is already over */ }
  }
}

/** Base64 of a UTF-8 string; `btoa` alone would mangle non-ASCII credentials. */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Submit one message. Never throws: every failure is returned as a structured
 * result whose `detail` is safe to show an operator — it never contains the
 * password, the AUTH payload, or the message body.
 */
export async function smtpSend(options: SmtpSendOptions): Promise<SmtpResult> {
  const timeoutMs = clampTimeout(options.timeoutMs);
  const connect = options.connect ?? (await defaultConnect());
  if (!connect) {
    return { ok: false, stage: "connect", code: null, detail: "SMTP sockets are unavailable in this runtime." };
  }
  let session: SmtpSession | null = null;
  try {
    const socket = connect({ hostname: options.host, port: options.port }, { secureTransport: options.secureTransport });
    session = new SmtpSession(socket, timeoutMs);
    await session.command(null, "greeting", [220]);
    await session.command("EHLO demo-mcp.workers.dev", "ehlo", [250]);
    if (options.secureTransport === "starttls") {
      await session.command("STARTTLS", "starttls", [220]);
      if (typeof socket.startTls !== "function") {
        throw new SmtpFailure("starttls", null, "This runtime cannot upgrade the SMTP connection to TLS.");
      }
      session = new SmtpSession(socket.startTls(), timeoutMs);
      await session.command("EHLO demo-mcp.workers.dev", "ehlo", [250]);
    }
    if (options.username && options.password) await session.authenticate(options.username, options.password);
    await session.command(`MAIL FROM:<${sanitizeAddress(options.envelopeFrom)}>`, "mail_from", [250]);
    await session.command(`RCPT TO:<${sanitizeAddress(options.recipient)}>`, "rcpt_to", [250, 251]);
    await session.command("DATA", "data", [354]);
    await session.sendMessage(options.message, "data");
    await session.command("QUIT", "quit", [221, 250]).catch(() => undefined);
    return { ok: true, stage: "done", code: 250, detail: null };
  } catch (error) {
    if (error instanceof SmtpFailure) return { ok: false, stage: error.stage, code: error.code, detail: error.detail };
    return { ok: false, stage: "connect", code: null, detail: "The mail server could not be reached." };
  } finally {
    if (session) await session.close();
  }
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(20_000, Math.max(2_000, Math.trunc(value as number)));
}

/** Strip anything that could terminate the address argument early. */
export function sanitizeAddress(value: string): string {
  return String(value ?? "").replace(/[<>\r\n\s]/g, "").slice(0, 254);
}

export interface MailMessage {
  from: string;
  fromName: string | null;
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
}

/**
 * Build a minimal, correct RFC 5322 message.
 *
 * Every header value is stripped of CR/LF, so no value (recipient, display name,
 * subject) can inject an additional header or body part.
 */
export function buildMimeMessage(message: MailMessage): string {
  const headers = [
    `From: ${formatAddress(message.fromName, message.from)}`,
    `To: ${formatAddress(null, message.to)}`,
  ];
  if (message.replyTo) headers.push(`Reply-To: ${formatAddress(null, message.replyTo)}`);
  headers.push(
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId(message.from)}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
  );
  // Body line endings are normalised here; dot-stuffing happens in sendMessage.
  const body = message.text.replace(/\r?\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

function formatAddress(name: string | null, address: string): string {
  const clean = sanitizeAddress(address);
  const safeName = name ? stripControl(name) : "";
  return safeName ? `"${safeName.replace(/(["\\])/g, "\\$1")}" <${clean}>` : `<${clean}>`;
}

/** RFC 2047 encoding for any header value that is not plain ASCII. */
function encodeHeaderValue(value: string): string {
  const single = stripControl(value);
  if (/^[\x20-\x7e]*$/.test(single)) return single;
  const bytes = new TextEncoder().encode(single);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function stripControl(value: string): string {
  return String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim();
}

function messageId(from: string): string {
  const domain = (sanitizeAddress(from).split("@")[1] || "demo-mcp.workers.dev").replace(/[^A-Za-z0-9.-]/g, "");
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const token = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}.${token}@${domain || "demo-mcp.workers.dev"}`;
}
