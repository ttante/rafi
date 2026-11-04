// SCN 2.2's M2 behaviors as builders, for scenario scripts: `on("builder T1#1", B.malformed(4412))`.
// Builder behaviors extend the role's happy path (its edit and run_check) unless they replace the reply.
import { parseRule } from "./parse.js";
import { happyPath, RUNS } from "./roles.mjs";
import type { Behavior, BehaviorOf, MetaLike, Rule, Step, TurnContext } from "./engine.js";

export const DONE = Object.freeze({ kind: "done", summary: "s", runs: [] as number[], block: null, question: null });

/** A rule from a selector (`builder T1#1 @build`) and a behavior. */
export function on(selector: string, behavior: BehaviorOf): Rule {
  return { selector: parseRule(`${selector}: x`).selector, behavior };
}

const happy = (meta: MetaLike, ctx: TurnContext): Behavior => happyPath(meta, ctx) as Behavior;
const extend = (extra: Partial<Behavior>, before: readonly Step[] = []): BehaviorOf => (meta, ctx) => {
  const base = happy(meta, ctx);
  return { ...base, ...extra, steps: [...before, ...(base.steps ?? []), ...(extra.steps ?? [])] };
};

const json = JSON.stringify(DONE);

type Verdict = { results: { req: number; status: string; runs: number[]; needs: string | null; note: string | null }[];
  summary: string };

/** QA's happy verdict for this turn (every requirement rafi's message lists), with some results changed. */
const verdict = (change: (r: Verdict["results"][number]) => Verdict["results"][number], summary: string) =>
  (meta: MetaLike, ctx: TurnContext): Behavior => {
    const base = happy(meta, ctx).reply as Verdict;
    return { steps: [], reply: { results: base.results.map(change), summary } };
  };

/** Any reply as JSON with trailing text starting exactly at byte `at`. */
const malformedOf = (reply: unknown, at = 200): Behavior => {
  const text = JSON.stringify(reply);
  return { raw: `${text}${" ".repeat(Math.max(0, at - text.length))}trailing text` };
};

export const B = {
  done: (): BehaviorOf => happy,
  malformed: (at: number): Behavior => ({ raw: `${json}${" ".repeat(Math.max(0, at - json.length))}trailing text` }),
  truncated: (): Behavior => ({ raw: json.slice(0, json.indexOf('"block"') + 3) }),
  repairOk: (): Behavior => ({ reply: DONE }),
  repairChanged: (field: keyof typeof DONE): Behavior => ({ reply: { ...DONE, [field]: "something else" } }),
  missingField: (name: keyof typeof DONE): Behavior => {
    const { [name]: _drop, ...rest } = DONE;
    return { reply: rest };
  },
  wrongType: (name: keyof typeof DONE): Behavior => ({ reply: { ...DONE, [name]: "4" } }),
  twoFinals: (): BehaviorOf => extend({ twoFinals: { ...DONE, summary: "a second final reply" } }),
  doneInvalid: (): Behavior => ({ reply: { ...DONE, summary: null } }),
  binding: (): Behavior => ({ reply: { ...DONE, ticket: "T9", session_id: "another-session" } }),
  verdictRuns: (runs: unknown[]): Behavior => ({ reply: { results: [{ req: 1, status: "satisfied", runs,
    needs: null, note: null }], summary: "checked" } }),
  hang: (): Behavior => ({ hang: true }),
  /** The role's happy path with extra steps after it (`B.also({ read: "README.md" })`). */
  also: (...steps: Step[]): BehaviorOf => extend({ steps }),
  read: (file: string): BehaviorOf => extend({ steps: [{ read: file }] }),
  /** The user edits (or removes) a file mid-turn: no tool event (C123). */
  outside: (o: NonNullable<Step["outside"]>): BehaviorOf =>
    extend({ steps: [{ outside: o }] }),
  /** QA's prepare reply with these requirements. */
  requirements: (list: { from: number; text: string; check: string | null }[]): Behavior => ({ steps: [],
    reply: { requirements: list.map((r) => ({ ...r, expect: r.check ? "passes" : null })), in_scope: ["the ticket"],
      out_of_scope: [], risks: [], add_tags: [] } }),
  /** QA rejects: each listed requirement not-satisfied with its note, the rest satisfied. */
  reject: (notes: Record<number, string>) => verdict((r) => (notes[r.req] === undefined ? r
    : { ...r, status: "not-satisfied", note: notes[r.req]! }), "Rejected."),
  /** The same rejection every time (SCN 2.2 same-reject). */
  sameReject: (n: number) => verdict((r) => (r.req === n ? { ...r, status: "not-satisfied",
    note: `R${n} still fails the same way` } : r), "Rejected."),
  pass: () => verdict((r) => r, "Every requirement is satisfied."),
  unable: (n: number, needs: string) => verdict((r) => (r.req === n ? { ...r, status: "unable", runs: [], needs,
    note: `R${n} needs a ${needs}` } : r), "One requirement couldn't be verified."),
  malformedOf,
  /** The repair resend: the same reply, as valid JSON. */
  repairOf: (reply: unknown): Behavior => ({ reply }),
  /** Works for `minutes` on the fake clock with activity every `every` minutes (0: none). */
  slow: (minutes: number, every = 1): BehaviorOf => {
    const steps: Step[] = [];
    const chunk = every || minutes;
    for (let t = 0; t < minutes; t += chunk) {
      steps.push({ wait: chunk * 60_000 }, ...(every ? [{ activity: `working, ${t + chunk} min in` }] : []));
    }
    return extend({}, steps);
  },
  error: (code: "transient" | "quota" | "auth", resetAt?: string): Behavior => ({ error: code === "quota"
    ? "usage limit reached" : code === "auth" ? "authentication failed: please log in" : "overloaded, try again",
  errorCode: code, ...(resetAt ? { resetAt } : {}) }),
  toolFail: (n: number): BehaviorOf => extend({}, [{ toolFail: n }]),
  toolShapes: (): BehaviorOf => extend({}, [{ toolFail: 6 }, { toolShapes: true }]),
  /** run_check calls; the reply cites the runs they returned. */
  runCheck: (...commands: string[]): BehaviorOf => (meta, ctx) => {
    const base = happy(meta, ctx);
    const edits = (base.steps ?? []).filter((s) => s.edit);
    return { ...base, steps: [...edits, ...commands.map((c) => ({ runCheck: c }))] };
  },
  /** A test run in the agent's own shell, then a done reply claiming it passed; no run_check. */
  shellTest: (command: string): BehaviorOf => (meta, ctx) => {
    const base = happy(meta, ctx);
    return { steps: [...(base.steps ?? []).filter((s) => s.edit), { shell: command }],
      reply: { ...DONE, summary: `Ran ${command}; it passed.` } };
  },
  edit: (file: string): BehaviorOf => extend({}, [{ edit: file, content: "edited\n" }]),
  ask: (question: string, options: string[]): Behavior => ({ steps: [{ ask: { question, options } }],
    reply: { kind: "needs-input", summary: null, runs: [], block: null,
      question: { text: question, choices: options } } }),
};

export { RUNS };
