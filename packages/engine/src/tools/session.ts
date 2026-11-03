// run_check and check_output for one agent session (ARCH 6.9, C37, C43). run_check accepts only: the requirements
// file's checks (checked when rafi wrote them), the project's test runner with file or test-name arguments, and
// the setup script. Everything else is refused and recorded with the reason; nothing reaches a shell.
import path from "node:path";
import { splitCommand } from "../agents/shellForms.js";
import type { ToolResult } from "./mcp.js";

export interface CheckRules {
  readonly root: string;
  /** checks.test_runner as argv (C42), e.g. ["npx", "jest"] or ["npm", "test"]. */
  readonly runner: readonly string[] | null;
  readonly requirementChecks: readonly string[];
  readonly setupScript: string;
  /** package.json scripts that are tests (`test`, `test:unit`). */
  readonly testScripts: readonly string[];
}

export type CommandCheck = { ok: true; argv: string[] } | { ok: false; reason: string };

const NAME_OPTIONS: ReadonlySet<string> = new Set(["-t", "--testNamePattern"]);
const ONLY = "run_check runs only test commands: the test runner with file or test-name arguments, the " +
  "requirements file's checks, or the setup script";

function startsWith(argv: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((word, i) => argv[i] === word);
}

/** The arguments after the runner: test files inside the worktree, or a test name. */
function argsProblem(args: readonly string[], root: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (NAME_OPTIONS.has(arg)) { i += 1; continue; }
    if (arg.startsWith("--testNamePattern=")) continue;
    if (arg.startsWith("-")) return `the runner option ${arg} isn't allowed; pass test files or -t <test name>`;
    const target = path.resolve(root, arg);
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return `${arg} is outside the project`;
  }
  return null;
}

function scriptCheck(argv: readonly string[], rules: CheckRules): boolean {
  if (argv[0] !== "npm" && argv[0] !== "pnpm" && argv[0] !== "yarn") return false;
  const script = argv[1] === "run" ? argv[2] : argv[1];
  return Boolean(script && rules.testScripts.includes(script));
}

function program(argv: readonly string[], rules: CheckRules): CommandCheck {
  if (argv[0] === "rafi") return { ok: false, reason: "agents can't run rafi commands through run_check" };
  if (rules.runner && startsWith(argv, rules.runner)) {
    const problem = argsProblem(argv.slice(rules.runner.length), rules.root);
    return problem ? { ok: false, reason: problem } : { ok: true, argv: [...argv] };
  }
  if ((argv.length === 2 && argv[0] === "bash" && argv[1] === rules.setupScript) ||
    (argv.length === 1 && argv[0] === rules.setupScript)) return { ok: true, argv: [...argv] };
  return { ok: false, reason: ONLY };
}

export function checkCommand(command: string, rules: CheckRules): CommandCheck {
  const split = splitCommand(command);
  if (!split.ok) return { ok: false, reason: `${split.reason} isn't allowed: send one test command, no shell` };
  const words = split.argv.join(" ");
  // The requirements file can be edited after rafi wrote it, so its checks pass C43's rules again here.
  if (rules.requirementChecks.some((c) => { const s = splitCommand(c); return s.ok && s.argv.join(" ") === words &&
    requirementCheckProblem(c, rules) === null; })) {
    return { ok: true, argv: split.argv };
  }
  return program(split.argv, rules);
}

/** C43: a `check` QA writes into the requirements file; null when acceptable. */
export function requirementCheckProblem(check: string, rules: CheckRules): string | null {
  const split = splitCommand(check);
  if (!split.ok) return `the check "${check}" uses ${split.reason}; a check is one test command with no shell syntax`;
  if (scriptCheck(split.argv, rules)) return argsProblem(split.argv.slice(2), rules.root);
  const r = program(split.argv, rules);
  return r.ok ? null : `the check "${check}" isn't a test command (${r.reason})`;
}

export interface SessionTools {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export function toolSession(o: { role: "builder" | "qa"; rules: CheckRules;
  execute(argv: string[], command: string): Promise<string>;
  refuse(command: string, reason: string): Promise<string>;
  output(run: number): Promise<string | null> }): SessionTools {
  return {
    async call(name, args) {
      if (name === "check_output") {
        const run = Number(args.run);
        const text = Number.isInteger(run) && run > 0 ? await o.output(run) : null;
        return text === null ? { text: `There's no run ${String(args.run)} for this ticket.`, isError: true }
          : { text, isError: false };
      }
      if (typeof args.command !== "string" || !args.command.trim()) {
        return { text: "run_check needs a `command`: one test command.", isError: true };
      }
      const checked = checkCommand(args.command, o.rules);
      if (!checked.ok) return { text: await o.refuse(args.command, checked.reason), isError: true };
      return { text: await o.execute(checked.argv, args.command), isError: false };
    },
  };
}
