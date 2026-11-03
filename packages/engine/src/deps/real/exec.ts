// Real child processes, always with argument arrays and never a shell (ARCH 2.4).
import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "../types.js";

export function realExec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ? { ...o.env } : undefined, shell: false,
      windowsHide: true, timeout: o.timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: stderr + error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (o.input !== undefined) child.stdin.end(o.input);
    else child.stdin.end();
  });
}

export function realGit(args: string[], o: ExecOptions): Promise<ExecResult> {
  return realExec("git", args, o);
}
