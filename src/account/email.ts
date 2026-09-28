/**
 * Transactional email for DEMO accounts: provider resolution, message
 * templates, and truthful delivery reporting.
 *
 * DEMO's required authentication sender identity is `demomcp7@gmail.com`.
 * Two supported ways to actually send as it, and the honest limits of each:
 *
 *  - `gmail` — SMTP submission to smtp.gmail.com:465 (implicit TLS) with a
 *    Google **App Password**. The mailbox genuinely is the sender; Google signs
 *    the message (SPF/DKIM) and it lands in the user's inbox as demomcp7@gmail.com.
 *    Requires 2-Step Verification on that Google account and a generated App
 *    Password. Only the App Password is secret.
 *  - `resend` — HTTPS API. Resend can only send from a domain *you own and have
 *    verified*; `gmail.com` is not yours, so `demomcp7@gmail.com` can only be the
 *    Reply-To here. If `EMAIL_FROM` points at a public mailbox domain this module
 *    reports the configuration as invalid instead of letting every send be
 *    rejected at the provider.
 *  - `smtp` — any other SMTP relay (489/465/587) with explicit host/credentials.
 *
 * Discipline: credentials are read from Worker secrets only; no log statement in
 * this file includes a credential, a token, a code, or message content; a send
 * failure is *reported* and never converted into a fake success.
 */

import { buildMimeMessage, smtpSend, type SmtpConnect } from "./smtp.js";

export type EmailProviderId = "resend" | "gmail" | "smtp";

/** The DEMO sender identity requested for all authentication mail. */
export const DEFAULT_EMAIL_ADDRESS = "demomcp7@gmail.com";
export const DEFAULT_EMAIL_FROM = `DEMO MCP <${DEFAULT_EMAIL_ADDRESS}>`;
const DEFAULT_GMAIL_HOST = "smtp.gmail.com";
const DEFAULT_GMAIL_PORT = 465;

/**
 * Domains that no HTTP email API can authenticate. Naming them is a
 * configuration *policy* check, not a secret: it turns "every send is rejected
 * by the provider at runtime" into an actionable startup diagnostic.
 */
const UNVERIFIABLE_FROM_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "mail.com", "yandex.com", "zoho.com",
]);

export interface AccountEmailEnv extends Record<string, unknown> {
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  ACCOUNT_EMAIL_TIMEOUT_MS?: string | number;
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string | number;
  SMTP_SECURE?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
}

/**
 * Accepted binding names for the SMTP password secret, canonical name first.
 *
 * The value is typed by hand into the Cloudflare dashboard or piped into
 * `wrangler secret put`, and a secret only ever reaches the Worker under the
 * exact name it was saved as. Cloudflare binding names are case sensitive, so a
 * secret saved as `smtp_password`, `SMTP_PASS` or `GMAIL_APP_PASSWORD` is
 * perfectly visible in the dashboard while `env.SMTP_PASSWORD` stays undefined
 * — the deployment then reports "the secret is not set" to an operator who is
 * looking straight at it. Accepting the usual spellings, matched
 * case- and separator-insensitively, turns that dead end into a working sender.
 * Only the *name* is ever reported; the value never is.
 */
export const SMTP_PASSWORD_SECRETS = [
  "SMTP_PASSWORD",
  "GMAIL_APP_PASSWORD",
  "SMTP_PASS",
  "EMAIL_PASSWORD",
  "APP_PASSWORD",
] as const;

export interface SecretPresence {
  /** The env key the value was found under; null when no such key exists at all. */
  key: string | null;
  /** Trimmed value — empty when unset, or when set to whitespace only. */
  value: string;
}

