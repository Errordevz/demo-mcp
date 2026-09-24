/**
 * Quota-bounded in-memory filesystem for temporary Git repositories.
 *
 * Workers have no local disk, so `git_repository` operates on a MemoryFs that
 * satisfies isomorphic-git's `FsClient` contract. Two properties matter:
 *
 *  - **Bounded**: every write counts against a byte budget and a file-count
 *    budget. A repo whose pack exceeds the configured cap fails mid-clone with
 *    a stable `size_limit_exceeded` error instead of exhausting the isolate.
 *  - **Disposable**: `dispose()` clears all maps — the repository exists only
 *    as long as the tool call (or the small isolate cache entry) that created
 *    it. No repository bytes ever touch persistent storage.
 */

import { BrowserError } from "../core/errors.js";

interface FsEntry {
  bytes: Uint8Array;
}

export interface MemoryFsOptions {
  maxBytes: number;
  maxFiles?: number;
  label?: string;
}

function norm(path: string): string {
  const parts = String(path).split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return "/" + parts.join("/");
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

export class MemoryFs {
  private files = new Map<string, FsEntry>();
  private dirs = new Set<string>(["/"]);
  bytesWritten = 0;
  readBytes = 0;
  private disposed = false;

  constructor(private readonly options: MemoryFsOptions) {}

  get fileCount(): number {
    return this.files.size;
  }

  dispose(): void {
    this.files.clear();
    this.dirs.clear();
    this.disposed = true;
  }

  private assertAlive(): void {
    if (this.disposed) throw new BrowserError("session_expired", "The temporary Git workspace was cleaned up; run the operation again.", { retryable: true });
  }

  private assertBudget(size: number): void {
    if (this.bytesWritten + size > this.options.maxBytes) {
      throw new BrowserError("size_limit_exceeded", `The repository data exceeds the ${(this.options.maxBytes / (1024 * 1024)).toFixed(0)} MB temporary-workspace limit.`, {
        hint: "Use a smaller repository, or depth: 1 / single_branch to fetch less history.",
        retryable: false,
      });
    }
    const maxFiles = this.options.maxFiles ?? 200_000;
    if (this.files.size + 1 > maxFiles) {
      throw new BrowserError("size_limit_exceeded", `The repository exceeds the ${maxFiles} file limit for the temporary workspace.`, { retryable: false });
    }
  }

  private touch(): void {
    if (this.disposed) throw new BrowserError("session_expired", "The temporary Git workspace was cleaned up.", { retryable: true });
  }

  /** The `isomorphic-git` FsClient surface (promise flavour). */
  readonly promises = {
    readFile: async (path: string, encoding?: unknown): Promise<Uint8Array | string> => {
      this.assertAlive();
      const entry = this.files.get(norm(path));
      if (!entry) throw enoent("open", path);
      this.readBytes += entry.bytes.byteLength;
      const wantUtf8 = encoding === "utf8" || (typeof encoding === "object" && encoding !== null && (encoding as { encoding?: string }).encoding === "utf8");
      if (wantUtf8) return new TextDecoder("utf-8", { fatal: false }).decode(entry.bytes);
      return entry.bytes;
    },
    writeFile: async (path: string, data: Uint8Array | ArrayBuffer | string): Promise<void> => {
      this.assertAlive();
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
      const existing = this.files.get(norm(path));
      const delta = bytes.byteLength - (existing?.bytes.byteLength ?? 0);
      if (delta > 0) this.assertBudget(delta);
      // Copy: callers may reuse the buffer afterwards.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      await this.promises.mkdir(parentOf(norm(path)), { recursive: true });
      this.files.set(norm(path), { bytes: copy });
      this.bytesWritten += Math.max(0, delta);
    },
    unlink: async (path: string): Promise<void> => {
      this.touch();
      const key = norm(path);
      const entry = this.files.get(key);
      if (!entry) throw enoent("unlink", path);
      this.files.delete(key);
      this.bytesWritten = Math.max(0, this.bytesWritten - entry.bytes.byteLength);
    },
    readdir: async (path: string, options?: { recursive?: boolean }): Promise<string[]> => {
      this.touch();
      const dir = norm(path);
      if (!this.dirs.has(dir) && ![...this.files.keys()].some((f) => f.startsWith(dir + "/"))) {
        // isomorphic-git probes directories that may not exist; empty beats throwing
        // for the paths it tolerates, and mkdir(-p) covers the rest.
        if (options?.recursive) return [];
        throw enoent("scandir", path);
      }
      const out: string[] = [];
      for (const file of this.files.keys()) {
        if (parentOf(file) === dir) out.push(file.slice(dir === "/" ? 1 : dir.length + 1));
        else if (options?.recursive && file.startsWith(dir + "/")) out.push(file.slice(dir === "/" ? 1 : dir.length + 1));
      }
      if (!options?.recursive) {
        for (const d of this.dirs) {
          if (parentOf(d) === dir && d !== "/") out.push(d.slice(dir === "/" ? 1 : dir.length + 1));
        }
      }
      return out;
    },
    mkdir: async (path: string, options?: { recursive?: boolean }): Promise<void> => {
      this.touch();
      const full = norm(path);
      if (!options?.recursive) {
        if (this.dirs.has(full)) {
          const error = new Error(`EEXIST: file already exists, mkdir '${path}'`) as Error & { code: string };
          error.code = "EEXIST";
          throw error;
        }
        const parent = parentOf(full);
        if (full !== "/" && !this.dirs.has(parent)) throw enoent("mkdir", path);
        this.dirs.add(full);
        return;
      }
      const segments = full === "/" ? [] : full.slice(1).split("/");
      let current = "";
      for (const segment of segments) {
        current = `${current}/${segment}`;
        this.dirs.add(current);
      }
    },
    rmdir: async (path: string, options?: { recursive?: boolean }): Promise<void> => {
      this.touch();
      const full = norm(path);
      const children = [...this.files.keys()].filter((f) => f.startsWith(full + "/"));
      if (children.length > 0 && !options?.recursive) {
        const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`) as Error & { code: string };
        error.code = "ENOTEMPTY";
        throw error;
      }
      for (const child of children) {
        this.bytesWritten = Math.max(0, this.bytesWritten - (this.files.get(child)?.bytes.byteLength ?? 0));
        this.files.delete(child);
      }
      this.dirs.delete(full);
    },
    stat: async (path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mode: number }> => {
      this.touch();
      const full = norm(path);
      const file = this.files.get(full);
      if (file) return { isDirectory: () => false, isFile: () => true, size: file.bytes.byteLength, mode: 0o644 };
      if (this.dirs.has(full)) return { isDirectory: () => true, isFile: () => false, size: 0, mode: 0o755 };
      throw enoent("stat", path);
    },
    lstat: async (path: string) => {
      return this.promises.stat(path);
    },
    readlink: async (): Promise<string> => {
      this.touch();
      throw new Error("EINVAL: no symlinks in the memory filesystem");
    },
    symlink: async (): Promise<void> => {
      this.touch();
      // isomorphic-git never needs symlinks for bare reads; accept as no-op so
      // code paths that probe symlink support do not fail.
    },
    chmod: async (): Promise<void> => {
      this.touch();
    },
  };
}

function enoent(op: string, path: string): Error & { code: string } {
  const error = new Error(`ENOENT: no such file or directory, ${op} '${path}'`) as Error & { code: string };
  error.code = "ENOENT";
  return error;
}
