/**
 * Account email tests.
 *
 * The SMTP half of this file runs `smtpSend` against a real TCP SMTP server
 * implemented in-process, so the wire protocol (greeting, EHLO, AUTH PLAIN →
 * AUTH LOGIN fallback, MAIL FROM/RCPT TO, DATA dot-stuffing, QUIT) is verified
 * byte for byte rather than mocked. Only the socket factory is injected — that
 * is the same seam production fills with `cloudflare:sockets`.
 *
 * The policy half pins the sender-identity rules that make
 * `demomcp7@gmail.com` either genuinely usable (Gmail SMTP + App Password) or an
 * honest, reported configuration error — never a silent, unreachable promise.
 */

import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_FROM,
  parseFrom,
  resolveAccountEmailConfig,
  sendAccountEmail,
  verificationEmail,
  resetEmail,
  passwordChangedEmail,
  accountDeletedEmail,
} from "../src/account/email.js";
import { buildMimeMessage, smtpSend, type SmtpConnect, type SmtpSocketLike } from "../src/account/smtp.js";

/* ------------------------------------------------------------- SMTP server */

interface Captured {
  authPlain: string[];
  authLogin: string[];
  envelopeFrom: string[];
  recipients: string[];
  data: string[];
  commands: string[];
}

interface FakeSmtpOptions {
  /** Reply this code to AUTH PLAIN (default 235 = accept). */
  authPlainCode?: number;
  /** Reply this code to RCPT TO (default 250 = accept). */
  rcptCode?: number;
  /** When true, the server advertises no AUTH extension. */
  noAuthAdvertised?: boolean;
}

async function startSmtpServer(options: FakeSmtpOptions = {}) {
  const captured: Captured = { authPlain: [], authLogin: [], envelopeFrom: [], recipients: [], data: [], commands: [] };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let dataBuffer = "";

    const send = (line: string) => socket.write(`${line}\r\n`);
    send("220 fake.demo ESMTP ready");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            captured.data.push(dataBuffer);
            dataBuffer = "";
            send("250 2.0.0 Ok: queued");
          } else {
            dataBuffer += `${line}\r\n`;
          }
          continue;
        }

        captured.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          const extensions = options.noAuthAdvertised ? ["250-SIZE 10485760", "250 8BITMIME"] : ["250-SIZE 10485760", "250-AUTH PLAIN LOGIN", "250 8BITMIME"];
          socket.write("250-fake.demo greets you\r\n");
          for (const ext of extensions) socket.write(`${ext}\r\n`);
        } else if (upper.startsWith("AUTH PLAIN")) {
          captured.authPlain.push(line);
          const code = options.authPlainCode ?? 235;
          send(code === 235 ? "235 2.7.0 Authentication successful" : `${code} 5.7.8 Username and Password not accepted`);
        } else if (upper === "AUTH LOGIN") {
          captured.authLogin.push(line);
          send("334 VXNlcm5hbWU6");
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && captured.authLogin.length === 1) {
          captured.authLogin.push(line);
          send("334 UGFzc3dvcmQ6");
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && captured.authLogin.length === 2) {
          captured.authLogin.push(line);
          send("235 2.7.0 Authentication successful");
        } else if (upper.startsWith("MAIL FROM")) {
          captured.envelopeFrom.push(line);
          send("250 2.1.0 Ok");
        } else if (upper.startsWith("RCPT TO")) {
          captured.recipients.push(line);
          send(options.rcptCode && options.rcptCode !== 250 ? `${options.rcptCode} 5.1.1 No such user here` : "250 2.1.5 Ok");
        } else if (upper === "DATA") {
          inData = true;
          dataBuffer = "";
          send("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper === "QUIT") {
          send("221 2.0.0 Bye");
          socket.end();
        } else {
          send("502 5.5.2 Command not implemented");
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  const connect: SmtpConnect = (_target, _options) => nodeSocket(net.connect(address.port, "127.0.0.1"));
  return {
    port: address.port,
    captured,
    connect,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Adapt a Node socket to the structural socket the SMTP client expects. */
function nodeSocket(socket: net.Socket): SmtpSocketLike {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      socket.on("end", () => {
        try { controller.close(); } catch { /* already closed */ }
      });
      socket.on("error", (error) => controller.error(error));
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()));
      });
    },
  });
  return { readable, writable, close: () => { socket.destroy(); } };
}

