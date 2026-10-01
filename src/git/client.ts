/**
 * Generic public-Git client (DEMO 0.9).
 *
 * Works against any Git smart-HTTP server — GitHub, GitLab, Codeberg, Gitea,
 * sourcehut or a self-hosted `git-http-backend` — using the *protocol*, not a
 * host-specific API. `isomorphic-git` speaks smart-HTTP and consumes packfiles
 * in pure JS; DEMO plugs its own guarded HTTP transport underneath so every
 * request and every redirect hop runs the SSRF stack first, and its own
 * MemoryFs so clones are bounded, disposable and never touch a disk.
 *
 * Guarantees enforced here:
 *  - public repos only; 401/403 becomes a structured `auth_required` refusal
 *    and no credential is ever requested, accepted or invented,
 *  - no hooks, no LFS commands, no build scripts, no shell — repository
 *    contents are read as data through object reads (`readBlob`/`readTree`),
 *    never executed,
 *  - size caps (pack bytes, workspace bytes, file counts), timeouts and
 *    depth limits, all as stable errors,
 *  - temporary clones are cached for at most `GIT_TEMP_REPO_TTL_MS` inside one
 *    isolate and then wiped (`MemoryFs.dispose`), and every clone is a fresh
 *    object graph — `mode: fetch` simply re-clones.
 */

import * as git from "isomorphic-git";
import { BrowserError, isBrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { publicToolRateLimiter, WindowedRateLimiter } from "../core/rate-limit.js";
import type { LineDiff } from "../core/text-diff.js";
import { changedSections, diffLines, toUnifiedDiff, type ChangedSection } from "../core/text-diff.js";
import { parseGitignore, testPath, type IgnoreDecision, type IgnoreMatcher } from "./gitignore.js";
import { resolveGitPolicy, type GitPolicy } from "./config.js";
import { MemoryFs } from "./memory-fs.js";
import { assertGitTargetAllowed, authRequiredError, normalizeGitRepoUrl, type NormalizedGitRepo } from "./safety.js";

/* ───────────────────────────── guarded transport ─────────────────────────── */

export interface GitHttpOptions {
  guard: (url: string) => Promise<string>;
  policy: GitPolicy;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

interface GitHttpResponse {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array>;
  statusCode: number;
  statusMessage: string;
}

const GIT_PROTOCOL_ACCEPT = "application/x-git-upload-pack-advertisement, application/x-git-upload-pack-result, */*";

/** Build an `isomorphic-git` HttpClient whose every hop is SSRF-validated. */
export function createGuardedGitHttpClient(options: GitHttpOptions): { request(req: GitHttpRequest): Promise<GitHttpResponse> } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = 5;
  return {
    async request(request: GitHttpRequest): Promise<GitHttpResponse> {
      const method = (request.method ?? "GET").toUpperCase();
      let currentUrl = await options.guard(request.url);
      let bodyBytes: Uint8Array | undefined;
      if (request.body) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of request.body) {
          chunks.push(chunk);
          total += chunk.byteLength;
          if (total > 2_000_000) {
            throw new BrowserError("size_limit_exceeded", "The Git request body exceeded the 2 MB limit.", { retryable: false });
          }
        }
        bodyBytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }

      for (let redirects = 0; ; ) {
        const controller = new AbortController();
        const deadline = Date.now() + options.policy.requestTimeoutMs;
        const onAbort = () => controller.abort();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), options.policy.requestTimeoutMs);
        let response: Response;
        try {
          const headers: Record<string, string> = {
            accept: GIT_PROTOCOL_ACCEPT,
            "user-agent": "DEMO-MCP/1.1.0 (public git read-only)",
            ...(request.headers ?? {}),
          };
          response = await fetchImpl(currentUrl, {
            method,
            headers,
            redirect: "manual",
            signal: controller.signal,
            ...(bodyBytes ? { body: bodyBytes.slice() } : {}),
          });
        } catch (error) {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          options.signal?.removeEventListener("abort", onAbort);
          if (controller.signal.aborted) {
            throw new BrowserError("timeout", `The Git request exceeded the ${options.policy.requestTimeoutMs}ms timeout.`, { retryable: true });
          }
          throw new BrowserError("navigation_failed", `The Git request failed: ${String(error instanceof Error ? error.message : error).slice(0, 180)}`, { retryable: true, cause: error });
        }
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        options.signal?.removeEventListener("abort", onAbort);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) throw new BrowserError("navigation_failed", "The Git server sent a redirect without a Location header.", { retryable: false });
          if (redirects + 1 > maxRedirects) throw new BrowserError("blocked_url", "More than 5 Git redirects; not following further.", { retryable: false });
          let next: string;
          try {
            next = new URL(location, currentUrl).toString();
          } catch {
            throw new BrowserError("blocked_url", "A Git redirect pointed at an unparsable location and was not followed.", { retryable: false });
          }
          // Re-validate every hop: a public URL must not bounce into an internal target.
          currentUrl = await options.guard(next);
          redirects += 1;
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined);
          throw authRequiredError(currentUrl, response.status);
        }

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower === "set-cookie" || /(authorization|api[-_]?key|token|secret)/i.test(lower)) return;
          headers[lower] = value.slice(0, 400);
        });

        const declared = Number(response.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > options.policy.maxPackBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new BrowserError("size_limit_exceeded", `The Git response is ${declared} bytes, above the ${Math.round(options.policy.maxPackBytes / (1024 * 1024))} MB limit.`, {
            hint: "Fetch less history (depth: 1) or inspect a smaller repository.",
            retryable: false,
          });
        }

        const iter = capStream(response.body, options.policy.maxPackBytes, deadline, currentUrl);
        return {
          url: currentUrl,
          method,
          headers,
          body: iter,
          statusCode: response.status,
          statusMessage: response.statusText ?? "",
        };
      }
    },
  };
}

