/**
 * JWT inspection (DEMO 0.9) — decoding only, NEVER verification.
 *
 * Hard rules encoded here:
 *   - DECODING ≠ VERIFICATION: every result says `verification: "not-performed"`
 *     and a decoded token is never described as valid/authentic,
 *   - the complete token is never logged, never returned and never echoed in an
 *     error message (redaction-first; only a short SHA-256 fingerprint of the
 *     whole token may appear, which cannot be reversed),
 *   - no signing key is ever requested, accepted or stored — there is no
 *     verification input path at all, by design.
 */

import { LIMITS, clamp } from "../core/limits.js";
import { redactText } from "../core/redact.js";

export interface JwtClaimView {
  claim: string;
  value: unknown;
  present: boolean;
  /** For temporal claims: parsed instant + validation against `now`. */
  parsed?: string | null;
  status?: "valid-window" | "expired" | "not-yet-valid" | "unparsable" | null;
}

export interface JwtInspection {
  structure: {
    parts: 2 | 3;
    headerValidJson: boolean;
    payloadValidJson: boolean;
    signaturePresent: boolean;
    signatureBytes: number | null;
  };
  algorithm: string | null;
  header: Record<string, unknown>;
  claims: {
    registered: JwtClaimView[];
    custom: Record<string, unknown>;
  };
  temporal: {
    now: string;
    exp: JwtClaimView | null;
    iat: JwtClaimView | null;
    nbf: JwtClaimView | null;
  };
  issuer: unknown;
  audience: unknown;
  subject: unknown;
  tokenFingerprint: string | null;
  verification: "not-performed";
  verificationNote: string;
  warnings: string[];
}

export type JwtFailure =
  | { ok: false; error: "invalid_token"; message: string }
  | { ok: true; inspection: JwtInspection };

const REGISTERED = ["iss", "sub", "aud", "exp", "nbf", "iat", "jti"] as const;

/** Inspect (decode) a JWT. Returns a structured failure — never the token. */
export async function inspectJwt(tokenInput: string, options: { now?: Date } = {}): Promise<JwtFailure> {
  const warnings: string[] = [];
  const token = String(tokenInput ?? "").trim();
  if (!token) return fail("The token is empty. Provide a compact JWS (three base64url parts separated by dots).");
  if (token.length > LIMITS.jwtMaxChars) return fail(`The token exceeds the ${LIMITS.jwtMaxChars}-character inspection limit.`);
  // Whole-token shape: header.payload[.signature]. The signature part may be
  // empty (unsecured JWS "alg: none") — still two dots.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token)) {
    return fail("This is not a compact JWT/JWS: expected header.payload.signature with base64url parts. JWE (five parts) and arbitrary bearer strings are not decoded.");
  }
  const parts = token.split(".");
  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  if (!header.ok) return fail("The header part is not valid base64url-encoded JSON.");
  if (!payload.ok) return fail("The payload (claims) part is not valid base64url-encoded JSON.");

  const headerValue = header.value as Record<string, unknown>;
  const claimsValue = payload.value as Record<string, unknown>;
  const algorithm = typeof headerValue.alg === "string" ? headerValue.alg : null;
  if (!algorithm) warnings.push('The header has no "alg" field — unusual for a JWT.');
  if (algorithm?.toLowerCase() === "none") warnings.push('Algorithm "none" (unsecured JWS): anybody can mint such a token; treat its content as UNAUTHENTICATED data.');
  if (algorithm && /^(HS|RS|ES|PS|EdDSA)/i.test(algorithm) && !parts[2]) warnings.push("The signature part is empty although the header declares a signing algorithm.");

  const now = options.now ?? new Date();
  const temporalView = (claim: "exp" | "nbf" | "iat"): JwtClaimView | null => {
    const raw = claimsValue[claim];
    if (raw === undefined || raw === null) return null;
    const view: JwtClaimView = { claim, value: typeof raw === "number" ? raw : redactText(String(raw), 60), present: true, parsed: null, status: null };
    const seconds = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(seconds)) {
      view.status = "unparsable";
      return view;
    }
    const instant = new Date(seconds * 1000);
    view.parsed = instant.toISOString();
    if (claim === "exp") view.status = instant.getTime() <= now.getTime() ? "expired" : "valid-window";
    else if (claim === "nbf") view.status = instant.getTime() > now.getTime() ? "not-yet-valid" : "valid-window";
    else view.status = "valid-window";
    return view;
  };

  const registered: JwtClaimView[] = REGISTERED.map((claim) => {
    const raw = claimsValue[claim];
    if (claim === "exp" || claim === "nbf" || claim === "iat") return temporalView(claim) ?? { claim, value: null, present: false, parsed: null, status: null };
    return { claim, value: raw === undefined ? null : sanitizeClaimValue(raw), present: raw !== undefined };
  });

  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(claimsValue)) {
    if ((REGISTERED as readonly string[]).includes(key)) continue;
    custom[key] = sanitizeClaimValue(value);
    if (Object.keys(custom).length >= 30) break;
  }

  const fingerprint = await sha256Prefix(token);
  return {
    ok: true,
    inspection: {
      structure: {
        parts: 3,
        headerValidJson: true,
        payloadValidJson: true,
        signaturePresent: Boolean(parts[2]),
        signatureBytes: parts[2] ? Math.floor((parts[2].length * 3) / 4) : null,
      },
      algorithm,
      header: Object.fromEntries(Object.entries(headerValue).slice(0, 20).map(([key, value]) => [key, sanitizeClaimValue(value)])),
      claims: { registered, custom },
      temporal: { now: now.toISOString(), exp: temporalView("exp"), iat: temporalView("iat"), nbf: temporalView("nbf") },
      issuer: claimsValue.iss ?? null,
      audience: claimsValue.aud ?? null,
      subject: claimsValue.sub ?? null,
      tokenFingerprint: fingerprint,
      verification: "not-performed",
      verificationNote:
        "DECODING IS NOT VERIFICATION. These claims are readable bytes — anyone holding the token (or minting one with alg:none) can produce them. DEMO never verifies signatures, never accepts signing keys, and never claims a token is authentic, valid, or safe to trust from this output. Expired/nbf windows are computed against the stated 'now', which is also unauthenticated metadata.",
      warnings,
    },
  };

  function fail(message: string): JwtFailure {
    return { ok: false, error: "invalid_token", message: redactText(message, 500) };
  }
}

function decodeJsonPart(part: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function sanitizeClaimValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value, 300);
  if (Array.isArray(value)) return value.slice(0, 10).map(sanitizeClaimValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 15)) out[key] = sanitizeClaimValue(entry);
    return out;
  }
  return value;
}

async function sha256Prefix(token: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(token);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `sha256:${hex.slice(0, 16)}…`;
  } catch {
    return null;
  }
}

void clamp;
