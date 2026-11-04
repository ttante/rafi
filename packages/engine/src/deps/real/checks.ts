// The real deps.checks (ARCH 8.2, 6.9): spawns a test command behind ask/grants.ts's prefix (C40), streams its
// output, ends its whole process group on abort; and finds whether this machine has a sandbox.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { CheckResult, CheckRun, SandboxFacts } from "../types.js";

const OUTPUT_LIMIT = 4 * 1024 * 1024;

function onPath(name: string, envPath: string | undefined): string | null {
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch { /* not here */ }
  }
  return null;
}

function probe(): SandboxFacts {
  if (process.platform === "darwin") {
    try {
      accessSync("/usr/bin/sandbox-exec", constants.X_OK);
      return { platform: "darwin", sandboxExec: true };
    } catch {
      return { platform: "darwin", sandboxExec: false };
    }
  }
  const bwrap = process.platform === "win32" ? null : onPath("bwrap", process.env.PATH);
  const bwrapWorks = bwrap !== null && spawnSync(bwrap, ["--ro-bind", "/", "/", "--unshare-net", "--", "true"],
    { stdio: "ignore", timeout: 10_000 }).status === 0;
  return { platform: process.platform, bwrap, bwrapWorks };
}

export function realChecks() {
  let facts: SandboxFacts | null = null;
  return {
    run(cmd: string, args: string[], o: CheckRun): Promise<CheckResult> {
      const argv = [...o.sandbox, cmd, ...args];
      const started = performance.now();
      return new Promise((resolve) => {
        const group = process.platform !== "win32";
        const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { ...o.env }, shell: false,
          windowsHide: true, detached: group, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let aborted = false;
        const take = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (output.length < OUTPUT_LIMIT) output += text;
          o.onOutput(text);
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        const kill = () => {
          aborted = true;
          try { if (group && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {
            /* already gone */
          }
        };
        if (o.signal.aborted) kill();
        o.signal.addEventListener("abort", kill, { once: true });
        const done = (code: number | null, signal: string | null, extra = "") => {
          o.signal.removeEventListener("abort", kill);
          const durationMs = Math.round(performance.now() - started);
          resolve({ code, signal, aborted, durationMs, output: output + extra });
        };
        child.on("error", (error) => done(null, null, error.message));
        child.on("close", (code, signal) => done(code, signal));
      });
    },
    async sandbox(): Promise<SandboxFacts> {
      facts ??= probe();
      return facts;
    },
  };
}
