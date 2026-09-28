/**
 * Type declarations for `scripts/safe-diagnostics.mjs` so the TypeScript test
 * suite can import the redaction helpers directly: `npm run typecheck` covers
 * the tests directory, and `allowJs` is off, so an imported `.mjs` module needs
 * a declaration file.
 */

/** Bytes read from a response body when building a diagnostic message. */
export declare const MAX_DIAGNOSTIC_BYTES: number;
/** Characters of that body actually printed. */
export declare const MAX_DIAGNOSTIC_CHARS: number;
/** Bytes read when a body is expected to be parsed (public JSON routes). */
export declare const MAX_PAYLOAD_BYTES: number;
/** Headers that may carry a credential and are therefore never reported. */
export declare const FORBIDDEN_HEADER: RegExp;

export interface BoundedBody {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

export declare function redactSecrets(value: unknown, maxLength?: number): string;
export declare function readBoundedBody(response: Response, maxBytes?: number): Promise<BoundedBody>;
export declare function setsCookie(response: Response): boolean;
export declare function safeHeaderSummary(response: Response): string[];
export declare function safeRedirectTarget(response: Response): string | null;
export declare function formatResponseSummary(
  response: Response,
  read: BoundedBody,
  options?: { label?: string },
): string;
export declare function describeResponse(
  response: Response,
  options?: { label?: string; maxBytes?: number },
): Promise<string>;
export declare function fingerprintSecret(value: string, sha256Hex: (value: string) => string): string;