/** Async iterator over the response body with byte + wall-clock caps. */
function capStream(body: ReadableStream<Uint8Array> | null, maxBytes: number, deadline: number, url: string): AsyncIterableIterator<Uint8Array> {
  const reader = body?.getReader();
  let received = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (!reader) return { done: true, value: undefined };
      if (Date.now() > deadline) {
        await reader.cancel().catch(() => undefined);
        throw new BrowserError("timeout", "The Git transfer exceeded its time budget.", { retryable: true });
      }
      const { done, value } = await reader.read();
      if (done) return { done: true, value: undefined };
      received += value?.byteLength ?? 0;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BrowserError("size_limit_exceeded", `The Git response exceeded the ${Math.round(maxBytes / (1024 * 1024))} MB limit while streaming.`, { retryable: false });
      }
      return { done: false, value: value ?? new Uint8Array() };
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      await reader?.cancel().catch(() => undefined);
      return { done: true, value: undefined };
    },
    async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
      await reader?.cancel().catch(() => undefined);
      throw error;
    },
  };
}

/* ───────────────────────────── error translation ─────────────────────────── */

/** Map isomorphic-git / transport errors to DEMO's stable error taxonomy. */
export function mapGitError(error: unknown, displayUrl: string): BrowserError {
  if (isBrowserError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (/401|403|authentication|HttpAuthRequired|HttpForbidden/i.test(`${code ?? ""} ${message}`)) return authRequiredError(displayUrl, null);
  if (/404|not found|NotFound/i.test(`${code ?? ""} ${message}`)) {
    return new BrowserError("page_not_found", `No public Git repository answered at ${displayUrl} (the server returned 404).`, {
      retryable: false,
      hint: "Check the URL. It must be the repository's https:// clone URL (any Git host), not a web page URL.",
    });
  }
  if (/ParseError|protocol error|malformed/i.test(`${code ?? ""} ${message}`)) {
    return new BrowserError("unsupported", `The server at ${displayUrl} did not speak a compatible Git smart-HTTP protocol.`, { retryable: false });
  }
  if (/timeout|abort/i.test(message)) return new BrowserError("timeout", `The Git operation against ${displayUrl} timed out.`, { retryable: true });
  return new BrowserError("internal", `The Git operation failed: ${message.slice(0, 200)}`, { retryable: true, cause: error });
}

/* ───────────────────────────── repo workspace ────────────────────────────── */

export interface OpenRepoOptions {
  env: Record<string, unknown> | undefined;
  url: string;
  ref?: string | null;
  /** History depth in commits (1 = shallow tip). `0` or omitted = full history
   * up to the byte budget. */
  depth?: number | null;
  /** Force a fresh clone even if a live cached workspace exists. */
  refresh?: boolean;
  guard?: (url: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Test-only URL resolver override (used to point the client at a local
   * fixture server). The MCP tool layer never passes this; production always
   * uses the SSRF-checked `normalizeGitRepoUrl`. */
  resolveRepoUrl?: (input: string) => NormalizedGitRepo;
}

interface CachedWorkspace {
  key: string;
  fs: MemoryFs;
  dir: string;
  cache: object;
  normalized: NormalizedGitRepo;
  headOid: string | null;
  defaultBranch: string | null;
  createdAt: number;
  bytes: number;
}

const workspaceCache = new Map<string, CachedWorkspace>();
let gitRateLimiter: WindowedRateLimiter | null = null;

function rateLimiterFor(): WindowedRateLimiter {
  if (!gitRateLimiter) {
    gitRateLimiter = new WindowedRateLimiter(
      (env) => resolveGitPolicy(env).rateLimitPerMinute,
      "GIT_RATE_LIMIT_PER_MINUTE",
      6,
      1,
      60,
    );
  }
  return gitRateLimiter;
}

/** Drop every cached workspace (tests / operator reset). */
export function resetGitWorkspaces(): void {
  for (const entry of workspaceCache.values()) entry.fs.dispose();
  workspaceCache.clear();
  gitRateLimiter?.reset();
}

function evictStale(policy: GitPolicy): void {
  const now = Date.now();
  for (const [key, entry] of [...workspaceCache.entries()]) {
    if (now - entry.createdAt > policy.tempRepoTtlMs) {
      entry.fs.dispose();
      workspaceCache.delete(key);
    }
  }
  // Bounded cache: at most 3 temporary repositories per isolate.
  while (workspaceCache.size > 3) {
    const oldest = workspaceCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = workspaceCache.get(oldest);
    entry?.fs.dispose();
    workspaceCache.delete(oldest);
  }
}

export interface RepoWorkspace {
  fs: MemoryFs;
  dir: string;
  cache: object;
  normalized: NormalizedGitRepo;
  policy: GitPolicy;
  headOid: string | null;
  defaultBranch: string | null;
  depth: number | null;
  created: boolean;
}

/** Clone (or reuse) a bounded in-memory workspace for a repository. */
export async function openRepo(options: OpenRepoOptions): Promise<RepoWorkspace> {
  const policy = resolveGitPolicy(options.env);
  const normalized = (options.resolveRepoUrl ?? ((input: string) => normalizeGitRepoUrl(input, { allowInsecureHttp: String((options.env ?? {}).BROWSER_ALLOW_INSECURE_HTTP ?? "false").toLowerCase() === "true" })))(options.url);
  rateLimiterFor().charge(options.env, "git", normalized.cloneUrl);
  // Also charge the shared public budget so heavy Git use cannot crowd out feeds.
  publicToolRateLimiter.charge(options.env, "git_repository", normalized.cloneUrl);
  const guard = options.guard ?? (await import("../core/guarded-fetch.js")).createSsrfGuard(options.env);

  const depth = options.depth === null || options.depth === undefined ? null : clamp(Math.trunc(options.depth), 1, policy.maxDepth);
  const key = `${normalized.cloneUrl}|${depth ?? "full"}|${options.ref ?? "HEAD"}`;
  evictStale(policy);
  if (!options.refresh) {
    const cached = workspaceCache.get(key);
    if (cached) {
      cached.createdAt = Date.now();
      return { fs: cached.fs, dir: cached.dir, cache: cached.cache, normalized: cached.normalized, policy, headOid: cached.headOid, defaultBranch: cached.defaultBranch, depth, created: false };
    }
  } else {
    const stale = workspaceCache.get(key);
    if (stale) {
      stale.fs.dispose();
      workspaceCache.delete(key);
    }
  }

  const fs = new MemoryFs({ maxBytes: Math.min(policy.memoryMaxBytes, policy.maxPackBytes * 3), label: normalized.host });
  const dir = "/repo";
  const cache = {};
  const http = createGuardedGitHttpClient({ guard, policy, fetchImpl: options.fetchImpl });
  try {
    await git.clone({
      fs: fs as never,
      http,
      dir,
      url: normalized.cloneUrl,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(depth ? { depth } : {}),
      singleBranch: Boolean(options.ref),
      noCheckout: true,
      cache,
      onAuth: () => ({ cancel: true }),
    } as never);
  } catch (error) {
    fs.dispose();
    throw mapGitError(error, normalized.displayUrl);
  }

  let defaultBranch: string | null = null;
  try {
    const head = await fs.promises.readFile(`${dir}/.git/refs/remotes/origin/HEAD`, "utf8");
    const match = /ref:\s*(.+)\s*$/.exec(String(head));
    if (match) defaultBranch = match[1].replace(/^refs\/(heads|remotes\/origin)\//, "").trim();
  } catch {
    defaultBranch = null;
  }
  let headOid: string | null = null;
  try {
    headOid = await git.resolveRef({ fs: fs as never, dir, ref: options.ref ?? "HEAD" });
  } catch {
    headOid = null;
  }

  const entry: CachedWorkspace = { key, fs, dir, cache, normalized, headOid, defaultBranch, createdAt: Date.now(), bytes: fs.bytesWritten };
  workspaceCache.set(key, entry);
  return { fs: entry.fs, dir: entry.dir, cache: entry.cache, normalized: entry.normalized, policy, headOid: entry.headOid, defaultBranch: entry.defaultBranch, depth, created: true };
}

/* ───────────────────────────── remote refs (no clone) ─────────────────────── */

export interface RemoteRefs {
  url: string;
  defaultBranch: string | null;
  branches: Array<{ name: string; oid: string; default: boolean }>;
  tags: Array<{ name: string; oid: string }>;
  head: { oid: string; symbolic: string | null } | null;
  truncated: boolean;
}

/** Refs + default branch straight from the server advertisement (no clone). */
export async function listRemoteRefs(options: { env: Record<string, unknown> | undefined; url: string; maxRefs?: number; guard?: (url: string) => Promise<string>; fetchImpl?: typeof fetch; resolveRepoUrl?: (input: string) => NormalizedGitRepo }): Promise<RemoteRefs> {
  const policy = resolveGitPolicy(options.env);
  const normalized = (options.resolveRepoUrl ?? ((input: string) => normalizeGitRepoUrl(input, { allowInsecureHttp: String((options.env ?? {}).BROWSER_ALLOW_INSECURE_HTTP ?? "false").toLowerCase() === "true" })))(options.url);
  rateLimiterFor().charge(options.env, "git-refs", normalized.cloneUrl);
  publicToolRateLimiter.charge(options.env, "git_repository", normalized.cloneUrl);
  const guard = options.guard ?? (await import("../core/guarded-fetch.js")).createSsrfGuard(options.env);
  const http = createGuardedGitHttpClient({ guard, policy, fetchImpl: options.fetchImpl });
  const maxRefs = clamp(options.maxRefs ?? 2_000, 1, 5_000);
  try {
    const refs = await git.listServerRefs({
      http,
      url: normalized.cloneUrl,
      protocolVersion: 1,
      symrefs: true,
      peelTags: true,
      onAuth: () => ({ cancel: true }),
    } as never);
    const branches: Array<{ name: string; oid: string; default: boolean }> = [];
    const tags: Array<{ name: string; oid: string }> = [];
    let head: RemoteRefs["head"] = null;
    let defaultBranch: string | null = null;
    for (const entry of refs as Array<{ ref: string; oid: string; target?: string; symbolicTarget?: string; peeled?: string; peeledOid?: string }>) {
      if (entry.ref === "HEAD") {
        const symbolic = entry.target ?? entry.symbolicTarget ?? null;
        head = { oid: entry.oid, symbolic };
        if (symbolic) defaultBranch = symbolic.replace(/^refs\/(heads|tags)\//, "");
        continue;
      }
      if (entry.ref.startsWith("refs/heads/")) {
        const name = entry.ref.slice("refs/heads/".length);
        branches.push({ name, oid: entry.oid, default: defaultBranch === name });
        if (branches.length >= maxRefs) break;
      } else if (entry.ref.startsWith("refs/tags/")) {
        const name = entry.ref.slice("refs/tags/".length);
        tags.push({ name, oid: entry.oid });
        if (tags.length >= maxRefs) break;
      }
    }
    if (defaultBranch) {
      for (const branch of branches) branch.default = branch.name === defaultBranch;
    }
    return {
      url: normalized.displayUrl,
      defaultBranch,
      branches,
      tags,
      head,
      truncated: refs.length > maxRefs,
    };
  } catch (error) {
    throw mapGitError(error, normalized.displayUrl);
  }
}

/* ────────────────────────────── repo operations ──────────────────────────── */

export interface GitCommitInfo {
  oid: string;
  shortOid: string;
  message: string;
  author: { name: string; email: string; timestamp: string } | null;
  committer: { name: string; email: string; timestamp: string } | null;
  parents: string[];
  tree: string;
  changedFiles?: Array<{ path: string; change: "added" | "modified" | "deleted" | "renamed" }>;
}

export async function commitInfo(ws: RepoWorkspace, oid: string, withChanges: boolean): Promise<GitCommitInfo> {
  const commit = await git.readCommit({ fs: ws.fs as never, dir: ws.dir, oid, cache: ws.cache });
  const person = (source?: { name?: string; email?: string; timestamp?: number; timezoneOffset?: number }) =>
    source?.name || source?.email
      ? {
          name: String(source.name ?? "").slice(0, 200),
          email: String(source.email ?? "").slice(0, 200),
          timestamp: source.timestamp ? new Date(source.timestamp * 1000).toISOString() : "",
        }
      : null;
  let changedFiles: GitCommitInfo["changedFiles"];
  if (withChanges) {
    changedFiles = await changedFilesFor(ws, oid);
  }
  return {
    oid,
    shortOid: oid.slice(0, 12),
    message: String(commit.commit.message ?? "").slice(0, 4_000),
    author: person(commit.commit.author),
    committer: person(commit.commit.committer),
    parents: commit.commit.parent ?? [],
    tree: commit.commit.tree,
    ...(changedFiles ? { changedFiles } : {}),
  };
}

/** Changed files between a commit and its first parent (or the empty tree). */
export async function changedFilesFor(ws: RepoWorkspace, oid: string): Promise<Array<{ path: string; change: "added" | "modified" | "deleted" | "renamed" }>> {
  const commit = await git.readCommit({ fs: ws.fs as never, dir: ws.dir, oid, cache: ws.cache });
  const parent = commit.commit.parent?.[0];
  const changes = await compareTrees(ws, parent ?? EMPTY_TREE_OID, oid);
  return changes.files.map((file) => ({ path: file.path, change: file.change === "removed" ? ("deleted" as const) : file.change }));
}

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface FileChange {
  path: string;
  change: "added" | "removed" | "modified" | "renamed";
  beforeOid: string | null;
  afterOid: string | null;
  binary: boolean | null;
  beforeSize?: number;
  afterSize?: number;
}

export interface CompareResult {
  base: string;
  head: string;
  files: FileChange[];
  stats: { added: number; removed: number; modified: number; renamed: number };
  truncated: boolean;
}

/** Tree-level comparison via isomorphic-git's two-tree walk. */
export async function compareTrees(ws: RepoWorkspace, baseOid: string, headOid: string, options: { maxFiles?: number } = {}): Promise<CompareResult> {
  const maxFiles = clamp(options.maxFiles ?? LIMITS.gitMaxFilesListed, 1, LIMITS.gitMaxFilesListed);
  const rows: Array<{ path: string; change: FileChange["change"]; beforeOid: string | null; afterOid: string | null }> = [];
  const renames = new Map<string, string>();
  await git.walk({
    fs: ws.fs as never,
    dir: ws.dir,
    cache: ws.cache,
    trees: [git.TREE({ ref: baseOid }) as never, git.TREE({ ref: headOid }) as never],
    map: async (filepath: string, entries: Array<{ oid?(): Promise<string>; type?(): Promise<string> } | null>) => {
      // NOTE: isomorphic-git treats a `null` return from map as "prune this
      // subtree" — everything here must return `undefined` to keep walking.
      if (rows.length > maxFiles) return undefined;
      const [before, after] = entries;
      const beforeOid: string | null = before ? ((await before.oid?.()) ?? null) : null;
      const afterOid: string | null = after ? ((await after.oid?.()) ?? null) : null;
      const beforeType: string | null = before ? ((await before.type?.()) ?? null) : null;
      const afterType: string | null = after ? ((await after.type?.()) ?? null) : null;
      // Only blobs matter for change reporting.
      const isBlobBefore = beforeType === "blob";
      const isBlobAfter = afterType === "blob";
      if (!isBlobBefore && !isBlobAfter) return undefined;
      const path = filepath === "." ? "" : filepath;
      if (!path) return undefined;
      if (beforeOid && afterOid && beforeOid === afterOid) return undefined;
      if (!beforeOid && afterOid) rows.push({ path, change: "added", beforeOid, afterOid });
      else if (beforeOid && !afterOid) rows.push({ path, change: "removed", beforeOid, afterOid });
      else rows.push({ path, change: "modified", beforeOid, afterOid });
      return undefined;
    },
    reduce: async () => undefined,
  });

  // Rename detection: identical removed+added blob oids.
  const addedByOid = new Map<string, string>();
  const removedByOid = new Map<string, string>();
  for (const row of rows) {
    if (row.change === "added" && row.afterOid) addedByOid.set(row.afterOid, row.path);
    if (row.change === "removed" && row.beforeOid) removedByOid.set(row.beforeOid, row.path);
  }
  for (const [oid, from] of removedByOid) {
    const to = addedByOid.get(oid);
    if (to) {
      renames.set(from, to);
    }
  }
  const files: FileChange[] = [];
  const stats = { added: 0, removed: 0, modified: 0, renamed: 0 };
  for (const row of rows) {
    if (row.change === "removed" && renames.has(row.path)) {
      const to = renames.get(row.path)!;
      files.push({ path: to, change: "renamed", beforeOid: row.beforeOid, afterOid: row.afterOid ?? addedByOid.get(row.beforeOid!) ?? null, binary: null });
      stats.renamed++;
      continue;
    }
    if (row.change === "added" && [...renames.values()].includes(row.path)) continue;
    files.push({ path: row.path, change: row.change, beforeOid: row.beforeOid, afterOid: row.afterOid, binary: null });
    if (row.change === "added") stats.added++;
    else if (row.change === "removed") stats.removed++;
    else stats.modified++;
  }
  return { base: baseOid, head: headOid, files: files.slice(0, maxFiles), stats, truncated: rows.length > maxFiles };
}

export interface FileResult {
  path: string;
  revision: string;
  oid: string;
  bytes: number;
  binary: boolean;
  text: string | null;
  truncated: boolean;
}

/** Read a file at a revision (blob data only — never materialized to a worktree). */
export async function readFileAt(ws: RepoWorkspace, rev: string, path: string, options: { maxChars?: number } = {}): Promise<FileResult> {
  const oid = await resolveRevision(ws, rev);
  const blob = await git.readBlob({ fs: ws.fs as never, dir: ws.dir, oid, filepath: path, cache: ws.cache }).catch((error: unknown) => {
    const mapped = mapGitError(error, ws.normalized.displayUrl);
    if (mapped.code === "internal") throw new BrowserError("page_not_found", `"${path}" does not exist at revision ${rev}.`, { retryable: false });
    throw mapped;
  });
  const bytes = blob.blob;
  const binary = isBinary(bytes);
  const maxChars = clamp(options.maxChars ?? LIMITS.gitMaxFileBytes, 256, LIMITS.gitMaxFileBytes);
  if (binary) return { path, revision: rev, oid, bytes: bytes.byteLength, binary: true, text: null, truncated: false };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const truncated = text.length > maxChars;
  return { path, revision: rev, oid, bytes: bytes.byteLength, binary: false, text: truncated ? text.slice(0, maxChars) : text, truncated };
}

export function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_000));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

export async function resolveRevision(ws: RepoWorkspace, rev: string): Promise<string> {
  const cleaned = String(rev ?? "").trim() || "HEAD";
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(cleaned)) throw new BrowserError("invalid_input", "Revisions may contain letters, digits, . _ / - only.");
  try {
    return await git.resolveRef({ fs: ws.fs as never, dir: ws.dir, ref: cleaned });
  } catch {
    try {
      const oid = await git.expandOid({ fs: ws.fs as never, dir: ws.dir, oid: cleaned } as never);
      return oid;
    } catch (error) {
      throw new BrowserError("page_not_found", `Revision "${cleaned}" was not found in this repository.`, { retryable: false, hint: "Use a branch name, tag, or a full/abbreviated commit id.", cause: error });
    }
  }
}

export interface TreeEntryInfo {
  path: string;
  type: "blob" | "tree";
  oid: string;
}

/** Recursive tree listing at a revision with entry caps. */
export async function listTree(ws: RepoWorkspace, rev: string, options: { path?: string; maxEntries?: number } = {}): Promise<{ revision: string; oid: string; entries: TreeEntryInfo[]; truncated: boolean }> {
  const oid = await resolveRevision(ws, rev);
  const maxEntries = clamp(options.maxEntries ?? LIMITS.gitMaxTreeEntries, 1, LIMITS.gitMaxTreeEntries);
  const entries: TreeEntryInfo[] = [];
  let truncated = false;
  await git.walk({
    fs: ws.fs as never,
    dir: ws.dir,
    cache: ws.cache,
    trees: [git.TREE({ ref: oid }) as never],
    map: async (filepath: string, entriesFor: Array<{ oid?(): Promise<string>; type?(): Promise<string> } | null>) => {
      // `null` from map prunes subtrees in isomorphic-git — return undefined.
      const entry = entriesFor[0];
      if (!entry) return undefined;
      const type = await entry.type?.();
      const entryOid = await entry.oid?.();
      const path = filepath === "." ? "" : filepath;
      if (!path || !entryOid || (type !== "blob" && type !== "tree")) return undefined;
      if (options.path && !path.startsWith(options.path)) return undefined;
      if (entries.length >= maxEntries) {
        truncated = true;
        return undefined;
      }
      entries.push({ path, type: type as "blob" | "tree", oid: entryOid });
      return undefined;
    },
    reduce: async () => undefined,
  });
  return { revision: rev, oid, entries, truncated };
}

export interface LogEntry extends GitCommitInfo {
  parents: string[];
}

/** Commit history at a revision (bounded). */
export async function logAt(ws: RepoWorkspace, rev: string, options: { limit?: number; path?: string; includeChanges?: boolean } = {}): Promise<{ revision: string; entries: LogEntry[]; truncated: boolean }> {
  const limit = clamp(options.limit ?? 30, 1, LIMITS.gitMaxLogEntries);
  const log = (await git.log({
    fs: ws.fs as never,
    dir: ws.dir,
    cache: ws.cache,
    ref: rev,
    depth: limit + 1,
    ...(options.path ? { filepath: options.path } : {}),
    includeChanges: false,
  })) as unknown as Array<{ oid: string; commit: { message: string; author?: { name?: string; email?: string; timestamp?: number }; committer?: { name?: string; email?: string; timestamp?: number }; parent?: string[]; tree: string } }>;
  const entries: LogEntry[] = [];
  for (const entry of log.slice(0, limit)) {
    entries.push(await commitInfo(ws, entry.oid, options.includeChanges === true));
  }
  return { revision: rev, entries, truncated: log.length > limit };
}

export interface SearchHit {
  path: string;
  line: number;
  preview: string;
  revision: string;
}

/** Content search across the tree at a revision (case-sensitive substring or regex). */
export async function searchContent(ws: RepoWorkspace, rev: string, query: string, options: { pathFilter?: string; maxHits?: number; caseInsensitive?: boolean; regex?: boolean } = {}): Promise<{ revision: string; hits: SearchHit[]; filesScanned: number; filesSkipped: number; truncated: boolean }> {
  const oid = await resolveRevision(ws, rev);
  const maxHits = clamp(options.maxHits ?? 50, 1, 200);
  let matcher: (line: string) => boolean;
  if (options.regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query.slice(0, 500), options.caseInsensitive ? "i" : "");
    } catch (error) {
      throw new BrowserError("invalid_input", `The search pattern is not a valid regular expression: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`, { retryable: false });
    }
    matcher = (line) => pattern.test(line);
  } else {
    const needle = options.caseInsensitive ? query.toLowerCase() : query;
    matcher = (line) => (options.caseInsensitive ? line.toLowerCase() : line).includes(needle);
  }
  const filter = options.pathFilter ? safePathFilter(options.pathFilter) : null;
  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  let truncated = false;
  const files = await git.listFiles({ fs: ws.fs as never, dir: ws.dir, ref: oid, cache: ws.cache });
  for (const path of files.slice(0, LIMITS.gitMaxSearchFiles)) {
    if (filter && !filter.test(path)) continue;
    if (hits.length >= maxHits) {
      truncated = true;
      break;
    }
    const blob = await git.readBlob({ fs: ws.fs as never, dir: ws.dir, oid, filepath: path, cache: ws.cache }).catch(() => null);
    if (!blob) {
      filesSkipped++;
      continue;
    }
    const bytes = blob.blob;
    if (isBinary(bytes) || bytes.byteLength > LIMITS.gitMaxBytesPerFileScanned) {
      filesSkipped++;
      continue;
    }
    filesScanned++;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
      if (matcher(lines[i])) {
        hits.push({ path, line: i + 1, preview: lines[i].slice(0, 240), revision: rev });
      }
    }
    if (files.length > LIMITS.gitMaxSearchFiles) truncated = true;
  }
  return { revision: rev, hits, filesScanned, filesSkipped, truncated };
}