/** Binding names compare case- and separator-insensitively (`smtp-pass` == `SMTP_PASS`). */
function normalizeKeyName(name: string): string {
  return String(name ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Look a secret up under any of its accepted names.
 *
 * The key is returned even when the value is blank, because "no secret with
 * this name exists" and "a secret with this name is set to nothing" are two
 * different operator mistakes that look identical from the outside — and the
 * second one is invisible from the Cloudflare dashboard, which shows the name
 * and never the value.
 */
export function resolveEnvSecret(
  env: AccountEmailEnv | Record<string, unknown>,
  names: readonly string[],
): SecretPresence {
  const source = (env ?? {}) as Record<string, unknown>;
  let blank: string | null = null;
  const note = (key: string, value: string): SecretPresence => {
    if (value) return { key, value };
    if (blank === null) blank = key;
    return { key: blank, value: "" };
  };
  // Exact names first, so the canonical spelling always wins over a lookalike.
  for (const name of names) {
    const raw = source[name];
    if (typeof raw !== "string") continue;
    const found = note(name, raw.trim());
    if (found.value) return found;
  }
  const wanted = new Set(names.map(normalizeKeyName));
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw !== "string") continue;
    if (!wanted.has(normalizeKeyName(key))) continue;
    const found = note(key, raw.trim());
    if (found.value) return found;
  }
  return { key: blank, value: "" };
}

/**
 * The operator-facing explanation for a missing SMTP password.
 *
 * Says which names were looked for and how to set it, because "the secret is
 * not set" is only actionable once the operator knows exactly what the Worker
 * looks for and why it cannot see what they already saved.
 */
function smtpPasswordReason(secret: SecretPresence, mailbox: string | null): string {
  if (secret.key) {
    return `Email delivery is off: the ${secret.key} secret exists on this Worker but its value is empty. `
      + "Re-set it with: wrangler secret put SMTP_PASSWORD";
  }
  const target = mailbox ? ` for ${mailbox}` : "";
  return `Email delivery is off: no SMTP password secret is set on this Worker${target}. `
    + `DEMO looks for a Google App Password under ${SMTP_PASSWORD_SECRETS.join(", ")} `
    + "(names are matched case-insensitively) and found none of them. "
    + "Set the canonical one with: wrangler secret put SMTP_PASSWORD";
}

export interface AccountEmailConfig {
  provider: EmailProviderId | null;
  /** True only when a real send has a complete, usable configuration. */
  configured: boolean;
  /** Bare sender address, e.g. `demomcp7@gmail.com` — safe to report. */
  from: string | null;
  /** Display name paired with `from` in the From header. */
  fromName: string | null;
  /** Address that receives replies; DEMO sets the sender mailbox by default. */
  replyTo: string | null;
  /** Operator-facing explanation when `configured` is false. */
  reason: string | null;
  /** Non-secret SMTP endpoint summary, for diagnostics only. */
  smtp: { host: string; port: number; secureTransport: "on" | "starttls" | "off" } | null;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSendResult {
  sent: boolean;
  reason: string | null;
  provider: EmailProviderId | null;
}

/** Split `Display Name <user@example.com>` / `user@example.com` into parts. */
export function parseFrom(value: string): { address: string; name: string | null } {
  const raw = String(value ?? "").trim();
  const angled = /^(.*?)<\s*([^<>]+)\s*>\s*$/.exec(raw);
  const address = (angled ? angled[2]! : raw).trim();
  const name = angled ? (angled[1] ?? "").trim().replace(/^"|"$/g, "") : "";
  return { address, name: name || null };
}

function isEmailAddress(value: string): boolean {
  return /^[^\s@,<>]{1,64}@[^\s@,<>]{1,249}\.[^\s@,<>]{2,}$/.test(value);
}

function boolFrom(value: string | undefined, fallback: boolean): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "on", "required"].includes(text);
}

