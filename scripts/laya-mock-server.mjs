#!/usr/bin/env node
/**
 * Local mock of a Laya-compatible decision server — development tool only.
 *
 * Implements the Jev-compatible System One contract DEMO's Laya provider speaks:
 *
 *   POST /v1/systemone
 *   { "state": …, "model": …, "questions": { "<id>": { type, instructions, criteria? } } }
 *   → { "model": "laya-mock-1.0.0", "answers": { "<id>": … }, "usage": { input_tokens, output_tokens } }
 *
 * It exists so the integration can be exercised end-to-end without a real hosted
 * Laya deployment. The answers are deterministic and deliberately simple (first
 * choice option wins, mid-range score, "yes" noul) — enough to verify the wire
 * contract, timeouts, auth and error paths, never enough to judge model quality.
 *
 * Usage:
 *   node scripts/laya-mock-server.mjs [port]           # default port 8790
 *   LAYA_MOCK_API_KEY=secret node scripts/laya-mock-server.mjs
 *     → then every request must carry `Authorization: Bearer secret` (401 otherwise)
 *
 * Note: DEMO enforces its SSRF policy on LAYA_BASE_URL (https, no loopback/private
 * targets), so a localhost URL like this script's cannot be wired into a deployed
 * or `wrangler dev` Worker — by design. The unit/integration tests in
 * tests/laya.test.ts exercise the same contract through an in-process stub; this
 * script is for poking at the contract by hand, e.g.:
 *
 *   curl -s http://127.0.0.1:8790/v1/systemone -H 'content-type: application/json' -d '{
 *     "state": {"user_message": "can you look at this page for me?"},
 *     "model": "laya-latest",
 *     "questions": {"primary": {"type": "choice", "instructions": "Which tool family?",
 *       "criteria": {"browser_action": "Open a page", "utility": "Local helper", "needs_user_clarification": "Unclear"}}}}'
 *
 * This file is not imported by the Worker and is never part of the deploy bundle.
 */

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8790) || 8790;
const requiredKey = (process.env.LAYA_MOCK_API_KEY ?? "").trim();
const MODEL = "laya-mock-1.0.0";

function answerQuestion(spec) {
  if (!spec || typeof spec !== "object") return null;
  if (spec.type === "noul") {
    return { type: "noul", noul: 0.82 };
  }
  if (spec.type === "choice") {
    const options = Object.keys(spec.criteria ?? {});
    if (options.length === 0) return null;
    const winner = options[0];
    const rest = Number((0.15 / Math.max(1, options.length - 1)).toFixed(4));
    return {
      type: "choice",
      choice: winner,
      probabilities: Object.fromEntries(options.map((option) => [option, option === winner ? 0.85 : rest])),
      confidence: 0.85,
    };
  }
  if (spec.type === "score") {
    const levels = Array.isArray(spec.criteria) ? spec.criteria : [];
    if (levels.length < 2) return null;
    const top = levels.length - 1;
    const probabilities = Object.fromEntries(levels.map((_, index) => [String(index), index === 0 ? 0.7 : Number((0.3 / top).toFixed(4))]));
    return {
      type: "score",
      score: 0.4,
      legend: Object.fromEntries(levels.map((description, index) => [String(index), String(description).slice(0, 120)])),
      probabilities,
      confidence: 0.78,
    };
  }
  return null;
}

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (request.method === "GET" && request.url === "/healthz") {
    return send(200, { ok: true, mock: "laya", model: MODEL });
  }

  if (request.method !== "POST" || (request.url ?? "").split("?")[0] !== "/v1/systemone") {
    return send(404, { detail: "mock Laya: the only route is POST /v1/systemone" });
  }

  if (requiredKey) {
    const authorization = String(request.headers.authorization ?? "");
    if (authorization !== `Bearer ${requiredKey}`) {
      return send(401, { detail: "mock Laya: missing or invalid bearer credential" });
    }
  }

  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) return send(413, { detail: "mock Laya: request too large" });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(422, { detail: "mock Laya: request body must be JSON" });
  }

  const questions = body?.questions;
  if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) {
    return send(422, { detail: "mock Laya: `questions` must be a non-empty object" });
  }

  const answers = {};
  for (const [id, spec] of Object.entries(questions)) {
    const answer = answerQuestion(spec);
    if (!answer) return send(422, { detail: `mock Laya: unsupported or malformed question "${id}"` });
    answers[id] = answer;
  }

  const stateChars = typeof body.state === "string" ? body.state.length : JSON.stringify(body.state ?? null).length;
  return send(200, {
    model: MODEL,
    answers,
    usage: { input_tokens: Math.max(1, Math.round(stateChars / 4)), output_tokens: 8 * Object.keys(answers).length },
  });
});

server.listen(port, () => {
  console.log(`[laya-mock] POST http://127.0.0.1:${port}/v1/systemone — model "${MODEL}"`);
  console.log(`[laya-mock] auth: ${requiredKey ? "requires Authorization: Bearer <LAYA_MOCK_API_KEY>" : "unauthenticated"}`);
  console.log("[laya-mock] development mock only; deterministic canned answers; not the real Laya model.");
});
