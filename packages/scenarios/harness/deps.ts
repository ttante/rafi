// Harness Deps (SCN 7.2): real fs, git, exec and db wrapped by the fence; the fake clock, notifier and
// terminal; crash and pause hooks; a seeded random (plan choice C24); a per-"computer" state folder.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeQuery, CodexSpawn, Db, DbStatement, Deps, Env, JsonRpcStream } from "@rafi-ai/engine";
import { openRealDb, realExec, realFs } from "@rafi-ai/engine/deps/real";
import type { FakeClock } from "../fakes/clock.js";
import type { FakeNotifier } from "../fakes/notifier.js";
import type { FakeTerminal } from "../fakes/terminal.js";
import { scriptedChecks, type CheckLogEntry, type FakeTest } from "../fakes/checks.js";
import { defaultAgents, type ScriptState } from "./agents.js";
import type { MemoryServe } from "../fakes/serve.js";
import { httpFetch, type FakeHttp } from "../fakes/http.js";
import { runGh, type FakeGh } from "../fakes/gh.js";
import { Fence } from "./fence.js";
import { hookControl, type HookControl } from "./hooks.js";

/**
 * The git binary itself, found once from the test runner's PATH (its `--exec-path` folder holds the real binary).
 * A computer's environment has no PATH, so a bare `git` resolves through the OS default path, which on macOS is the
 * xcrun shim at /usr/bin/git: about 90 ms a call with no HOME, against 6 ms. Only the program path changes; the
 * environment rafi passes, and every recorded child environment, stay as they were. See `noGlobalConfig` for the one
 * variable added, and only when it changes nothing.
 */
export const GIT_BINARY = (() => {
  try {
    const dir = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const file = path.join(dir, process.platform === "win32" ? "git.exe" : "git");
    return existsSync(file) ? file : "git";
  } catch {
    return "git";
  }
})();

/**
 * M5 slice 0's profile (test code only): with RAFI_PROFILE set to a file, each git and exec call appends one JSON
 * line `{job, kind, cmd, ms}`, so the fast suite's git cost per job can be counted. Unset, nothing is written.
 */
async function profiled<R>(kind: string, cmd: string, run: () => Promise<R>): Promise<R> {
  const file = process.env.RAFI_PROFILE;
  if (!file) return run();
  const started = performance.now();
  try { return await run(); } finally {
    const job = path.basename(process.argv.find((a) => /\.(test|scenario)\.ts$/.test(a)) ?? "engine-tests");
    appendFileSync(file, `${JSON.stringify({ job, kind, cmd, ms: performance.now() - started })}\n`);
  }
}

/** Folders found missing (a fake HOME such as `/home/u` can't appear later); existing ones are looked at each time. */
const MISSING = new Set<string>();
const missing = (dir: string) => {
  if (MISSING.has(dir)) return true;
  if (existsSync(dir)) return false;
  MISSING.add(dir);
  return true;
};

/**
 * M4 review, finding 5: whether `GIT_CONFIG_GLOBAL=/dev/null` changes nothing for this environment, so the harness
 * may add it. It's exactly when git would read no global config file anyway: no GIT_CONFIG_GLOBAL of its own, and
 * neither `$XDG_CONFIG_HOME/git/config` (else `$HOME/.config/git/config`) nor `$HOME/.gitconfig` exists. The win is
 * a fake HOME under macOS's automounter (`/home/u`), about 70 ms a lookup; its missing folder is looked up once.
 */
export function noGlobalConfig(env: Env): boolean {
  if (env.GIT_CONFIG_GLOBAL !== undefined) return false;
  const xdg = env.XDG_CONFIG_HOME ?? (env.HOME ? path.join(env.HOME, ".config") : null);
  const files: [string | null, string][] = [[xdg, path.join("git", "config")], [env.HOME ?? null, ".gitconfig"]];
  return files.every(([dir, file]) => !dir || missing(dir) || !existsSync(path.join(dir, file)));
}

