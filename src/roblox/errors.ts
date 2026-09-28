/**
 * Roblox auth error taxonomy.
 *
 * Same contract as the browser subsystem: every failure becomes a stable,
 * machine-readable code with an actionable hint, and nothing sensitive may ride
 * along in the message. Roblox error responses are reduced to a status code plus
 * the documented `error` string, never a raw body, and every message passes
 * through `redactText` on the way out.
 */

import { redactText } from "../core/redact.js";

export type RobloxAuthErrorCode =
  /** Configuration is incomplete (client id/secret/redirect URI). */
  | "not_configured"
  /** Storage or encryption is unavailable for the requested operation. */
  | "storage_unavailable"
  /** The request has no valid verified identity or no linked grant. */
  | "unauthenticated"
  /** Legacy browser-session error retained for stored historical records only. */
  | "session_expired"
  /** Callback carried no `state`. */
  | "state_missing"
  /** Callback `state` does not match anything pending. */
  | "state_mismatch"
  /** The pending authorization outlived `OAUTH_STATE_TTL_SECONDS`. */
  | "state_expired"
  /** The pending authorization was already redeemed (replay). */
  | "state_replayed"
  /** The state is valid but was minted for a different browser binding. */
  | "state_binding_mismatch"
  /** Roblox reported an authorization-denial (`error=` on the callback). */
  | "provider_denied"
  /** `POST /oauth/v1/token` rejected the code or the verifier. */
  | "token_exchange_failed"
  /** The issued token does not carry a scope a tool needs. */
  | "insufficient_scope"
  /** The action has no official Roblox OAuth/Open Cloud endpoint. */
  | "not_supported"
  /** Access token expired and the refresh token was refused. */
  | "reauthorization_required"
  /** Roblox answered 4xx to an API call. */
  | "api_error"
  /** Roblox answered 429. */
  | "rate_limited"
  /** Roblox answered 5xx, or the fetch itself failed. */
  | "network_error"
  /** `Origin`/`Sec-Fetch-Site` did not pass the same-site check. */
  | "origin_mismatch"
  /** Request host is not in `ROBLOX_ALLOWED_HOSTS`. */
  | "host_not_allowed"
  | "invalid_input"
  | "internal";

export interface RobloxAuthErrorDetails {
  code: RobloxAuthErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  /** HTTP status the route layer should answer with. */
  status: number;
  data?: Record<string, unknown>;
}

/** Map an auth failure onto the HTTP status a browser-facing route should use. */
const STATUS_BY_CODE: Record<RobloxAuthErrorCode, number> = {
  not_configured: 503,
  storage_unavailable: 503,
  unauthenticated: 401,
  session_expired: 401,
  state_missing: 400,
  state_mismatch: 400,
  state_expired: 400,
  state_replayed: 400,
  state_binding_mismatch: 400,
  provider_denied: 400,
  token_exchange_failed: 400,
  insufficient_scope: 403,
  not_supported: 200,
  reauthorization_required: 401,
  api_error: 502,
  rate_limited: 429,
  network_error: 502,
  origin_mismatch: 403,
  host_not_allowed: 403,
  invalid_input: 400,
  internal: 500,
};

export class RobloxAuthError extends Error {
  readonly code: RobloxAuthErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly data?: Record<string, unknown>;

  constructor(
    code: RobloxAuthErrorCode,
    message: string,
    options: { hint?: string; retryable?: boolean; data?: Record<string, unknown>; status?: number } = {},
  ) {
    // Redaction is enforced in the constructor so no caller can leak by accident.
    super(redactText(message, 400));
    this.name = "RobloxAuthError";
    this.code = code;
    this.hint = options.hint ? redactText(options.hint, 400) : undefined;
    this.retryable = options.retryable ?? (code === "rate_limited" || code === "network_error");
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.data = options.data;
  }

  toJSON(): RobloxAuthErrorDetails {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      retryable: this.retryable,
      status: this.status,
      ...(this.data ? { data: this.data } : {}),
    };
  }

  /** Browser-safe JSON error body: code + message + hint, nothing else. */
  toResponse(extra: Record<string, unknown> = {}): Response {
    const body = { error: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}), retryable: this.retryable, ...extra };
    return Response.json(body, {
      status: this.status,
      headers: { "Cache-Control": "no-store", ...(this.code === "rate_limited" ? { "Retry-After": String((this.data?.retryAfterSeconds as number) ?? 30) } : {}) },
    });
  }
}