/** True only for addresses that cannot leave the machine. */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function portFrom(value: string | number | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

/**
 * Resolve the email surface. Presence and policy only — never a credential
 * value, and never a guess: if a required secret is missing the system reports
 * *why* email is off rather than silently degrading.
 */
export function resolveAccountEmailConfig(env: AccountEmailEnv): AccountEmailConfig {
  const from = parseFrom(env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM);
  const replyTo = String(env.EMAIL_REPLY_TO ?? "").trim() || null;
  const requested = String(env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const provider: EmailProviderId | null =
    requested === "resend" || requested === "gmail" || requested === "smtp" ? requested : null;

  const base = {
    from: isEmailAddress(from.address) ? from.address : null,
    fromName: from.name,
    replyTo: replyTo && isEmailAddress(replyTo) ? replyTo : null,
    smtp: null as AccountEmailConfig["smtp"],
  };

  if (!provider) {
    return {
      ...base,
      provider: null,
      configured: false,
      reason: "Email delivery is off: set EMAIL_PROVIDER to \"gmail\", \"resend\" or \"smtp\" on this Worker.",
    };
  }
  if (!base.from) {
    return {
      ...base,
      provider,
      configured: false,
      reason: "Email delivery is off: EMAIL_FROM is not a usable email address.",
    };
  }

  if (provider === "resend") {
    const apiKey = String(env.RESEND_API_KEY ?? "").trim();
    const domain = base.from.split("@")[1]!.toLowerCase();
    if (UNVERIFIABLE_FROM_DOMAINS.has(domain)) {
      return {
        ...base,
        provider,
        configured: false,
        reason: `Email delivery is off: Resend can only send from a domain you have verified, and "${domain}" cannot be verified by anyone but its owner. `
          + "Set EMAIL_PROVIDER=gmail with a Google App Password to send as this mailbox, verify your own domain for Resend, or point EMAIL_FROM at an address on that domain and keep demomcp7@gmail.com as EMAIL_REPLY_TO.",
      };
    }
    if (!apiKey) {
      return { ...base, provider, configured: false, reason: "Email delivery is off: the RESEND_API_KEY secret is not set on this Worker." };
    }
    return { ...base, provider, configured: true, reason: null };
  }

  // SMTP-family providers.
  if (provider === "gmail") {
    const username = String(env.SMTP_USERNAME ?? "").trim() || base.from;
    const secret = resolveEnvSecret(env, SMTP_PASSWORD_SECRETS);
    const smtp = { host: DEFAULT_GMAIL_HOST, port: DEFAULT_GMAIL_PORT, secureTransport: "on" as const };
    if (!isEmailAddress(username)) {
      return { ...base, provider, configured: false, reason: "Email delivery is off: the Gmail SMTP username is not a usable email address.", smtp };
    }
    // Gmail rewrites the envelope sender to the authenticated mailbox, so a
    // mismatch here would silently send from a different address than EMAIL_FROM.
    if (username.toLowerCase() !== base.from.toLowerCase()) {
      return {
        ...base,
        provider,
        configured: false,
        reason: `Email delivery is off: Gmail requires EMAIL_FROM (${base.from}) to be the authenticated mailbox (${username}); it cannot send as another address.`,
        smtp,
      };
    }
    if (!secret.value) {
      return {
        ...base,
        provider,
        configured: false,
        reason: smtpPasswordReason(secret, base.from),
        smtp,
      };
    }
    return { ...base, provider, configured: true, reason: null, smtp };
  }

  const host = String(env.SMTP_HOST ?? "").trim().toLowerCase();
  const username = String(env.SMTP_USERNAME ?? "").trim();
  const secret = resolveEnvSecret(env, SMTP_PASSWORD_SECRETS);
  const port = portFrom(env.SMTP_PORT, 465);
  const plaintextLoopback = !boolFrom(env.SMTP_SECURE, true) && isLoopbackHost(host);
  const secureTransport: "on" | "starttls" | "off" = plaintextLoopback
    ? "off"
    : port === 587 || port === 2587
      ? "starttls"
      : "on";
  const smtp = { host, port, secureTransport };
  if (!isLoopbackHost(host) && (!/^[a-z0-9.-]+$/.test(host) || !host.includes("."))) {
    return { ...base, provider, configured: false, reason: "Email delivery is off: SMTP_HOST is not a usable hostname.", smtp: null };
  }
  // Plaintext submission is refused for any real relay, because the App
  // Password would cross the network in the clear. A loopback host is the one
  // exception: nothing leaves the machine, and it is what lets the account
  // flow be exercised end to end against a local SMTP sink.
  if (!boolFrom(env.SMTP_SECURE, true) && !isLoopbackHost(host)) {
    return { ...base, provider, configured: false, reason: "Email delivery is off: unencrypted SMTP is not supported; use port 465 (implicit TLS) or 587 (STARTTLS).", smtp };
  }
  if (port === 25) {
    return { ...base, provider, configured: false, reason: "Email delivery is off: Cloudflare Workers cannot connect to SMTP port 25.", smtp };
  }
  if (!username) {
    return { ...base, provider, configured: false, reason: "Email delivery is off: SMTP_USERNAME is not set on this Worker; a password alone cannot authenticate.", smtp };
  }
  if (!secret.value) {
    return { ...base, provider, configured: false, reason: smtpPasswordReason(secret, base.from), smtp };
  }
  return { ...base, provider, configured: true, reason: null, smtp };
}

/** Short, non-secret summary for the public status/telemetry surface. */
export function emailDeliverySummary(config: AccountEmailConfig): { configured: boolean; provider: EmailProviderId | null; from: string | null; reason: string | null } {
  return { configured: config.configured, provider: config.provider, from: config.configured ? config.from : null, reason: config.reason };
}

export interface SendEmailDeps {
  /** Injected in tests; production uses the runtime fetch. */
  fetch?: typeof fetch;
  /** Injected in tests; production resolves `cloudflare:sockets`. */
  connect?: SmtpConnect;
  now?: () => number;
}

/**
 * Deliver one message through the configured provider.
 *
 * Failures are reported, never raised: a lost verification email must not crash
 * the request that triggered it. The returned `reason` is safe to show a user or
 * operator and contains no credential material.
 */
export async function sendAccountEmail(
  env: AccountEmailEnv,
  message: EmailMessage,
  deps: SendEmailDeps | typeof fetch = {},
): Promise<EmailSendResult> {
  // Backwards-compatible: the original signature passed a bare fetcher.
  const resolved: SendEmailDeps = typeof deps === "function" ? { fetch: deps } : deps;
  const config = resolveAccountEmailConfig(env);
  if (!config.configured || !config.provider || !config.from) {
    return { sent: false, reason: config.reason ?? "Email delivery is not configured on this deployment.", provider: config.provider };
  }
  if (!isEmailAddress(String(message.to ?? ""))) {
    return { sent: false, reason: "The recipient address is not usable, so no message was sent.", provider: config.provider };
  }
  if (config.provider === "resend") return sendViaResend(env, config, message, resolved);
  if (!config.smtp) {
    return { sent: false, reason: "The SMTP endpoint is not configured, so no message was sent.", provider: config.provider };
  }
  return sendViaSmtp(env, config, message, resolved);
}

async function sendViaResend(
  env: AccountEmailEnv,
  config: AccountEmailConfig,
  message: EmailMessage,
  deps: SendEmailDeps,
): Promise<EmailSendResult> {
  const fetcher = deps.fetch ?? fetch;
  const payload: Record<string, unknown> = {
    from: config.fromName ? `${config.fromName} <${config.from}>` : config.from,
    to: [message.to],
    subject: message.subject,
    text: message.text,
  };
  if (config.replyTo) payload.reply_to = config.replyTo;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${String(env.RESEND_API_KEY ?? "").trim()}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(emailTimeoutMs(env, deps.now)),
    });
    if (!response.ok) {
      return { sent: false, reason: `The email provider rejected the message (HTTP ${response.status}).`, provider: "resend" };
    }
    return { sent: true, reason: null, provider: "resend" };
  } catch {
    return { sent: false, reason: "The email provider could not be reached.", provider: "resend" };
  }
}

