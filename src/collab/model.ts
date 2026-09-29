/**
 * Shared coding workspace — model and policy.
 *
 * DEMO cannot run arbitrary code (there is no sandbox binding) and neither Jev
 * nor Laya is a code-execution service: Jev (TypeSafe) answers typed decision
 * questions and Laya answers the same shapes over HTTP. What DEMO *can* do, and
 * does here, is give all three collaborators one shared, auditable workspace:
 * a project binding, tasks with owners and dependencies, patches attributed to
 * an author with base hashes and conflict detection, review verdicts, recorded
 * test results (with the runner named, never invented), an append-only history,
 * and capability reporting that says exactly what each collaborator can and
 * cannot do.
 *
 * A collaborator that cannot execute code is never described as if it could:
 * `capabilities.execution` is `"none"` for all three, and `tests.runner` only
 * ever says `github_actions` when a workflow dispatch actually happened.
 *
 * Everything in this file is pure: the Durable Object applies these functions
 * against its storage, and tests exercise them directly.
 */

import { BrowserError } from "../core/errors.js";

export type CollaboratorId = string;

export interface CollaboratorCapability {
  id: CollaboratorId;
  label: string;
  kind: "mcp_client" | "decision_provider";
  /** `available` only when the underlying credential/endpoint is configured. */
  status: "available" | "unavailable";
  /** How this collaborator reaches the workspace today. */
  channel: string;
  capabilities: {
    research: boolean;
    read_repository: boolean;
    submit_patch: boolean;
    review: boolean;
    record_tests: boolean;
    apply_patch: boolean;
    write_to_github: boolean;
    execute_code: boolean;
    typed_decisions: boolean;
  };
  execution: "none" | "github_actions";
  limitations: string[];
}

export interface CollaboratorEnvironment {
  /** Jev/TypeSafe credential present. */
  jevConfigured?: boolean;
  /** Laya endpoint + credential present. */
  layaConfigured?: boolean;
  /** A GitHub token that could dispatch workflows or write branches. */
  githubTokenConfigured?: boolean;
  /** Whether patch application is enabled for this deployment. */
  applyEnabled?: boolean;
}

/**
 * The capability matrix, derived from what is actually configured. Nothing here
 * is aspirational: every `true` maps to a tool or route that exists in this
 * repository, and every limitation names the missing dependency.
 */
export function collaboratorCapabilities(env: CollaboratorEnvironment = {}): CollaboratorCapability[] {
  const githubNote = env.githubTokenConfigured
    ? "A GitHub token is configured, so branch/PR operations are available through the GitHub REST tools."
    : "No GitHub token is configured on this Worker, so DEMO cannot push branches or open pull requests. Patches are kept in the shared workspace and applied to DEMO's copy only.";
  return [
    {
      id: "chatgpt",
      label: "ChatGPT",
      kind: "mcp_client",
      status: "available",
      channel: "MCP (this endpoint) with optional DEMO OAuth per-tool grants",
      capabilities: { research: true, read_repository: true, submit_patch: true, review: true, record_tests: true, apply_patch: env.applyEnabled !== false, write_to_github: Boolean(env.githubTokenConfigured), execute_code: false, typed_decisions: false },
      execution: "none",
      limitations: [
        "DEMO executes no code: it stores patches, detects conflicts and records test results. Any execution ChatGPT performs happens in ChatGPT's own environment.",
        githubNote,
      ],
    },
    {
      id: "jev",
      label: "Jev (TypeSafe)",
      kind: "decision_provider",
      status: env.jevConfigured ? "available" : "unavailable",
      channel: env.jevConfigured
        ? "DEMO's typed-decision client (jev_decide, jev_capabilities) plus workspace tools when it connects as an MCP client with a collab:write grant"
        : "Not configured: TYPESAFE_API_KEY is absent, so no Jev request is sent.",
      capabilities: { research: true, read_repository: true, submit_patch: true, review: true, record_tests: true, apply_patch: env.applyEnabled !== false, write_to_github: false, execute_code: false, typed_decisions: Boolean(env.jevConfigured) },
      execution: "none",
      limitations: [
        "Jev's public API answers typed decision questions; it does not execute code or edit files. DEMO therefore lets Jev *request* operations (patches, reviews, task updates) that DEMO performs and attributes to it.",
        env.jevConfigured ? "Decision calls require the decision:use OAuth scope; workspace writes require collab:write." : "Unavailable until TYPESAFE_API_KEY is set.",
      ],
    },
    {
      id: "laya",
      label: "Laya",
      kind: "decision_provider",
      status: env.layaConfigured ? "available" : "unavailable",
      channel: env.layaConfigured
        ? "DEMO's Laya provider (laya_capabilities, jev_decide with provider routing) plus workspace tools when it connects as an MCP client with a collab:write grant"
        : "Not configured: LAYA_BASE_URL/LAYA_API_KEY are absent, so no Laya request is sent.",
      capabilities: { research: true, read_repository: true, submit_patch: true, review: true, record_tests: true, apply_patch: env.applyEnabled !== false, write_to_github: false, execute_code: false, typed_decisions: Boolean(env.layaConfigured) },
      execution: "none",
      limitations: [
        "Laya is a typed-decision provider like Jev: it returns schema-validated answers, not code. DEMO records and applies its requested operations and never claims Laya ran anything.",
        env.layaConfigured ? "Only schema-valid answers are accepted; an invalid answer is a provider failure, not a patch." : "Unavailable until LAYA_BASE_URL and LAYA_API_KEY are set.",
      ],
    },
  ];
}

