// Test helpers for engine unit tests: a temp dir, a manual clock, and a log opened on real SQLite.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Clock, Db, Processes } from "../src/deps/types.js";
import { openRealDb } from "../src/deps/real/db.js";
import { realExec } from "../src/deps/real/exec.js";
import type { ExecOptions } from "../src/deps/types.js";
import { openLog, type Log } from "../src/log/db.js";
import { redactor } from "../src/log/redact.js";
import type { AppendContext } from "../src/log/append.js";

/**
 * The git binary itself (its `--exec-path` folder holds it). Tests pass git an environment with no PATH, so a bare
 * `git` resolves through the OS default path, which on macOS is the xcrun shim at /usr/bin/git (about 90 ms a
 * call); only the program path changes, never the environment the test gives.
 */
const GIT = (() => {
  try {
    const file = path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
      process.platform === "win32" ? "git.exe" : "git");
    return existsSync(file) ? file : "git";
  } catch {
    return "git";
  }
})();

/** realGit with the git binary found once (the same arguments and environment). */
export function testGit(args: string[], o: ExecOptions) {
  return realExec(GIT, args, o);
}

const made = new Set<string>();

/** Removes every temp folder this process made once it exits with all tests passed (a failing run keeps them). */
function removeMade(): void {
  if ((process.exitCode ?? 0) !== 0) return;
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  made.clear();
}

/** A `<tmpdir>/<prefix>XXXXXX` folder, removed at a passing exit. */
export function tempDir(prefix = "rafi-engine-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  if (!made.size) process.on("exit", removeMade);
  made.add(dir);
  return dir;
}

/** A clock whose sleeps move time at once and are recorded. */
export function manualClock(start = Date.parse("2026-11-01T14:00:00Z")): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => new Date(now),
    timer: () => () => undefined,
    async sleep(ms) {
      slept.push(ms);
      now += ms;
    },
  };
}

/** A db whose writes report SQLITE_BUSY until `busyUntil(clock)` is false. */
export function busyDb(file: string, busy: () => boolean): Db {
  const real = openRealDb(file);
  const fail = () => {
    if (busy()) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  };
  return {
    exec(sql) { if (sql.startsWith("BEGIN")) fail(); real.exec(sql); },
    prepare: (sql) => real.prepare(sql),
    pragma: (sql, o) => real.pragma(sql, o),
    close: () => real.close(),
    get inTransaction() { return real.inTransaction; },
  };
}

export async function testLog(o: { dir?: string; clock?: Clock; db?: (file: string) => Db } = {}) {
  const dir = o.dir ?? tempDir();
  const clock = o.clock ?? manualClock();
  const file = path.join(dir, "state.sqlite3");
  const log: Log = await openLog({ db: { open: o.db ?? ((f) => openRealDb(f)) }, clock }, file);
  let n = 0;
  const ctx: AppendContext = {
    log, redact: redactor({ RAFI_TEST_TOKEN: "s3cr3t-value-123" }), now: () => clock.now(),
    newId: () => `id-${String(++n).padStart(6, "0")}`,
  };
  return { dir, file, clock, log, ctx };
}

export function processesFor(instance: string, alive: (instance: string) => boolean): Processes {
  return {
    self: () => ({ instance, host: "h", pid: 1, startedAt: null }),
    isAlive: async (owner) => alive(owner.instance),
  };
}
