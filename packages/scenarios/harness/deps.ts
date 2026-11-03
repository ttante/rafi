// Harness Deps (SCN 7.2): real fs, git, exec and db wrapped by the fence; the fake clock, notifier and
// terminal; crash and pause hooks; a seeded random (plan choice C24); a per-"computer" state folder.
import os from "node:os";
import path from "node:path";
import type { ClaudeQuery, CodexSpawn, Deps, Env, JsonRpcStream } from "@rafi-ai/engine";
import { openRealDb, realExec, realFs, realGit } from "@rafi-ai/engine/deps/real";
import type { FakeClock } from "../fakes/clock.js";
import type { FakeNotifier } from "../fakes/notifier.js";
import type { FakeTerminal } from "../fakes/terminal.js";
import { scriptedChecks, type CheckLogEntry, type FakeTest } from "../fakes/checks.js";
import { defaultAgents, type ScriptState } from "./agents.js";
import type { MemoryServe } from "../fakes/serve.js";
import { Fence } from "./fence.js";
import { hookControl, type HookControl } from "./hooks.js";

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
  const defaults = defaultAgents(computer.script, computer.serve, (ms) => fakeClock.sleep(ms, "agent"));
  const codex = computer.agents?.codex ?? defaults.codex;
  const query = computer.agents?.claudeQuery ?? defaults.claudeQuery;
  return {
    codex: codex ? (o) => {
      computer.childEnvs.push(o.env);
      computer.agentEnvs.push({ kind: "codex", env: o.env });
      const stream = codex(o);
      return { ...stream, write: (message, meta) => { sent(message); stream.write(message, meta); },
        onMessage: (fn) => stream.onMessage(fn), onClose: (fn) => stream.onClose(fn), close: () => stream.close() };
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

export function harnessDeps(computer: Computer, terminal: FakeTerminal,
  o: { cwd: string; instance: string; env?: Record<string, string> }) {
  const fence = new Fence();
  const clock = computer.clock;
  const id = o.instance;
  const hooks = hookControl(() => fence.crash());
  fence.whenCrashed(() => {
    clock.drop(id);
    computer.alive.delete(id);
  });
  computer.alive.add(id);
  const random = {
    id: () => `id-${String(++computer.ids.next).padStart(6, "0")}`,
    jitter: () => 0,
    secret: () => `tok${String(++computer.ids.next).padStart(6, "0")}${"0".repeat(55)}`,
  };
  const fs = fence.fs(realFs(random));
  const tracked = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A) => clock.track(() => fn(...args));
  const deps: Deps = {
    agents: recordedAgents(computer),
    clock: clock.forInstance(id),
    notifier: computer.notifier,
    terminal,
    fs: {
      read: tracked(fs.read), readBytes: tracked(fs.readBytes), writeAtomic: tracked(fs.writeAtomic),
      append: tracked(fs.append), rename: tracked(fs.rename), remove: tracked(fs.remove), mkdir: tracked(fs.mkdir),
      stat: tracked(fs.stat), list: tracked(fs.list),
    },
    git: (args, opts) => clock.track(async () => {
      fence.check(`git ${args[0]}`);
      computer.childEnvs.push(opts.env ?? computer.env);
      return realGit(args, opts);
    }),
    exec: (cmd, args, opts) => clock.track(() => {
      computer.childEnvs.push(opts.env ?? computer.env);
      return realExec(cmd, args, opts);
    }),
    checks: scriptedChecks({ clock: clock.forInstance(id), home: computer.home, log: computer.checks.log,
      get tests() { return computer.checks.tests; }, get sandbox() { return computer.checks.sandbox; },
      get listing() { return computer.checks.listing; } }),
    serve: (opts) => computer.serve.serve(opts),
    spawnBackground: unavailable("spawnBackground"),
    db: { open: (file, opts) => fence.db(openRealDb(file, opts)) },
    processes: {
      self: () => ({ instance: id, host: computer.host, pid: 1000, startedAt: null }),
      isAlive: async (owner) => computer.alive.has(owner.instance),
    },
    hooks: hooks.hooks,
    machine: { stateDir: computer.stateDir, host: computer.host, platform: computer.platform ?? process.platform },
    env: o.env ? Object.freeze({ ...computer.env, ...o.env }) : computer.env,
    cwd: o.cwd,
    random,
    logChanged: () => () => undefined,
  };
  return { id, deps, fence, hooks } satisfies Instance;
}

export function defaultHost(): string {
  return os.hostname();
}

export function stateDirFor(root: string, name: string): string {
  return path.join(root, `computer-${name}`, ".rafi");
}