/* ------------------------------------------------------------------- state */

export type TaskStatus = "queued" | "in_progress" | "blocked" | "review" | "done" | "failed";
export const TASK_STATUSES: TaskStatus[] = ["queued", "in_progress", "blocked", "review", "done", "failed"];

export interface CollabTask {
  id: string;
  title: string;
  description: string;
  assignee: CollaboratorId;
  status: TaskStatus;
  dependsOn: string[];
  files: string[];
  attempts: number;
  maxAttempts: number;
  createdBy: CollaboratorId;
  createdAt: string;
  updatedAt: string;
  patches: string[];
  testRuns: string[];
  lastError: string | null;
  notes: string[];
}

export interface PatchReview {
  reviewer: CollaboratorId;
  verdict: "approve" | "request_changes" | "reject";
  comments: string;
  at: string;
}

export interface CollabPatch {
  id: string;
  taskId: string | null;
  author: CollaboratorId;
  path: string;
  operation: "create" | "modify" | "delete";
  /** Hash of the file the author worked from; null for `create`. */
  baseHash: string | null;
  /** Full new content for create/modify (bounded, text only). */
  content: string | null;
  /** Unified diff, optional and informational. */
  diff: string | null;
  status: "proposed" | "applied" | "rejected" | "conflict";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: CollaboratorId | null;
  review: PatchReview | null;
  conflict: string | null;
  protectedPath: boolean;
}

export interface CollabTestRun {
  id: string;
  taskId: string | null;
  patchId: string | null;
  command: string;
  /** `recorded` means DEMO did not run anything; `github_actions` means a dispatch was made. */
  runner: "recorded" | "github_actions";
  status: "passed" | "failed" | "not_run" | "dispatched";
  summary: string;
  outputExcerpt: string | null;
  externalUrl: string | null;
  actor: CollaboratorId;
  at: string;
}