async function sendViaSmtp(
  env: AccountEmailEnv,
  config: AccountEmailConfig,
  message: EmailMessage,
  deps: SendEmailDeps,
): Promise<EmailSendResult> {
  const smtp = config.smtp!;
  const username = String(env.SMTP_USERNAME ?? "").trim() || config.from!;
  // Resolve the credential through the same alias-aware lookup the
  // configuration check used, so a password saved under an accepted alias is
  // the password that actually goes on the wire.
  const resolved = resolveEnvSecret(env, SMTP_PASSWORD_SECRETS);
  // Google displays App Passwords in groups of four ("abcd efgh ijkl mnop").
  // The grouping is display-only, so a value pasted verbatim would otherwise
  // authenticate with spaces that were never part of the credential. Only the
  // Gmail path strips them: a generic relay password is used exactly as saved.
  const password = config.provider === "gmail" ? resolved.value.replace(/\s+/g, "") : resolved.value;
  const mime = buildMimeMessage({
    from: config.from!,
    fromName: config.fromName,
    to: message.to,
    replyTo: config.replyTo,
    subject: message.subject,
    text: message.text,
  });
  const result = await smtpSend({
    host: smtp.host,
    port: smtp.port,
    secureTransport: smtp.secureTransport,
    username,
    password,
    envelopeFrom: config.from!,
    recipient: message.to,
    message: mime,
    connect: deps.connect,
    timeoutMs: emailTimeoutMs(env, deps.now),
  });
  if (result.ok) return { sent: true, reason: null, provider: config.provider };
  return {
    sent: false,
    reason: `The mail server did not accept the message at the ${result.stage} step. ${result.detail ?? ""}`.trim(),
    provider: config.provider,
  };
}

