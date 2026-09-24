/**
 * `git_repository` — one grouped, mode-driven tool for public Git inspection.
 *
 * Everything a coding agent needs to *read* a public repository (metadata,
 * branches, tags, history, commits, files at any revision, trees, content
 * search, compare/patch, stats, .gitignore) without a GitHub API key and
 * without a credential flow of any kind. Private repositories are a hard
 * `auth_required` refusal; hooks, LFS and repository automation are never run;
 * every URL goes through DEMO's SSRF stack on every hop.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { errorFrom, runTool, textResult } from "./results.js";
import {
  compareRevisions,
  commitInfo,
  exportPatch,
  inspectGitignore,
  listRemoteRefs,
  listTree,
  logAt,
  mapGitError,
  openRepo,
  readFileAt,
  repoStats,
  resolveRevision,
  searchContent,
} from "../git/client.js";
import { normalizeGitRepoUrl } from "../git/safety.js";
import { resolveGitPolicy } from "../git/config.js";

export const GIT_TOOL_NAMES = ["git_repository"] as const;

const MODES = ["info", "branches", "tags", "log", "commit", "file", "tree", "search", "compare", "patch", "stats", "ignore", "fetch"] as const;

export interface GitToolContext {
  env: Record<string, unknown> & { GIT_MAX_PACK_MB?: string; GIT_REQUEST_TIMEOUT_MS?: string; GIT_RATE_LIMIT_PER_MINUTE?: string; GIT_MAX_DEPTH?: string; GIT_MEMORY_MAX_MB?: string; GIT_TEMP_REPO_TTL_MS?: string };
}

export function registerGitTools(mcp: McpServer, ctx: GitToolContext): void {
  mcp.registerTool(
    "git_repository",
    {
      title: "Public Git Repository",
      description:
        "Inspect a PUBLIC Git repository over the standard Git smart-HTTP protocol — works with GitHub, GitLab, Codeberg, Gitea, sourcehut or any compatible host, with NO API key and NO credentials. Modes: info (metadata + default branch), branches, tags, log (history with changed files per commit via include_changes), commit (one commit + changed files), file (read a file at any revision), tree (structure), search (content search at a revision), compare (two revisions: structured diffs + patch), patch (export a commit as a patch), stats (basic statistics), ignore (.gitignore inspection + path tests), fetch (re-fetch state). Private repositories return auth_required — DEMO never accepts, requests or stores Git credentials. Repository contents are treated as untrusted data: hooks, LFS, build scripts and repository automation are never executed. Temporary clones are size/time limited and cleaned up automatically.",
      inputSchema: {
        mode: z.enum(MODES).describe("Which operation to perform."),
        url: z.string().max(1_000).describe("Public https:// repository URL (…/owner/repo or …/owner/repo.git)."),
        rev: z.string().max(255).optional().describe("Revision for log/commit/file/tree/search/ignore/patch: branch, tag or commit id. Default: HEAD."),
        path: z.string().max(500).optional().describe("File path (file/commit), tree prefix (tree), or glob path filter (search)."),
        query: z.string().max(500).optional().describe("Search text or regex (search mode)."),
        base: z.string().max(255).optional().describe("Base revision for compare mode."),
        head: z.string().max(255).optional().describe("Head revision for compare mode."),
        limit: z.number().int().min(1).max(LIMITS.gitMaxLogEntries).optional().describe("Entry/hit limit (log: commits, search: matches)."),
        depth: z.number().int().min(1).max(LIMITS.gitMaxDepth).optional().describe("History depth to fetch (1 = tip only). Omit for full history within the byte budget."),
        include_changes: z.boolean().optional().describe("log mode: include the changed files for each commit (default true)."),
        case_insensitive: z.boolean().optional().describe("search mode: case-insensitive matching."),
        regex: z.boolean().optional().describe("search mode: treat query as a regular expression."),
        test_paths: z.array(z.string().max(500)).max(20).optional().describe("ignore mode: paths to test against .gitignore rules."),
        refresh: z.boolean().optional().describe("Force a fresh fetch instead of reusing the cached temporary clone."),
        timeout_ms: z.number().int().min(2_000).max(LIMITS.gitTimeoutMaxMs).optional().describe("Network timeout (bounded by deployment policy)."),
      },
      annotations: { title: "Public Git Repository", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const mode = args.mode as (typeof MODES)[number];
        const url = String(args.url ?? "");
        // Validate the URL before anything else: fast, precise errors for
        // ssh://, credentials, internal hosts and malformed input.
        const policy = resolveGitPolicy(ctx.env);
        const normalized = normalizeGitRepoUrl(url, { allowInsecureHttp: String(ctx.env.BROWSER_ALLOW_INSECURE_HTTP ?? "false").toLowerCase() === "true" });

        try {
          switch (mode) {
            case "info":
            case "branches":
            case "tags": {
              const refs = await listRemoteRefs({ env: ctx.env, url });
              if (mode === "info") {
                return textResult({
                  ok: true,
                  repository: refs.url,
                  default_branch: refs.defaultBranch,
                  branch_count: refs.branches.length,
                  tag_count: refs.tags.length,
                  head: refs.head,
                  branches: refs.branches.slice(0, 200),
                  tags: refs.tags.slice(0, 200),
                  truncated: refs.truncated,
                  auth: "public-only; DEMO does not accept Git credentials",
                  limits: { max_pack_bytes: policy.maxPackBytes, timeout_ms: policy.requestTimeoutMs },
                });
              }
              return textResult({ ok: true, repository: refs.url, ...(mode === "branches" ? { branches: refs.branches, default_branch: refs.defaultBranch } : { tags: refs.tags }), truncated: refs.truncated });
            }
            case "log": {
              const ws = await openRepo({ env: ctx.env, url, ref: args.rev ?? null, depth: args.depth ?? LIMITS.gitDefaultDepth, refresh: args.refresh });
              const log = await logAt(ws, args.rev ?? "HEAD", { limit: args.limit ?? 30, path: args.path, includeChanges: args.include_changes !== false });
              return textResult({ ok: true, repository: ws.normalized.displayUrl, revision: log.revision, resolved_oid: await resolveRevision(ws, log.revision).catch(() => null), commits: log.entries, truncated: log.truncated });
            }
            case "commit": {
              const rev = args.rev ?? "HEAD";
              const ws = await openRepo({ env: ctx.env, url, ref: null, depth: args.depth ?? null });
              const oid = await resolveRevision(ws, rev);
              const info = await commitInfo(ws, oid, true);
              return textResult({ ok: true, repository: ws.normalized.displayUrl, revision: rev, commit: info });
            }
            case "file": {
              if (!args.path) throw new BrowserError("invalid_input", "file mode requires path.");
              const ws = await openRepo({ env: ctx.env, url, ref: args.rev ?? null, depth: 1 });
              const file = await readFileAt(ws, args.rev ?? "HEAD", args.path);
              return textResult({
                ok: true,
                repository: ws.normalized.displayUrl,
                revision: file.revision,
                path: file.path,
                oid: file.oid,
                bytes: file.bytes,
                binary: file.binary,
                truncated: file.truncated,
                ...(file.binary ? { note: "Binary file: content is not returned as text. Use compare/patch for change metadata." } : { content: file.text }),
              });
            }
            case "tree": {
              const ws = await openRepo({ env: ctx.env, url, ref: args.rev ?? null, depth: 1 });
              const tree = await listTree(ws, args.rev ?? "HEAD", { path: args.path });
              return textResult({ ok: true, repository: ws.normalized.displayUrl, revision: tree.revision, root_oid: tree.oid, entries: tree.entries, truncated: tree.truncated });
            }
            case "search": {
              if (!args.query) throw new BrowserError("invalid_input", "search mode requires query.");
              const ws = await openRepo({ env: ctx.env, url, ref: args.rev ?? null, depth: 1 });
              const result = await searchContent(ws, args.rev ?? "HEAD", args.query, {
                pathFilter: args.path,
                maxHits: args.limit ?? 50,
                caseInsensitive: args.case_insensitive === true,
                regex: args.regex === true,
              });
              return textResult({ ok: true, repository: ws.normalized.displayUrl, ...result });
            }
            case "compare": {
              if (!args.base || !args.head) throw new BrowserError("invalid_input", "compare mode requires base and head revisions.");
              const ws = await openRepo({ env: ctx.env, url, ref: null, depth: args.depth ?? null });
              const comparison = await compareRevisions(ws, args.base, args.head, { maxFiles: 200 });
              return textResult({ ok: true, repository: ws.normalized.displayUrl, ...comparison });
            }
            case "patch": {
              const rev = args.rev ?? "HEAD";
              const ws = await openRepo({ env: ctx.env, url, ref: null, depth: args.depth ?? null });
              const patch = await exportPatch(ws, rev);
              return textResult({ ok: true, repository: ws.normalized.displayUrl, ...patch });
            }
            case "stats": {
              const ws = await openRepo({ env: ctx.env, url, ref: null, depth: args.depth ?? LIMITS.gitDefaultDepth });
              const refs = await listRemoteRefs({ env: ctx.env, url }).catch(() => null);
              const stats = await repoStats(ws, refs);
              return textResult({ ok: true, repository: ws.normalized.displayUrl, ...stats });
            }
            case "ignore": {
              const ws = await openRepo({ env: ctx.env, url, ref: args.rev ?? null, depth: 1 });
              const report = await inspectGitignore(ws, args.rev ?? "HEAD", args.test_paths ?? []);
              return textResult({ ok: true, repository: ws.normalized.displayUrl, ...report });
            }
            case "fetch": {
              const ws = await openRepo({ env: ctx.env, url, ref: args.rev ?? null, depth: args.depth ?? null, refresh: true });
              return textResult({ ok: true, repository: ws.normalized.displayUrl, fetched: true, head_oid: ws.headOid, default_branch: ws.defaultBranch, workspace_bytes: ws.fs.bytesWritten, note: "DEMO re-cloned into a fresh temporary workspace; previous workspace cleaned up." });
            }
            default:
              throw new BrowserError("invalid_input", `Unknown mode "${String(mode)}".`, { hint: `Valid modes: ${MODES.join(", ")}` });
          }
        } catch (error) {
          return errorFrom(mapGitError(error, normalized.displayUrl));
        }
      }),
  );
}