function safePathFilter(pattern: string): RegExp {
  try {
    let source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    return new RegExp(`^${source}$`);
  } catch {
    throw new BrowserError("invalid_input", "path_filter is not a usable glob.");
  }
}

export interface FileDiff {
  path: string;
  change: FileChange["change"];
  binary: boolean;
  beforeText: string | null;
  afterText: string | null;
  diff: string | null;
  sections: ChangedSection[];
  stats: { added: number; removed: number; similarity: number };
}

export interface CompareDiff extends CompareResult {
  diffs: FileDiff[];
  patch: string;
}

/** Compare two revisions: per-file structured diffs + one unified patch. */
export async function compareRevisions(ws: RepoWorkspace, base: string, head: string, options: { maxFiles?: number; includeDiffs?: boolean } = {}): Promise<CompareDiff> {
  const baseOid = await resolveRevision(ws, base);
  const headOid = await resolveRevision(ws, head);
  const comparison = await compareTrees(ws, baseOid, headOid, { maxFiles: options.maxFiles ?? 200 });
  const diffs: FileDiff[] = [];
  const patchParts: string[] = [`# patch ${ws.normalized.displayUrl} ${base.slice(0, 12)}..${head.slice(0, 12)}`, `# base ${baseOid}`, `# head ${headOid}`];
  let patchBudget = LIMITS.gitMaxPatchBytes;
  for (const file of comparison.files.slice(0, options.maxFiles ?? 200)) {
    if (patchBudget <= 0) break;
    const before = file.beforeOid ? await readBlobByOid(ws, file.beforeOid) : null;
    const after = file.afterOid ? await readBlobByOid(ws, file.afterOid) : null;
    const binary = (before && isBinary(before)) || (after && isBinary(after));
    const beforeText = before && !isBinary(before) ? new TextDecoder("utf-8", { fatal: false }).decode(before) : null;
    const afterText = after && !isBinary(after) ? new TextDecoder("utf-8", { fatal: false }).decode(after) : null;
    let diff: string | null = null;
    let sections: ChangedSection[] = [];
    let stats = { added: 0, removed: 0, similarity: beforeText === afterText ? 1 : 0 };
    if (!binary && (beforeText !== null || afterText !== null)) {
      const lineDiff: LineDiff = diffLines(beforeText ?? "", afterText ?? "", { maxLines: 4_000 });
      diff = toUnifiedDiff(lineDiff, `a/${file.path}`, `b/${file.path}`, 2);
      sections = changedSections(lineDiff).slice(0, 20);
      stats = { added: lineDiff.added, removed: lineDiff.removed, similarity: lineDiff.similarity };
    }
    const header = `diff --git a/${file.path} b/${file.path}`;
    const filePatch = binary
      ? `${header}\n# Binary files differ (${file.change}) — patch omitted.`
      : `${header}\n${diff ?? ""}`;
    patchParts.push(filePatch);
    patchBudget -= filePatch.length;
    diffs.push({
      path: file.path,
      change: file.change,
      binary: Boolean(binary),
      beforeText: binary ? null : (beforeText ?? "").slice(0, LIMITS.gitMaxFileBytes),
      afterText: binary ? null : (afterText ?? "").slice(0, LIMITS.gitMaxFileBytes),
      diff: binary ? null : (diff ?? "").slice(0, LIMITS.gitMaxPatchBytes),
      sections,
      stats,
    });
  }
  return {
    ...comparison,
    diffs,
    patch: patchParts.join("\n").slice(0, LIMITS.gitMaxPatchBytes),
  };
}

