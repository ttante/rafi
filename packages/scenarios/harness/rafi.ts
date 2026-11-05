// In-process `rafi …` (SCN 7.2 mode `next`): fresh harness deps per call, then runCli.
import { runCli } from "@rafi-ai/cli/next";
import { FakeClock } from "../fakes/clock.js";
import { FakeNotifier } from "../fakes/notifier.js";
import { fakeTerminal, stripAnsi } from "../fakes/terminal.js";
import { memoryServe } from "../fakes/serve.js";
import { fakeGh } from "../fakes/gh.js";
import { fakeHttp } from "../fakes/http.js";
import path from "node:path";
import { defaultHost, harnessDeps, stateDirFor, type Computer } from "./deps.js";
import type { PauseFn } from "./hooks.js";
import type { StorageFaults } from "./deps.js";

export interface RafiResult {
  readonly argv: readonly string[];
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** stdout and stderr in order, ANSI codes removed. */
  readonly output: string;
  readonly raw: string;
  readonly title: string;
  readonly pinned: readonly string[];
  readonly passed: readonly string[];
  readonly crashed: string | null;
}

/** Splits a command line the way a POSIX shell would for simple quoting ('…', "…", backslash). */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (has || current) out.push(current);
  return out;
}

export function newComputer(root: string, name = "a", env: Record<string, string | undefined> = {}): Computer {
  return {
    clock: new FakeClock(), notifier: new FakeNotifier(), stateDir: stateDirFor(root, name), host: defaultHost(),
    env: Object.freeze({ TZ: "UTC", ...env }), ids: { next: 0 }, alive: new Set(),
    childEnvs: [], agentEnvs: [], canaries: {}, sentToAgents: [],
    checks: { tests: {}, sandbox: "available", log: [] }, serve: memoryServe(), http: fakeHttp(), gh: fakeGh(),
    home: path.dirname(stateDirFor(root, name)), script: { rules: [], transcript: [], sessions: [] }, bus: [],
  };
}

/** `input`: lines typed into the terminal, answered by prompts in order. */
export interface RafiOptions {
  tty?: boolean; cwd?: string; input?: readonly string[]; env?: Record<string, string>;
  /** C156: crash at the k-th occurrence (1-based) or the first whose name starts with this text. */
  crashAt?: number | string;
  /** P34: at the at-th occurrence, fn runs and the engine waits for it. */
  pauseAt?: { at: number | ((occurrence: string, index: number) => boolean); fn: PauseFn };
  /** Every occurrence as it's passed (record mode, P33). */
  onEach?: (occurrence: string, index: number) => void;
  /** C157: storage faults for this instance. */
  faults?: StorageFaults;
  /** Awaited before each git call this instance makes (a race test's interleaving point). */
  onGit?: (args: readonly string[]) => Promise<void> | void;
  /** Awaited before each file this instance reads (M5 R4's interleaving point). */
  onRead?: (file: string) => Promise<void> | void;
}

/** A command still running (C156): wait for output, type lines, press Ctrl+C, then its result. */
export interface LiveRafi {
  done(): Promise<RafiResult>;
  /** Resolves when the output since the last match matches `re`; rejects if the command ends first. */
  expect(re: RegExp): Promise<void>;
  send(text: string): void;
  interrupt(): void;
  /** SIGHUP (the terminal closed) or SIGTERM to this rafi. */
  signal(name: "SIGHUP" | "SIGTERM"): void;
  /** No more typed input. */
  end(): void;
  output(): string;
}
export type Rafi = ((line: string, o?: RafiOptions) => Promise<RafiResult>) &
  { start(line: string, o?: RafiOptions): LiveRafi };

/** A crashed instance has no exit code of its own; the harness reports SIGKILL's (128 + 9). */
export const KILLED = 137;

export function rafiRunner(computer: Computer, cwd: string, results: RafiResult[] = []): Rafi {
  let instances = 0;
  const launch = (line: string, o: RafiOptions, live: boolean) => {
    const terminal = fakeTerminal({ tty: Boolean(o.tty) });
    for (const typed of o.input ?? []) terminal.send(`${typed}\n`);
    // After the typed lines the input ends, so a prompt with nothing more to read gets end-of-input (C100). A live
    // handle keeps its input open for send().
    if (!live) terminal.end();
    const instance = harnessDeps(computer, terminal,
      { cwd: o.cwd ?? cwd, instance: `inst-${++instances}`, env: o.env, faults: o.faults, onGit: o.onGit,
        onRead: o.onRead });
    if (o.crashAt !== undefined) instance.hooks.crashAt(o.crashAt);
    if (o.pauseAt) instance.hooks.pauseAt(o.pauseAt.at, o.pauseAt.fn);
    if (o.onEach) instance.hooks.onEach(o.onEach);
    const argv = splitArgs(line);
    const pending = (async () => {
      const code = await runCli(argv, instance.deps);
      instance.fence.closeAll();
      computer.alive.delete(instance.id);
      const crashed = instance.hooks.crashed;
      const result: RafiResult = {
        argv, code: crashed ? KILLED : code, out: terminal.out(), err: terminal.err(),
        output: stripAnsi(terminal.all()),
        raw: terminal.all(), title: terminal.screen?.title ?? "", pinned: terminal.screen?.pinned() ?? [],
        passed: instance.hooks.passed, crashed,
      };
      results.push(result);
      return result;
    })();
    return { pending, terminal };
  };
  const run = (line: string, o: RafiOptions = {}) => launch(line, o, false).pending;
  /** Starts a command without waiting; another rafi() call in the same "computer" can run meanwhile (C156). */
  const start = (line: string, o: RafiOptions = {}): LiveRafi => {
    const { pending, terminal } = launch(line, o, true);
    let cursor = 0;
    let finished = false;
    void pending.then(() => { finished = true; });
    return {
      done: () => pending,
      send: (text) => terminal.send(text),
      interrupt: () => terminal.interrupt(),
      signal: (name) => terminal.signal(name),
      end: () => terminal.end(),
      output: () => stripAnsi(terminal.all()),
      expect: (re) => new Promise<void>((resolve, reject) => {
        const look = () => {
          const text = stripAnsi(terminal.all()).slice(cursor);
          const m = re.exec(text);
          if (m) { cursor += m.index + m[0].length; stop(); resolve(); return true; }
          return false;
        };
        const stop = terminal.onWrite(() => void look());
        if (look()) return;
        void pending.then(() => {
          if (!look()) { stop(); reject(new Error(`the command ended without printing ${re}:\n${terminal.all()}`)); }
        });
        if (finished && !look()) reject(new Error(`the command already ended without printing ${re}`));
      }),
    };
  };
  return Object.assign(run, { start });
}
