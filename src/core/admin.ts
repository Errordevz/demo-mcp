/**
 * Administrator gate for the few operations that can spend real resources
 * (catalog refreshes, destructive workspace actions).
 *
 * There is deliberately no "admin" flag on DEMO accounts: the deployment's
 * `DEMO_API_KEY` secret — already configured on the Worker, previously used as
 * the legacy `/mcp` bearer — is the operator credential. The key is compared by
 * SHA-256 digest in constant time, is never logged, never echoed back, and never
 * accepted as a tool *argument* (a secret that a model can type is a secret that
 * ends up in a transcript).
 *
 * A caller may present it either as `x-demo-admin-key: <key>` or as
 * `Authorization: Bearer <key>` on the HTTP routes. MCP callers cannot set
 * headers, so those tools refuse with `admin_required` and name the HTTP route
 * (or the `collab:admin` OAuth scope, when the operator prefers that).
 */

import { BrowserError } from "./errors.js";

export interface AdminEnv {
  DEMO_API_KEY?: string;
}

const HEADER = "x-demo-admin-key";

export function adminKeyConfigured(env: AdminEnv): boolean {
  return typeof env.DEMO_API_KEY === "string" && env.DEMO_API_KEY.trim().length >= 16;
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Constant-time comparison over digests; length differences cannot leak. */
export async function adminKeyMatches(env: AdminEnv, presented: string | null | undefined): Promise<boolean> {
  const expected = (env.DEMO_API_KEY ?? "").trim();
  const candidate = (presented ?? "").trim();
  if (!adminKeyConfigured(env) || !candidate || candidate.length > 512) return false;
  const [a, b] = await Promise.all([digest(expected), digest(candidate)]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

export function presentedAdminKey(request: Request): string | null {
  const header = request.headers.get(HEADER) ?? request.headers.get("x-api-key");
  if (header) return header;
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
  return match ? (match[1] ?? "").trim() : null;
}

export async function isAdminRequest(request: Request, env: AdminEnv): Promise<boolean> {
  return adminKeyMatches(env, presentedAdminKey(request));
}

export function adminRequired(operation: string): BrowserError {
  return new BrowserError("admin_required", `${operation} requires the deployment's administrator key.`, {
    hint: adminKeyConfiguredHint(),
    data: { header: HEADER, httpRoute: "POST /byox/refresh" },
  });
}

function adminKeyConfiguredHint(): string {
  return "Present the DEMO admin key as the x-demo-admin-key header on the HTTP route (POST /byox/refresh), or hold the collab:admin DEMO OAuth scope. DEMO never accepts an administrator key as a tool argument.";
}

export function adminNotConfigured(operation: string): BrowserError {
  return new BrowserError("not_configured", `${operation} is unavailable because this deployment has no DEMO_API_KEY secret.`, {
    hint: "Set the DEMO_API_KEY Worker secret (at least 16 characters) to enable administrator operations.",
  });
}
