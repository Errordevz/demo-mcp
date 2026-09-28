/**
 * Password hashing and policy for DEMO accounts.
 *
 * PBKDF2-HMAC-SHA256 with a per-user 128-bit salt. WebCrypto (present in every
 * Workers isolate) has no argon2/bcrypt primitive, so PBKDF2 at 210,000
 * iterations — the OWASP password-storage recommendation for PBKDF2-HMAC-SHA256 —
 * is the strongest established algorithm available server-side here. The
 * parameters travel with the hash (`pbkdf2$<iterations>$<salt>$<derived>`) so the
 * work factor can be raised without breaking existing users.
 */

const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface PasswordCheck {
  ok: boolean;
  reason?: string;
}

/** Deliberately short denylist of the most common passwords; length + entropy do the heavy lifting. */
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "1234567890", "123456789", "12345678", "qwerty123",
  "letmein123", "iloveyou", "adminadmin", "roblox123", "demodemo1", "welcome123",
]);

export function checkPasswordPolicy(password: string): PasswordCheck {
  if (typeof password !== "string") return { ok: false, reason: "A password is required." };
  if (password.length < 10) return { ok: false, reason: "Use at least 10 characters." };
  if (password.length > 128) return { ok: false, reason: "Passwords are limited to 128 characters." };
  if (!/[a-z]/i.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, reason: "Use at least one letter and one number." };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return { ok: false, reason: "That password is too common; choose something harder to guess." };
  return { ok: true };
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of arr) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const text = atob(value);
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt).buffer as ArrayBuffer, iterations },
    key,
    KEY_BYTES * 8,
  );
}

/** Format: `pbkdf2$<iterations>$<salt b64>$<derived key b64>` — self-describing, migration-friendly. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

/** Constant-time comparison; never throws on malformed stored values. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 5_000_000) return false;
  const salt = fromBase64(parts[2]!);
  const expected = fromBase64(parts[3]!);
  if (!salt || !expected || expected.length !== KEY_BYTES) return false;
  try {
    const derived = new Uint8Array(await derive(password, salt, iterations));
    if (derived.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < derived.length; i++) diff |= derived[i]! ^ expected[i]!;
    return diff === 0;
  } catch {
    return false;
  }
}

/** True when the stored hash predates the current work factor (rehash on next login). */
export function passwordNeedsRehash(stored: string): boolean {
  const parts = String(stored ?? "").split("$");
  return parts.length === 4 && parts[0] === "pbkdf2" && Number(parts[1]) !== ITERATIONS;
}