/** One "computer": its clock, notifier, machine state folder and environment, shared by its instances. */
export interface Computer {
  readonly clock: FakeClock;
  readonly notifier: FakeNotifier;
  readonly stateDir: string;
  readonly host: string;
  readonly env: Env;
  readonly ids: { next: number };
  readonly alive: Set<string>;
  readonly agents?: { codex?(o: CodexSpawn): JsonRpcStream; claudeQuery?: ClaudeQuery };
  /** The environment of every process rafi started on this computer (S-CLI-2 step 4's ENV-5 check). */
  readonly childEnvs: Env[];
  /** Each agent runtime's environment, tagged by runtime (Claude's `env` option, the Codex app-server's spawn). */
  readonly agentEnvs: { kind: "codex" | "claude"; env: Env; readOnly?: boolean }[];
  /** The platform rafi sees (`deps.machine.platform`); "win32" simulates Windows' environment rules. */
  readonly platform?: NodeJS.Platform;
  /** C89: canary values by variable name; the after-each check greps for each and its encodings when set. */
  readonly canaries: Record<string, string>;
  /** Every message rafi sent an agent, as JSON: the transcript S-CLI-2 step 4 checks for dropped prompts. */
  readonly sentToAgents: string[];
  /** The scripted test runs (fakes/checks.ts): per-test outcomes, the sandbox setting, and every run's argv. */
  readonly checks: { tests: Record<string, FakeTest>; sandbox: "available" | "missing"; log: CheckLogEntry[];
    listing?: "hang" };
  /** The in-memory MCP endpoints (fakes/serve.ts). */
  readonly serve: MemoryServe;
  /** The "home folder" of this computer (the parent of stateDir). */
  readonly home: string;
  /** The fake agents' script rules (first match wins, else the role happy path) and their transcript. */
  readonly script: ScriptState;
  /** P47: the scripted tracker sources (Linear, Jira, URLs) and every request rafi sent them. */
  readonly http: FakeHttp;
  /** M5 (C216): the fake `gh` and `glab`, which deps.exec routes to in-process. */
  readonly gh: FakeGh;
  /** C139: who watches which database; a commit by one instance tells the others on the same file. */
  readonly bus: { instance: string; file: string; fn: () => void }[];
}

/** C157 (S-CRASH-2): a torn write of the at-th matching file (half its bytes land, then the instance dies); the
 * database busy for busyMs on the clock; SQLITE_FULL on the n-th event insert. */
export interface StorageFaults {
  readonly tornWrite?: RegExp;
  readonly at?: number;
  /** With tornWrite: the write is cut at its rename instead: its temp file, named as `deps/real/fs.ts` names it
   * (`.<name>.<id>.tmp` beside the file), is written whole, then the instance dies before the rename. */
  readonly atRename?: boolean;
  readonly busyMs?: number;
  readonly fullOnAppend?: number;
  /** C157 "refused large write": a blob over this many bytes fails with SQLITE_FULL (optional data that won't fit). */
  readonly refuseBlobsOver?: number;
  /** The at-th BEGIN this instance runs is refused once as busy, so its write waits on a `backoff` timer before it
   * retries (a race test's interleaving point: another command writes in that wait, as a held lock would allow). */
  readonly busyAt?: number;
  /** C229: a git call this instance makes fails as git would (exit 128 with this stderr) when the predicate picks
   * it; lifted for the next instance (`rafi resume` runs without it). */
  readonly git?: (args: readonly string[], cwd: string,
    env: Readonly<Record<string, string | undefined>> | undefined) => string | null;
}

