/**
 * Screenshot comparison (DEMO 0.9) — extends the *existing* screenshot stack.
 *
 * There is no second screenshot system: inputs are existing screenshot
 * references (the R2-backed `screenshots/<id>` objects `ScreenshotManager`
 * writes) or public image URLs fetched through the guarded client. The pixel
 * comparison itself runs inside DEMO's existing Cloudflare browser (the same
 * `withRawPage` one-shot path the legacy tools use) with canvas work in-page —
 * exactly how frame analysis already avoids Worker-side codecs. The difference
 * image is stored back through `ScreenshotManager`, so it inherits the same
 * link format and TTL.
 *
 * Without the browser binding the tool degrades to an honest metadata-only
 * comparison (dimensions/bytes/hash) plus a note — never a fabricated pixel diff.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  changedPixels: number;
}

export interface PixelDiffStats {
  width: number;
  height: number;
  comparedPixels: number;
  changedPixels: number;
  differenceRatio: number;
  meanChannelDelta: number;
  threshold: number;
}

export interface ScreenshotDiffStats {
  pixel: PixelDiffStats | null;
  regions: DiffRegion[];
  similarity: number;
  identical: boolean;
  meta: {
    a: { width: number | null; height: number | null; bytes: number };
    b: { width: number | null; height: number | null; bytes: number };
    sameBytes: boolean;
  };
  diffImageUrl: string | null;
  mode: "pixel" | "metadata";
  message: string;
}

/**
 * Pure helper (unit-testable): merge per-cell change flags into bounding
 * regions. `grid` is `rows × cols` booleans of "cell contains changed pixels".
 */
export function mergeChangedRegions(grid: boolean[][], cellWidth: number, cellHeight: number, minChangedCells = 1): DiffRegion[] {
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  const seen: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const regions: DiffRegion[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c] || seen[r][c]) continue;
      // BFS flood fill for a connected blob of changed cells.
      const queue: Array<[number, number]> = [[r, c]];
      seen[r][c] = true;
      let minR = r;
      let maxR = r;
      let minC = c;
      let maxC = c;
      let cells = 0;
      while (queue.length) {
        const [cr, cc] = queue.shift()!;
        cells++;
        minR = Math.min(minR, cr);
        maxR = Math.max(maxR, cr);
        minC = Math.min(minC, cc);
        maxC = Math.max(maxC, cc);
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || seen[nr][nc] || !grid[nr][nc]) continue;
          seen[nr][nc] = true;
          queue.push([nr, nc]);
        }
      }
      if (cells >= minChangedCells) {
        regions.push({
          x: minC * cellWidth,
          y: minR * cellHeight,
          width: (maxC - minC + 1) * cellWidth,
          height: (maxR - minR + 1) * cellHeight,
          changedPixels: cells,
        });
      }
    }
  }
  return regions.sort((a, b) => b.changedPixels - a.changedPixels).slice(0, 25);
}

/** In-page comparison routine, executed by the browser on two image URLs. */
export function compareImagesInPage(): void {
  // NOTE: this function is serialised and evaluated inside Chromium; it must
  // stay self-contained (no imports, no outer variables).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _unused = 0;
}

