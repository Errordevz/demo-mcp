/**
 * HTTP surface for the shared coding workspace.
 *
 * The MCP tools are the primary interface; these routes exist so a collaborator
 * that speaks plain HTTP (a GitHub Action, a CI job, the DEMO dashboard) can
 * read the workspace without an MCP session, and so an operator can publish a
 * review link. Reads are public summaries only — patch content, file bodies and
 * history need a `collab:write` DEMO OAuth grant, because workspace content is
 * project code, not marketing copy.
 */

import { BrowserError, describeError } from "../core/errors.js";
import { requireMcpScope } from "../auth/tool-auth.js";
import { collaboratorCapabilities, isProtectedPath, MAX_PATCH_BYTES, planTasks, PROTECTED_PATH_PREFIXES, summarizeWorkspace, type CollabOperation } from "./model.js";
import { resolveCollabStore, type CollabStore } from "./store.js";

const MAX_BODY_BYTES = MAX_PATCH_BYTES + 20_000;

interface RouteContext {
  env: Record<string, unknown>;
  request: Request;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(error: unknown): Response {
  const info = describeError(error);
  const status = info.code === "not_found" ? 404 : info.code === "conflict" ? 409 : info.code === "admin_required" ? 403 : info.code === "invalid_input" || info.code === "validation_failed" ? 400 : info.code === "size_limit_exceeded" ? 413 : info.code === "not_configured" ? 503 : 500;
  return json({ ok: false, error: info }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new BrowserError("size_limit_exceeded", "Request body too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BrowserError("size_limit_exceeded", "Request body too large.");
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BrowserError("invalid_input", "Body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string, max: number): string | null {
  const value = body[name];
  if (value == null) return null;
  if (typeof value !== "string") throw new BrowserError("invalid_input", `"${name}" must be a string.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new BrowserError("invalid_input", `"${name}" must be 1-${max} characters.`);
  return trimmed;
}

async function requireWrite(context: RouteContext, tool: string): Promise<{ ok: true; principal: string } | { ok: false; response: Response }> {
  const outcome = await requireMcpScope({ env: context.env, authorization: context.request.headers.get("Authorization") }, tool, "collab:write");
  if (!outcome.ok) return { ok: false, response: json({ ok: false, error: outcome.result }, 401) };
  return { ok: true, principal: outcome.principal.subjectHash.slice(0, 16) };
}

export function isCollabPath(pathname: string): boolean {
  return pathname === "/collab" || pathname.startsWith("/collab/");
}

/**
 * `GET|POST /collab...`. Returns `null` for an unknown sub-path so the caller
 * can fall through to its own 404 handler (mirrors the other route modules).
 */
export async function handleCollabRoute(request: Request, env: Record<string, unknown>): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isCollabPath(url.pathname)) return null;
  const context: RouteContext = { env, request };
  const segments = url.pathname.split("/").filter(Boolean); // ["collab", ...]
  const store = resolveCollabStore(env);
  const method = request.method.toUpperCase();

  try {
    if (segments.length === 1) {
      if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      let total: number | null = null;
      if (store) {
        try {
          total = (await store.collabList()).total;
        } catch {
          total = null;
        }
      }
      const jevConfigured = Boolean(env.TYPESAFE_API_KEY);
      const layaConfigured = Boolean(env.LAYA_BASE_URL && env.LAYA_API_KEY);
      return json({
        ok: true,
        storage: store ? "durable-object" : "unavailable",
        workspaces: total,
        collaborators: collaboratorCapabilities({ jevConfigured, layaConfigured, githubTokenConfigured: Boolean(env.GITHUB_ACTIONS_TOKEN), applyEnabled: String(env.COLLAB_ALLOW_APPLY ?? "true").toLowerCase() !== "false" }),
        endpoints: {
          list: "GET /collab/workspaces",
          read: "GET /collab/workspaces/:id",
          open: "POST /collab/workspaces",
          operate: "POST /collab/workspaces/:id/operations",
        },
        scopes: { write: "collab:write" },
        policy: {
          execution: "DEMO executes no code. Patches are stored in DEMO's workspace copy; tests are recorded or dispatched, never silently claimed as passing.",
          protectedPaths: PROTECTED_PATH_PREFIXES,
          mcpTools: "collab_collaborators, collab_workspace, collab_task, collab_patch, collab_review, collab_tests, collab_delegate, collab_history",
        },
      });
    }

    if (!store) return json({ ok: false, error: { code: "not_configured", message: "The shared workspace storage is not bound on this deployment." } }, 503);

    if (segments[1] === "workspaces" && segments.length === 2) {
      if (method === "GET") {
        const listing = await store.collabList();
        return json({ ok: true, ...listing, workspaces: listing.workspaces.slice(0, 100) });
      }
      if (method === "POST") {
        const auth = await requireWrite(context, "collab_workspace_http");
        if (!auth.ok) return auth.response;
        const body = await readJson(request);
        const repo = stringField(body, "repo", 300);
        if (!repo || !/^https:\/\//.test(repo)) return json({ ok: false, error: { code: "invalid_input", message: '"repo" must be an https:// repository URL.' } }, 400);
        const ref = stringField(body, "ref", 120) ?? "main";
        const title = stringField(body, "title", 200) ?? `Workspace on ${repo}`;
        const subdir = stringField(body, "subdir", 200);
        const byoxGoal = stringField(body, "byox_goal", 200);
        const opened = await store.collabOpen({ actor: "chatgpt", title, repo, ref, subdir, byoxGoal });
        return json({ ok: true, workspace: opened.summary, principal: auth.principal }, 201);
      }
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    if (segments[1] === "workspaces" && segments.length >= 3) {
      const id = decodeURIComponent(segments[2]!);
      if (segments.length === 3) {
        if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
        const workspace = await store.collabGet(id);
        if (!workspace) return json({ ok: false, error: { code: "not_found", message: `Workspace ${id} does not exist.` } }, 404);
        // Public summary; the full state (patch bodies, file hashes) needs the write grant.
        const auth = await requireMcpScope({ env, authorization: request.headers.get("Authorization") }, "collab_workspace_http", "collab:write");
        if (auth.ok) {
          return json({ ok: true, workspace, plan: planTasks(workspace), principal: auth.principal.subjectHash.slice(0, 16) });
        }
        return json({ ok: true, summary: summarizeWorkspace(workspace), detail: "Patch bodies and file hashes need a collab:write DEMO OAuth grant." });
      }
      if (segments[3] === "operations" && segments.length === 4) {
        if (method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
        const auth = await requireWrite(context, "collab_operation_http");
        if (!auth.ok) return auth.response;
        const body = await readJson(request);
        const operation = body.operation;
        if (!operation || typeof operation !== "object" || Array.isArray(operation)) return json({ ok: false, error: { code: "invalid_input", message: '"operation" must be an object with an "op" field.' } }, 400);
        const op = operation as CollabOperation;
        if ((op as { op: string }).op === "create_workspace") return json({ ok: false, error: { code: "invalid_input", message: "Use POST /collab/workspaces to open a workspace." } }, 400);
        if (op.op === "submit_patch" && typeof op.path === "string" && isProtectedPath(op.path) && body.approve_protected !== true && (op as { approveProtected?: boolean }).approveProtected !== true) {
          return json({ ok: false, error: { code: "admin_required", message: `${op.path} is a protected path. Submit with approveProtected: true to record it for review.` } }, 403);
        }
        const result = await store.collabApply(id, op, { applyEnabled: String(env.COLLAB_ALLOW_APPLY ?? "true").toLowerCase() !== "false" });
        return json({ ok: true, ...result.result, events: result.events, plan: planTasks(result.workspace), principal: auth.principal });
      }
      return json({ ok: false, error: "not_found" }, 404);
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    return failure(error);
  }
}

export type { CollabStore };
