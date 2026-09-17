/**
 * Cryptographic primitives for the Roblox OAuth flow.
 *
 * All randomness comes from `crypto.getRandomValues` (Workers WebCrypto), all
 * hashing/digest from `crypto.subtle`. Nothing here is hand-rolled crypto:
 * PKCE is RFC 7636 S256, token-at-rest encryption is AES-256-GCM with a
 * per-record random IV.
 */

import { robloxAuthError } from "./errors.js";

const BASE64URL_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** RFC 7636 code verifier charset (unreserved characters), 43–128 chars long. */
export function randomCodeVerifier(byteLength = 48): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64UrlEncode(bytes);
}

/** Unopaque OAuth `state` / session id: 256 bits of entropy, URL safe. */
export function randomOpaqueToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  // Fixed-width alphabet => no padding characters in a value that travels in a URL.
  return base64UrlEncode(bytes).slice(0, Math.ceil((byteLength * 4) / 3));
}

/** Random string from the base64url alphabet, used for PKCE verifiers directly. */
export function randomAlphabetToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += BASE64URL_ALPHABET[byte % BASE64URL_ALPHABET.length];
  return out;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomCodeVerifier(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)), method: "S256" };
}

/** Verify a PKCE pair the way Roblox's authorization server does. */
export async function verifyPkcePair(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest)) === challenge;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison for short secrets (state, binding hashes). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const CIPHER_PREFIX = "v1";

/**
 * AES-256-GCM at-rest cipher for token material.
 *
 * `ROBLOX_TOKEN_KEY` may either be 32 random bytes in base64/base64url (the
 * recommended form) or any long high-entropy passphrase, which is stretched with
 * HKDF-SHA-256. Both paths end up as a 256-bit key; a low-entropy passphrase is
 * the operator's choice and the setup guide says so in plain words.
 */
export class TokenCipher {
  private constructor(
    readonly key: CryptoKey,
    readonly keyId: string,
  ) {}

  static async deriveKey(input: Uint8Array): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey("raw", input as unknown as ArrayBuffer, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("demo-mcp/roblox-token-v1"),
        info: new TextEncoder().encode("aes-256-gcm"),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /**
   * Build a cipher from the configured secret value.
   * Returns `null` when nothing is configured, so callers can degrade to an
   * explicitly-reported memory-only mode rather than storing plaintext tokens.
   */
  static async fromSecret(value: string | undefined | null): Promise<TokenCipher | null> {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return null;
    let keyBytes: Uint8Array | null = null;
    try {
      const decoded = base64UrlDecode(trimmed);
      if (decoded.length === 32 && /^[A-Za-z0-9+/_=-]+$/.test(trimmed)) keyBytes = decoded;
    } catch {
      keyBytes = null;
    }
    const material = keyBytes ?? new TextEncoder().encode(trimmed);
    if (!keyBytes && trimmed.length < 24) {
      throw robloxAuthError(
        "not_configured",
        "ROBLOX_TOKEN_KEY is too short to be a secure key.",
        { hint: "Use 32 random bytes encoded in base64 (for example `openssl rand -base64 32`), or a passphrase of 32+ characters." },
      );
    }
    const key = await TokenCipher.deriveKey(material);
    // `key` is non-extractable, so the key id fingerprints the *input* instead. That is
    // all it is used for: detecting that ROBLOX_TOKEN_KEY was rotated under a stored
    // record, so the record can ask for re-consent instead of failing opaquely.
    const keyId = (await sha256Hex(base64UrlEncode(material))).slice(0, 12);
    return new TokenCipher(key, keyId);
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as ArrayBuffer }, this.key, new TextEncoder().encode(plaintext));
    return `${CIPHER_PREFIX}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
  }

  async decrypt(sealed: string): Promise<string | null> {
    const [version, ivText, dataText, ...rest] = (sealed ?? "").split(".");
    if (version !== CIPHER_PREFIX || !ivText || !dataText || rest.length > 0) return null;
    try {
      const iv = base64UrlDecode(ivText);
      const data = base64UrlDecode(dataText);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as ArrayBuffer }, this.key, data as unknown as ArrayBuffer);
      return new TextDecoder().decode(plain);
    } catch {
      // Wrong key, torn ciphertext or tampering: all indistinguishable, all fatal for this record.
      return null;
    }
  }
}
