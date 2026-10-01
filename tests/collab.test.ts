/**
 * Shared coding workspace: policy (`src/collab/model.ts`), storage layout
 * (`src/collab/store.ts`), the HTTP surface (`src/collab/routes.ts`) and the
 * `DemoAccounts` RPC wiring.
 *
 * The point of these tests is the honesty contract as much as the mechanics:
 * DEMO must never report that a collaborator executed code, must refuse
 * self-review, must detect conflicting patches, and must keep a protected path
 * behind an explicit approval.
 */
import { describe, expect, it } from "vitest";
import {
  applyOperation,
  collaboratorCapabilities,
  createWorkspace,
  isProtectedPath,
  planTasks,
  summarizeWorkspace,
  type CollabOperation,
  type CollabWorkspace,
} from "../src/collab/model.js";
import { collabApply, collabGet, collabList, collabOpen, collabSummary, DemoAccounts, resolveCollabStore, type CollabStorageLike } from "../src/collab/store.js";
import { handleCollabRoute } from "../src/collab/routes.js";
import { InMemoryMcpAuthStore } from "../src/auth/oauth-store.js";
import { sha256Hex } from "../src/auth/crypto.js";
import { decodeRpcError } from "../src/core/errors.js";

const ORIGIN = "https://demo.test";
const SUBJECT = "c".repeat(64);
const NOW = 1_790_000_000_000;

/* ------------------------------------------------------------------ helpers */

function memoryStorage(): CollabStorageLike & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    get: async <T,>(key: string) => map.get(key) as T | undefined,
    put: async <T,>(key: string, value: T) => void map.set(key, value),
    delete: async (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  };
}

function namespaceWith(storage: CollabStorageLike) {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      collabOpen: (input: never, now?: number) => collabOpen(storage, input, now),
      collabList: () => collabList(storage),
      collabGet: (id: string) => collabGet(storage, id),
      collabSummary: (id: string) => collabSummary(storage, id),
      collabApply: (id: string, operation: CollabOperation, context?: { applyEnabled?: boolean }) => collabApply(storage, id, operation, context ?? {}),
    }),
  };
}

function env(storage: CollabStorageLike, extra: Record<string, unknown> = {}) {
  return {
    DEMO_ACCOUNTS: namespaceWith(storage),
    COLLAB_ALLOW_APPLY: "true",
    SSRF_DNS_CHECK: "false",
    ...extra,
  } as unknown as Record<string, unknown>;
}

async function opened(actor = "chatgpt"): Promise<{ storage: CollabStorageLike & { keys(): string[] }; workspace: CollabWorkspace }> {
  const storage = memoryStorage();
  const { summary } = await collabOpen(storage, { actor, title: "Fix the audit findings", repo: "https://github.com/Errordevz/demo-mcp", ref: "main" }, NOW);
  const workspace = await collabGet(storage, summary.workspaceId);
  if (!workspace) throw new Error("workspace was not stored");
  return { storage, workspace };
}

/* ------------------------------------------------------------ capability matrix */

describe("collaborator capability matrix", () => {
  it("never claims execution, and only claims GitHub writes when a token exists", () => {
    const withoutToken = collaboratorCapabilities({ jevConfigured: false, layaConfigured: false, githubTokenConfigured: false, applyEnabled: true });
    expect(withoutToken.map((person) => person.id)).toEqual(["chatgpt", "jev", "laya"]);
    for (const person of withoutToken) {
      expect(person.execution, person.id).toBe("none");
      expect(person.capabilities.execute_code, person.id).toBe(false);
      expect(person.capabilities.write_to_github, person.id).toBe(false);
      expect(person.limitations.length, person.id).toBeGreaterThan(0);
    }
    // Jev/Laya are decision channels, not text-suggestion-only: they can submit
    // patches and reviews that DEMO performs and attributes.
    const jev = withoutToken.find((person) => person.id === "jev")!;
    expect(jev.status).toBe("unavailable");
    expect(jev.capabilities.typed_decisions).toBe(false);
    expect(jev.channel).toContain("TYPESAFE_API_KEY");

    const configured = collaboratorCapabilities({ jevConfigured: true, layaConfigured: true, githubTokenConfigured: true, applyEnabled: false });
    expect(configured.find((person) => person.id === "jev")?.status).toBe("available");
    expect(configured.find((person) => person.id === "laya")?.status).toBe("available");
    expect(configured[0]!.capabilities.write_to_github).toBe(true);
    expect(configured[0]!.capabilities.apply_patch).toBe(false);
  });
});

