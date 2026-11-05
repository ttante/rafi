// Rule matching in the fake executables (P8 option C, M4 plan Q1; SCN 7.3): a process-mode script's rules carry a
// selector (role, ticket, step, attempt) and are matched against the turn's identity, read from rafi's log
// (identity.mjs), the way the in-process script engine matches `meta`: the first unused rule whose selector fits,
// else the role's happy path. Used rules are kept in a file beside the script, so every process of one script (each
// agent session is its own process) and every rafi instance after a kill shares them (C166). A script without
// `match: "identity"` keeps M1's order-only rules. Plain ESM: the Agent SDK strips NODE_OPTIONS.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { turnIdentity } from "./identity.mjs";
import { happyPath } from "./roles.mjs";

const fits = (selector = {}, id) => ["role", "ticket", "step", "attempt"]
  .every((k) => selector[k] === undefined || selector[k] === id[k]);

/** QA's happy verdict for this turn with the listed requirements not satisfied (behaviors.ts `B.reject`). */
function reject(notes, id, ctx) {
  const base = happyPath(id, ctx).reply;
  return { steps: [], reply: { summary: "Rejected.", results: base.results.map((r) => (notes[r.req] === undefined ? r
    : { ...r, status: "not-satisfied", note: notes[r.req] })) } };
}

/** The behavior a rule gives this turn: a plain behavior, or one made from the turn (happy, reject, slow). */
export function behaviorOf(rule, id, ctx) {
  const make = rule.make ?? null;
  let b = rule.behavior ?? {};
  if (make?.kind === "happy") b = happyPath(id, ctx);
  if (make?.kind === "reject") b = reject(make.notes ?? {}, id, ctx);
  if (make?.kind === "slow") {
    const base = happyPath(id, ctx);
    const waits = [];
    for (let t = 0; t < make.ms; t += make.every ?? make.ms) {
      waits.push({ wait: make.every ?? make.ms }, { activity: `working, ${t + (make.every ?? make.ms)} ms in` });
    }
    b = { ...base, steps: [...waits, ...(base.steps ?? [])] };
  }
  // `say`: an activity line first (a canary a secret-redaction check looks for in rafi's outputs).
  if (make?.say) b = { ...b, steps: [{ activity: make.say }, ...(b.steps ?? [])] };
  return { ...b, ...(make?.kill ? { kill: make.kill } : {}), ...(make?.ignoreCancel ? { ignoreCancel: true } : {}),
    ...(make?.ignoreTerm ? { ignoreTerm: true } : {}) };
}

function usedOf(file) {
  return existsSync(file) ? new Set(JSON.parse(readFileSync(file, "utf8"))) : new Set();
}

/**
 * The next behavior for a turn in `ctx.cwd`, and the identity it was matched on (null: no log, order only).
 * `next(index)` is the order-only fallback (the shared cursor).
 */
export function pickBehavior(script, scriptPath, ctx, next) {
  const rules = script.rules ?? [];
  if (script.match !== "identity") {
    return { identity: null, behavior: rules[Math.min(next(), rules.length - 1)]?.behavior ?? { reply: {} } };
  }
  const identity = turnIdentity(ctx.cwd);
  if (!identity) return { identity: null, behavior: rules[Math.min(next(), rules.length - 1)]?.behavior ?? {} };
  const file = `${script.shared ?? scriptPath}.used`;
  const used = usedOf(file);
  const index = rules.findIndex((r, i) => !used.has(i) && fits(r.selector, identity));
  if (index < 0) return { identity, behavior: happyPath(identity, ctx) };
  used.add(index);
  writeFileSync(file, JSON.stringify([...used]));
  return { identity, rule: index, behavior: behaviorOf(rules[index], identity, ctx) };
}

/** The fake `claude`'s rule shape for a behavior (claude/query.ts `claudeRule`). */
export function claudeShape(b) {
  const behavior = b.hang ? "hang" : b.crash ? "crash" : b.error ? "error" : "reply";
  return { ...b, behavior, message: b.error };
}
