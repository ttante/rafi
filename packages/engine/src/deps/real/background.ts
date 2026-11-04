// The real deps.spawnBackground (ARCH 8.7, D5): `--detach` starts one ordinary rafi with the given arguments, in a
// new session (so closing the terminal doesn't stop it), stdin closed, stdout and stderr appended to the log file,
// with rafi's own environment and nothing added (no hand-off variables, ENV-5). Unref'd: the parent can exit.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

/** `entry`: the rafi script this process runs (the launcher), so the child is the same ordinary command. */
export function backgroundSpawner(entry: string) {
  return (argv: string[], o: { cwd: string; log: string }): { pid: number } => {
    const log = path.resolve(o.cwd, o.log);
    mkdirSync(path.dirname(log), { recursive: true });
    const out = openSync(log, "a");
    try {
      const child = spawn(process.execPath, [entry, ...argv], { cwd: o.cwd, detached: true, windowsHide: true,
        stdio: ["ignore", out, out], env: process.env });
      child.unref();
      return { pid: child.pid ?? 0 };
    } finally {
      closeSync(out);
    }
  };
}
