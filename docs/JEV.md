# The Jev Decision Engine (TypeSafe) in DEMO

DEMO can ask **Jev** — TypeSafe's structured decision model — for narrow typed judgments
inside its workflows. This document is the whole contract: what TypeSafe and Jev are, what
this repository does with them, exactly which questions it asks, what it does with the
answers, and what it refuses to do.

Read the provider docs before changing any of it: <https://docs.typesafe.ai/api.md>,
<https://docs.typesafe.ai/primitives.md>, <https://docs.typesafe.ai/confidence.md>.

---

## 1. Three things that are easy to conflate

| Thing | What it is | Where it lives here |
| --- | --- | --- |
| **TypeSafe** | The provider: an HTTP API at `api.typesafe.ai`, keys minted at `console.typesafe.ai/keys` | `src/jev/client.ts` |
| **Jev** | TypeSafe's flagship **System One** model. It takes `state` + typed questions and returns typed answers with probabilities in one parallel pass. It does not generate text. | requested via `model: "jev-latest"` |
| **The TypeSafe skill** | An instruction package for the *coding agent* working on this repository | installed for the agent (see [§7](#7-the-typesafe-skill-and-demo)); surfaced in DEMO's tool list as guidance only |

Installing the skill does **not** give Demo a runtime capability, and Demo cannot
dynamically execute an agent skill — the runtime capability is the code in `src/jev/`,
which exists independently of the skill.

**Jev is not wired in as a chat model.** It is not in any model picker, it replaces no
LLM, and DEMO never asks it to produce prose, code or tool calls. It is only ever asked to
choose among options DEMO enumerated in code.

---

## 2. The API contract this integration implements

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json

{ "state": …, "model": "jev-latest", "questions": { "<id>": { … } } }
```

Answer shapes consumed by `validateAnswer()` in `src/jev/client.ts`:

| Question | Request `criteria` | Answer |
| --- | --- | --- |
| `noul` (yes/no) | optional `{ true, false }` describing what each means | `{ type: "noul", noul: 0…1 }` — no separate confidence field |
| `choice` | `map<option, description>` | `{ type: "choice", choice, probabilities, confidence }` |
| `score` | ordered `array` of level descriptions (≥ 2) | `{ type: "score", score, legend, probabilities, confidence }` |

Plus `model` (the versioned id that answered) and `usage` in the response, and `GET
/v1/models` (used only by the capability report).

Rules DEMO enforces on itself, stricter than the API's documented minimum:

* The API origin is **pinned in code**; no variable can redirect the credential.
* Question ids match `^[a-z][a-z0-9_]{0,39}$` (they are keys for code, never sent to the model).
* 1–16 questions per request, ≤ 32 Choice options, 2–10 Score levels, instructions ≤ 1 200 chars.
* `state` is capped at 8 000 characters; longer input is truncated and reported as
  `stateTruncated: true` rather than silently dropped or forwarded whole.
* A Choice answer naming an option outside the set we sent is **rejected**
  (`validation_failed`) — the code never coerces or trusts an unexpected value.
* An omitted option in `probabilities` is read as `0` instead of failing the whole call:
  the distribution is auxiliary evidence, `choice` + `confidence` are what gets acted on.
* Timeouts are hard (`AbortSignal.timeout`), and retries are capped at **one**, only for
  429/529/5xx, honouring `retry-after` up to 1 500 ms. There is no retry for 401/422, and
  no retry loop that could double-bill or hold an MCP request open.

---

## 3. Where the key lives

`TYPESAFE_API_KEY` is a **Worker secret** — Cloudflare dashboard → *Workers & Pages →
demo-mcp → Settings → Variables and secrets → Encrypt*, or `wrangler secret put
TYPESAFE_API_KEY`. No other placement is supported:

* it is read from `env` at call time in exactly two functions and is **not** stored on the
  resolved config object, so a capability report or a `demo_ping` cannot echo it;
* it never appears in a URL, a query string, HTML, a log line (`safeLog` runs through the
  redactor, and a test asserts a full flow writes nothing credential-shaped to the console),
  a tool result, or an error message;
* nothing in the frontend can read it: `ui.ts` fetches only same-origin JSON routes, and
  there is no `VITE_`/`NEXT_PUBLIC_`-style public variable anywhere in this project;
* if it is missing, the tools and `/health` report `credentialConfigured: false` with the
  dashboard fix — never a partial value, never a masked fragment.

Non-secret policy (already in `wrangler.jsonc` as strings, all optional):

| Variable | Default | Controls |
| --- | --- | --- |
| `TYPESAFE_ENABLED` | on when a key exists | `false`/`off`/`0`/`no` short-circuits every decision path to DEMO's own rules with **zero** network calls |
| `TYPESAFE_MODEL` | `jev-latest` | The `model` field. `jev-latest` is a moving alias for the newest stable release; pin `jev-1.13.0` if you tune thresholds against a version |
| `TYPESAFE_DECISION_TIMEOUT_MS` | `2500` | Per-request budget (250–15 000 ms). Beyond it the decision is abandoned, not queued |
| `TYPESAFE_REVIEW_THRESHOLD` | `0.5` | Below it an answer is recorded but **not acted on** |
| `TYPESAFE_ACCEPT_THRESHOLD` | `0.7` | At or above it an answer applies without a review flag. Clamped so it can never sit below the review floor |

---

## 4. Every question DEMO asks (the file to review)

All of it is in `src/jev/decisions.ts` — questions, option sets and thresholds in one
place, on purpose: that file, not the client, is what a human should read to audit this
feature.

### `video_intent_focus` — the one workflow that calls Jev

`inspect_video` converts the user's own words into an analysis *focus* so frame allocation
and the vision prompt adapt. That mapping is a long list of regexes in
`src/video/intent.ts`, and regexes are exactly where a calibrated judgment helps.

* **When it is called:** only when the message contains text **and** no focus pattern
  matched (which also means no reaction phrase matched). A bare link, or a message the
  rules already understood, sends nothing.
* **The Choice:** `instructions` = "What kind of answer is the user asking for about this
  video? Judge only the message text. Choose general when the message does not say.";
  `criteria` = the 11 `IntentFocus` values (`reaction`, `authenticity`, `humor`, `text_ocr`,
  `ending`, `beginning`, `scary`, `people`, `game`, `summary`, `general`), each with a rubric.
* **The speculative Noul** in the same request (`wants_reaction`, "asks for the reader's own
  reaction rather than information?") is asked only when the caller did not pin
  `reactionMode`, and is thresholded at **0.5** — a Noul has no confidence field, so its
  probability *is* the answer.
* **What DEMO does with it:** replaces `focus` and recomputes `analysisHint` from
  `analysisHintFor(focus)`. Raw user text is never injected into the prompt, and a focus
  outside `FOCUS_VALUES` is rejected by `src/video/intent-hook.ts`.
* **What it cannot do:** change the frame *budget*, the duration/size limits, the SSRF
  guard, whether audio is claimed, `visualEvidenceDelivered`, or any permission check.
* **Fallback:** the deterministic rules' verdict, with the engine's answer still reported
  under `intent.decision` (`policy: low_confidence_fallback` / `unavailable_fallback`).

### `tool_route` — advisory request classification

Choice over DEMO's real handler families: `browser_action`, `video_analysis`,
`roblox_account`, `skills_lookup`, `utility`, plus the two outcomes that must always be
available — `needs_user_clarification` and `not_supported`. Deterministic keyword rules run
first; Jev is consulted only when they are ambiguous. Nothing in DEMO executes a tool call
from this answer — it is for the caller (or a logged audit) to act on.

### `result_review` — escalation scoring

A Score whose three levels are the three things a caller can do with a result:

| Level | Meaning | Maps to |
| --- | --- | --- |
| 0 | states its own evidence, repeats nothing beyond it | `no_review` |
| 1 | usable, but one part rests on an inference worth confirming | `flag_for_review` |
| 2 | asserts something its own evidence does not support, or omits a limit that changes the answer | `hold_for_review` |

`score` is rounded to a level and gated by the same thresholds. **`hold_for_review` never
blocks, deletes, unpublishes or withholds anything**: it reports that a person should look.
Destructive, financial, account and security-sensitive actions in DEMO stay gated by their
own explicit checks, which this cannot satisfy, skip or weaken.

### Confidence, and what it is not

TypeSafe derives `confidence` from the *shape* of the returned distribution: concentrated →
confident, flat → genuinely unsure. Low confidence usually means none of the options was a
clear winner. It is **not** a probability that the answer is correct, and a confidence of
1.0 does not license acting — it describes the model's answer. That is why:

* thresholds are policy, chosen by *consequence*: DEMO applies a low-stakes focus choice in
  the middle band and flags it, and applies nothing below the review floor;
* `probabilities` are always returned alongside, so code (or a reviewer) can apply its own
  measure instead of TypeSafe's;
* the numbers are starting points, not findings: validate them against your own traffic
  before raising them, and note that this repository has **not** measured a domain-specific
  accuracy figure for Jev.

---

## 5. Failure behaviour, in one table

| Situation | Reported as | Effect on the workflow |
| --- | --- | --- |
| No `TYPESAFE_API_KEY` | `unavailable_fallback`, `note` names the secret | no request sent; deterministic result stands |
| `TYPESAFE_ENABLED=false` | same, with the config reason | same |
| 401 / 403 | `capability_unavailable`, hint points at the key page | fallback; no retry |
| 422 | `validation_failed` with the provider detail | fallback; indicates a bug in *our* question definition |
| 429 | one backoff retry, then `rate_limited` | fallback |
| 529 / 5xx / unreachable / timeout | `PROVIDER_UNAVAILABLE` / `timeout` (retryable) | fallback, request abandoned on schedule |
| non-JSON body, missing answer, out-of-range number, unknown option | `validation_failed` | fallback; the raw value is never mapped into DEMO's state |
| hook throws inside the video pipeline | caught in `applyIntentHook` | intent unchanged, no user-visible error |

There is no path in which a TypeSafe failure turns into a failed video inspection, a
failed browser tool, or a `500` from `/mcp`.

---

## 6. Enable it (browser-only)

1. Create a key at <https://console.typesafe.ai/keys>.
2. Cloudflare dashboard → Workers & Pages → `demo-mcp` → Settings → Variables and secrets →
   **Encrypt** → `TYPESAFE_API_KEY`. Nothing else is required: the policy vars already ship
   in `wrangler.jsonc`.
3. Deploy (repository → Actions → **“Deploy + live video tests”** → `skip_live: true`, or
   `npx wrangler deploy`). Secrets are per environment — Production *and* Preview.
4. Open `https://<worker-url>/capabilities/jev` in a browser. `available: true`, a
   `model`, and the two thresholds mean it is live. `/health` shows
   `"jevDecisionEngine": true, "jevApiKeyConfigured": true`.
5. To exercise one real decision, call the MCP tool (this needs an MCP client, not a
   browser): `jev_decide` with `{ "decision": "tool_route", "request": "could you look at that thing and tell me what you think?" }`.
   Expect `source: "jev"` with a `decision`, `certainty`, `policy` and `probabilities`. If
   it comes back `policy: "unavailable_fallback"`, the `note` field says why.

`jev_decide` refuses to run when `DEMO_API_KEY` is unset, because each call is a paid
request and an open `/mcp` endpoint is reachable by anyone who finds the URL. Set
`DEMO_API_KEY` and pass it as a bearer token in your MCP client config.

To turn it off, set `TYPESAFE_ENABLED=false` — every workflow immediately returns to
DEMO's own rules.

---

## 7. The TypeSafe skill and DEMO

The skill was installed **for the coding agent** with the documented "other agents"
method, run once, project-local (no `-g`):

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai
```

The installed `SKILL.md` was then read and followed while this feature was built — which is
why the questions and thresholds live together in one reviewable file, why every question is
narrow with an explicit no-match option, why a Choice answer is only trusted inside the set
we sent, and why confidence is treated as the shape of a distribution rather than as
permission to act.

What the installer produced here: `.agents/skills/typesafe-ai/{SKILL.md,LICENSE}` (the real
files), `.claude/skills/typesafe-ai` and `agent/skills/typesafe-ai` (symlinks for agents that
look there), `skills/typesafe-ai` (a symlink), and `skills-lock.json` with the source path and
content hash. Two deliberate adjustments:

* `skills/typesafe-ai` is a **vendored copy** of `SKILL.md` + `LICENSE` rather than a symlink
  into an ignored directory, so the guidance is tracked, reviewable and survives a fresh
  clone — the same way this repo already ships `skills/caveman/SKILL.md`. It was verified
  byte-identical to the installed copy (`diff -r`, exit 0), and MIT-licensed redistribution
  keeps the upstream `LICENSE` next to it.
* The agent-specific install dirs (`.agents/`, `.claude/`, `agent/`) are git-ignored — they
  are working-tree tooling. `skills-lock.json` **is** tracked, so the recorded
  `computedHash` makes an unrefreshed copy visible, and `npx skills update` is the documented
  way to refresh.

Nothing was added to `src/`, `index.ts` or the deployed bundle.

Discoverability, honestly scoped:

* A coding agent working in this directory finds the skill in the standard project skill
  locations (`.agents/skills/`, `.claude/skills/`, `skills/`).
* Inside DEMO's own MCP surface there is `skill_builtin_typesafe`, a condensed guidance note
  (the same shape as the existing `skill_builtin_caveman`) for a connected AI that wants the
  rules while working with this project: what Jev is, which primitives to pick, that
  confidence is distribution concentration rather than correctness, and that `SKILL.md` and
  the provider docs stay the source of truth. It is *not* a copy of the whole skill file and
  it is documentation, not execution: **DEMO does not install or run skill code**, and ChatGPT cannot invoke the
  installer through this Worker (`skill_install_info` deliberately returns the command
  instead of running it).
* The capability that *is* runtime is `jev_decide` / `jev_capabilities` /
  `demo://capabilities/jev`, plus the `inspect_video` hook. "Use Jev to classify this" maps
  to `jev_decide`; "use the TypeSafe skill" maps to the coding agent, not to a DEMO tool.

---

## 8. Tests

`tests/jev.test.ts` (37 cases) and `tests/wrangler-config.test.ts` (9) cover:

* the exact documented request (host, bearer header, `state`/`model`/`questions` body) and
  answer validation for all three primitives;
* rejection of an unknown option, an out-of-range number, a missing answer and a non-JSON
  body; refusal to send anything when our own question set is malformed;
* 401 / 422 / 429 / 529 / 503 mapping, the single `retry-after` backoff, timeout handling,
  and "no credential in URL, body or console" (with the header asserted as the one
  legitimate place);
* policy: high confidence applied, middle band applied-with-review, low confidence
  **ignored** while still reported, out-of-set answer ignored, unavailable engine
  indistinguishable from disabled for the caller;
* the video hook: not called when the regexes decided or there is no text, curated-hint-only
  prompt injection resistance, and `applyIntentHook` absorbing a throwing, lying or
  malformed provider;
* the MCP surface: tool discovery, the `DEMO_API_KEY` gate on the paid tool, argument
  validation before any network use, a capabilities report with no masked or leaked field,
  and `/capabilities/jev` + `/health` flags;
* configuration: all eleven browser/video vars plus the five `TYPESAFE_*` policy vars present
  exactly once with exact string values, no credential-shaped key in `vars`, no `env.*`
  section that could drift, bindings/migrations intact, every declared var actually read by
  the code — plus behavioural proof that `SSRF_DNS_FAIL_OPEN=true` only widens the
  resolver-unreachable case while localhost, private literals, metadata endpoints and
  DNS-rebinding answers stay blocked.

What is **not** verified automatically: real answer quality on DEMO traffic. That needs your
own labelled examples; the thresholds exist so you can measure it rather than guess.