const MESSAGE: Parameters<typeof smtpSend>[0] = {
  host: "127.0.0.1",
  port: 1,
  secureTransport: "off",
  username: "demomcp7@gmail.com",
  password: "app-password-secret",
  envelopeFrom: "demomcp7@gmail.com",
  recipient: "user@example.com",
  message: "Subject: hi\r\n\r\nbody\r\n",
  timeoutMs: 5_000,
};

/* --------------------------------------------------------------- SMTP tests */

describe("smtpSend against a real SMTP server", () => {
  it("authenticates with AUTH PLAIN and delivers the message", async () => {
    const server = await startSmtpServer();
    try {
      const result = await smtpSend({ ...MESSAGE, connect: server.connect });
      expect(result.ok).toBe(true);
      expect(result.stage).toBe("done");
      expect(server.captured.authPlain.length).toBe(1);
      expect(server.captured.authLogin.length).toBe(0);
      // The AUTH payload carries the credentials, so it must never be echoed back.
      expect(result.detail).toBeNull();
      expect(server.captured.envelopeFrom[0]).toBe("MAIL FROM:<demomcp7@gmail.com>");
      expect(server.captured.recipients[0]).toBe("RCPT TO:<user@example.com>");
      expect(server.captured.data[0]).toContain("Subject: hi");
      expect(server.captured.data[0]!.endsWith("\r\n")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("falls back to AUTH LOGIN only when PLAIN is not implemented, not when it is rejected", async () => {
    const fallback = await startSmtpServer({ authPlainCode: 504 });
    try {
      const result = await smtpSend({ ...MESSAGE, connect: fallback.connect });
      expect(result.ok).toBe(true);
      expect(fallback.captured.authLogin.length).toBeGreaterThan(0);
    } finally {
      await fallback.close();
    }

    // A credential rejection (535) must NOT be retried with a second mechanism.
    const rejected = await startSmtpServer({ authPlainCode: 535 });
    try {
      const result = await smtpSend({ ...MESSAGE, connect: rejected.connect });
      expect(result.ok).toBe(false);
      expect(result.stage).toBe("auth");
      expect(result.code).toBe(535);
      expect(rejected.captured.authLogin.length).toBe(0);
    } finally {
      await rejected.close();
    }
  });

  it("reports the failing stage and never leaks the password", async () => {
    const server = await startSmtpServer({ rcptCode: 550 });
    try {
      const result = await smtpSend({ ...MESSAGE, connect: server.connect });
      expect(result.ok).toBe(false);
      expect(result.stage).toBe("rcpt_to");
      expect(result.code).toBe(550);
      expect(result.detail ?? "").not.toContain("app-password-secret");
      expect(JSON.stringify(result)).not.toContain("app-password-secret");
    } finally {
      await server.close();
    }
  });

  it("dot-stuffs a body line that begins with a period and terminates with CRLF.CRLF", async () => {
    const server = await startSmtpServer();
    try {
      const result = await smtpSend({
        ...MESSAGE,
        message: "Subject: dots\r\n\r\n.hidden\r\nvisible\r\n",
        connect: server.connect,
      });
      expect(result.ok).toBe(true);
      expect(server.captured.data[0]).toContain("\r\n..hidden\r\n");
      expect(server.captured.data[0]).not.toContain("\r\n.hidden\r\n");
    } finally {
      await server.close();
    }
  });

  it("never throws when the server is unreachable", async () => {
    const connect: SmtpConnect = () => {
      throw new Error("connection refused");
    };
    const result = await smtpSend({ ...MESSAGE, connect });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("The mail server could not be reached.");
  });
});

/* -------------------------------------------------------------- MIME builder */

describe("MIME message construction", () => {
  it("emits the DEMO sender identity and blocks header injection", () => {
    const mime = buildMimeMessage({
      from: "demomcp7@gmail.com",
      fromName: "DEMO MCP",
      to: "user@example.com",
      replyTo: "demomcp7@gmail.com",
      subject: "Verify\r\nBcc: attacker@example.com",
      text: "line one\nline two",
    });
    expect(mime).toContain('From: "DEMO MCP" <demomcp7@gmail.com>');
    expect(mime).toContain("To: <user@example.com>");
    expect(mime).toContain("Reply-To: <demomcp7@gmail.com>");
    // The injected CRLF is flattened, so no Bcc header can exist.
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain("X-Auto-Response-Suppress: All");
    expect(mime).toContain("\r\n\r\nline one\r\nline two\r\n");
    const [headers, body] = mime.split("\r\n\r\n");
    expect(headers!.split("\r\n").every((line) => /^[A-Za-z-]+:/.test(line))).toBe(true);
    expect(body).toBeDefined();
  });

  it("encodes a non-ASCII subject per RFC 2047", () => {
    const mime = buildMimeMessage({
      from: "demomcp7@gmail.com", fromName: null, to: "u@example.com", replyTo: null,
      subject: "Résumé du compte", text: "ok",
    });
    expect(mime).toContain("Subject: =?UTF-8?B?");
  });
});

/* ------------------------------------------------------ provider policy rules */

describe("sender-identity policy", () => {
  it("defaults to the DEMO sender identity", () => {
    expect(DEFAULT_EMAIL_FROM).toBe("DEMO MCP <demomcp7@gmail.com>");
    expect(parseFrom(DEFAULT_EMAIL_FROM)).toEqual({ address: "demomcp7@gmail.com", name: "DEMO MCP" });
    expect(parseFrom("plain@example.com")).toEqual({ address: "plain@example.com", name: null });
  });

  it("accepts Gmail SMTP submission once the App Password secret exists", () => {
    const config = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "gmail",
      EMAIL_FROM: DEFAULT_EMAIL_FROM,
      SMTP_PASSWORD: "app-password",
    });
    expect(config.configured).toBe(true);
    expect(config.provider).toBe("gmail");
    expect(config.from).toBe("demomcp7@gmail.com");
    expect(config.smtp).toEqual({ host: "smtp.gmail.com", port: 465, secureTransport: "on" });
  });

  it("refuses Gmail without the App Password, naming the secret", () => {
    const config = resolveAccountEmailConfig({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: DEFAULT_EMAIL_FROM });
    expect(config.configured).toBe(false);
    expect(config.reason).toContain("SMTP_PASSWORD");
    expect(config.reason).toContain("App Password");
  });

  it("refuses a Gmail send from a mailbox other than the authenticated one", () => {
    const config = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "gmail",
      EMAIL_FROM: "DEMO <someone.else@gmail.com>",
      SMTP_USERNAME: "demomcp7@gmail.com",
      SMTP_PASSWORD: "app-password",
    });
    expect(config.configured).toBe(false);
    expect(config.reason).toContain("cannot send as another address");
  });

  it("refuses an unverifiable From domain on Resend instead of failing per send", () => {
    const config = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: DEFAULT_EMAIL_FROM,
      RESEND_API_KEY: "re_test_key",
    });
    expect(config.configured).toBe(false);
    expect(config.reason).toContain("cannot be verified");
    expect(config.reason).toContain("EMAIL_REPLY_TO");
  });

  it("accepts Resend for an owned From domain and keeps the Gmail identity as reply-to", () => {
    const config = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "DEMO MCP <auth@demomcp.example>",
      EMAIL_REPLY_TO: "demomcp7@gmail.com",
      RESEND_API_KEY: "re_test_key",
    });
    expect(config.configured).toBe(true);
    expect(config.from).toBe("auth@demomcp.example");
    expect(config.replyTo).toBe("demomcp7@gmail.com");
  });

  it("allows plaintext only on loopback, for local end-to-end runs", () => {
    const local = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "smtp", EMAIL_FROM: "DEMO MCP <demomcp7@gmail.com>", SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "2525", SMTP_SECURE: "false", SMTP_USERNAME: "demomcp7@gmail.com", SMTP_PASSWORD: "local-only",
    });
    expect(local.configured).toBe(true);
    expect(local.smtp).toEqual({ host: "127.0.0.1", port: 2525, secureTransport: "off" });
    // The same setting pointed at a real relay stays refused.
    const remote = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "smtp", EMAIL_FROM: "auth@example.com", SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "2525", SMTP_SECURE: "false", SMTP_USERNAME: "u", SMTP_PASSWORD: "p",
    });
    expect(remote.configured).toBe(false);
  });

  it("rejects an unencrypted or port-25 relay, and an unset provider", () => {
    expect(resolveAccountEmailConfig({}).configured).toBe(false);
    const insecure = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "smtp", EMAIL_FROM: "auth@example.com", SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USERNAME: "u", SMTP_PASSWORD: "p",
    });
    expect(insecure.configured).toBe(false);
    expect(insecure.reason).toContain("unencrypted SMTP is not supported");
    const port25 = resolveAccountEmailConfig({
      EMAIL_PROVIDER: "smtp", EMAIL_FROM: "auth@example.com", SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "25", SMTP_USERNAME: "u", SMTP_PASSWORD: "p",
    });
    expect(port25.configured).toBe(false);
    expect(port25.reason).toContain("port 25");
  });
});

