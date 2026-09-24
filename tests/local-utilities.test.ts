/**
 * DEMO 0.9 — local utilities: JSON Schema validation, JWT decoding (never
 * verification), cron parsing and text/document diff. Everything runs offline.
 */

import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "../src/validate/json-schema.js";
import { inspectJwt } from "../src/tokens/jwt.js";
import { explainCron, nextCronOccurrences } from "../src/time/cron.js";
import { changedSections, diffJson, diffLines, summarizeDiff, toUnifiedDiff } from "../src/core/text-diff.js";

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(header: unknown, payload: unknown, signature = "sig"): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${b64url(signature)}`;
}

describe("JSON Schema validation", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 2 },
      age: { type: "integer", minimum: 0, maximum: 150 },
      tags: { type: "array", items: { type: "string" }, uniqueItems: true },
      contact: { type: "object", properties: { email: { type: "string", format: "email" } }, additionalProperties: false },
    },
  };

  it("accepts a valid document", () => {
    const result = validateJsonSchema({ name: "Ada", age: 36, tags: ["x"], contact: { email: "a@b.co" } }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns exact failing paths with expected/received", () => {
    const result = validateJsonSchema({ name: "A", age: -1, extra: true, tags: ["dup", "dup"], contact: { email: "nope", phone: "1" } }, schema);
    expect(result.valid).toBe(false);
    const byKeyword = Object.fromEntries(result.errors.map((error) => [`${error.path}:${error.keyword}`, error]));
    expect(byKeyword["/name:minLength"]).toBeTruthy();
    expect(byKeyword["/name:minLength"].received.valuePreview).toBe("A");
    expect(byKeyword["/age:minimum"]).toBeTruthy();
    expect(byKeyword["/age:minimum"].expected).toBe(0);
    expect(byKeyword["/extra:additionalProperties"]).toBeTruthy();
    expect(byKeyword["/tags/1:uniqueItems"]).toBeTruthy();
    expect(byKeyword["/contact/email:format"]).toBeTruthy();
    expect(byKeyword["/contact/phone:additionalProperties"]).toBeTruthy();
  });

  it("reports missing required properties at the root", () => {
    const result = validateJsonSchema({}, schema);
    const required = result.errors.filter((error) => error.keyword === "required").map((error) => error.message);
    expect(required.join(" ")).toContain('"name"');
    expect(required.join(" ")).toContain('"age"');
  });

  it("supports combinators, conditionals, const/enum and $defs refs", () => {
    const advanced = {
      $defs: { positive: { type: "integer", minimum: 1 } },
      type: "object",
      properties: {
        kind: { enum: ["a", "b"] },
        value: { $ref: "#/$defs/positive" },
        extra: { oneOf: [{ type: "string" }, { type: "number" }] },
        mode: { const: "on" },
      },
      if: { properties: { kind: { const: "a" } }, required: ["kind"] },
      then: { required: ["value"] },
    };
    expect(validateJsonSchema({ kind: "a", value: 3, extra: "s", mode: "on" }, advanced).valid).toBe(true);
    const missingThen = validateJsonSchema({ kind: "a", extra: 1, mode: "on" }, advanced);
    expect(missingThen.valid).toBe(false);
    expect(missingThen.errors.some((error) => error.keyword === "required")).toBe(true);
    const badRef = validateJsonSchema({ kind: "b", value: -5 }, advanced);
    expect(badRef.valid).toBe(false);
    expect(badRef.errors.some((error) => error.path === "/value" && error.keyword === "minimum")).toBe(true);
  });

  it("refuses remote $refs without fetching them and warns on unknown keywords", () => {
    const result = validateJsonSchema({ x: 1 }, { type: "object", properties: { x: { $ref: "https://evil.test/schema.json" } }, customKeyword: true });
    expect(result.valid).toBe(true); // remote ref = unconstrained, by decision
    expect(result.warnings.join(" ")).toMatch(/remote \$ref/i);
    expect(result.warnings.join(" ")).toMatch(/customKeyword/);
  });

  it("reports boolean schemas and type failures precisely", () => {
    expect(validateJsonSchema("anything", false).errors[0].keyword).toBe("false");
    const typed = validateJsonSchema("text", { type: "number" });
    expect(typed.errors[0]).toMatchObject({ path: "", keyword: "type" });
    expect(typed.errors[0].received.type).toBe("string");
  });
});

describe("JWT inspection (decode only)", () => {
  it("decodes header/payload/claims and reports temporal windows", async () => {
    const now = new Date("2024-06-01T12:00:00Z");
    const token = makeJwt({ alg: "RS256", typ: "JWT", kid: "key-1" }, { iss: "https://issuer.test", sub: "user-42", aud: ["api"], exp: Date.parse("2024-06-01T13:00:00Z") / 1000, iat: Date.parse("2024-06-01T11:00:00Z") / 1000, nbf: Date.parse("2024-06-01T11:30:00Z") / 1000, role: "editor" });
    const result = await inspectJwt(token, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspection = result.inspection;
    expect(inspection.algorithm).toBe("RS256");
    expect(inspection.subject).toBe("user-42");
    expect(inspection.issuer).toBe("https://issuer.test");
    expect(inspection.audience).toEqual(["api"]);
    expect(inspection.temporal.exp?.status).toBe("valid-window");
    expect(inspection.claims.custom.role).toBe("editor");
    expect(inspection.verification).toBe("not-performed");
    expect(inspection.verificationNote).toMatch(/DECODING IS NOT VERIFICATION/i);
    expect(inspection.tokenFingerprint).toMatch(/^sha256:/);
    // Never echoes the token itself.
    expect(JSON.stringify(inspection)).not.toContain(token);
  });

  it("reports expired and not-yet-valid windows against the stated now", async () => {
    const now = new Date("2024-06-01T12:00:00Z");
    const expired = makeJwt({ alg: "HS256" }, { exp: Date.parse("2024-06-01T11:00:00Z") / 1000 });
    const result = await inspectJwt(expired, { now });
    expect(result.ok && result.inspection.temporal.exp?.status).toBe("expired");
    const future = makeJwt({ alg: "HS256" }, { nbf: Date.parse("2024-06-01T15:00:00Z") / 1000 });
    const futureResult = await inspectJwt(future, { now });
    expect(futureResult.ok && futureResult.inspection.temporal.nbf?.status).toBe("not-yet-valid");
  });

  it("flags alg:none and missing signatures without ever verifying", async () => {
    const token = makeJwt({ alg: "none" }, { sub: "anon" }, "");
    const result = await inspectJwt(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.warnings.join(" ")).toMatch(/UNAUTHENTICATED/i);
    expect(result.inspection.structure.signaturePresent).toBe(false);
    expect(result.inspection.verification).toBe("not-performed");
  });

  it("rejects non-JWT input and never echoes token material in failures", async () => {
    const garbage = "not-a-jwt-secret-value";
    const result = await inspectJwt(garbage);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_token");
    expect(result.message).not.toContain(garbage);
    const jwe = "a.b.c.d.e";
    const jweResult = await inspectJwt(jwe);
    expect(jweResult.ok).toBe(false);
  });

  it("never accepts key material and never claims verification", async () => {
    const result = await inspectJwt(makeJwt({ alg: "RS256" }, { sub: "x" }));
    const text = JSON.stringify(result);
    // No key material of any kind appears — only the decode-only disclaimer.
    expect(text).not.toMatch(/-----BEGIN/i);
    expect(text).not.toMatch(/private[_-]?key/i);
    expect(result.ok && result.inspection.verification).toBe("not-performed");
    expect(result.ok && result.inspection.verificationNote).toMatch(/never verifies signatures/i);
  });
});

describe("cron parsing", () => {
  it("explains standard expressions in human language", () => {
    const every15 = explainCron("*/15 9-17 * * MON-FRI");
    expect(every15.valid).toBe(true);
    expect(every15.human).toMatch(/every 15 minutes/i);
    expect(every15.human).toMatch(/hour 9, 10, 11/);
    expect(every15.human).toMatch(/weekday 1, 2, 3, 4, 5/);
    const daily = explainCron("@daily");
    expect(daily.format).toBe("macro");
    expect(daily.human).toMatch(/at minute 0/);
    const sixField = explainCron("30 * * * * *");
    expect(sixField.format).toBe("6-field(seconds)");
  });

  it("computes upcoming occurrences deterministically", () => {
    const from = new Date("2024-03-01T00:00:00Z");
    const result = nextCronOccurrences("0 12 * * *", { from, count: 3 });
    expect(result.valid).toBe(true);
    expect(result.occurrences.next).toEqual(["2024-03-01T12:00:00.000Z", "2024-03-02T12:00:00.000Z", "2024-03-03T12:00:00.000Z"]);
    const feb29 = nextCronOccurrences("0 0 29 2 *", { from: new Date("2024-03-01T00:00:00Z"), count: 1, horizonDays: 366 * 4 });
    expect(feb29.occurrences.next[0]).toBe("2028-02-29T00:00:00.000Z");
    const impossible = nextCronOccurrences("0 0 30 2 *", { from, count: 1, horizonDays: 366 * 2 });
    expect(impossible.occurrences.next).toEqual([]);
    expect(impossible.occurrences.message).toMatch(/no occurrence/i);
  });

  it("detects malformed expressions with precise errors", () => {
    for (const bad of ["", "* *", "61 * * * *", "* 25 * * *", "* * 0 * *", "*/0 * * * *", "a b c d e", "@fortnightly"]) {
      const result = explainCron(bad);
      expect(result.valid, bad).toBe(false);
      expect(result.error, bad).toBeTruthy();
    }
    const wrap = explainCron("0 0 * * FRI-MON");
    expect(wrap.valid).toBe(true);
    expect(wrap.warnings.join(" ")).toMatch(/wraps around/);
  });

  it("uses Vixie OR semantics for dom/dow", () => {
    // 1st of month OR Mondays, at 00:00 in March 2024 (Fri Mar 1, Mon Mar 4, Mon 11, ...).
    const result = nextCronOccurrences("0 0 1 * 1", { from: new Date("2024-02-29T00:00:00Z"), count: 3 });
    const days = result.occurrences.next.map((iso) => iso.slice(0, 10));
    expect(days[0]).toBe("2024-03-01");
    expect(days[1]).toBe("2024-03-04"); // Monday
  });
});

describe("text/document diff", () => {
  it("produces structured sections and unified diffs", () => {
    const diff = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(summarizeDiff(diff)).toMatchObject({ added_lines: 2, removed_lines: 1, identical: false });
    const sections = changedSections(diff);
    expect(sections[0].removed).toEqual(["b"]);
    expect(sections[0].added).toEqual(["B"]);
    expect(sections[1].added).toEqual(["d"]);
    const unified = toUnifiedDiff(diff, "old.md", "new.md");
    expect(unified).toContain("--- old.md");
    expect(unified).toContain("+++ new.md");
    expect(unified).toContain("-b");
    expect(unified).toContain("+B");
  });

  it("diffs JSON with exact paths", () => {
    const result = diffJson({ user: { name: "A", tags: [1, 2] } }, { user: { name: "B", tags: [1, 2, 3] }, extra: true });
    const paths = result.entries.map((entry) => `${entry.path}:${entry.change}`);
    expect(paths).toEqual(expect.arrayContaining(["/user/name:changed", "/user/tags/2:added", "/extra:added"]));
  });

  it("reports identical inputs as identical", () => {
    const diff = diffLines("same\ntext\n", "same\ntext\n");
    expect(summarizeDiff(diff).identical).toBe(true);
    expect(diff.similarity).toBe(1);
  });

  it("enforces line limits", () => {
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    expect(() => diffLines(big, "x", { maxLines: 50 })).toThrowError(/at most 50 lines/);
  });
});