/* --------------------------------------------------------------- workspace ops */

describe("workspace operations", () => {
  it("creates a workspace with attribution and a summary", async () => {
    const { workspace } = await opened();
    expect(workspace.id).toMatch(/^ws_/);
    expect(workspace.createdBy).toBe("chatgpt");
    expect(workspace.version).toBe(1);
    const summary = summarizeWorkspace(workspace);
    expect(summary.project).toMatchObject({ repo: "https://github.com/Errordevz/demo-mcp", ref: "main" });
    expect(summary.counts).toMatchObject({ tasks: 0, patches: 0, tests: 0 });
  });

  it("refuses a task whose dependency does not exist and reports the plan honestly", async () => {
    const { storage, workspace } = await opened();
    await expect(
      collabApply(storage, workspace.id, { op: "assign_task", actor: "chatgpt", title: "Second", description: "needs the first", assignee: "jev", dependsOn: ["task_missing"] }, {}),
    ).rejects.toThrow(/does not exist/);

    const first = await collabApply(storage, workspace.id, { op: "assign_task", actor: "chatgpt", title: "Design", description: "Write the plan", assignee: "jev" }, {});
    const firstId = (first.result as { task: { id: string } }).task.id;
    const second = await collabApply(storage, workspace.id, { op: "assign_task", actor: "chatgpt", title: "Implement", description: "Apply the plan", assignee: "laya", dependsOn: [firstId] }, {});
    const secondId = (second.result as { task: { id: string } }).task.id;

    const plan = planTasks(second.workspace);
    expect(plan.ready).toEqual([firstId]);
    expect(plan.blocked.map((task) => task.id)).toEqual([secondId]);
    expect(plan.blocked[0]!.waitingOn).toEqual([firstId]);

    // Moving the dependent task to in_progress while its dependency is open is
    // refused: DEMO does not silently reorder work.
    await expect(collabApply(storage, workspace.id, { op: "update_task", actor: "laya", taskId: secondId, status: "in_progress" }, {})).rejects.toThrow(/dependenc|blocked/i);

    await collabApply(storage, workspace.id, { op: "update_task", actor: "jev", taskId: firstId, status: "done" }, {});
    const moved = await collabApply(storage, workspace.id, { op: "update_task", actor: "laya", taskId: secondId, status: "in_progress" }, {});
    expect(planTasks(moved.workspace).running).toEqual([secondId]);
  });

  it("detects a conflicting patch, refuses self-review, and honours the apply switch", async () => {
    const { storage, workspace } = await opened();
    // Register the file the first patch creates.
    const created = await collabApply(storage, workspace.id, { op: "submit_patch", actor: "chatgpt", path: "src/byox/catalog.ts", operation: "create", content: "export const x = 1;\n" }, {});
    const firstPatch = (created.result as { patch: { id: string } }).patch.id;
    // The file becomes part of the workspace only when the patch is applied,
    // which is what a later modify patch has to be based on.
    const applied = await collabApply(storage, workspace.id, { op: "resolve_patch", actor: "laya", patchId: firstPatch, action: "apply" }, {});
    expect((applied.result as { patch: { status: string } }).patch.status).toBe("applied");
    expect(applied.workspace.files["src/byox/catalog.ts"]?.sha256).toMatch(/^[a-f0-9]{64}$/);

    // A second patch from a different author based on a *different* hash of the
    // same file is a conflict, recorded at submit time.
    const conflicting = await collabApply(
      storage,
      workspace.id,
      { op: "submit_patch", actor: "jev", path: "src/byox/catalog.ts", operation: "modify", content: "export const x = 2;\n", baseHash: "f".repeat(64) },
      {},
    );
    const conflictPatch = conflicting.result as { patch: { id: string; status: string; conflict: string | null } };
    expect(conflictPatch.patch.status).toBe("conflict");
    expect(conflictPatch.patch.conflict).toBeTruthy();

    // Applying the conflicting patch needs an explicit force.
    await expect(collabApply(storage, workspace.id, { op: "resolve_patch", actor: "chatgpt", patchId: conflictPatch.patch.id, action: "apply" }, {})).rejects.toThrow(/conflict/i);
    const forced = await collabApply(storage, workspace.id, { op: "resolve_patch", actor: "chatgpt", patchId: conflictPatch.patch.id, action: "apply", force: true }, {});
    expect((forced.result as { patch: { status: string } }).patch.status).toBe("applied");

    // A patch cannot be approved by its own declared author.
    await expect(collabApply(storage, workspace.id, { op: "review", actor: "jev", patchId: conflictPatch.patch.id, verdict: "approve", comments: "looks good" }, {})).rejects.toThrow(/own|self/i);

    // The deployment switch stops application, never submission.
    const gated = await collabApply(storage, workspace.id, { op: "submit_patch", actor: "laya", path: "docs/notes.md", operation: "create", content: "notes\n" }, {});
    const gatedPatch = (gated.result as { patch: { id: string } }).patch.id;
    await expect(collabApply(storage, workspace.id, { op: "resolve_patch", actor: "chatgpt", patchId: gatedPatch, action: "apply" }, { applyEnabled: false })).rejects.toThrow(/disabled|COLLAB_ALLOW_APPLY/i);
    expect(firstPatch).not.toBe(gatedPatch);
  });

  it("keeps protected paths behind an explicit approval", async () => {
    expect(isProtectedPath(".github/workflows/live-deploy.yml")).toBe(true);
    expect(isProtectedPath("src/core/admin.ts")).toBe(true);
    expect(isProtectedPath("src/byox/catalog.ts")).toBe(false);
    const { storage, workspace } = await opened();
    const submitted = await collabApply(storage, workspace.id, { op: "submit_patch", actor: "chatgpt", path: ".github/workflows/live-deploy.yml", operation: "create", content: "name: x\n" }, {});
    const patch = (submitted.result as { patch: { id: string; protectedPath: boolean } }).patch;
    expect(patch.protectedPath).toBe(true);
    await expect(collabApply(storage, workspace.id, { op: "resolve_patch", actor: "chatgpt", patchId: patch.id, action: "apply" }, {})).rejects.toThrow(/protected/i);
    const approved = await collabApply(storage, workspace.id, { op: "resolve_patch", actor: "chatgpt", patchId: patch.id, action: "apply", approveProtected: true }, {});
    expect((approved.result as { patch: { status: string } }).patch.status).toBe("applied");
  });

  it("records test runs without pretending DEMO ran them", async () => {
    const { storage, workspace } = await opened();
    const recorded = await collabApply(storage, workspace.id, { op: "record_test", actor: "chatgpt", command: "npx vitest run", status: "passed", runner: "recorded", summary: "18 files passed" }, {});
    expect((recorded.result as { honesty: string }).honesty).toContain("DEMO did not run this command");
    const dispatched = await collabApply(storage, workspace.id, { op: "record_test", actor: "chatgpt", command: "dispatch owner/repo/live-deploy.yml@main", status: "dispatched", runner: "github_actions", summary: "workflow dispatched" }, {});
    expect((dispatched.result as { honesty: string }).honesty).toContain("conclusion is not in this record");
    expect(recorded.workspace.tests).not.toEqual(dispatched.workspace.tests);
  });

  it("rejects an operation whose shape is impossible", async () => {
    const { storage, workspace } = await opened();
    await expect(collabApply(storage, workspace.id, { op: "submit_patch", actor: "chatgpt", path: "../escape.ts", operation: "create", content: "x" }, {})).rejects.toThrow(/safe relative path/i);
    await expect(collabApply(storage, workspace.id, { op: "submit_patch", actor: "chatgpt", path: "src/known.ts", operation: "modify", content: "x" }, {})).rejects.toThrow(/not registered/i);
    await expect(applyOperation(workspace, { op: "create_workspace", actor: "chatgpt", title: "x", repo: "r", ref: "main" } as CollabOperation)).rejects.toThrow(/handled by the store/i);
  });
});