function faulty(real: Db, f: StorageFaults, now: () => number): Db {
  let busyUntil: number | null = null;
  let inserts = 0;
  let begins = 0;
  const statement = (inner: DbStatement, sql: string): DbStatement => ({ ...inner,
    run: (...params) => {
      if (/^\s*INSERT INTO events/i.test(sql) && ++inserts === f.fullOnAppend) {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      }
      const data = params.at(-1);
      if (f.refuseBlobsOver !== undefined && /INSERT\s+(OR\s+IGNORE\s+)?INTO blobs/i.test(sql) &&
        data instanceof Uint8Array && data.byteLength > f.refuseBlobsOver) {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      }
      return inner.run(...params);
    }, get: (...p) => inner.get(...p), all: (...p) => inner.all(...p) });
  return { ...real, get inTransaction() { return real.inTransaction; }, close: () => real.close(),
    pragma: (s, o) => real.pragma(s, o), prepare: (sql) => statement(real.prepare(sql), sql),
    exec(sql) {
      if (/^\s*BEGIN/i.test(sql) && ++begins === f.busyAt) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      if (f.busyMs && /^\s*BEGIN/i.test(sql)) {
        busyUntil ??= now() + f.busyMs;
        if (now() < busyUntil) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      real.exec(sql);
    } };
}

export interface Instance {
  readonly id: string;
  readonly deps: Deps;
  readonly fence: Fence;
  readonly hooks: HookControl;
}

const unavailable = (what: string) => (): never => {
  throw new Error(`harness: ${what} isn't scripted in this scenario`);
};

/** Wraps the agent transports so each start records its env and each message rafi sends is kept. */
function recordedAgents(computer: Computer): Deps["agents"] {
  const sent = (message: unknown) => { computer.sentToAgents.push(JSON.stringify(message) ?? ""); };
  const fakeClock = computer.clock.forInstance("fake-agents");
  // M4: an interrupt ends a wait early (the fakes pass a signal); an ended wait resolves rather than rejects.
  const defaults = defaultAgents(computer.script, computer.serve,
    (ms, signal) => fakeClock.sleep(ms, "agent", signal).catch(() => undefined));
  const codex = computer.agents?.codex ?? defaults.codex;
  const query = computer.agents?.claudeQuery ?? defaults.claudeQuery;
  return {
    codex: codex ? (o) => {
      computer.childEnvs.push(o.env);
      computer.agentEnvs.push({ kind: "codex", env: o.env });
      const stream = codex(o);
      return { ...stream, write: (message, meta) => { sent(message); stream.write(message, meta); },
        onMessage: (fn) => stream.onMessage(fn), onClose: (fn) => stream.onClose(fn), close: () => stream.close(),
        kill: () => stream.kill() };
    } : unavailable("codex"),
    claudeQuery: query ? (params) => {
      computer.childEnvs.push((params.options.env as Env | undefined) ?? computer.env);
      const write = (params.options.sandbox as { filesystem?: { allowWrite?: string[] } } | undefined)?.filesystem;
      computer.agentEnvs.push({ kind: "claude", env: (params.options.env as Env | undefined) ?? computer.env,
        readOnly: (write?.allowWrite ?? []).length === 0 });
      const prompt = (async function* () {
        for await (const message of params.prompt) { sent(message); yield message; }
      })();
      return query({ ...params, prompt });
    } : (unavailable("claude") as unknown as ClaudeQuery),
    claudeTools: async (name, tools) => defaults.claudeTools(name, tools as never),
  };
}

/** deps.git: the fence, the race hook, the env record, C229's fault, then the real git by its path. */
function harnessGit(computer: Computer, fence: Fence, o: { onGit?: (args: readonly string[]) => Promise<void> | void;
  faults?: StorageFaults }): Deps["git"] {
  return (args, opts) => computer.clock.track(async () => {
    fence.check(`git ${args[0]}`);
    await o.onGit?.(args);
    computer.childEnvs.push(opts.env ?? computer.env);
    const refused = o.faults?.git?.(args, opts.cwd, opts.env);
    if (refused) return { code: 128, stdout: "", stderr: refused };
    const env = opts.env && noGlobalConfig(opts.env) ? { ...opts.env, GIT_CONFIG_GLOBAL: os.devNull } : opts.env;
    return profiled("git", args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "",
      () => realExec(GIT_BINARY, args, { ...opts, env }));
  });
}

export function harnessDeps(computer: Computer, terminal: FakeTerminal,
  o: { cwd: string; instance: string; env?: Record<string, string>; faults?: StorageFaults;
    onGit?: (args: readonly string[]) => Promise<void> | void;
    onRead?: (file: string) => Promise<void> | void }) {
  const fence = new Fence();
  const clock = computer.clock;
  const id = o.instance;
  const hooks = hookControl(() => fence.crash());
  const unwatch = () => {
    const kept = computer.bus.filter((w) => w.instance !== id);
    computer.bus.splice(0, computer.bus.length, ...kept);
  };
  fence.whenCrashed(() => {
    clock.drop(id);
    computer.alive.delete(id);
    unwatch();
    terminal.freeze();
  });
  const committed = (file: string) => () => {
    for (const w of computer.bus.filter((x) => x.file === file && x.instance !== id)) {
      void clock.track(async () => w.fn());
    }
  };
  computer.alive.add(id);
  const random = {
    id: () => `id-${String(++computer.ids.next).padStart(6, "0")}`,
    jitter: () => 0,
    secret: () => `tok${String(++computer.ids.next).padStart(6, "0")}${"0".repeat(55)}`,
  };
  const real = realFs(random);
  let writes = 0;
  const torn = o.faults?.tornWrite;
  const fs = fence.fs(torn ? { ...real, writeAtomic: async (p, d) => {
    if (torn.test(p) && ++writes === (o.faults?.at ?? 1)) {
      if (o.faults?.atRename) {
        await real.writeAtomic(path.join(path.dirname(p), `.${path.basename(p)}.${random.id()}.tmp`), d);
        hooks.crashNow(`write of ${path.basename(p)} torn at its rename (${writes})`);
      }
      const bytes = typeof d === "string" ? Buffer.from(d) : Buffer.from(d);
      await real.writeAtomic(p, bytes.subarray(0, Math.floor(bytes.length / 2)));
      hooks.crashNow(`torn write of ${path.basename(p)} (${writes})`);
    }
    return real.writeAtomic(p, d);
  } } : real);
  const tracked = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A) => clock.track(() => fn(...args));
  const deps: Deps = {
    agents: recordedAgents(computer),
    clock: clock.forInstance(id),
    notifier: computer.notifier,
    terminal,
    fs: {
      read: tracked(async (file) => { await o.onRead?.(file); return fs.read(file); }),
      readBytes: tracked(fs.readBytes), writeAtomic: tracked(fs.writeAtomic),
      append: tracked(fs.append), rename: tracked(fs.rename), remove: tracked(fs.remove), mkdir: tracked(fs.mkdir),
      stat: tracked(fs.stat), realpath: tracked(fs.realpath), list: tracked(fs.list),
    },
    git: harnessGit(computer, fence, o),
    exec: (cmd, args, opts) => clock.track(() => {
      computer.childEnvs.push(opts.env ?? computer.env);
      const name = path.basename(cmd).replace(/\.exe$/i, "");
      if (name === "gh" || name === "glab") return runGh(computer.gh, name, args, opts);
      return profiled("exec", path.basename(cmd), () => realExec(cmd, args, opts));
    }),
    fetch: (url, opts) => clock.track(() => httpFetch(computer.http)(url, opts)),
    checks: scriptedChecks({ clock: clock.forInstance(id), home: computer.home, log: computer.checks.log,
      get tests() { return computer.checks.tests; }, get sandbox() { return computer.checks.sandbox; },
      get listing() { return computer.checks.listing; } }),
    serve: (opts) => computer.serve.serve(opts),
    spawnBackground: unavailable("spawnBackground"),
    db: { open: (file, opts) => {
      const opened = openRealDb(file, opts);
      return fence.db(o.faults ? faulty(opened, o.faults, () => clock.now().getTime()) : opened,
        committed(path.resolve(file)));
    } },
    processes: {
      self: () => ({ instance: id, host: computer.host, pid: 1000, startedAt: null }),
      isAlive: async (owner) => computer.alive.has(owner.instance),
    },
    hooks: hooks.hooks,
    machine: { stateDir: computer.stateDir, host: computer.host, platform: computer.platform ?? process.platform },
    env: o.env ? Object.freeze({ ...computer.env, ...o.env }) : computer.env,
    cwd: o.cwd,
    random,
    logChanged: (file, fn) => {
      const entry = { instance: id, file: path.resolve(file), fn };
      computer.bus.push(entry);
      return () => { const at = computer.bus.indexOf(entry); if (at >= 0) computer.bus.splice(at, 1); };
    },
  };
  return { id, deps, fence, hooks } satisfies Instance;
}

export function defaultHost(): string {
  return os.hostname();
}

export function stateDirFor(root: string, name: string): string {
  return path.join(root, `computer-${name}`, ".rafi");
}
