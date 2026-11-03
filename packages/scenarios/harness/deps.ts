// Harness Deps (SCN 7.2): real fs, git, exec and db wrapped by the fence; the fake clock, notifier and
// terminal; crash and pause hooks; a seeded random (plan choice C24); a per-"computer" state folder.
import os from "node:os";
import path from "node:path";
import type { ClaudeQuery, CodexSpawn, Deps, Env, JsonRpcStream } from "@rafi-ai/engine";
import { openRealDb, realExec, realFs, realGit } from "@rafi-ai/engine/deps/real";
import type { FakeClock } from "../fakes/clock.js";
import type { FakeNotifier } from "../fakes/notifier.js";
import type { FakeTerminal } from "../fakes/terminal.js";
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
  /** Every message rafi sent an agent, as JSON: the transcript S-CLI-2 step 4 checks for dropped prompts. */
  readonly sentToAgents: string[];
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
  const codex = computer.agents?.codex;
  const query = computer.agents?.claudeQuery;
  return {
    codex: codex ? (o) => {
      computer.childEnvs.push(o.env);
      const stream = codex(o);
      return { ...stream, write: (message, meta) => { sent(message); stream.write(message, meta); },
        onMessage: (fn) => stream.onMessage(fn), onClose: (fn) => stream.onClose(fn), close: () => stream.close() };
    } : unavailable("codex"),
    claudeQuery: query ? (params) => {
      computer.childEnvs.push((params.options.env as Env | undefined) ?? computer.env);
      const prompt = (async function* () {
        for await (const message of params.prompt) { sent(message); yield message; }
      })();
      return query({ ...params, prompt });
    } : (unavailable("claude") as unknown as ClaudeQuery),
  };
}

export function harnessDeps(computer: Computer, terminal: FakeTerminal, o: { cwd: string; instance: string }) {
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
    checks: { run: unavailable("checks.run") },
    serve: unavailable("serve"),
    spawnBackground: unavailable("spawnBackground"),
    db: { open: (file, opts) => fence.db(openRealDb(file, opts)) },
    processes: {
      self: () => ({ instance: id, host: computer.host, pid: 1000, startedAt: null }),
      isAlive: async (owner) => computer.alive.has(owner.instance),
    },
    hooks: hooks.hooks,
    machine: { stateDir: computer.stateDir, host: computer.host, platform: process.platform },
    env: computer.env,
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
