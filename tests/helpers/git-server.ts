/**
 * Test helper: a real Git smart-HTTP server over the local fixture repository.
 *
 * The tests drive the *actual* `git upload-pack --stateless-rpc` binary as the
 * CGI would, so `git_repository` is exercised end-to-end against real packfile
 * negotiation — the same bytes a public GitHub/GitLab/Gitea server produces.
 * The DEMO guard is injected as permissive for 127.0.0.1 *in tests only*.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureRepo {
  dir: string;
  /** Two commits on main + a v1 tag on the first commit + a `dev` branch. */
  headMain: string;
  firstCommit: string;
  cleanup(): void;
}

export function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "demo-git-fixture-"));
  const run = (args: string[]) => {
    const result = spawnSyncCaptured("git", args, dir);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  run(["init", "-q", "-b", "main", "."]);
  run(["config", "user.email", "fixture@example.test"]);
  run(["config", "user.name", "Fixture"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(dir, "README.md"), "# Fixture\n\nHello world fixture.\n");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "main.c"), "int main(void) { return 0; }\n");
  writeFileSync(path.join(dir, ".gitignore"), "build/\n*.log\n!keep.log\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "first commit\n\nAdds README and a source file."]);
  const firstCommit = spawnSyncCaptured("git", ["rev-parse", "HEAD"], dir).stdout.trim();
  run(["tag", "v1"]);
  writeFileSync(path.join(dir, "README.md"), "# Fixture\n\nHello world fixture.\nSecond revision line.\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "second commit"]);
  const headMain = spawnSyncCaptured("git", ["rev-parse", "HEAD"], dir).stdout.trim();
  run(["checkout", "-q", "-b", "dev"]);
  writeFileSync(path.join(dir, "dev.txt"), "dev only\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "dev commit"]);
  run(["checkout", "-q", "main"]);
  return {
    dir,
    headMain,
    firstCommit,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { spawnSync } from "node:child_process";
function spawnSyncCaptured(command: string, args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export interface GitServer {
  url: string;
  requests: Array<{ method: string; path: string }>;
  /** Force HTTP 401 responses (private-repo behaviour). */
  requireAuth: boolean;
  close(): Promise<void>;
}

const SERVICE_HEADER = Buffer.from("001e# service=git-upload-pack\n0000", "utf8");

export function startGitServer(repoDir: string): Promise<GitServer> {
  const requests: Array<{ method: string; path: string }> = [];
  const state = { requireAuth: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.test");
    requests.push({ method: req.method ?? "GET", path: url.pathname });
    if (state.requireAuth) {
      res.writeHead(401, { "www-authenticate": "Basic realm=private" });
      res.end("auth required");
      return;
    }
    if (url.pathname.endsWith("/info/refs") && url.searchParams.get("service") === "git-upload-pack") {
      const child = spawn("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", repoDir], { cwd: repoDir });
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
      res.write(SERVICE_HEADER);
      child.stdout.pipe(res);
      child.on("error", () => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }
    if (url.pathname.endsWith("/git-upload-pack") && req.method === "POST") {
      res.setHeader("content-type", "application/x-git-upload-pack-result");
      const child = spawn("git", ["upload-pack", "--stateless-rpc", repoDir], { cwd: repoDir });
      child.on("error", () => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end();
        }
      });
      req.pipe(child.stdin);
      child.stdout.pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/fixture.git`,
        requests,
        get requireAuth() {
          return state.requireAuth;
        },
        set requireAuth(value: boolean) {
          state.requireAuth = value;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      } as GitServer);
    });
  });
}

/** A guard that allows loopback *for tests only* (production always blocks it). */
export async function permissiveGuard(url: string): Promise<string> {
  return new URL(url).toString();
}