/* ------------------------------------------------------------- delivery calls */

describe("sendAccountEmail", () => {
  it("reports the reason instead of pretending, when email is off", async () => {
    const result = await sendAccountEmail({}, { to: "user@example.com", subject: "s", text: "t" }, {});
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("EMAIL_PROVIDER");
    expect(result.provider).toBeNull();
  });

  it("reports a provider rejection as a failure (never a fake success)", async () => {
    const result = await sendAccountEmail(
      { EMAIL_PROVIDER: "resend", EMAIL_FROM: "DEMO <auth@example.com>", RESEND_API_KEY: "re_test_key" },
      { to: "user@example.com", subject: "s", text: "t" },
      { fetch: (async () => new Response("nope", { status: 422 })) as unknown as typeof fetch },
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("422");
    expect(result.provider).toBe("resend");
  });

  it("sends through the Resend HTTPS API with the configured sender and reply-to", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ id: "mail_1" });
    }) as unknown as typeof fetch;
    const result = await sendAccountEmail(
      { EMAIL_PROVIDER: "resend", EMAIL_FROM: "DEMO MCP <auth@example.com>", EMAIL_REPLY_TO: "demomcp7@gmail.com", RESEND_API_KEY: "re_test_key" },
      { to: "user@example.com", subject: "Verify", text: "code" },
      { fetch: fetcher },
    );
    expect(result.sent).toBe(true);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.body.from).toBe("DEMO MCP <auth@example.com>");
    expect(calls[0]!.body.reply_to).toBe("demomcp7@gmail.com");
  });

  it("delivers through the injected SMTP socket for a gmail-configured deployment", async () => {
    const server = await startSmtpServer();
    try {
      const result = await sendAccountEmail(
        { EMAIL_PROVIDER: "gmail", EMAIL_FROM: DEFAULT_EMAIL_FROM, SMTP_PASSWORD: "app-password-secret" },
        { to: "user@example.com", subject: "Verify your DEMO account", text: "code inside" },
        { connect: server.connect },
      );
      expect(result.sent).toBe(true);
      expect(result.provider).toBe("gmail");
      expect(server.captured.recipients[0]).toBe("RCPT TO:<user@example.com>");
      expect(server.captured.data[0]).toContain('From: "DEMO MCP" <demomcp7@gmail.com>');
      expect(server.captured.data[0]).toContain("code inside");
    } finally {
      await server.close();
    }
  });

  it("refuses an unusable recipient without contacting any provider", async () => {
    let called = 0;
    const fetcher = (async () => { called++; return Response.json({}); }) as unknown as typeof fetch;
    const result = await sendAccountEmail(
      { EMAIL_PROVIDER: "resend", EMAIL_FROM: "DEMO <auth@example.com>", RESEND_API_KEY: "k" },
      { to: "not-an-email", subject: "s", text: "t" },
      { fetch: fetcher },
    );
    expect(result.sent).toBe(false);
    expect(called).toBe(0);
  });
});

/* ------------------------------------------------------------------- templates */

describe("account email copy", () => {
  it("carries both a one-click link and an 8-character code for verification", () => {
    const message = verificationEmail("ABCD2345", "https://demo.example/#/verify?token=abc", 30);
    expect(message.text).toContain("ABCD2345");
    expect(message.text).toContain("https://demo.example/#/verify?token=abc");
    expect(message.text).toContain("30 minutes");
    expect(message.subject).toContain("ABCD2345");
  });

  it("points the reset link at the real site and states the expiry", () => {
    const message = resetEmail("https://demo.example", "tok_1234567890", 30);
    expect(message.text).toContain("https://demo.example/#/reset?token=tok_1234567890");
    expect(message.text).toContain("30 minutes");
  });

  it("explains a password change and an account deletion", () => {
    const changed = passwordChangedEmail("https://demo.example", Date.UTC(2026, 8, 28));
    expect(changed.subject).toContain("password was changed");
    expect(changed.text).toContain("https://demo.example/#/auth");
    const deleted = accountDeletedEmail(Date.UTC(2026, 8, 28));
    expect(deleted.subject).toContain("deleted");
    expect(deleted.text).toContain("every active session");
    expect(deleted.text).toContain("Roblox grant");
  });
});
