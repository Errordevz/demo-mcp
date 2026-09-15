import { describe, expect, it } from "vitest";
import { redactText, redactValue, safeLog } from "../src/core/redact.js";

describe("redaction", () => {
  it("redacts authorization headers and bearer tokens", () => {
    const text = 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4';
    const out = redactText(text);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toMatch(/\[jwt-redacted\]|\[redacted\]/);
  });

  it("redacts cookie and password key/value pairs", () => {
    const out = redactText('{"password": "hunter2", "cookie": "sessionid=abc123; other=1", "api_key": "sk-live-abcdefghijklmnop"}');
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-live-abcdefghijklmnop");
    expect(out).not.toContain("sessionid=abc123");
  });

  it("redacts credentials embedded in URLs", () => {
    const out = redactText("connecting to https://admin:supersecret@db.example.com:5432");
    expect(out).not.toContain("supersecret");
    expect(out).toContain("@");
  });

  it("redacts emails and phone numbers", () => {
    expect(redactText("contact me at person@example.com")).not.toContain("person@example.com");
    expect(redactText("call +1 415 555 2671 now")).not.toContain("415 555 2671");
  });

  it("redacts private keys", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----";
    expect(redactText(pem)).not.toContain("MIIEvQIBADANBgkqhkiG9w0B");
  });

  it("redacts sensitive object keys recursively", () => {
    const value = { user: "alice", password: "hunter2", nested: { token: "abc", keep: "visible" } };
    const out = redactValue(value) as Record<string, any>;
    expect(out.password).toBe("[redacted]");
    expect(out.nested.token).toBe("[redacted]");
    expect(out.nested.keep).toBe("visible");
    expect(out.user).toBe("alice");
  });

  it("keeps log output free of secrets", () => {
    const spy = vi_spy();
    safeLog("log", "test", { headers: { authorization: "Bearer abcdefghijklmnop1234567890" }, note: "ok" });
    const output = spy.output();
    spy.restore();
    expect(output).not.toContain("abcdefghijklmnop1234567890");
    expect(output).toContain("test");
  });
});

/** Tiny console.log capture without pulling in vitest globals here. */
function vi_spy() {
  const original = console.log;
  let buffer = "";
  console.log = (...args: unknown[]) => {
    buffer += args.map(String).join(" ") + "\n";
  };
  return {
    output: () => buffer,
    restore: () => {
      console.log = original;
    },
  };
}