/* ------------------------------------------------------------------- storage */

describe("workspace storage", () => {
  it("lists workspaces newest first, evicts beyond the bound, and survives a missing id", async () => {
    const storage = memoryStorage();
    const first = await collabOpen(storage, { actor: "chatgpt", title: "A", repo: "https://example.test/a", ref: "main" }, NOW);
    const second = await collabOpen(storage, { actor: "jev", title: "B", repo: "https://example.test/b", ref: "main" }, NOW + 1_000);
    const listing = await collabList(storage);
    expect(listing.total).toBe(2);
    expect(listing.workspaces[0]!.id).toBe(second.summary.workspaceId);
    expect(await collabGet(storage, "ws_not-a-real-workspace-name")).toBeNull();
    expect(await collabSummary(storage, first.summary.workspaceId)).toMatchObject({ project: { repo: "https://example.test/a" } });
    await expect(collabApply(storage, "ws_missing0000", { op: "assign_task", actor: "chatgpt", title: "t", description: "d", assignee: "jev" }, {})).rejects.toThrow(/does not exist/);
  });

  it("exposes the same surface through the DEMO_ACCOUNTS object client and keeps error codes across the RPC hop", async () => {
    const storage = memoryStorage();
    const store = resolveCollabStore(env(storage));
    expect(store?.kind).toBe("durable-object");
    const opened = await store!.collabOpen({ actor: "chatgpt", title: "Through the client", repo: "https://example.test/c", ref: "main" });
    const id = opened.summary.workspaceId;
    expect((await store!.collabList()).total).toBe(1);
    expect((await store!.collabGet(id))?.id).toBe(id);
    expect(await store!.collabSummary("ws_missing0000")).toBeNull();
    await expect(store!.collabApply("ws_missing0000", { op: "assign_task", actor: "chatgpt", title: "t", description: "d", assignee: "jev" })).rejects.toMatchObject({ code: "not_found" });
    expect(resolveCollabStore({})).toBeNull();
  });

  it("wires the workspace into the existing DemoAccounts Durable Object without a new binding", async () => {
    const storage = memoryStorage();
    // The DO class methods are the RPC surface the client calls; exercise them
    // against a hand-built `this` so the wiring is covered without workerd.
    // A real prototype: the object's storage accessors live on the class, so a
    // plain object literal would not inherit them.
    const fake = Object.create(DemoAccounts.prototype) as {
      ctx: { storage: { get: unknown; put: unknown; delete: unknown }; blockConcurrencyWhile: (fn: () => Promise<void>) => Promise<void> };
      serial: (fn: () => Promise<void>) => Promise<void>;
    };
    fake.ctx = { storage: { get: storage.get, put: storage.put, delete: storage.delete }, blockConcurrencyWhile: async (fn) => fn() };
    fake.serial = async (fn) => fn();
    expect(typeof DemoAccounts.prototype.collabApply).toBe("function");
    const opened = await DemoAccounts.prototype.collabOpen.call(fake, { actor: "chatgpt", title: "DO", repo: "https://example.test/do", ref: "main" }, NOW);
    const id = opened.summary.workspaceId;
    const applied = await DemoAccounts.prototype.collabApply.call(fake, id, { op: "assign_task", actor: "jev", title: "Task", description: "Do the thing", assignee: "jev" }, {});
    expect((applied.result as { task: { assignee: string } }).task.assignee).toBe("jev");
    expect((await DemoAccounts.prototype.collabList.call(fake)).total).toBe(1);
    // Keys are namespaced, so the account object's own data cannot collide.
    expect(storage.keys().length).toBeGreaterThan(0);
    expect(storage.keys().every((key) => key.startsWith("collab:"))).toBe(true);
  });

  it("decodes an encoded RPC error instead of losing the code", () => {
    const decoded = decodeRpcError(new Error("DEMO_BROWSER_ERROR:{\"code\":\"conflict\",\"message\":\"nope\",\"retryable\":false}"));
    expect((decoded as { code?: string }).code).toBe("conflict");
    const plain = new Error("something else");
    expect(decodeRpcError(plain)).toBe(plain);
  });
});

