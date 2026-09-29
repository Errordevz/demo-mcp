# Build Your Own X catalog and the shared collaboration workspace

Two features that let DEMO work on *real repository work* with other agents
without ever pretending to be able to do more than it can.

* **Build Your Own X (`byox_*`)** — DEMO indexes the public
  [`codecrafters-io/build-your-own-x`](https://github.com/codecrafters-io/build-your-own-x)
  README into an R2-backed reference catalog (title, languages, category,
  original URL). It stores *references*, never tutorial content.
* **Shared workspace (`collab_*`)** — a durable workspace where ChatGPT, Jev and
  Laya can plan tasks, submit patches, review each other, record test runs and
  delegate typed decisions. DEMO applies nothing to GitHub and executes no code.

## What DEMO does and does not do

| Capability | Reality |
| --- | --- |
| Index the catalog | Yes, incrementally (ETag → SHA-256), stored in R2 under `byox/`. |
| Serve catalog metadata | Yes — public MCP tools and public HTTP routes. |
| Read one tutorial page | On request only, bounded, SSRF-guarded, single page, no caching of content. It honours the source: a 403/401/paywall/CAPTCHA is reported as such. |
| Execute tutorial code | **Never.** No sandbox exists. |
| Store patches | Yes — attributed to a collaborator, conflict-checked, applied to DEMO's workspace copy only. |
| Push branches / open PRs | Only when a `GITHUB_ACTIONS_TOKEN` is configured, and only through GitHub's own API. |
| Run tests | Never by itself. A recorded result is a collaborator's report; a dispatched workflow records that a run was *requested*, not that it passed. |
| Jev / Laya | Typed decision providers (their real APIs). They can request patches and reviews; DEMO performs and attributes them. They cannot execute code and DEMO never claims they did. |

## Storage (no new binding, no migration)

Both features reuse existing infrastructure:

* the catalog index lives in the **`SCREENSHOTS` R2 bucket** under the `byox/`
  prefix (`index.json`, `state.json`, `source.md`);
* the workspace lives in the **existing `DEMO_ACCOUNTS` Durable Object**
  (`DemoAccounts`) under `collab:` keys. The object is already bound and already
  migrated, so collaborating needs no new Durable Object and no schema change.

## MCP tools

| Tool | Access | Notes |
| --- | --- | --- |
| `byox_search`, `byox_get_tutorial`, `byox_categories`, `byox_learning_plan` | public | Metadata only. |
| `byox_read_tutorial` | public | One page, bounded excerpt, original link always returned. |
| `byox_refresh_index` | administrator | Administrator key or the `collab:admin` scope. The key is **never** a tool argument. |
| `collab_collaborators` | public | The capability matrix and the limitations. |
| `collab_workspace`, `collab_task`, `collab_patch`, `collab_review`, `collab_tests`, `collab_history` | `collab:write` | Workspace content is project code. |
| `collab_delegate` | `collab:write` + `decision:use` | Spends a paid provider call. |

Resources: `demo://capabilities/byox`, `demo://capabilities/collab`.

## HTTP routes

```
GET  /capabilities/byox                  catalog report (freshness, counts, policy)
GET  /capabilities/collab                collaboration report (matrix, policy)
POST /byox/refresh                       administrator only (x-demo-admin-key)
GET  /byox, /byox/search, /byox/categories, /byox/tutorial/:id, /byox/source, /byox/plan
GET  /collab                             public summary + policy
GET  /collab/workspaces                  public list (ids, repo, counts)
GET  /collab/workspaces/:id              public summary; full state with collab:write
POST /collab/workspaces                  open a workspace (collab:write)
POST /collab/workspaces/:id/operations    apply an operation (collab:write)
```

## Refresh behaviour (incremental and safe)

1. `If-None-Match` with the stored ETag → `304` only bumps `lastCheckedAt`.
2. Otherwise the README bytes are hashed; an identical hash is reported as
   "unchanged" without touching the index.
3. A **truncated** body, or one that parses into fewer than 50 entries, never
   replaces a good index: the previous catalog is kept, the state records the
   reason and the catalog is reported `stale`.
4. Network failures and non-200 responses write `lastError` to the state and
   leave the catalog intact.
5. Every refresh is rate-limited; `BYOX_REFRESH_MIN_INTERVAL_SECONDS` (default
   3600) debounces it unless `force` is set by an administrator.

Environment knobs (`wrangler.jsonc` / secrets): `BYOX_README_URL`,
`BYOX_REFRESH_MIN_INTERVAL_SECONDS`, `BYOX_STALE_AFTER_SECONDS`, `BYOX_MAX_BYTES`,
`BYOX_RATE_LIMIT_PER_MINUTE`, `DEMO_API_KEY` (administrator key, ≥16 chars),
`COLLAB_ALLOW_APPLY`, `GITHUB_ACTIONS_TOKEN` + `GITHUB_ACTIONS_REPO` (dispatch).

## Workspace rules

* Every change records the *declared* author and the *verified* DEMO OAuth
  principal hash — DEMO cannot prove which model produced a patch, and says so.
* A patch is a `create` / `modify` / `delete` with a base hash. Conflicts are
  detected at submit time and re-checked at apply time; applying a conflicted
  patch needs `force`, and a protected path additionally needs
  `approve_protected`.
* Protected paths: `.github/workflows/`, `src/auth/`, `src/security/`,
  `src/core/admin.ts`, `wrangler.jsonc`.
* A patch cannot be reviewed by its own declared author.
* `COLLAB_ALLOW_APPLY=false` stops application, never submission.
* Tasks are dependency-checked: a task cannot start while its dependency is
  open, and `planTasks()` reports ready / blocked / running / retryable work.

## Trust boundary

Retrieved tutorial text, patch bodies and provider answers are **data**. They are
never treated as instructions, never executed, and never allowed to change
DEMO's policy.
