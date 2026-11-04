// The script engine (SCN 2.2, plan choice C10): matches a turn by role, ticket, step and attempt from `meta`
// and gives the fakes a behavior. M1 covers the provider-level behaviors that need no reply schema; role
// happy paths and verdict behaviors register in M2 and M3.
import { parseRule, splitArgs, unquote, type Selector } from "./parse.js";

/** One action inside a turn, run in order before the reply (SCN 2.2's M2 behaviors). */
export interface Step {
  readonly activity?: string;
  readonly edit?: string;
  readonly content?: string;
  readonly shell?: string;
  readonly runCheck?: string;
  readonly checkOutput?: number;
  /** Claude: n failed exploratory reads (SCN-14). */
  readonly toolFail?: number;
  /** Claude: the S-SCN-14 set of tool outcomes. */
  readonly toolShapes?: boolean;
  /** A file read: Claude's Read tool use (allowed without canUseTool); Codex's `cat <path>` command. */
  readonly read?: string;
  /** The user, not the agent, edits or removes a file mid-turn: written straight to disk, no tool event (C123). */
  readonly outside?: { readonly edit?: string; readonly remove?: string; readonly content?: string;
    /** Replace this text with that in the file instead of writing `content`. */
    readonly replace?: readonly [string, string] };
  readonly ask?: { question: string; options: string[] };
  /** Waits on the fake clock (in-process fakes; real time in the executables). */
  readonly wait?: number;
  /** Codex: print the bearer token from the thread config (a hostile agent, ARCH 1.2 "the token leaks"). */
  readonly echoToken?: boolean;
  /** Codex: the provider compacts the thread's context (a contextCompaction item). */
  readonly compact?: boolean;
  /** Codex: the model asks to run this command outside the sandbox (an approval with additionalPermissions). */
  readonly escalate?: string;
  /** Codex: the model asks for more permissions (item/permissions/requestApproval). */
  readonly permissionsRequest?: boolean;
}

export interface Behavior {
  readonly steps?: readonly Step[];
  readonly errorCode?: "transient" | "quota" | "auth";
  readonly resetAt?: string;
  readonly twoFinals?: unknown;
  /** Claude: end the turn with this result subtype (e.g. error_max_structured_output_retries). */
  readonly resultSubtype?: string;
  readonly reply?: unknown;
  /** Raw reply text instead of the JSON of `reply` (malformed replies). */
  readonly raw?: string;
  readonly activity?: string;
  /** A command the agent asks approval for (on Codex, an escalation out of the sandbox). */
  readonly bash?: string;
  readonly hang?: boolean;
  readonly error?: string;
  readonly crash?: boolean;
  readonly usage?: { inputTokens: number; outputTokens: number };
  /** Codex: the model context window its token usage reports (`modelContextWindow`). */
  readonly contextWindow?: number;
}

/** A behavior, or one built from the turn (to extend the role's happy path). */
export type BehaviorOf = Behavior | ((meta: MetaLike, ctx: TurnContext) => Behavior);

export interface Rule {
  readonly selector: Selector;
  readonly behavior: BehaviorOf;
}

export interface MetaLike {
  readonly role?: string;
  readonly ticket?: string;
  readonly step?: string;
  readonly attempt?: number;
}

function malformed(kind: string): Behavior {
  const json = JSON.stringify({ kind: "done", summary: "s", runs: [], block: null, question: null });
  if (kind === "not-json") return { raw: "I finished the work." };
  if (kind === "truncated") return { raw: json.slice(0, Math.floor(json.length / 2)) };
  const at = /^trailing@(\d+)$/.exec(kind);
  // The trailing text starts exactly at byte N, as moneyTree T002's "trailing content at byte 4412".
  if (at) return { raw: `${json}${" ".repeat(Math.max(0, Number(at[1]) - json.length))}trailing text` };
  throw new Error(`fake script: unknown malformed(${kind})`);
}

/** Converts a parsed rule to a behavior. Unknown behaviors fail the scenario at load time. */
export function behaviorOf(name: string, args: string): Behavior {
  switch (name) {
    case "reply": return { reply: JSON.parse(args || "{}") };
    case "activity": return { activity: unquote(args), reply: {} };
    case "shell": return { bash: unquote(args), reply: {} };
    case "hang": return { hang: true };
    case "error": return { error: unquote(args) || "transient" };
    case "crash": return { crash: true };
    case "malformed": return malformed(unquote(args));
    default: throw new Error(`fake script: behavior ${name}(${args}) isn't in M1 (see plan choice C10)`);
  }
}

export function rule(line: string, extra: Behavior = {}): Rule {
  const parsed = parseRule(line);
  return { selector: parsed.selector, behavior: { ...behaviorOf(parsed.name, parsed.args), ...extra } };
}

function matches(selector: Selector, meta: MetaLike): boolean {
  return (selector.role === undefined || selector.role === meta.role) &&
    (selector.ticket === undefined || selector.ticket === meta.ticket) &&
    (selector.step === undefined || selector.step === meta.step) &&
    (selector.attempt === undefined || selector.attempt === meta.attempt);
}

export interface TurnContext {
  readonly cwd: string;
  readonly message: string;
}

/** The in-process matcher: the first unused rule whose selector matches the turn's meta. */
export function scriptEngine(rules: readonly Rule[],
  happy: (meta: MetaLike, ctx: TurnContext) => Behavior = () => ({ reply: {} })) {
  const used = new Set<Rule>();
  return {
    next(meta: MetaLike, ctx: TurnContext = { cwd: ".", message: "" }): Behavior {
      const index = rules.findIndex((r) => !used.has(r) && matches(r.selector, meta));
      if (index < 0) return happy(meta, ctx);
      used.add(rules[index]!);
      const b = rules[index]!.behavior;
      return typeof b === "function" ? b(meta, ctx) : b;
    },
  };
}

export { splitArgs };
