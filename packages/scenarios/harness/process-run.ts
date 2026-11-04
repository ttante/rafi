// The process set's live runs (M4 slice 11; SCN 7.10): the built launcher started without waiting, in a real PTY
// (Ctrl+C is a real SIGINT to the foreground group), the fakes' operation logs, file hashes, and process checks.
// Real time throughout; every wait has a deadline.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertFreshBuild, LAUNCHER } from "./process.js";
import { madeTemp } from "./temp.js";

export interface Live {
  readonly child: ChildProcess;
  readonly pid: number;
  /** Everything printed so far (stdout and stderr, or the PTY). */
  output(): string;
  /** Resolves with the exit code (null when killed) and the signal. */
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
  /** PTY only: bytes to the terminal (`"\u0003"` is Ctrl+C). */
  type(text: string): void;
}

export type LaunchOptions = { cwd: string; pathFirst?: string; env?: Record<string, string>; pty?: boolean };

function envFor(o: LaunchOptions): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, TZ: "UTC", RAFI_ENGINE: "next", ...o.env };
  if (o.pathFirst) env.PATH = `${o.pathFirst}${path.delimiter}${env.PATH ?? ""}`;
  return env;
}

// A PTY around one command: its output to stdout, JSON lines on stdin as `{"write": "..."}` (os.write to the master,
// so "\u0003" is the terminal's Ctrl+C); exits with the command's exit code (128+n for a signal).
const DRIVER = String.raw`
import json, os, pty, select, struct, sys, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
ctl, pending, status, open_ = 0, b"", None, True
while True:
    watch = ([fd] if open_ else []) + ([ctl] if ctl is not None else [])
    readable, _, _ = select.select(watch, [], [], 0.05)
    if fd in readable:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if chunk:
            os.write(1, chunk)
        else:
            open_ = False
    if ctl is not None and ctl in readable:
        data = os.read(ctl, 65536)
        if not data:
            ctl = None
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            if line.strip() and open_:
                os.write(fd, json.loads(line)["write"].encode())
    if status is None:
        ended, st = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = st
    if status is not None and (not open_ or fd not in readable):
        break
code = os.waitstatus_to_exitcode(status)
sys.exit(128 - code if code < 0 else code)
`;

const driverFile = (() => {
  const state = { file: "" };
  return () => {
    if (!state.file) {
      state.file = path.join(madeTemp("rafi-pty-"), "rafi_pty_driver.py");
      writeFileSync(state.file, DRIVER);
    }
    return state.file;
  };
})();

/** Starts the built launcher with `args` and returns at once. */
export function launch(args: readonly string[], o: LaunchOptions): Live {
  assertFreshBuild();
  const argv = [process.execPath, LAUNCHER, ...args];
  const child = o.pty
    ? spawn("python3", ["-I", driverFile(), ...argv], { cwd: o.cwd, env: envFor(o), stdio: ["pipe", "pipe", "pipe"] })
    : spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: envFor(o), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (c: Buffer) => { out += c.toString("utf8"); });
  child.stderr!.on("data", (c: Buffer) => { out += c.toString("utf8"); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, output: out }));
  });
  return { child, pid: child.pid!, output: () => out, done,
    type: (text) => { child.stdin?.write(`${JSON.stringify({ write: text })}\n`); } };
}

/** The same, waiting for the exit (no PTY). */
export async function run(args: readonly string[], o: LaunchOptions): Promise<{ code: number | null;
  output: string }> {
  const r = await launch(args, o).done;
  return { code: r.code, output: r.output };
}

/** Polls `check` every 50 ms until it returns something truthy, or throws after `ms` naming `what`. */
export async function waitFor<T>(what: string, check: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export type Op = Record<string, unknown> & { op: string };

/** A fake's operation log (JSON lines); empty while it doesn't exist. */
export function ops(file: string): Op[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Op]; } catch { return []; }
  });
}

/** The provider processes a fake log recorded starting. */
export function providerPids(file: string): number[] {
  return ops(file).filter((o) => o.op === "start" && typeof o.pid === "number").map((o) => o.pid as number);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** sha256 of every file outside `.git/` (with `.rafi/` too unless `withRafi` is false). */
export function hashes(dir: string, o: { withRafi?: boolean } = {}, base = dir, out: Record<string, string> = {}) {
  for (const name of readdirSync(dir).sort()) {
    if (dir === base && (name === ".git" || (o.withRafi === false && name === ".rafi"))) continue;
    const file = path.join(dir, name);
    const info = statSync(file, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isDirectory()) hashes(file, o, base, out);
    else out[path.relative(base, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return out;
}

/** `ps` rows: pid, ppid, pgid and the command line. */
export function processes(): { pid: number; ppid: number; pgid: number; command: string }[] {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), pgid: Number(m![3]), command: m![4]! }));
}
