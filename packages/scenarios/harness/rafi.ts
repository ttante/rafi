// In-process `rafi …` (SCN 7.2 mode `next`): fresh harness deps per call, then runCli.
import { runCli } from "@rafi-ai/cli/next";
import { FakeClock } from "../fakes/clock.js";
import { FakeNotifier } from "../fakes/notifier.js";
import { fakeTerminal, stripAnsi } from "../fakes/terminal.js";
import { memoryServe } from "../fakes/serve.js";
import path from "node:path";
import { defaultHost, harnessDeps, stateDirFor, type Computer } from "./deps.js";

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
    checks: { tests: {}, sandbox: "available", log: [] }, serve: memoryServe(),
    home: path.dirname(stateDirFor(root, name)), script: { rules: [], transcript: [], sessions: [] },
  };
}

/** `input`: lines typed into the terminal, answered by prompts in order. */
export interface RafiOptions { tty?: boolean; cwd?: string; input?: readonly string[]; env?: Record<string, string> }
export type Rafi = ((line: string, o?: RafiOptions) => Promise<RafiResult>) &
  { start(line: string, o?: RafiOptions): { done(): Promise<RafiResult> } };

export function rafiRunner(computer: Computer, cwd: string, results: RafiResult[] = []): Rafi {
  let instances = 0;
  const run = async (line: string, o: RafiOptions = {}) => {
    const terminal = fakeTerminal({ tty: Boolean(o.tty) });
    for (const typed of o.input ?? []) terminal.send(`${typed}\n`);
    // After the typed lines the input ends, so a prompt with nothing more to read gets end-of-input (C100).
    terminal.end();
    const instance = harnessDeps(computer, terminal,
      { cwd: o.cwd ?? cwd, instance: `inst-${++instances}`, env: o.env });
    const argv = splitArgs(line);
    const code = await runCli(argv, instance.deps);
    instance.fence.closeAll();
    computer.alive.delete(instance.id);
    const result: RafiResult = {
      argv, code, out: terminal.out(), err: terminal.err(), output: stripAnsi(terminal.all()), raw: terminal.all(),
      title: terminal.screen?.title ?? "", pinned: terminal.screen?.pinned() ?? [],
    };
    results.push(result);
    return result;
  };
  /** Starts a command without waiting; another rafi() call in the same "computer" can run meanwhile. */
  const start = (line: string, o: RafiOptions = {}) => {
    const pending = run(line, o);
    return { done: () => pending };
  };
  return Object.assign(run, { start });
}
