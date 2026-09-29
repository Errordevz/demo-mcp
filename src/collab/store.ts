/**
 * Shared-workspace persistence.
 *
 * Storage lives in the **existing** `DEMO_ACCOUNTS` Durable Object (`DemoAccounts`),
 * which already owns the deployment's strongly-consistent KV area. Reusing it
 * means the collaboration feature needs no new binding and no new Durable Object
 * migration — a deploy of this change cannot disturb the account objects.
 *
 * `src/collab/model.ts` owns the policy; this module owns storage layout, the
 * bounded workspace index, and the client that talks to the object. The object's
 * RPC methods (see `DemoAccounts`) are thin: they serialise with the same
 * `blockConcurrencyWhile` mutex the account operations use, so a read-modify-write
 * of a workspace can never interleave with another request.
 */

import { decodeRpcError, encodeForRpc } from "../core/errors.js";
import { applyOperation, createWorkspace, newId, summarizeWorkspace, type ApplyContext, type CollabOperation, type CollabWorkspace, type OperationResult, type WorkspaceSummary } from "./model.js";

/** The narrow storage surface the helpers need (Durable Object storage). */
export interface CollabStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** All collab keys are namespaced so the account object's own keys never collide. */
const PREFIX = "collab:";
const INDEX_KEY = `${PREFIX}index`;
const WORKSPACE_KEY = (id: string) => `${PREFIX}ws:${id}`;

/** How many workspaces one deployment keeps; the oldest are evicted by index size. */
export const MAX_WORKSPACES = 50;

export interface WorkspaceIndexEntry {
  id: string;
  title: string;
  repo: string;
  ref: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tasks: number;
  patches: number;
  tests: number;
}

export interface OpenWorkspaceInput {
  actor: string;
  title: string;
  repo: string;
  ref: string;
  subdir?: string | null;
  byoxGoal?: string | null;
}

interface WorkspaceIndex {
  counter: number;
  entries: WorkspaceIndexEntry[];
}

function indexEntry(workspace: CollabWorkspace): WorkspaceIndexEntry {
  return {
    id: workspace.id,
    title: workspace.title,
    repo: workspace.project.repo,
    ref: workspace.project.ref,
    createdBy: workspace.createdBy,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    tasks: Object.keys(workspace.tasks).length,
    patches: Object.keys(workspace.patches).length,
    tests: Object.keys(workspace.tests).length,
  };
}

async function readIndex(storage: CollabStorageLike): Promise<WorkspaceIndex> {
  const value = await storage.get<WorkspaceIndex>(INDEX_KEY);
  if (!value || !Array.isArray(value.entries) || typeof value.counter !== "number") return { counter: 0, entries: [] };
  return value;
}

/**
 * Persist a workspace and its index entry, evicting the oldest workspaces when
 * the deployment exceeds `MAX_WORKSPACES`. Eviction is best-effort and never
 * fails the write.
 */
async function writeWorkspace(storage: CollabStorageLike, workspace: CollabWorkspace, index: WorkspaceIndex): Promise<WorkspaceIndex> {
  const entries = index.entries.filter((candidate) => candidate.id !== workspace.id);
  entries.push(indexEntry(workspace));
  const sorted = [...entries].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const evicted = sorted.slice(0, Math.max(0, sorted.length - MAX_WORKSPACES));
  const kept = sorted.slice(evicted.length);
  await storage.put(WORKSPACE_KEY(workspace.id), workspace);
  await storage.put(INDEX_KEY, { counter: index.counter, entries: kept } satisfies WorkspaceIndex);
  for (const entry of evicted) {
    await storage.delete(WORKSPACE_KEY(entry.id)).catch(() => undefined);
  }
  return { counter: index.counter, entries: kept };
}

/* ------------------------------------------------------------------ helpers */
/* These run inside the Durable Object: single-threaded, and serialised by the  */
/* object's mutex for read-modify-write operations.                             */

