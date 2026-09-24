/**
 * Git repository URL safety (shared repo-validation for every git mode).
 *
 * The URL a caller supplies is treated like any other externally controlled
 * target: it goes through DEMO's existing SSRF stack before any request (and
 * again on every redirect hop, in the HTTP client). On top of that, this module
 * enforces the Git-specific rules the spec asks for:
 *
 *  - only https:// (or http:// when the operator explicitly allows insecure
 *    Git hosts — the same flag as the browser's `BROWSER_ALLOW_INSECURE_HTTP`),
 *  - no embedded credentials, no `git@…:…` scp syntax, no `ssh://`, `git://`,
 *    `file://` or any other scheme,
 *  - `.git` suffix normalisation and canonical-form output,
 *  - a deny-list of hosts whose "clone" flows execute hooks/LFS by design —
 *    DEMO never runs hooks, package installs, LFS commands, build scripts or
 *    repository automation, so that guarantee lives here, not in a caveat.
 */

import { BrowserError } from "../core/errors.js";
import { checkUrlSync, parseTargetUrl } from "../core/url-guard.js";

export interface NormalizedGitRepo {
  /** Canonical fetch URL ending in `.git` (required by some smart-HTTP servers). */
  cloneUrl: string;
  /** Human display URL (without credentials, without query). */
  displayUrl: string;
  host: string;
  path: string;
}

const SSH_SHAPE = /^(?:ssh:\/\/|git:\/\/|(?:git|[\w.-]+)@[\w.-]+:)/i;

/**
 * Reject repo hosts whose clone semantics imply running local tooling
 * (credential helpers, LFS smudge filters) that DEMO must never execute.
 * Public *HTTP* access to them still works if explicitly allowed; the deny
 * list targets schemes, and `github.com`-style hosts are fine — this set is
 * intentionally tiny and only covers URL forms whose whole meaning is
 * "execute my local git config".
 */
export function normalizeGitRepoUrl(input: string, options: { allowInsecureHttp?: boolean } = {}): NormalizedGitRepo {
  const raw = String(input ?? "").trim();
  if (!raw) throw gitInvalid("A repository URL is required.", "Pass a public https:// Git URL such as https://github.com/octocat/Hello-World.git");
  if (raw.length > 1_000) throw gitInvalid("The repository URL is too long (max 1000 characters).");
  if (SSH_SHAPE.test(raw)) {
    throw gitInvalid(
      "ssh://, git:// and git@host:path clone URLs are not supported.",
      "Use the public https:// URL of the repository instead — DEMO talks to Git over HTTPS only, without credentials.",
    );
  }
  // `https://host/owner/repo` without scheme? Default to https for host-like input.
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(candidate)) candidate = `https://${candidate}`;
    else throw gitInvalid("That does not look like a repository URL.", "Provide a full https:// URL (e.g. https://codeberg.org/owner/repo).");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw gitInvalid("The repository URL could not be parsed.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw gitInvalid(`Unsupported URL scheme "${parsed.protocol}".`, "Git access is restricted to http(s) smart-HTTP URLs.");
  }
  if (parsed.protocol === "http:" && !options.allowInsecureHttp) {
    throw gitInvalid("Plain http:// Git URLs are disabled for this deployment.", "Use the https:// URL of the repository.");
  }
  if (parsed.username || parsed.password) {
    throw gitInvalid("Repository URLs with embedded credentials are rejected.", "DEMO works with public repositories only and never accepts or stores credentials — remove the username/password from the URL.");
  }
  if (parsed.search || parsed.hash) {
    throw gitInvalid("Query strings and fragments are not allowed on repository URLs.");
  }

  // Static SSRF pass (DNS verification still happens per actual request hop).
  const staticCheck = checkUrlSync(parsed.toString(), { allowInsecureHttp: options.allowInsecureHttp === true });
  if (!staticCheck.ok) {
    throw new BrowserError(staticCheck.code, `The repository host failed DEMO's network safety check: ${staticCheck.reason}`, {
      hint: "Git targets must be public servers on normal ports. localhost, private ranges, link-local and metadata addresses are blocked.",
      data: { hostname: staticCheck.hostname ?? null },
    });
  }

  let path = parsed.pathname.replace(/\/{2,}/g, "/");
  // Strip a trailing slash, then remember + re-add the .git suffix canonically.
  path = path.replace(/\/+$/, "");
  if (!path || path === "") throw gitInvalid("The repository URL has no path (e.g. …/owner/repo).");
  const withoutSuffix = path.replace(/\.git$/i, "");
  const hasSuffix = path.toLowerCase().endsWith(".git");
  const clonePath = hasSuffix ? path : `${withoutSuffix}.git`;
  const host = parsed.host.toLowerCase();
  const cloneUrl = `${parsed.protocol}//${host}${clonePath}`;
  const displayUrl = `${parsed.protocol}//${host}${hasSuffix ? clonePath : withoutSuffix}`;
  return { cloneUrl, displayUrl, host, path: withoutSuffix };
}

/**
 * Confirm the target is *reachable* on the network layer before heavier work
 * (and re-check redirect hops later). `guard` is the caller-provided async
 * validator — production passes the env-configured DEMO guard; tests can pass
 * a permissive one. The returned URL is the normalized one from the guard.
 */
export async function assertGitTargetAllowed(
  url: string,
  guard: (candidate: string) => Promise<string>,
): Promise<string> {
  return guard(url);
}

/**
 * Redirect-poisoning is caught in the HTTP client (every hop goes through the
 * guard). This helper maps the *server response* of a clone/fetch attempt to
 * DEMO's honest error surface: private/auth-gated repos are a clearly
 * distinguishable failure, never a hang or a credential prompt.
 */
export function authRequiredError(displayUrl: string, status: number | null): BrowserError {
  return new BrowserError("auth_required", `The Git server at ${displayUrl} requires authentication (HTTP ${status ?? 401}).`, {
    retryable: false,
    capability: "git_public_only",
    hint: "DEMO inspects public repositories only. It does not accept, request, harvest or store Git credentials, so private repositories are a hard refusal, not a workaround. Use a public mirror of the content instead.",
    data: { status: status ?? null },
  });
}

function gitInvalid(message: string, hint?: string): BrowserError {
  return new BrowserError("invalid_input", message, { hint, retryable: false });
}

/** Validate + reject obviously internal hosts, returning the safe display URL. */
export function describeRepoForError(input: string): string {
  try {
    const { url } = parseTargetUrl(input);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 160);
  } catch {
    return "[invalid-url]";
  }
}