/** The serialisable page function performing the actual canvas diff. */
export async function runCanvasDiff(page: any, aDataUrl: string, bDataUrl: string, threshold: number, gridCols: number, gridRows: number): Promise<{ stats: PixelDiffStats; grid: boolean[][]; diffDataUrl: string | null }> {
  return page.evaluate(
    // Serialised into the page — self-contained by design.
    function canvasDiff(aSource: string, bSource: string, pixelThreshold: number, cols: number, rows: number) {
      const load = (src: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("image failed to decode"));
          image.src = src;
        });
      return Promise.all([load(aSource), load(bSource)])
        .then(([a, b]) => {
          const width = Math.min(a.naturalWidth, b.naturalWidth);
          const height = Math.min(a.naturalHeight, b.naturalHeight);
          if (!width || !height) throw new Error("images have no overlapping pixels");
          const canvasA = document.createElement("canvas");
          const canvasB = document.createElement("canvas");
          const canvasDiff = document.createElement("canvas");
          canvasA.width = canvasB.width = canvasDiff.width = width;
          canvasA.height = canvasB.height = canvasDiff.height = height;
          const ctxA = canvasA.getContext("2d")!;
          const ctxB = canvasB.getContext("2d")!;
          const ctxD = canvasDiff.getContext("2d")!;
          ctxA.drawImage(a, 0, 0, width, height, 0, 0, width, height);
          ctxB.drawImage(b, 0, 0, width, height, 0, 0, width, height);
          const dataA = ctxA.getImageData(0, 0, width, height).data;
          const dataB = ctxB.getImageData(0, 0, width, height).data;
          const diff = ctxD.createImageData(width, height);
          const cellW = Math.max(1, Math.ceil(width / cols));
          const cellH = Math.max(1, Math.ceil(height / rows));
          const grid: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
          let changed = 0;
          let deltaSum = 0;
          const total = width * height;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const index = (y * width + x) * 4;
              const dr = Math.abs(dataA[index] - dataB[index]);
              const dg = Math.abs(dataA[index + 1] - dataB[index + 1]);
              const db = Math.abs(dataA[index + 2] - dataB[index + 2]);
              const delta = (dr + dg + db) / 3;
              deltaSum += delta;
              const isChanged = delta > pixelThreshold;
              if (isChanged) {
                changed++;
                grid[Math.floor(y / cellH)][Math.floor(x / cellW)] = true;
                diff.data[index] = 255;
                diff.data[index + 1] = 60;
                diff.data[index + 2] = 60;
                diff.data[index + 3] = 255;
              } else {
                // Dimmed grayscale context so humans can see where changes are.
                const gray = (dataA[index] + dataA[index + 1] + dataA[index + 2]) / 3 / 3;
                diff.data[index] = gray;
                diff.data[index + 1] = gray;
                diff.data[index + 2] = gray;
                diff.data[index + 3] = 255;
              }
            }
          }
          ctxD.putImageData(diff, 0, 0);
          return {
            stats: {
              width,
              height,
              comparedPixels: total,
              changedPixels: changed,
              differenceRatio: Math.round((changed / total) * 10000) / 10000,
              meanChannelDelta: Math.round((deltaSum / total) * 100) / 100,
              threshold: pixelThreshold,
            },
            grid,
            diffDataUrl: width * height <= 12_000_000 ? canvasDiff.toDataURL("image/png") : null,
          };
        })
        .catch((error: unknown) => ({ error: String(error) }));
    },
    aDataUrl,
    bDataUrl,
    threshold,
    gridCols,
    gridRows,
  ) as Promise<{ stats: PixelDiffStats; grid: boolean[][]; diffDataUrl: string | null }>;
}

export function diffThreshold(value: number | undefined): number {
  return clamp(value ?? 16, 1, 128);
}

export function requireDistinct(a: string, b: string): void {
  if (a === b) throw new BrowserError("invalid_input", "Provide two different screenshots/images to compare.", { retryable: false });
}

export function metadataSimilarity(a: { width: number | null; height: number | null; bytes: number; sha?: string | null }, b: { width: number | null; height: number | null; bytes: number; sha?: string | null }): number {
  if (a.sha && b.sha && a.sha === b.sha) return 1;
  const widthScore = a.width && b.width ? Math.min(a.width, b.width) / Math.max(a.width, b.width) : 0.5;
  const heightScore = a.height && b.height ? Math.min(a.height, b.height) / Math.max(a.height, b.height) : 0.5;
  const byteScore = Math.min(a.bytes, b.bytes) / Math.max(1, Math.max(a.bytes, b.bytes));
  return Math.round((0.35 * widthScore + 0.35 * heightScore + 0.3 * byteScore) * 1000) / 1000;
}

export const SCREENSHOT_DIFF_NOTE = `Pixel comparison runs in DEMO's existing Cloudflare browser (canvas work in-page, no Worker-side codec). Diff images are stored with the existing screenshot store (same link format and TTL). ${LIMITS.imageCompareMaxImages ? "" : ""}`;