export interface CollabEvent {
  id: string;
  at: string;
  actor: CollaboratorId;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

export interface WorkspaceFile {
  path: string;
  sha256: string;
  bytes: number;
  updatedAt: string;
  updatedBy: CollaboratorId;
}

export interface CollabWorkspace {
  id: string;
  version: number;
  title: string;
  project: { repo: string; ref: string; subdir: string | null; byoxGoal: string | null };
  createdBy: CollaboratorId;
  createdAt: string;
  updatedAt: string;
  files: Record<string, WorkspaceFile>;
  tasks: Record<string, CollabTask>;
  patches: Record<string, CollabPatch>;
  tests: Record<string, CollabTestRun>;
  events: CollabEvent[];
}

/** Files whose modification needs an explicit approval (destructive/sensitive). */
export const PROTECTED_PATH_PREFIXES = [".github/workflows/", "src/auth/", "src/security/", "src/core/admin.ts", "wrangler.jsonc"];
export const MAX_PATCH_BYTES = 200_000;
export const MAX_EVENTS = 500;

export function isProtectedPath(path: string): boolean {
  const normalized = normalizePath(path);
  return PROTECTED_PATH_PREFIXES.some((prefix) => (prefix.endsWith(".jsonc") ? normalized === prefix : normalized.startsWith(prefix)));
}

export function normalizePath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export function newId(prefix: string, seed: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* -------------------------------------------------------------- operations */

export interface CreateWorkspaceOperation {
  op: "create_workspace";
  actor: CollaboratorId;
  title: string;
  repo: string;
  ref: string;
  subdir?: string | null;
  byoxGoal?: string | null;
}
export interface AssignTaskOperation {
  op: "assign_task";
  actor: CollaboratorId;
  taskId?: string;
  title: string;
  description: string;
  assignee: CollaboratorId;
  dependsOn?: string[];
  files?: string[];
  maxAttempts?: number;
}
export interface UpdateTaskOperation {
  op: "update_task";
  actor: CollaboratorId;
  taskId: string;
  status?: TaskStatus;
  assignee?: CollaboratorId;
  note?: string;
  lastError?: string | null;
}
export interface SubmitPatchOperation {
  op: "submit_patch";
  actor: CollaboratorId;
  taskId?: string | null;
  path: string;
  content?: string | null;
  diff?: string | null;
  operation?: "create" | "modify" | "delete";
  baseHash?: string | null;
}
export interface ResolvePatchOperation {
  op: "resolve_patch";
  actor: CollaboratorId;
  patchId: string;
  action: "apply" | "reject";
  /** Required for `apply` when the patch targets a protected path. */
  approveProtected?: boolean;
  force?: boolean;
}
export interface ReviewOperation {
  op: "review";
  actor: CollaboratorId;
  patchId?: string;
  taskId?: string;
  verdict: "approve" | "request_changes" | "reject";
  comments: string;
}
export interface RecordTestOperation {
  op: "record_test";
  actor: CollaboratorId;
  taskId?: string | null;
  patchId?: string | null;
  command: string;
  status: "passed" | "failed" | "not_run" | "dispatched";
  runner?: "recorded" | "github_actions";
  summary: string;
  outputExcerpt?: string | null;
  externalUrl?: string | null;
}
export interface RegisterFileOperation {
  op: "register_file";
  actor: CollaboratorId;
  path: string;
  content: string;
}

export type CollabOperation =
  | CreateWorkspaceOperation
  | AssignTaskOperation
  | UpdateTaskOperation
  | SubmitPatchOperation
  | ResolvePatchOperation
  | ReviewOperation
  | RecordTestOperation
  | RegisterFileOperation;

export interface ApplyContext {
  now?: number;
  /** Patch application enabled for this deployment (COLLAB_ALLOW_APPLY). */
  applyEnabled?: boolean;
}

export interface OperationResult {
  workspace: CollabWorkspace;
  events: CollabEvent[];
  result: Record<string, unknown>;
}

function event(actor: CollaboratorId, action: string, target: string, details: Record<string, unknown>, at: string, seed: string): CollabEvent {
  return { id: newId("ev", `${at}:${actor}:${action}:${target}:${seed}`), at, actor, action, target, details };
}

function fail(code: "invalid_input" | "not_found" | "conflict" | "admin_required" | "size_limit_exceeded", message: string, hint?: string): never {
  throw new BrowserError(code, message, hint ? { hint } : {});
}

/**
 * Apply one operation to a workspace. Pure and deterministic given `now`; the
 * Durable Object passes its own timestamp so events and hashes are reproducible
 * in tests.
 */
export async function applyOperation(workspace: CollabWorkspace, operation: CollabOperation, context: ApplyContext = {}): Promise<OperationResult> {
  const now = context.now ?? Date.now();
  const at = new Date(now).toISOString();
  const next: CollabWorkspace = structuredClone(workspace);
  const events: CollabEvent[] = [];
  const applyEnabled = context.applyEnabled !== false;
  let result: Record<string, unknown> = {};

  switch (operation.op) {
    case "create_workspace": {
      fail("invalid_input", "create_workspace is handled by the store, not applyOperation.");
      break;
    }
    case "assign_task": {
      const taskId = operation.taskId?.trim() || newId("task", `${at}:${operation.title}:${operation.assignee}`);
      if (next.tasks[taskId]) fail("conflict", `Task ${taskId} already exists.`);
      const dependsOn = (operation.dependsOn ?? []).map((id) => id.trim()).filter(Boolean);
      for (const dependency of dependsOn) if (!next.tasks[dependency]) fail("not_found", `Dependency ${dependency} does not exist in this workspace.`);
      const task: CollabTask = {
        id: taskId,
        title: operation.title.slice(0, 300),
        description: operation.description.slice(0, 4_000),
        assignee: operation.assignee,
        status: "queued",
        dependsOn,
        files: (operation.files ?? []).map(normalizePath).filter(Boolean),
        attempts: 0,
        maxAttempts: Math.min(10, Math.max(1, operation.maxAttempts ?? 3)),
        createdBy: operation.actor,
        createdAt: at,
        updatedAt: at,
        patches: [],
        testRuns: [],
        lastError: null,
        notes: [],
      };
      next.tasks[taskId] = task;
      events.push(event(operation.actor, "task_assigned", taskId, { assignee: task.assignee, dependsOn, files: task.files }, at, taskId));
      result = { task };
      break;
    }
    case "update_task": {
      const task = next.tasks[operation.taskId];
      if (!task) fail("not_found", `Task ${operation.taskId} does not exist.`);
      if (operation.status && !TASK_STATUSES.includes(operation.status)) fail("invalid_input", `Unknown status "${operation.status}".`);
      if (operation.status === "in_progress" && task.status === "queued") {
        const unmet = task.dependsOn.filter((id) => next.tasks[id]?.status !== "done");
        if (unmet.length) fail("conflict", `Task ${task.id} is blocked by ${unmet.join(", ")}.`, "Complete the dependencies first; the orchestrator never silently reorders them.");
      }
      if (operation.status === "failed") task.attempts += 1;
      const before = { status: task.status, assignee: task.assignee };
      if (operation.status) task.status = operation.status;
      if (operation.assignee) task.assignee = operation.assignee;
      if (operation.lastError !== undefined) task.lastError = operation.lastError;
      if (operation.note) task.notes = [...task.notes, `${operation.actor}: ${operation.note.slice(0, 1_000)}`].slice(-20);
      task.updatedAt = at;
      events.push(event(operation.actor, "task_updated", task.id, { before, after: { status: task.status, assignee: task.assignee }, note: operation.note ?? null }, at, `${task.id}:${task.status}`));
      result = { task };
      break;
    }
    case "submit_patch": {
      const path = normalizePath(operation.path);
      if (!path || path.includes("..")) fail("invalid_input", "A patch needs a safe relative path (no `..`).");
      if (operation.content && operation.content.length > MAX_PATCH_BYTES) fail("size_limit_exceeded", `Patch content exceeds ${MAX_PATCH_BYTES} characters.`);
      if (operation.taskId && !next.tasks[operation.taskId]) fail("not_found", `Task ${operation.taskId} does not exist.`);
      const known = next.files[path];
      const patchOperation = operation.operation ?? (known ? "modify" : "create");
      if (patchOperation === "modify" && !known) fail("not_found", `File ${path} is not registered in this workspace, so a modify patch cannot be based on it.`, "Register the file first (register_file) or submit the patch as an operation: \"create\".");
      const baseHash = operation.baseHash ?? known?.sha256 ?? null;
      const patchId = newId("patch", `${at}:${operation.actor}:${path}:${operation.content?.length ?? 0}`);
      const conflict = conflictReason({ workspace: next, patchId, path, operation: patchOperation, baseHash, actor: operation.actor });
      const patch: CollabPatch = {
        id: patchId,
        taskId: operation.taskId ?? null,
        author: operation.actor,
        path,
        operation: patchOperation,
        baseHash,
        content: operation.content ?? null,
        diff: operation.diff ?? null,
        status: conflict ? "conflict" : "proposed",
        createdAt: at,
        resolvedAt: null,
        resolvedBy: null,
        review: null,
        conflict,
        protectedPath: isProtectedPath(path),
      };
      next.patches[patchId] = patch;
      if (patch.taskId && next.tasks[patch.taskId]) next.tasks[patch.taskId] = { ...next.tasks[patch.taskId]!, patches: [...next.tasks[patch.taskId]!.patches, patchId], updatedAt: at };
      events.push(event(operation.actor, conflict ? "patch_conflict_detected" : "patch_submitted", patchId, { path, operation: patchOperation, baseHash, conflict }, at, patchId));
      result = { patch };
      break;
    }
    case "resolve_patch": {
      const patch = next.patches[operation.patchId];
      if (!patch) fail("not_found", `Patch ${operation.patchId} does not exist.`);
      if (patch.status !== "proposed" && patch.status !== "conflict") fail("conflict", `Patch ${patch.id} is already ${patch.status}.`);
      if (operation.action === "reject") {
        patch.status = "rejected";
        patch.resolvedAt = at;
        patch.resolvedBy = operation.actor;
        events.push(event(operation.actor, "patch_rejected", patch.id, { path: patch.path }, at, patch.id));
        result = { patch };
        break;
      }
      if (!applyEnabled) fail("admin_required", "Patch application is disabled on this deployment (COLLAB_ALLOW_APPLY is not enabled).", "An operator can enable COLLAB_ALLOW_APPLY, or review the patches without applying them.");
      if (patch.status === "conflict" && !operation.force) fail("conflict", `Patch ${patch.id} conflicts: ${patch.conflict}`, "Re-submit on the current file hash, or re-apply with force: true after an explicit approval.");
      if (patch.protectedPath && !operation.approveProtected) {
        fail("admin_required", `Patch ${patch.id} targets the protected path ${patch.path}.`, `Protected paths (${PROTECTED_PATH_PREFIXES.join(", ")}) need approve_protected: true from an authorized reviewer.`);
      }
      if ((patch.operation === "create" || patch.operation === "modify") && patch.content === null) fail("invalid_input", `Patch ${patch.id} has no content to apply.`);
      const current = next.files[patch.path] ?? null;
      if (patch.operation !== "create" && current && patch.baseHash && current.sha256 !== patch.baseHash && !operation.force) {
        patch.status = "conflict";
        patch.conflict = `The workspace copy of ${patch.path} changed after this patch was created (base ${patch.baseHash.slice(0, 12)}, current ${current.sha256.slice(0, 12)}).`;
        events.push(event(operation.actor, "patch_conflict_detected", patch.id, { path: patch.path, conflict: patch.conflict }, at, patch.id));
        result = { patch };
        break;
      }
      if (patch.operation === "delete") {
        delete next.files[patch.path];
      } else {
        const content = patch.content ?? "";
        next.files[patch.path] = { path: patch.path, sha256: await sha256Text(content), bytes: content.length, updatedAt: at, updatedBy: patch.author };
      }
      patch.status = "applied";
      patch.resolvedAt = at;
      patch.resolvedBy = operation.actor;
      patch.conflict = operation.force && patch.conflict ? `${patch.conflict} (applied with explicit override by ${operation.actor})` : patch.conflict;
      events.push(event(operation.actor, "patch_applied", patch.id, { path: patch.path, operation: patch.operation, author: patch.author, protectedPath: patch.protectedPath }, at, patch.id));
      result = { patch, file: next.files[patch.path] ?? null };
      break;
    }
    case "review": {
      if (operation.patchId) {
        const patch = next.patches[operation.patchId];
        if (!patch) fail("not_found", `Patch ${operation.patchId} does not exist.`);
        if (patch.author === operation.actor) fail("conflict", "A patch cannot be reviewed by its own author.", "Ask another collaborator to review it — self-approval is not recorded as a review.");
        patch.review = { reviewer: operation.actor, verdict: operation.verdict, comments: operation.comments.slice(0, 2_000), at };
        events.push(event(operation.actor, "patch_reviewed", patch.id, { verdict: operation.verdict, author: patch.author }, at, `${patch.id}:${operation.verdict}`));
        result = { patch };
        break;
      }
      const task = operation.taskId ? next.tasks[operation.taskId] : null;
      if (!task) fail("not_found", "A review needs a patch_id or an existing task_id.");
      task.notes = [...task.notes, `${operation.actor} (${operation.verdict}): ${operation.comments.slice(0, 1_000)}`].slice(-20);
      task.updatedAt = at;
      if (operation.verdict === "request_changes" && task.status === "review") task.status = "in_progress";
      events.push(event(operation.actor, "task_reviewed", task.id, { verdict: operation.verdict }, at, `${task.id}:${operation.verdict}`));
      result = { task };
      break;
    }
    case "record_test": {
      if (operation.taskId && !next.tasks[operation.taskId]) fail("not_found", `Task ${operation.taskId} does not exist.`);
      if (operation.patchId && !next.patches[operation.patchId]) fail("not_found", `Patch ${operation.patchId} does not exist.`);
      const runner = operation.runner ?? "recorded";
      if (runner === "github_actions" && operation.status !== "dispatched") fail("invalid_input", "A GitHub Actions run is recorded as status \"dispatched\" until its own result is known.");
      const testId = newId("test", `${at}:${operation.command}:${operation.status}:${operation.actor}`);
      const run: CollabTestRun = {
        id: testId,
        taskId: operation.taskId ?? null,
        patchId: operation.patchId ?? null,
        command: operation.command.slice(0, 500),
        runner,
        status: operation.status,
        summary: operation.summary.slice(0, 2_000),
        outputExcerpt: operation.outputExcerpt ? operation.outputExcerpt.slice(0, 8_000) : null,
        externalUrl: operation.externalUrl ?? null,
        actor: operation.actor,
        at,
      };
      next.tests[testId] = run;
      if (run.taskId && next.tasks[run.taskId]) next.tasks[run.taskId] = { ...next.tasks[run.taskId]!, testRuns: [...next.tasks[run.taskId]!.testRuns, testId], updatedAt: at };
      events.push(event(operation.actor, "test_recorded", testId, { command: run.command, status: run.status, runner }, at, testId));
      result = { test: run, honesty: runner === "recorded" ? "Recorded by a collaborator. DEMO did not run this command." : "A GitHub Actions dispatch was requested; the run's own conclusion is not in this record." };
      break;
    }
    case "register_file": {
      const path = normalizePath(operation.path);
      if (!path || path.includes("..")) fail("invalid_input", "A file needs a safe relative path (no `..`).");
      if (operation.content.length > MAX_PATCH_BYTES) fail("size_limit_exceeded", `File exceeds ${MAX_PATCH_BYTES} characters.`);
      next.files[path] = { path, sha256: await sha256Text(operation.content), bytes: operation.content.length, updatedAt: at, updatedBy: operation.actor };
      events.push(event(operation.actor, "file_registered", path, { bytes: operation.content.length }, at, path));
      result = { file: next.files[path] };
      break;
    }
  }

  next.version += 1;
  next.updatedAt = at;
  next.events = [...next.events, ...events].slice(-MAX_EVENTS);
  return { workspace: next, events, result };
}

/**
 * Why a patch cannot be applied as-is. Checked at submission (recorded on the
 * patch) and again at apply time, so a workspace that moved in between is caught.
 */
export function conflictReason(input: {
  workspace: CollabWorkspace;
  patchId: string;
  path: string;
  operation: "create" | "modify" | "delete";
  baseHash: string | null;
  actor: CollaboratorId;
}): string | null {
  const { workspace, patchId, path, operation, baseHash, actor } = input;
  const existing = workspace.files[path] ?? null;
  if (operation === "create" && existing) {
    return `${path} already exists in this workspace (created by ${existing.updatedBy}); submitting it as a create would overwrite that work.`;
  }
  if (operation !== "create") {
    if (!existing) return `${path} is not present in the workspace copy any more.`;
    if (baseHash && existing.sha256 !== baseHash) {
      return `${path} changed after this patch was prepared (based on ${baseHash.slice(0, 12)}, current ${existing.sha256.slice(0, 12)} by ${existing.updatedBy}).`;
    }
  }
  const other = Object.values(workspace.patches).find(
    (candidate) => candidate.id !== patchId && candidate.path === path && candidate.author !== actor && (candidate.status === "proposed" || candidate.status === "applied"),
  );
  if (other && other.status === "proposed" && operation !== "create" && other.operation !== "create") {
    return `Another collaborator (${other.author}) has a pending patch on ${path} (${other.id}). Review or discard it before applying both.`;
  }
  return null;
}

/* ------------------------------------------------------------ orchestration */

export interface TaskPlan {
  ready: string[];
  blocked: Array<{ id: string; waitingOn: string[] }>;
  parallelGroups: string[][];
  running: string[];
  review: string[];
  failed: Array<{ id: string; attempts: number; maxAttempts: number; lastError: string | null; retryable: boolean }>;
}

/**
 * Dependency-aware scheduling: ready tasks have every dependency `done`, blocked
 * ones name what they wait for, and `parallelGroups` groups independent ready
 * tasks (work that touches disjoint files can run at the same time; tasks that
 * share a file are serialised).
 */
export function planTasks(workspace: CollabWorkspace): TaskPlan {
  const tasks = Object.values(workspace.tasks);
  const ready: string[] = [];
  const blocked: Array<{ id: string; waitingOn: string[] }> = [];
  const running: string[] = [];
  const review: string[] = [];
  const failed: TaskPlan["failed"] = [];
  for (const task of tasks) {
    if (task.status === "done") continue;
    if (task.status === "failed") {
      failed.push({ id: task.id, attempts: task.attempts, maxAttempts: task.maxAttempts, lastError: task.lastError, retryable: task.attempts < task.maxAttempts });
      continue;
    }
    if (task.status === "in_progress") running.push(task.id);
    if (task.status === "review") review.push(task.id);
    if (task.status !== "queued") continue;
    const waitingOn = task.dependsOn.filter((id) => workspace.tasks[id]?.status !== "done");
    if (waitingOn.length) blocked.push({ id: task.id, waitingOn });
    else ready.push(task.id);
  }
  const groups: string[][] = [];
  const claimedFiles = new Set<string>();
  for (const id of ready.sort()) {
    const task = workspace.tasks[id]!;
    const conflictsWithExisting = task.files.some((file) => claimedFiles.has(file));
    if (!conflictsWithExisting || task.files.length === 0) {
      const group = groups.length && !conflictsWithExisting ? groups[groups.length - 1]! : (groups.push([]), groups[groups.length - 1]!);
      group.push(id);
      for (const file of task.files) claimedFiles.add(file);
    } else {
      groups.push([id]);
      for (const file of task.files) claimedFiles.add(file);
    }
  }
  return { ready: ready.sort(), blocked, parallelGroups: groups, running, review, failed };
}

export interface WorkspaceSummary {
  workspaceId: string;
  project: CollabWorkspace["project"];
  counts: { tasks: number; done: number; open: number; patches: number; applied: number; conflicts: number; tests: number; passed: number };
  contributions: Array<{ collaborator: CollaboratorId; tasks: number; done: number; patches: number; applied: number; reviews: number; tests: number }>;
  filesChanged: string[];
  tests: Array<{ id: string; command: string; status: string; runner: string; actor: string; at: string }>;
  remainingIssues: string[];
  historyTail: CollabEvent[];
}

/** Who did what — the report Part 5 asks for, derived from state, never from claims. */
export function summarizeWorkspace(workspace: CollabWorkspace): WorkspaceSummary {
  const contributions = new Map<string, { collaborator: string; tasks: number; done: number; patches: number; applied: number; reviews: number; tests: number }>();
  const bucket = (actor: string) => {
    let entry = contributions.get(actor);
    if (!entry) {
      entry = { collaborator: actor, tasks: 0, done: 0, patches: 0, applied: 0, reviews: 0, tests: 0 };
      contributions.set(actor, entry);
    }
    return entry;
  };
  for (const task of Object.values(workspace.tasks)) {
    const entry = bucket(task.assignee);
    entry.tasks += 1;
    if (task.status === "done") entry.done += 1;
  }
  for (const patch of Object.values(workspace.patches)) {
    const entry = bucket(patch.author);
    entry.patches += 1;
    if (patch.status === "applied") entry.applied += 1;
    if (patch.review) bucket(patch.review.reviewer).reviews += 1;
  }
  for (const test of Object.values(workspace.tests)) bucket(test.actor).tests += 1;

  const patches = Object.values(workspace.patches);
  const tests = Object.values(workspace.tests).sort((a, b) => b.at.localeCompare(a.at));
  const remainingIssues: string[] = [];
  for (const task of Object.values(workspace.tasks)) {
    if (task.status === "failed") remainingIssues.push(`Task ${task.id} "${task.title}" failed after ${task.attempts}/${task.maxAttempts} attempt(s): ${task.lastError ?? "no error recorded"}`);
    if (task.status === "blocked") remainingIssues.push(`Task ${task.id} is blocked.`);
  }
  for (const patch of patches) {
    if (patch.status === "conflict") remainingIssues.push(`Patch ${patch.id} on ${patch.path} conflicts: ${patch.conflict}`);
    if (patch.status === "proposed" && !patch.review) remainingIssues.push(`Patch ${patch.id} on ${patch.path} has no review yet.`);
  }
  if (patches.some((patch) => patch.status === "applied") && tests.filter((test) => test.status === "passed").length === 0) {
    remainingIssues.push("Patches were applied but no passing test result has been recorded (DEMO does not execute code).");
  }
  return {
    workspaceId: workspace.id,
    project: workspace.project,
    counts: {
      tasks: Object.keys(workspace.tasks).length,
      done: Object.values(workspace.tasks).filter((task) => task.status === "done").length,
      open: Object.values(workspace.tasks).filter((task) => task.status !== "done" && task.status !== "failed").length,
      patches: patches.length,
      applied: patches.filter((patch) => patch.status === "applied").length,
      conflicts: patches.filter((patch) => patch.status === "conflict").length,
      tests: tests.length,
      passed: tests.filter((test) => test.status === "passed").length,
    },
    contributions: [...contributions.values()].sort((a, b) => b.patches + b.tasks - (a.patches + a.tasks)),
    filesChanged: Object.values(workspace.files).map((file) => file.path).sort(),
    tests: tests.slice(0, 20).map((test) => ({ id: test.id, command: test.command, status: test.status, runner: test.runner, actor: test.actor, at: test.at })),
    remainingIssues,
    historyTail: workspace.events.slice(-20),
  };
}

/** Create the initial workspace record (the store calls this, not applyOperation). */
export async function createWorkspace(input: { id: string; actor: CollaboratorId; title: string; repo: string; ref: string; subdir?: string | null; byoxGoal?: string | null; now: number }): Promise<{ workspace: CollabWorkspace; events: CollabEvent[] }> {
  const at = new Date(input.now).toISOString();
  const workspace: CollabWorkspace = {
    id: input.id,
    version: 1,
    title: input.title.slice(0, 200),
    project: { repo: input.repo.slice(0, 300), ref: input.ref.slice(0, 120), subdir: input.subdir ? normalizePath(input.subdir) : null, byoxGoal: input.byoxGoal ? input.byoxGoal.slice(0, 200) : null },
    createdBy: input.actor,
    createdAt: at,
    updatedAt: at,
    files: {},
    tasks: {},
    patches: {},
    tests: {},
    events: [],
  };
  const created = event(input.actor, "workspace_created", workspace.id, { repo: workspace.project.repo, ref: workspace.project.ref }, at, workspace.id);
  workspace.events = [created];
  return { workspace, events: [created] };
}
