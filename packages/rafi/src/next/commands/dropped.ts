// Dropped and merged commands, flags and Manager host commands, and what replaced each (plan 5.2, S-CLI-2).
// Checked on the raw argv before anything else, so a dropped item fails before anything is read.

export interface Refusal {
  readonly message: string;
}

const COMMANDS: Readonly<Record<string, string | null>> = Object.freeze({
  "plan:doctor": "Use `rafi resume`, which finds saved planning sessions too.",
  "build:attach": "Use `rafi resume`, which attaches to a running build.",
  "build:resume": "Use `rafi resume`.",
  "build:decide": "Use `rafi answer`.",
  "build:stop": "Use `rafi stop`.",
  "build:start-over": "Use `rafi reset`.",
  "build:reset": "Use `rafi reset`.",
  audit: "Use `rafi stats show`.",
  state: "Moving a project to another computer is built in: commit, clone, then run `rafi resume`.",
  handoffs: null,
});

const SUBCOMMANDS: Readonly<Record<string, Readonly<Record<string, string | null>>>> = Object.freeze({
  tickets: Object.freeze({ import: null }),
});

const ALLOW = "Use `--allow` instead (for example `--allow internet`).";
const config = (key: string) => `Set \`${key}\` in rafi-config.yaml instead.`;

const START_FLAGS: Readonly<Record<string, string | null>> = Object.freeze({
  "--builder-network": ALLOW, "--qa-network": ALLOW, "--builder-approvals": ALLOW,
  "--create-pr": "Use `--completion pr` instead.", "--no-create-pr": "Use `--completion none` instead.",
  "--pr-ready": "Use `--completion pr-ready` instead.",
  "--merge-method": config("tickets.build.merge_method"), "--provider": config("tickets.build.provider"),
  "--auto-merge-wait": config("tickets.build.auto_merge_wait"),
  "--no-auto-merge-wait": config("tickets.build.auto_merge_wait"),
  "--auto-merge-timeout-minutes": config("tickets.build.auto_merge_timeout_minutes"),
  "--branch-prefix": config("tickets.build.branch_prefix"),
  "--max-branch-depth": config("tickets.build.max_branch_depth"),
  "--keep-worktrees": config("tickets.build.keep_worktrees"),
  "--show-session-cost": config("agent_defaults.roles.<role>.display_session_cost"),
  "--hide-session-cost": config("agent_defaults.roles.<role>.display_session_cost"),
  "--audit-logging": config("logs.capture"),
  "--auto-compact-threshold": config("agent_defaults.roles.builder.auto_compact_threshold_percent"),
  "-t": null, "--tickets": null, "-r": null, "--resume": null, "--continue": null, "--recover-run": null,
  "--recovery-mode": null, "--recovery-decision-digest": null, "--qa-revision": null, "--accept-handoff": null,
  "--accept-handoff-role": null, "--autonomy": "Set `retries` in rafi-config.yaml instead.", "--no-supervisor": null,
});

const FLAGS: Readonly<Record<string, Readonly<Record<string, string | null>>>> = Object.freeze({
  start: START_FLAGS,
  resume: Object.freeze({
    "--builder-network": ALLOW, "--qa-network": ALLOW, "--builder-approvals": ALLOW,
    "--qa-revision": null, "--no": null, "--fresh-with-handoff": null, "--fresh-session": null,
    "--guided-recovery": null, "--inspect": "Use `rafi status` to see where a build stopped.",
  }),
  plan: Object.freeze({ "--skip-run-confirmation": null }),
  "tickets init": Object.freeze({ "--queue-limit": null }),
});

/** Manager host commands dropped with the conflicting QA records (FLAG-MG-4), checked in `--ask`. */
const MANAGER_DROPPED: ReadonlySet<string> = new Set(["/qa-conflicts", "/qa-repair-plan", "/qa-repair"]);

function withHint(base: string, hint: string | null): Refusal {
  return { message: hint ? `${base} ${hint}` : base };
}

function commandPath(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg === "--" || arg.startsWith("-")) break;
    out.push(arg);
    if (out.length === 2) break;
  }
  return out;
}

function flagName(arg: string): string {
  return arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
}

function askRefusal(argv: readonly string[]): Refusal | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = arg === "--ask" ? argv[i + 1] : arg.startsWith("--ask=") ? arg.slice(6) : undefined;
    const command = value?.trim().split(/\s+/)[0];
    if (command && MANAGER_DROPPED.has(command)) return { message: `unknown Manager command '${command}'.` };
  }
  return null;
}

/** A refusal for a dropped or merged command, flag or Manager host command; null when argv is fine. */
export function droppedRefusal(argv: readonly string[]): Refusal | null {
  const [first, second] = commandPath(argv);
  if (first === undefined) return null;
  if (first in COMMANDS) return withHint(`unknown command '${first}'.`, COMMANDS[first] ?? null);
  const subs = SUBCOMMANDS[first];
  if (second !== undefined && subs && second in subs) {
    return withHint(`unknown command '${first} ${second}'.`, subs[second] ?? null);
  }
  const flags = FLAGS[`${first} ${second}`] ?? FLAGS[first];
  if (flags) {
    const end = argv.includes("--") ? argv.indexOf("--") : argv.length;
    for (const arg of argv.slice(0, end)) {
      const name = flagName(arg);
      if (name in flags) return withHint(`unknown option '${name}'.`, flags[name] ?? null);
    }
  }
  return first === "manager" ? askRefusal(argv) : null;
}
