/**
 * Public read-only HTTP surface for the Build Your Own X catalog.
 *
 * The MCP tools are the primary interface; this exists so the inspector UI (and
 * any other client without an MCP session) can show the catalog. Everything here
 * is *metadata* — title, category, languages, original URL — never tutorial
 * text. Reading a tutorial page is an explicit, single-page MCP action
 * (`byox_read_tutorial`) with its own access checks, and it is deliberately not
 * reachable as a route.
 *
 * Refreshing the index is administrator-only and lives at `POST /byox/refresh`
 * in the MCP layer; it is notable here only because this module refuses it.
 */

import { BrowserError, describeError } from "../core/errors.js";
import { buildLearningPlan, findTutorial, searchByox, type ByoxIndex } from "./catalog.js";
import { byoxConfig, loadByoxIndex, readByoxSourceSnapshot, refreshByoxIndex, type ByoxEnv } from "./store.js";
import { adminKeyConfigured, adminNotConfigured, adminRequired, isAdminRequest } from "../core/admin.js";
import { chargeByoxHttpRequest, byoxCapabilitiesReport } from "../mcp/byox-tools.js";

export function isByoxPath(pathname: string): boolean {
  return pathname === "/byox" || pathname.startsWith("/byox/");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(error: unknown): Response {
  const info = describeError(error);
  const status = info.code === "rate_limited" ? 429 : info.code === "admin_required" ? 403 : info.code === "not_configured" ? 503 : info.code === "invalid_input" ? 400 : info.code === "capability_unavailable" ? 503 : 500;
  return json({ ok: false, error: info }, status);
}

function requireIndex(index: ByoxIndex | null, reason: string | null): ByoxIndex {
  if (!index) throw new BrowserError("capability_unavailable", reason ?? "The catalog is not available.", { hint: "An administrator can build it with byox_refresh_index or POST /byox/refresh." });
  return index;
}

export async function handleByoxRoute(request: Request, env: Record<string, unknown>): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isByoxPath(url.pathname)) return null;
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean); // ["byox", ...]
  const byoxEnv = env as ByoxEnv;

  try {
    if (segments.length === 1) {
      if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      const load = await loadByoxIndex(byoxEnv);
      return json({ ok: true, catalog: byoxCapabilitiesReport(env, load), source: "codecrafters-io/build-your-own-x" });
    }

    if (segments[1] === "refresh") {
      if (method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      // The operator credential is the DEMO_API_KEY Worker secret, compared as a
      // digest; it is never echoed and never accepted as a query parameter.
      if (!(await isAdminRequest(request, env))) {
        const refusal = adminKeyConfigured(env) ? adminRequired("POST /byox/refresh") : adminNotConfigured("POST /byox/refresh");
        return json({ ok: false, error: describeError(refusal) }, 403);
      }
      chargeByoxHttpRequest(env, "http_refresh");
      const result = await refreshByoxIndex(byoxEnv, { force: true });
      return json({ ok: true, refresh: { refreshed: result.refreshed, unchanged: result.unchanged, stale: result.stale, reason: result.reason, checkedAt: result.checkedAt, storage: result.storage, diff: result.diff, counts: result.index?.counts ?? null } });
    }

    if (segments[1] === "categories") {
      if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      chargeByoxHttpRequest(env, "http_read");
      const load = await loadByoxIndex(byoxEnv);
      const index = requireIndex(load.index, load.reason);
      return json({ ok: true, categories: index.categories, languages: languageCounts(index), stale: load.stale, ageSeconds: load.ageSeconds, refreshedAt: index.source.lastCheckedAt });
    }

    if (segments[1] === "search") {
      if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      chargeByoxHttpRequest(env, "http_read");
      const load = await loadByoxIndex(byoxEnv);
      const index = requireIndex(load.index, load.reason);
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "10") || 10));
      const formatParam = url.searchParams.get("format");
      const format = formatParam === "article" || formatParam === "video" ? formatParam : undefined;
      const category = url.searchParams.get("category") ?? undefined;
      const language = url.searchParams.get("language") ?? undefined;
      const found = searchByox(index, { query: url.searchParams.get("q") ?? "", category, language, limit, ...(format ? { format } : {}) });
      return json({
        ok: true,
        total: found.total,
        hits: found.hits.map((hit) => hit.tutorial),
        stale: load.stale,
        ageSeconds: load.ageSeconds,
        note: "Metadata only: title, languages, category and the original URL. DEMO does not re-host or summarize tutorials.",
      });
    }

    if (segments[1] === "tutorial" && segments.length >= 3) {
      if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      chargeByoxHttpRequest(env, "http_read");
      const load = await loadByoxIndex(byoxEnv);
      const index = requireIndex(load.index, load.reason);
      const tutorial = findTutorial(index, decodeURIComponent(segments.slice(2).join("/")));
      if (!tutorial) return json({ ok: false, error: { code: "not_found", message: "No catalog entry matches that id, URL or exact title." } }, 404);
      return json({ ok: true, tutorial, stale: load.stale });
    }

    if (segments[1] === "source") {
      if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      // The catalog's own README is already public upstream; this returns the
      // snapshot DEMO indexed (provenance), not tutorial bodies.
      chargeByoxHttpRequest(env, "http_read");
      const load = await loadByoxIndex(byoxEnv);
      const snapshot = await readByoxSourceSnapshot(byoxEnv);
      if (!snapshot) return json({ ok: false, error: { code: "not_found", message: "No source snapshot has been stored yet." } }, 404);
      return json({
        ok: true,
        source: byoxConfig(byoxEnv).readmeUrl,
        bytes: snapshot.bytes,
        sha256: load.state?.sha256 ?? load.index?.source.sha256 ?? null,
        fetchedAt: load.state?.fetchedAt ?? load.index?.source.fetchedAt ?? null,
        lastCheckedAt: load.state?.lastCheckedAt ?? null,
        excerpt: snapshot.text.slice(0, 1200),
        note: "This is the upstream catalog README that DEMO parsed, not tutorial content.",
      });
    }

    if (segments[1] === "plan") {
      if (method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      chargeByoxHttpRequest(env, "http_read");
      const load = await loadByoxIndex(byoxEnv);
      const index = requireIndex(load.index, load.reason);
      const goal = url.searchParams.get("goal") ?? "";
      const language = url.searchParams.get("language") ?? undefined;
      const maxSteps = Math.min(10, Math.max(2, Number(url.searchParams.get("steps") ?? "6") || 6));
      const weeks = Math.min(52, Math.max(1, Number(url.searchParams.get("weeks") ?? "12") || 12));
      const level = url.searchParams.get("level") ?? undefined;
      return json({
        ok: true,
        plan: buildLearningPlan(index, { goal, weeks, maxSteps, ...(language ? { languages: [language] } : {}), ...(level ? { level } : {}) }),
        stale: load.stale,
      });
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    return failure(error);
  }
}

function languageCounts(index: ByoxIndex): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tutorial of index.tutorials) for (const name of tutorial.languages) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (b.count === a.count ? a.name.localeCompare(b.name) : b.count - a.count));
}

/** Configuration summary shown by the UI before the catalog is built. */
export function byoxRouteConfig(env: Record<string, unknown>) {
  const config = byoxConfig(env as ByoxEnv);
  return { readmeUrl: config.readmeUrl, staleAfterSeconds: config.staleAfterSeconds, maxBytes: config.maxBytes };
}
