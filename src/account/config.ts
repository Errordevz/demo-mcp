/**
 * Account-system configuration and transactional email.
 *
 * Everything here is policy/presence only. The email credential
 * (`RESEND_API_KEY`) is a Worker *secret*, never a var, never logged, and the
 * sender address is the only email-related value that is safe to report.
 */

export interface AccountConfig {
  sessionTtlSeconds: number;
  verificationCodeTtlSeconds: number;
  resetTokenTtlSeconds: number;
  rateLimitPerMinute: number;
  /** Canonical public origin for links in email (never request-derived). */
  publicOrigin: string | null;
  email: {
    provider: "resend" | null;
    configured: boolean;
    from: string | null;
  };
}

export interface AccountConfigEnv extends Record<string, unknown> {
  MCP_PUBLIC_ORIGIN?: string;
  ACCOUNT_SESSION_TTL_SECONDS?: string | number;
  ACCOUNT_RATE_LIMIT_PER_MINUTE?: string | number;
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
}

function numberFrom(value: string | number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

export function resolveAccountConfig(env: AccountConfigEnv): AccountConfig {
  let publicOrigin: string | null = null;
  const raw = (env.MCP_PUBLIC_ORIGIN ?? "").trim();
  if (raw) {
    try {
      const parsed = new URL(raw);
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if ((parsed.protocol === "https:" || (local && parsed.protocol === "http:")) && !parsed.username && !parsed.password) {
        publicOrigin = parsed.origin;
      }
    } catch {
      publicOrigin = null;
    }
  }
  const provider = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase() === "resend" ? ("resend" as const) : null;
  const from = (env.EMAIL_FROM ?? "").trim();
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const emailConfigured = Boolean(provider && from && from.length <= 254 && apiKey);
  return {
    sessionTtlSeconds: numberFrom(env.ACCOUNT_SESSION_TTL_SECONDS, 60 * 60 * 24 * 30, 3600, 60 * 60 * 24 * 90),
    verificationCodeTtlSeconds: 30 * 60,
    resetTokenTtlSeconds: 30 * 60,
    rateLimitPerMinute: numberFrom(env.ACCOUNT_RATE_LIMIT_PER_MINUTE, 20, 1, 300),
    publicOrigin,
    email: {
      provider,
      configured: emailConfigured,
      from: emailConfigured ? from : null,
    },
  };
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSendResult {
  sent: boolean;
  reason: string | null;
}

/**
 * Best-effort transactional email through the configured HTTPS provider.
 * Failures are reported, never raised: a lost verification email must not crash
 * the request that triggered it, and no email content is ever logged.
 */
export async function sendAccountEmail(env: AccountConfigEnv, message: EmailMessage, fetcher: typeof fetch = fetch): Promise<EmailSendResult> {
  const config = resolveAccountConfig(env);
  if (!config.email.configured || config.email.provider !== "resend" || !config.email.from) {
    return { sent: false, reason: "Email delivery is not configured on this deployment (EMAIL_PROVIDER/EMAIL_FROM/RESEND_API_KEY)." };
  }
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${(env.RESEND_API_KEY ?? "").trim()}`,
      },
      body: JSON.stringify({ from: config.email.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { sent: false, reason: `The email provider rejected the message (HTTP ${response.status}).` };
    return { sent: true, reason: null };
  } catch {
    return { sent: false, reason: "The email provider could not be reached." };
  }
}

export function verificationEmail(code: string, codeTtlMinutes: number): Pick<EmailMessage, "subject" | "text"> {
  return {
    subject: `${code} is your DEMO verification code`,
    text: [
      "Your DEMO account verification code is:",
      "",
      `  ${code}`,
      "",
      `It expires in ${codeTtlMinutes} minutes. If you did not create a DEMO account, ignore this message.`,
    ].join("\n"),
  };
}

export function resetEmail(origin: string | null, token: string, tokenTtlMinutes: number): Pick<EmailMessage, "subject" | "text"> {
  const link = origin ? `${origin}/#/auth/reset?token=${encodeURIComponent(token)}` : null;
  return {
    subject: "Reset your DEMO password",
    text: [
      "A password reset was requested for your DEMO account.",
      "",
      link ? `Reset link (valid ${tokenTtlMinutes} minutes):` : `Reset token (valid ${tokenTtlMinutes} minutes):`,
      link ? `  ${link}` : `  ${token}`,
      "",
      "If you did not request this, ignore this message — your password stays unchanged.",
    ].join("\n"),
  };
}