/* --------------------------------------------------------------------- routes */

describe("collab HTTP routes", () => {
  async function configured(storage: CollabStorageLike, options: { token?: string; scopes?: string[] } = {}) {
    const authStore = new InMemoryMcpAuthStore();
    // The bearer parser only accepts 32-128 base64url characters.
    const token = options.token ?? "collab-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await authStore.putAccessToken(await sha256Hex(token), {
      version: 1,
      clientIdHash: await sha256Hex("https://chatgpt.com/oauth/client.json"),
      principalHash: SUBJECT,
      scopes: options.scopes ?? ["collab:write"],
      audience: ORIGIN,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    return {
      env: env(storage, {
        MCP_PUBLIC_ORIGIN: ORIGIN,
        MCP_AUTH_ACCESS_TEAM_DOMAIN: "demo.cloudflareaccess.com",
        MCP_AUTH_ACCESS_AUD: "test-access-audience",
        MCP_AUTH: { idFromName: (name: string) => name, get: () => authStore },
        DEMO_API_KEY: "a-very-long-admin-key-value",
      }),
      authorization: `Bearer ${token}`,
    };
  }

  it("publishes a public summary that states the collaboration policy", async () => {
    const storage = memoryStorage();
    const response = await handleCollabRoute(new Request("https://demo.test/collab"), { DEMO_ACCOUNTS: namespaceWith(storage) });
    const body = (await response!.json()) as { ok: boolean; collaborators: unknown[]; policy: { execution: string } };
    expect(response!.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.collaborators).toHaveLength(3);
    expect(body.policy.execution).toContain("executes no code");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("lists workspaces publicly but hides patch bodies and file hashes without a grant", async () => {
    const storage = memoryStorage();
    const { summary } = await collabOpen(storage, { actor: "chatgpt", title: "Private work", repo: "https://example.test/p", ref: "main" }, NOW);
    const publicEnv = env(storage);
    const list = await handleCollabRoute(new Request("https://demo.test/collab/workspaces"), publicEnv);
    expect(((await list!.json()) as { total: number }).total).toBe(1);

    const detail = await handleCollabRoute(new Request(`https://demo.test/collab/workspaces/${summary.workspaceId}`), publicEnv);
    const publicDetail = (await detail!.json()) as { workspace?: unknown; summary?: { workspaceId: string }; detail: string };
    expect(publicDetail.workspace).toBeUndefined();
    expect(publicDetail.summary?.workspaceId).toBe(summary.workspaceId);
    expect(publicDetail.detail).toContain("collab:write");

    const authorized = await configured(storage);
    const withGrant = await handleCollabRoute(new Request(`https://demo.test/collab/workspaces/${summary.workspaceId}`, { headers: { authorization: authorized.authorization } }), authorized.env);
    expect(((await withGrant!.json()) as { workspace?: { id: string } }).workspace?.id).toBe(summary.workspaceId);
  });

  it("requires a collab:write grant for writes and rejects the wrong scope", async () => {
    const storage = memoryStorage();
    const anonymous = await handleCollabRoute(new Request("https://demo.test/collab/workspaces", { method: "POST", body: JSON.stringify({ repo: "https://example.test/x" }) }), env(storage));
    expect(anonymous!.status).toBe(401);

    const wrongScope = await configured(storage, { scopes: ["roblox:read"] });
    const denied = await handleCollabRoute(new Request("https://demo.test/collab/workspaces", { method: "POST", headers: { authorization: wrongScope.authorization }, body: JSON.stringify({ repo: "https://example.test/x" }) }), wrongScope.env);
    expect(denied!.status).toBe(401);

    const good = await configured(storage);
    const created = await handleCollabRoute(
      new Request("https://demo.test/collab/workspaces", { method: "POST", headers: { authorization: good.authorization, "content-type": "application/json" }, body: JSON.stringify({ repo: "https://example.test/x", title: "From HTTP" }) }),
      good.env,
    );
    const body = (await created!.json()) as { ok: boolean; workspace: { workspaceId: string; project: { repo: string } }; principal: string };
    expect(created!.status).toBe(201);
    expect(body.workspace.workspaceId).toMatch(/^ws_/);
    expect(body.workspace.project.repo).toBe("https://example.test/x");
    // The response carries the derived principal hash prefix, never the token.
    expect(body.principal).toHaveLength(16);
    expect(JSON.stringify(body)).not.toContain(good.authorization);
  });

  it("validates the repo URL, the operation shape and the protected-path approval", async () => {
    const storage = memoryStorage();
    const good = await configured(storage);
    const badRepo = await handleCollabRoute(new Request("https://demo.test/collab/workspaces", { method: "POST", headers: { authorization: good.authorization }, body: JSON.stringify({ repo: "git@github.com:x/y.git" }) }), good.env);
    expect(badRepo!.status).toBe(400);

    const opened = await handleCollabRoute(new Request("https://demo.test/collab/workspaces", { method: "POST", headers: { authorization: good.authorization }, body: JSON.stringify({ repo: "https://example.test/y" }) }), good.env);
    const id = ((await opened!.json()) as { workspace: { workspaceId: string } }).workspace.workspaceId;

    const protectedPatch = await handleCollabRoute(
      new Request(`https://demo.test/collab/workspaces/${id}/operations`, {
        method: "POST",
        headers: { authorization: good.authorization },
        body: JSON.stringify({ operation: { op: "submit_patch", actor: "chatgpt", path: "wrangler.jsonc", operation: "modify", content: "{}" } }),
      }),
      good.env,
    );
    expect(protectedPatch!.status).toBe(403);

    const createWorkspacePatch = await handleCollabRoute(
      new Request(`https://demo.test/collab/workspaces/${id}/operations`, {
        method: "POST",
        headers: { authorization: good.authorization },
        body: JSON.stringify({ operation: { op: "create_workspace", actor: "chatgpt", title: "x", repo: "https://example.test/z", ref: "main" } }),
      }),
      good.env,
    );
    expect(createWorkspacePatch!.status).toBe(400);

    const task = await handleCollabRoute(
      new Request(`https://demo.test/collab/workspaces/${id}/operations`, {
        method: "POST",
        headers: { authorization: good.authorization },
        body: JSON.stringify({ operation: { op: "assign_task", actor: "chatgpt", title: "Task", description: "Do it", assignee: "laya" } }),
      }),
      good.env,
    );
    const taskBody = (await task!.json()) as { ok: boolean; plan: { ready: unknown[] } };
    expect(task!.status).toBe(200);
    expect(taskBody.ok).toBe(true);
    expect(taskBody.plan.ready).toHaveLength(1);
  });

  it("returns null for paths it does not own", async () => {
    expect(await handleCollabRoute(new Request("https://demo.test/other"), {})).toBeNull();
  });
});