async function readBlobByOid(ws: RepoWorkspace, oid: string): Promise<Uint8Array | null> {
  try {
    const object = await git.readObject({ fs: ws.fs as never, dir: ws.dir, oid, cache: ws.cache });
    return object.type === "blob" ? (object.object as Uint8Array) : null;
  } catch {
    return null;
  }
}

export interface RepoStats {
  defaultBranch: string | null;
  branches: number;
  tags: number;
  fileCount: number;
  directoryCount: number;
  totalBytes: number | null;
  largestFiles: Array<{ path: string; bytes: number }>;
  topExtensions: Array<{ extension: string; count: number }>;
  recentContributors: Array<{ name: string; email: string; commits: number }>;
  historyInspected: number;
  limitations: string[];
}

/** Basic repository statistics computed from the fetched subset (honest about depth). */
export async function repoStats(ws: RepoWorkspace, refs: RemoteRefs | null): Promise<RepoStats> {
  const rev = "HEAD";
  const tree = await listTree(ws, rev, { maxEntries: LIMITS.gitMaxFilesListed });
  const limitations: string[] = [];
  if (tree.truncated) limitations.push(`File listing truncated at ${LIMITS.gitMaxFilesListed} entries.`);
  if (ws.depth) limitations.push(`Statistics reflect the fetched subset (depth: ${ws.depth}); total bytes cover listed files only.`);
  const files = tree.entries.filter((e) => e.type === "blob");
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const extensionCount = new Map<string, number>();
  for (const file of files) {
    const match = /\.([A-Za-z0-9_-]{1,12})$/.exec(file.path);
    const extension = match ? match[1].toLowerCase() : "(none)";
    extensionCount.set(extension, (extensionCount.get(extension) ?? 0) + 1);
  }
  const topExtensions = [...extensionCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([extension, count]) => ({ extension, count }));

  // Sizes: sample the largest by reading blobs (bounded).
  const largest: Array<{ path: string; bytes: number }> = [];
  let totalBytes = 0;
  let sizeSampled = 0;
  for (const file of files.slice(0, 600)) {
    const blob = await readBlobByOid(ws, file.oid);
    const bytes = blob?.byteLength ?? 0;
    totalBytes += bytes;
    sizeSampled++;
    largest.push({ path: file.path, bytes });
    if (largest.length > 500) break;
  }
  largest.sort((a, b) => b.bytes - a.bytes);

  const log = await logAt(ws, rev, { limit: 100 });
  const contributors = new Map<string, { name: string; email: string; commits: number }>();
  for (const entry of log.entries) {
    if (!entry.author) continue;
    const key = `${entry.author.name}|${entry.author.email}`;
    const current = contributors.get(key) ?? { name: entry.author.name, email: entry.author.email, commits: 0 };
    current.commits++;
    contributors.set(key, current);
  }

  return {
    defaultBranch: ws.defaultBranch ?? refs?.defaultBranch ?? null,
    branches: refs?.branches.length ?? 0,
    tags: refs?.tags.length ?? 0,
    fileCount: files.length,
    directoryCount: directories.size,
    totalBytes: sizeSampled === files.length ? totalBytes : null,
    largestFiles: largest.slice(0, 10),
    topExtensions,
    recentContributors: [...contributors.values()].sort((a, b) => b.commits - a.commits).slice(0, 10),
    historyInspected: log.entries.length,
    limitations,
  };
}