export function isRobloxAuthError(error: unknown): error is RobloxAuthError {
  return error instanceof RobloxAuthError;
}

export function robloxAuthError(
  code: RobloxAuthErrorCode,
  message: string,
  options?: { hint?: string; retryable?: boolean; data?: Record<string, unknown>; status?: number },
): RobloxAuthError {
  return new RobloxAuthError(code, message, options);
}

/** Normalise anything thrown into a `RobloxAuthError`. */
export function asRobloxAuthError(error: unknown): RobloxAuthError {
  if (isRobloxAuthError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timed out|timeout/i.test(message)) {
    return new RobloxAuthError("network_error", "The request to Roblox timed out.", { retryable: true });
  }
  return new RobloxAuthError("internal", message || "Unexpected Roblox authentication error.");
}

/**
 * Translate a token/userinfo/Open Cloud HTTP failure into a stable code.
 *
 * Only the status and Roblox's documented `error`/`details.code` strings are
 * used; response bodies are never echoed (they can contain account identifiers
 * and, on some endpoints, token material).
 */
export function fromHttpResponse(
  status: number,
  oauthError: string | null,
  context: "token" | "refresh" | "revoke" | "resource",
): RobloxAuthError {
  const retryAfter = status === 429;
  if (retryAfter) {
    return new RobloxAuthError("rate_limited", "Roblox rate limited this request.", {
      retryable: true,
      hint: "Back off and retry. Roblox publishes per-OAuth-authorization limits (for example 20 requests/minute for inventory reads); DEMO throttles itself below that.",
      data: { source: context },
    });
  }
  if (status === 401 || status === 403) {
    if (context === "refresh") {
      return new RobloxAuthError("reauthorization_required", "Roblox refused to refresh this authorization.", {
        hint: "Generate a fresh code with roblox_account_link_start, submit it on /oauth/roblox/link in the same Access identity, and approve again. Refresh tokens are single-use, so a lost response can mean the previous one was already consumed.",
        data: { source: context, oauthError },
      });
    }
    if (context === "resource") {
      return new RobloxAuthError(
        "insufficient_scope",
        oauthError === "insufficient_scope" || status === 403
          ? "The granted scopes do not permit this Roblox resource."
          : "Roblox rejected the access token for this resource.",
        {
          hint: "Check the scope list on the Roblox app, then reconnect so the new scopes are consented to. Do not attempt cookie-based access as a workaround.",
          data: { httpStatus: status, oauthError },
        },
      );
    }
    return new RobloxAuthError("token_exchange_failed", "Roblox rejected the client credentials for this OAuth request.", {
      data: { httpStatus: status, oauthError },
    });
  }
  if (status === 400) {
    if (context === "token") {
      return new RobloxAuthError("token_exchange_failed", "Roblox refused the authorization code.", {
        hint:
          oauthError && /invalid_grant|invalid authorization code|expired|already used/i.test(oauthError)
            ? "Roblox authorization codes are single-use and expire after about one minute. Generate a new DEMO link code, submit it at /oauth/roblox/link, and finish in the same browser."
            : `Roblox said: ${oauthError ?? "invalid_request"}. Check the redirect URI registered on the Roblox app against the one DEMO reports (GET /oauth/roblox/status), and confirm the client id/secret belong to the same app.`,
        data: { httpStatus: status, oauthError: oauthError ?? "invalid_request" },
      });
    }
    if (context === "refresh") {
      return new RobloxAuthError("reauthorization_required", "The refresh token is no longer valid.", {
        hint: "Call roblox_account_link_start and approve a fresh Roblox authorization through /oauth/roblox/link. Roblox refresh tokens can be consumed only once and may expire after 90 days.",
        data: { httpStatus: status, oauthError },
      });
    }
    return new RobloxAuthError("api_error", "Roblox rejected the request.", { data: { httpStatus: status, oauthError } });
  }
  if (status >= 500) {
    return new RobloxAuthError("network_error", `Roblox returned ${status}.`, {
      retryable: true,
      hint: "This is a Roblox-side failure. Retry in a moment; DEMO does not retry more than twice so it never amplifies an outage.",
      data: { httpStatus: status },
    });
  }
  return new RobloxAuthError("api_error", `Roblox returned HTTP ${status}.`, { data: { httpStatus: status, oauthError } });
}
