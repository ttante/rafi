// The script engine (SCN 2.2, plan choice C10): matches a turn by role, ticket, step and attempt from `meta`
// and gives the fakes a behavior. M1 covers the provider-level behaviors that need no reply schema; role
// happy paths and verdict behaviors register in M2 and M3.
import { parseRule, splitArgs, unquote, type Selector } from "./parse.js";

export interface Behavior {
  readonly reply?: unknown;
  /** Raw reply text instead of the JSON of `reply` (malformed replies). */
  readonly raw?: string;
  readonly activity?: string;
  readonly bash?: string;
  readonly hang?: boolean;
  readonly error?: string;
  readonly crash?: boolean;
  readonly usage?: { inputTokens: number; outputTokens: number };
}

export interface Rule {
  readonly selector: Selector;
  readonly behavior: Behavior;
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
  if (at) return { raw: `${json}${" ".repeat(Math.max(0, Number(at[1]) - json.length))} trailing text` };
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

/** The in-process matcher: the first unused rule whose selector matches the turn's meta. */
export function scriptEngine(rules: readonly Rule[], happy: (meta: MetaLike) => Behavior = () => ({ reply: {} })) {
  const used = new Set<number>();
  return {
    next(meta: MetaLike): Behavior {
      const index = rules.findIndex((r, i) => !used.has(i) && matches(r.selector, meta));
      if (index < 0) return happy(meta);
      used.add(index);
      return rules[index]!.behavior;
    },
  };
}

export { splitArgs };
