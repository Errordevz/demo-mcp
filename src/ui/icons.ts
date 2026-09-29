/**
 * DEMO brand marks for the browser chrome.
 *
 * Two reasons this lives in code instead of a build step:
 *
 *  1. the UI is one self-contained document with no third-party requests, and
 *  2. browsers request `/favicon.ico` (and Safari `/apple-touch-icon.png`) on
 *     their own. With no icon declared and no route serving one, every visit
 *     logged a 404 in the console — verified live against the deployment
 *     (`GET /favicon.ico` → `404 Not Found`). Declaring the icons and serving
 *     the routes removes that noise without adding a dependency.
 *
 * The PNGs are generated from the same geometry as the SVG below (dark rounded
 * tile, light "D"), carry no metadata, and contain nothing but pixels.
 */

/** SVG mark, used as the primary `rel="icon"` (any size, scales cleanly). */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="DEMO">
  <rect width="32" height="32" rx="7" fill="#0a0b0e"/>
  <path fill="#f0f3f7" d="M9 8h4.2v16H9zM13.2 8h3.4a8 8 0 0 1 0 16h-3.4v-4.2h3.4a3.8 3.8 0 0 0 0-7.6h-3.4z"/>
</svg>`;

/** 32x32 PNG, served at `/favicon.ico` for clients that request it by convention. */
export const FAVICON_PNG_BASE64 = [
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABdElEQVR42sXXS26DMBAG4Flj4xe2eeQB4bycgduguU6lLrqc",
    "qk0WCQEDDY2Rvg0j5v9XSANw9/iqFb5qO1+1g69a3Nlw2y1g6nHlpXflhd6kH4U3vSsberNrCVc0whUNRSLAFnVni5oi6cDm",
    "9WDzmiIZwOZntPmZIkHI/Akzf6JI1hX4+PyatEsB449o/JFC5grcW9oxA8G4Axp3oJA1BX5LLOyZsG+BP5RA0LZCbSsKGYfM",
    "vb+frfRagR1KIOisRJ2VFPIUsHEegKCyAlVWUMg4YOs8AEGZApUpKOQpYOM8AEGaHKXJKWQcsHUegCC1R6k9hTwFBGbj+YLX",
    "CrwYfi0glEOhHIVs+REt7RrZt8DG8FsBaVFISyGrwhd2zEBIZYapzChkLnTpuxXWFfhHCFwY5MJQJD8F9MCFpkgG4KnueKop",
    "kg5YqgRLFUVyvRMZVz3jit7s8T5kXPaMS3qTfvJCTpgQCRNdwsSQMIE7G267H87zb2+9FrkHX7VBAAAAAElFTkSuQmCC"
].join("");

/** 180x180 PNG, served at `/apple-touch-icon.png`. */
export const APPLE_TOUCH_ICON_PNG_BASE64 = [
    "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"
].join("");

/** Decode a base64 icon constant into the bytes an HTTP response needs. */
export function iconBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The icons as `data:` URLs — handy for tests and for any embedding surface. */
export const iconAssets = {
  svg: FAVICON_SVG,
  faviconPngDataUrl: `data:image/png;base64,${FAVICON_PNG_BASE64}`,
  appleTouchDataUrl: `data:image/png;base64,${APPLE_TOUCH_ICON_PNG_BASE64}`,
} as const;

const ICON_HEADERS: HeadersInit = {
  // Icons are static bytes: cache them, never sniff them, never let a proxy
  // rewrite the type. `securityHeaders()` is applied by the caller.
  "Cache-Control": "public, max-age=86400",
  "X-Content-Type-Options": "nosniff",
};

/** `/favicon.ico`, `/favicon.png` and `/favicon.svg`; `null` for other paths. */
export function faviconRoute(pathname: string): Response | null {
  if (pathname === "/favicon.svg") {
    return new Response(FAVICON_SVG, { headers: { ...ICON_HEADERS, "Content-Type": "image/svg+xml; charset=UTF-8" } });
  }
  if (pathname === "/favicon.ico" || pathname === "/favicon.png") {
    return new Response(iconBytes(FAVICON_PNG_BASE64), { headers: { ...ICON_HEADERS, "Content-Type": "image/png" } });
  }
  return null;
}

/** `/apple-touch-icon.png` (and iOS's legacy precomposed spelling). */
export function appleTouchIconRoute(pathname: string): Response | null {
  if (pathname === "/apple-touch-icon.png" || pathname === "/apple-touch-icon-precomposed.png") {
    return new Response(iconBytes(APPLE_TOUCH_ICON_PNG_BASE64), { headers: { ...ICON_HEADERS, "Content-Type": "image/png" } });
  }
  return null;
}

/** Every icon route in one call, for the Worker entrypoint. */
export function iconRoute(pathname: string): Response | null {
  return faviconRoute(pathname) ?? appleTouchIconRoute(pathname);
}