export async function collabOpen(storage: CollabStorageLike, input: OpenWorkspaceInput, now = Date.now()): Promise<{ summary: WorkspaceSummary; index: WorkspaceIndexEntry[] }> {
  const index = await readIndex(storage);
  const counter = index.counter + 1;
  const id = newId("ws", `${now}:${counter}:${input.repo}:${input.actor}`);
  const { workspace } = await createWorkspace({ id, actor: input.actor, title: input.title, repo: input.repo, ref: input.ref, subdir: input.subdir ?? null, byoxGoal: input.byoxGoal ?? null, now });
  const next = await writeWorkspace(storage, workspace, { counter, entries: index.entries });
  return { summary: summarizeWorkspace(workspace), index: next.entries };
}

export async function collabList(storage: CollabStorageLike): Promise<{ workspaces: WorkspaceIndexEntry[]; total: number }> {
  const index = await readIndex(storage);
  return { workspaces: [...index.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), total: index.entries.length };
}

export async function collabGet(storage: CollabStorageLike, id: string): Promise<CollabWorkspace | null> {
  if (!/^ws_[A-Za-z0-9_-]{4,80}$/.test(id)) return null;
  return (await storage.get<CollabWorkspace>(WORKSPACE_KEY(id))) ?? null;
}

export async function collabSummary(storage: CollabStorageLike, id: string): Promise<WorkspaceSummary | null> {
  const workspace = await collabGet(storage, id);
  return workspace ? summarizeWorkspace(workspace) : null;
}

export async function collabApply(storage: CollabStorageLike, id: string, operation: CollabOperation, context: ApplyContext = {}): Promise<OperationResult> {
  const workspace = await collabGet(storage, id);
  if (!workspace) throw Object.assign(new Error(`Workspace ${id} does not exist.`), { code: "not_found" });
  const index = await readIndex(storage);
  const result = await applyOperation(workspace, operation, context);
  await writeWorkspace(storage, result.workspace, index);
  return result;
}

/* ------------------------------------------------------------------- client */

/** RPC surface `DemoAccounts` exposes for the workspace. */
export interface CollabRpc {
  collabOpen(input: OpenWorkspaceInput, now?: number): Promise<{ summary: WorkspaceSummary; index: WorkspaceIndexEntry[] }>;
  collabList(): Promise<{ workspaces: WorkspaceIndexEntry[]; total: number }>;
  collabGet(id: string): Promise<CollabWorkspace | null>;
  collabSummary(id: string): Promise<WorkspaceSummary | null>;
  collabApply(id: string, operation: CollabOperation, context?: ApplyContext): Promise<OperationResult>;
}

export interface CollabStore extends CollabRpc {
  kind: "durable-object";
}

interface CollabNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

/**
 * Resolve the shared workspace through the bound `DEMO_ACCOUNTS` object. The
 * object name must match `ACCOUNTS_DO_NAME`; an id that does not exist is
 * created by Cloudflare on first use, exactly like the account object.
 */
export function resolveCollabStore(env: Record<string, unknown>): CollabStore | null {
  const namespace = env.DEMO_ACCOUNTS as CollabNamespaceLike | undefined;
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return null;
  let stub: CollabRpc;
  try {
    stub = namespace.get(namespace.idFromName("demo-accounts")) as CollabRpc;
  } catch {
    return null;
  }
  const call = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw decodeRpcError(error);
    }
  };
  return {
    kind: "durable-object",
    collabOpen: (input, now) => call(() => stub.collabOpen(input, now)),
    collabList: () => call(() => stub.collabList()),
    collabGet: (id) => call(() => stub.collabGet(id)),
    collabSummary: (id) => call(() => stub.collabSummary(id)),
    collabApply: (id, operation, context) => call(() => stub.collabApply(id, operation, context ?? {})),
  };
}

/** Wrap a storage error so a failure inside the object keeps its code. */
export function collabRpcError(error: unknown): Error {
  return encodeForRpc(error);
}