function emailTimeoutMs(env: AccountEmailEnv, _now?: () => number): number {
  const parsed = Number(String(env.ACCOUNT_EMAIL_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(parsed) && parsed >= 2_000 ? Math.min(20_000, Math.trunc(parsed)) : 8_000;
}

/* ------------------------------------------------------------- message copy */

export function verificationEmail(code: string, link: string | null, codeTtlMinutes: number): Pick<EmailMessage, "subject" | "text"> {
  const lines = [
    "Your DEMO account verification code is:",
    "",
    `  ${code}`,
    "",
  ];
  if (link) {
    lines.push("Or verify in one click — this link works once and expires with the code:", "", `  ${link}`, "");
  }
  lines.push(`The code and link expire in ${codeTtlMinutes} minutes.`, "If you did not create a DEMO account, you can ignore this message.");
  return { subject: `${code} is your DEMO verification code`, text: lines.join("\n") };
}

export function resetEmail(origin: string | null, token: string, tokenTtlMinutes: number): Pick<EmailMessage, "subject" | "text"> {
  const link = origin ? `${origin}/#/reset?token=${encodeURIComponent(token)}` : null;
  return {
    subject: "Reset your DEMO password",
    text: [
      "A password reset was requested for your DEMO account.",
      "",
      link ? `Reset link (valid ${tokenTtlMinutes} minutes):` : `Reset token (valid ${tokenTtlMinutes} minutes):`,
      link ? `  ${link}` : `  ${token}`,
      "",
      "The link works once. If you did not request this, ignore this message — your password stays unchanged.",
    ].join("\n"),
  };
}

export function passwordChangedEmail(origin: string | null, when: number): Pick<EmailMessage, "subject" | "text"> {
  return {
    subject: "Your DEMO password was changed",
    text: [
      "The password on your DEMO account was just changed, and every existing session was signed out.",
      "",
      `Time: ${new Date(when).toUTCString()}`,
      "",
      origin ? `If this was not you, reset your password now: ${origin}/#/auth` : "If this was not you, reset your password immediately from the DEMO sign-in page.",
      "Sign in with the new password to continue.",
    ].join("\n"),
  };
}

export function accountDeletedEmail(when: number): Pick<EmailMessage, "subject" | "text"> {
  return {
    subject: "Your DEMO account was deleted",
    text: [
      "Your DEMO account was deleted, along with every active session and any linked Roblox grant.",
      "",
      `Time: ${new Date(when).toUTCString()}`,
      "",
      "Any DEMO authorization previously granted to an MCP client expires within its normal short lifetime.",
      "If this was not you, recreate the account and contact the DEMO operator.",
    ].join("\n"),
  };
}
