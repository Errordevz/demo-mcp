/**
 * Cryptographic primitives for DEMO MCP OAuth 2.1 + PKCE:
 *  - PKCE S256 (RFC 7636): random 32-byte code_verifier and SHA-256 code_challenge.
 *  - Cryptographically random opaque tokens for authorization codes, access
 *    tokens, refresh tokens, state and CSRF bindings.
 *  - Constant-time string comparison (`safeEqual`) and SHA-256 hex digest (`sha256Hex`).
 */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let output = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    const c = bytes[i + 2]!;
    output += BASE64URL_ALPHABET[a >> 2]!;
    output += BASE64URL_ALPHABET[((a & 0x03) << 4) | (b >> 4)]!;
    output += BASE64URL_ALPHABET[((b & 0x0f) << 2) | (c >> 6)]!;
    output += BASE64URL_ALPHABET[c & 0x3f]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const a = bytes[i]!;
    output += BASE64URL_ALPHABET[a >> 2]!;
    output += BASE64URL_ALPHABET[(a & 0x03) << 4]!;
  } else if (remaining === 2) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    output += BASE64URL_ALPHABET[a >> 2]!;
    output += BASE64URL_ALPHABET[((a & 0x03) << 4) | (b >> 4)]!;
    output += BASE64URL_ALPHABET[(b & 0x0f) << 2]!;
  }
  return output;
}

export function randomOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toBase64Url(new Uint8Array(digest));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomOpaqueToken(32); // 43 chars of [A-Za-z0-9-_]
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge, method: "S256" };
}

export async function verifyPkcePair(codeVerifier: string, expectedChallenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const computed = await sha256Base64Url(codeVerifier);
  return safeEqual(computed, expectedChallenge);
}

/** Constant-time comparison over UTF-8 bytes so state / CSRF / PKCE checks do not leak prefix length. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
