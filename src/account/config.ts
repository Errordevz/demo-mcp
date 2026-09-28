/**
 * Account-system policy configuration.
 *
 * Everything here is policy/presence only. Email credentials
 * (`RESEND_API_KEY`, `SMTP_PASSWORD`) are Worker *secrets*, never vars, never
 * logged. The only email-related values that are safe to report are the sender
 * address, the provider id, and the reason email is off.
 *
 * The email implementation lives in `./email.ts`; the delivery helpers are
 * re-exported here so every account module keeps a single import surface.
 */

import {
  resolveAccountEmailConfig,
  type AccountEmailConfig,
  type AccountEmailEnv,
} from "./email.js";

export interface AccountConfig {
  sessionTtlSeconds: number;
  verificationCodeTtlSeconds: number;
  resetTokenTtlSeconds: number;
  rateLimitPerMinute: number;
  /** Canonical public origin for links in email (never request-derived). */
  publicOrigin: string | null;
  /** Whether an account must confirm its email before account-only features unlock. */
  requireVerifiedForLinking: boolean;
  email: AccountEmailConfig;
}

export interface AccountConfigEnv extends AccountEmailEnv {
  MCP_PUBLIC_ORIGIN?: string;
  ACCOUNT_SESSION_TTL_SECONDS?: string | number;
  ACCOUNT_RATE_LIMIT_PER_MINUTE?: string | number;
  ACCOUNT_REQUIRE_VERIFIED_FOR_LINKING?: string;
}

function numberFrom(value: string | number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function flagFrom(value: string | undefined, fallback: boolean): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "on"].includes(text);
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
  return {
    sessionTtlSeconds: numberFrom(env.ACCOUNT_SESSION_TTL_SECONDS, 60 * 60 * 24 * 30, 3600, 60 * 60 * 24 * 90),
    verificationCodeTtlSeconds: 30 * 60,
    resetTokenTtlSeconds: 30 * 60,
    rateLimitPerMinute: numberFrom(env.ACCOUNT_RATE_LIMIT_PER_MINUTE, 20, 1, 300),
    publicOrigin,
    requireVerifiedForLinking: flagFrom(env.ACCOUNT_REQUIRE_VERIFIED_FOR_LINKING, true),
    email: resolveAccountEmailConfig(env),
  };
}

export {
  sendAccountEmail,
  verificationEmail,
  resetEmail,
  passwordChangedEmail,
  accountDeletedEmail,
  resolveAccountEmailConfig,
  emailDeliverySummary,
  DEFAULT_EMAIL_ADDRESS,
  DEFAULT_EMAIL_FROM,
  parseFrom,
} from "./email.js";
export type { EmailMessage, EmailSendResult, AccountEmailConfig, AccountEmailEnv, EmailProviderId } from "./email.js";
