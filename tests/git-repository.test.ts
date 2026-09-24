/**
 * DEMO 0.9 — public Git capability.
 *
 * End-to-end against a REAL Git smart-HTTP server (the `git upload-pack`
 * binary producing genuine advertisements and packfiles), with `globalThis.fetch`
 * routed to it under a public-looking hostname so the production URL policy,
 * guard plumbing and client code all run unmodified. Plus unit coverage for
 * URL safety, the .gitignore matcher, workspace quotas and structured errors.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedFilesFor,
  compareRevisions,
  exportPatch,
  inspectGitignore,
  listRemoteRefs,
  listTree,
  logAt,
  mapGitError,
  openRepo,
  readFileAt,
  repoStats,
  resetGitWorkspaces,
  resolveRevision,
  searchContent,
  createGuardedGitHttpClient,
} from "../src/git/client.js";
import { MemoryFs } from "../src/git/memory-fs.js";
import { normalizeGitRepoUrl, authRequiredError } from "../src/git/safety.js";
import { parseGitignore, testPath } from "../src/git/gitignore.js";
import { createFixtureRepo, startGitServer, type FixtureRepo, type GitServer } from "./helpers/git-server.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import worker from "../index.js";
import type { NormalizedGitRepo } from "../src/git/safety.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const REPO_URL = "https://git.fixture.test/owner/repo.git";

function passthroughResolver(input: string): NormalizedGitRepo {
  return { cloneUrl: input, displayUrl: input, host: "git.fixture.test", path: "/owner/repo" };
}

describe("git_repository", () => {
  let fixture: FixtureRepo;
  let server: GitServer;
  let realFetch: typeof fetch;

  const fetchStub: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") {
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8", TTL: 60 }] }), { headers: { "content-type": "application/dns-json" } });
    }
    if (url.hostname === "git.fixture.test") {
      const target = new URL(server.url);
      url.hostname = target.hostname;
      url.port = target.port;
      url.protocol = target.protocol;
      return realFetch(url, init);
    }
    throw new TypeError(`fetch stub: unexpected host ${url.hostname}`);
  }) as typeof fetch;

  beforeEach(async () => {
    fixture = createFixtureRepo();
    server = await startGitServer(fixture.dir);
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchStub;
    resetGitWorkspaces();
    publicToolRateLimiter.reset();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await server.close();
    fixture.cleanup();
    resetGitWorkspaces();
  });

  const clientEnv = { GIT_REQUEST_TIMEOUT_MS: "30000" } as Record<string, unknown>;
  const open = (options: Partial<Parameters<typeof openRepo>[0]> = {}) =>
    openRepo({ env: clientEnv, url: REPO_URL, guard: async (u) => u, fetchImpl: fetchStub, resolveRepoUrl: passthroughResolver, ...options });

  it("lists remote branches, tags and the default branch without cloning", async () => {
    const refs = await listRemoteRefs({ env: clientEnv, url: REPO_URL, guard: async (u) => u, fetchImpl: fetchStub, resolveRepoUrl: passthroughResolver });
    expect(refs.branches.map((branch) => branch.name).sort()).toEqual(["dev", "main"]);
    expect(refs.tags.map((tag) => tag.name)).toContain("v1");
    expect(refs.defaultBranch).toBe("main");
    const main = refs.branches.find((branch) => branch.name === "main");
    expect(main?.default).toBe(true);
  });

  it("reads commit history with changed files and inspects a single commit", async () => {
    const ws = await open();
    const log = await logAt(ws, "main", { limit: 10, includeChanges: true });
    expect(log.entries.length).toBeGreaterThanOrEqual(2);
    expect(log.entries[0].message).toContain("second commit");
    expect(log.entries[0].changedFiles?.map((file) => file.path)).toContain("README.md");
    const { commitInfo } = await import("../src/git/client.js");
    const first = await commitInfo(ws, fixture.firstCommit, true);
    expect(first.parents.length).toBe(0);
    expect(first.changedFiles?.some((file) => file.path === "src/main.c" && file.change === "added")).toBe(true);
  });

  it("reads files at HEAD and at a specific commit/revision", async () => {
    const ws = await open();
    const atHead = await readFileAt(ws, "HEAD", "README.md");
    expect(atHead.text).toContain("Second revision line");
    const atFirst = await readFileAt(ws, fixture.firstCommit, "README.md");
    expect(atFirst.text).toContain("Hello world fixture");
    expect(atFirst.text).not.toContain("Second revision line");
    const byTag = await readFileAt(ws, "v1", "README.md");
    expect(byTag.oid).toBe(atFirst.oid);
    await expect(readFileAt(ws, "HEAD", "missing.txt")).rejects.toMatchObject({ code: "page_not_found" });
  });

  it("lists the tree structure at a revision", async () => {
    const ws = await open();
    const tree = await listTree(ws, "HEAD", { maxEntries: 100 });
    const paths = tree.entries.map((entry) => entry.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/main.c");
    expect(paths).toContain(".gitignore");
  });

  it("searches repository content at a revision", async () => {
    const ws = await open();
    const hits = await searchContent(ws, "HEAD", "Hello world");
    expect(hits.hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.hits[0].path).toBe("README.md");
    expect(hits.filesScanned).toBeGreaterThan(0);
    const filtered = await searchContent(ws, "HEAD", "int main", { pathFilter: "src/*" });
    expect(filtered.hits[0]?.path).toBe("src/main.c");
  });

  it("compares two revisions: structured file diffs + patch text", async () => {
    const ws = await open();
    const comparison = await compareRevisions(ws, fixture.firstCommit, "HEAD");
    expect(comparison.files.map((file) => file.path)).toContain("README.md");
    const readme = comparison.diffs.find((diff) => diff.path === "README.md");
    expect(readme?.change).toBe("modified");
    expect(readme?.diff).toContain("+Second revision line");
    expect(comparison.patch).toContain("diff --git a/README.md");
  });

  it("exports a commit as a patch", async () => {
    const ws = await open();
    const patch = await exportPatch(ws, fixture.firstCommit);
    expect(patch.patch).toContain("Subject: first commit");
    expect(patch.patch).toContain("diff --git");
    expect(patch.files).toBeGreaterThan(0);
  });

  it("computes basic repository statistics", async () => {
    const ws = await open({ depth: 2 });
    const stats = await repoStats(ws, null);
    expect(stats.fileCount).toBeGreaterThanOrEqual(3);
    expect(stats.topExtensions.map((entry) => entry.extension)).toContain("md");
    expect(stats.limitations.length).toBeGreaterThan(0); // depth honesty
  });

  it("inspects .gitignore and tests paths against it", async () => {
    const ws = await open();
    const report = await inspectGitignore(ws, "HEAD", ["build/out.o", "keep.log", "debug.log", "src/main.c"]);
    expect(report.exists).toBe(true);
    const decisions = Object.fromEntries((report.tested ?? []).map((entry) => [entry.path, entry.decision]));
    expect(decisions["build/out.o"]).toBe("ignored");
    expect(decisions["debug.log"]).toBe("ignored");
    expect(decisions["keep.log"]).toBe("not-ignored"); // negation wins
    expect(decisions["src/main.c"]).toBe("not-ignored");
  });

  it("resolves revisions including abbreviated oids", async () => {
    const ws = await open();
    const resolved = await resolveRevision(ws, fixture.headMain.slice(0, 8));
    expect(resolved).toBe(fixture.headMain);
  });

  it("computes changed files for a commit against its parent", async () => {
    const ws = await open();
    const changed = await changedFilesFor(ws, fixture.headMain);
    expect(changed).toEqual([{ path: "README.md", change: "modified" }]);
  });

  it("enforces the workspace byte quota with a stable error", async () => {
    const fs = new MemoryFs({ maxBytes: 64 });
    await fs.promises.writeFile("/repo/a", new Uint8Array(50));
    await expect(fs.promises.writeFile("/repo/b", new Uint8Array(50))).rejects.toMatchObject({ code: "size_limit_exceeded" });
    fs.dispose();
    await expect(fs.promises.readFile("/repo/a", "utf8")).rejects.toMatchObject({ code: "session_expired" });
  });

  it("refuses ssh/scp URLs and credential URLs before any request", () => {
    expect(() => normalizeGitRepoUrl("git@github.com:owner/repo.git")).toThrowError(/ssh/i);
    expect(() => normalizeGitRepoUrl("ssh://git@github.com/owner/repo.git")).toThrowError(/ssh/i);
    expect(() => normalizeGitRepoUrl("git://github.com/owner/repo.git")).toThrowError(/ssh|https/i);
    expect(() => normalizeGitRepoUrl("https://user:pass@github.com/owner/repo.git")).toThrowError(/credential/i);
    expect(() => normalizeGitRepoUrl("file:///etc/passwd")).toThrowError(/scheme/i);
    expect(() => normalizeGitRepoUrl("http://internal.example/x", { allowInsecureHttp: false })).toThrowError(/http/i);
  });

  it("blocks internal Git targets through the SSRF stack", () => {
    for (const url of [
      "https://localhost/repo.git",
      "https://127.0.0.1/repo.git",
      "https://10.0.0.5/repo.git",
      "https://169.254.169.254/repo.git",
      "https://metadata.google.internal/repo.git",
    ]) {
      expect(() => normalizeGitRepoUrl(url), url).toThrowError(/safety check|ssh|credential|scheme/i);
    }
  });

  it("normalizes .git suffix and display URLs", () => {
    const parsed = normalizeGitRepoUrl("https://github.com/octocat/Hello-World");
    expect(parsed.cloneUrl).toBe("https://github.com/octocat/Hello-World.git");
    expect(parsed.displayUrl).toBe("https://github.com/octocat/Hello-World");
  });

  it("reports auth-required as a structured refusal, never a credential prompt", () => {
    const error = authRequiredError("https://example.test/private", 401);
    expect(error.code).toBe("auth_required");
    expect(error.hint).toMatch(/public repositories only/i);
    expect(JSON.stringify(error.toJSON())).not.toMatch(/password|token/i);
  });

  it("maps 401/403 from the transport to auth_required", async () => {
    const http = createGuardedGitHttpClient({
      guard: async (u) => u,
      policy: { maxPackBytes: 1_000_000, requestTimeoutMs: 5_000, rateLimitPerMinute: 6, maxDepth: 5, memoryMaxBytes: 1_000_000, tempRepoTtlMs: 60_000 },
      fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(http.request({ url: "https://example.test/repo.git/info/refs" })).rejects.toMatchObject({ code: "auth_required" });
    const mapped = mapGitError(new Error("HttpError: 401 unauthorized"), "https://example.test/repo");
    expect(mapped.code).toBe("auth_required");
  });

  it("answers every git_repository mode through the MCP tool surface", async () => {
    const toolEnv = { GIT_RATE_LIMIT_PER_MINUTE: "60", TOOL_RATE_LIMIT_PER_MINUTE: "60", GIT_REQUEST_TIMEOUT_MS: "30000" } as never;
    const call = async (args: Record<string, unknown>) => {
      const response = await worker.fetch(
        new Request("https://demo.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "git_repository", arguments: args } }),
        }),
        toolEnv,
        CTX,
      );
      const text = await response.text();
      const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
      const body = (payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
      return { isError: Boolean(payload.result?.isError), parsed: JSON.parse(body) as Record<string, any> };
    };

    const info = await call({ mode: "info", url: REPO_URL });
    expect(info.isError).toBeFalsy();
    expect(info.parsed.default_branch).toBe("main");
    expect(info.parsed.branch_count).toBe(2);

    const branches = await call({ mode: "branches", url: REPO_URL });
    expect(branches.parsed.branches.map((branch: { name: string }) => branch.name).sort()).toEqual(["dev", "main"]);

    const tags = await call({ mode: "tags", url: REPO_URL });
    expect(tags.parsed.tags.map((tag: { name: string }) => tag.name)).toContain("v1");

    const log = await call({ mode: "log", url: REPO_URL, rev: "main", limit: 5 });
    expect(log.parsed.commits.length).toBeGreaterThanOrEqual(2);

    const file = await call({ mode: "file", url: REPO_URL, rev: "v1", path: "README.md" });
    expect(file.parsed.content).toContain("Hello world");

    const search = await call({ mode: "search", url: REPO_URL, query: "Hello world" });
    expect(search.parsed.hits.length).toBeGreaterThan(0);

    const compare = await call({ mode: "compare", url: REPO_URL, base: fixture.firstCommit, head: "HEAD" });
    expect(compare.parsed.files.length).toBeGreaterThan(0);

    const ignore = await call({ mode: "ignore", url: REPO_URL, test_paths: ["build/x"] });
    expect(ignore.parsed.tested[0].decision).toBe("ignored");

    const stats = await call({ mode: "stats", url: REPO_URL });
    expect(stats.parsed.fileCount).toBeGreaterThanOrEqual(3);
  });

  it("returns structured errors for invalid input at the tool surface", async () => {
    const toolEnv = { GIT_RATE_LIMIT_PER_MINUTE: "60", TOOL_RATE_LIMIT_PER_MINUTE: "60" } as never;
    const call = async (args: Record<string, unknown>) => {
      const response = await worker.fetch(
        new Request("https://demo.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "git_repository", arguments: args } }),
        }),
        toolEnv,
        CTX,
      );
      const text = await response.text();
      const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
      const body = (payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
      return JSON.parse(body) as Record<string, any>;
    };

    const ssh = await call({ mode: "info", url: "git@github.com:owner/repo.git" });
    expect(ssh.error).toBe("invalid_input");
    expect(ssh.message).toMatch(/ssh/i);

    const credentialed = await call({ mode: "info", url: "https://user:pass@example.com/x.git" });
    expect(credentialed.error).toBe("invalid_input");

    const internal = await call({ mode: "info", url: "https://127.0.0.1/x.git" });
    expect(["blocked_url", "invalid_input"]).toContain(internal.error);

    const missingArgs = await call({ mode: "file", url: REPO_URL });
    expect(missingArgs.error).toBe("invalid_input");

    const privateRepo = await call({ mode: "info", url: REPO_URL });
    // Flip the fixture server into private-repo mode and confirm the refusal.
    server.requireAuth = true;
    const refused = await call({ mode: "branches", url: REPO_URL });
    expect(refused.error).toBe("auth_required");
    expect(refused.hint ?? refused.message).toMatch(/public repositories only/i);
    server.requireAuth = false;
    void privateRepo;
  });
});

describe(".gitignore matcher", () => {
  it("handles comments, negation, directory rules and globs", () => {
    const matcher = parseGitignore(["# comment", "*.log", "!keep.log", "build/", "/root-only.txt", "docs/**/*.tmp"].join("\n"));
    expect(matcher.rules.length).toBe(5);
    expect(testPath(matcher, "app.log")).toBe("ignored");
    expect(testPath(matcher, "keep.log")).toBe("not-ignored");
    expect(testPath(matcher, "build/out.o")).toBe("ignored");
    expect(testPath(matcher, "nested/build/x")).toBe("ignored");
    expect(testPath(matcher, "root-only.txt")).toBe("ignored");
    expect(testPath(matcher, "sub/root-only.txt")).toBe("not-ignored");
    expect(testPath(matcher, "docs/a/b/c.tmp")).toBe("ignored");
    expect(testPath(matcher, "src/main.c")).toBe("not-ignored");
  });
});