export interface GitignoreReport {
  exists: boolean;
  revision: string;
  patterns: Array<{ line: number; pattern: string; negated: boolean; directoryOnly: boolean; rooted: boolean }>;
  tested?: Array<{ path: string; decision: IgnoreDecision }>;
  limitations: string[];
}

/** Read `.gitignore` at a revision and (optionally) test paths against it. */
export async function inspectGitignore(ws: RepoWorkspace, rev: string, testPaths: string[] = []): Promise<GitignoreReport> {
  let source: string | null = null;
  try {
    const file = await readFileAt(ws, rev, ".gitignore", { maxChars: 100_000 });
    source = file.text;
  } catch {
    source = null;
  }
  if (source === null) {
    return { exists: false, revision: rev, patterns: [], tested: testPaths.slice(0, 20).map((path) => ({ path, decision: "not-ignored" })), limitations: ["No .gitignore at this revision; only the repository's tracked files are visible to DEMO."] };
  }
  const matcher: IgnoreMatcher = parseGitignore(source);
  return {
    exists: true,
    revision: rev,
    patterns: matcher.rules,
    tested: testPaths.slice(0, 20).map((path) => ({ path, decision: testPath(matcher, path) })),
    limitations: [...matcher.limitations, "Matcher implements the documented practical subset of gitignore(5); last matching rule wins."],
  };
}

/** Full patch export for one commit (git show --format=email-ish, text only). */
export async function exportPatch(ws: RepoWorkspace, rev: string): Promise<{ revision: string; oid: string; commit: GitCommitInfo; patch: string; files: number; truncated: boolean }> {
  const oid = await resolveRevision(ws, rev);
  const commit = await commitInfo(ws, oid, false);
  const parent = commit.parents[0] ?? EMPTY_TREE_OID;
  const comparison = await compareRevisions(ws, parent, oid, { maxFiles: 100, includeDiffs: true });
  const header = [
    `From ${oid}`,
    `From: ${commit.author ? `${commit.author.name} <${commit.author.email}>` : "unknown"}`,
    `Date: ${commit.author?.timestamp ?? ""}`,
    `Subject: ${commit.message.split("\n")[0].slice(0, 200)}`,
    "",
    commit.message.slice(0, 4_000),
    "",
  ].join("\n");
  const body = `${header}${comparison.patch}`;
  return {
    revision: rev,
    oid,
    commit,
    patch: body.slice(0, LIMITS.gitMaxPatchBytes),
    files: comparison.files.length,
    truncated: body.length > LIMITS.gitMaxPatchBytes,
  };
}
