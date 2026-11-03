// In-process `rafi …` (SCN 7.2 mode `next`): fresh harness deps per call, then runCli.
import { runCli } from "@rafi-ai/cli/next";
import { FakeClock } from "../fakes/clock.js";
import { FakeNotifier } from "../fakes/notifier.js";
import { fakeTerminal, stripAnsi } from "../fakes/terminal.js";
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
    childEnvs: [], sentToAgents: [],
  };
}

export type Rafi = (line: string, o?: { tty?: boolean; cwd?: string }) => Promise<RafiResult>;

export function rafiRunner(computer: Computer, cwd: string, results: RafiResult[] = []): Rafi {
  let instances = 0;
  return async (line, o = {}) => {
    const terminal = fakeTerminal({ tty: Boolean(o.tty) });
    const instance = harnessDeps(computer, terminal, { cwd: o.cwd ?? cwd, instance: `inst-${++instances}` });
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
}
