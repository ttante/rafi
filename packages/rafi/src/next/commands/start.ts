// `rafi start <project>` (CMD-7): parse, call engine.start, render. --steps N, --ticket, --no-qa, --agent, --model,
// --effort, --fast, -y; the other flags are later milestones and are refused by name for now.
import { openEngine, startBuild, type Deps, type UiAnswer, type UiQuestion } from "@rafi-ai/engine";
import { activityUI } from "../ui/activity.js";
import { askText, choose } from "../ui/prompts.js";
import { line } from "../ui/lines.js";
import type { ActionContext } from "./actions.js";

const LATER: Readonly<Record<string, string>> = Object.freeze({ stacks: "M5", toTicket: "M5", detach: "M4",
  branchPerTicket: "M5", completion: "M5", base: "M5", dirtyWork: "M5", skip: "M5", allow: "M7", set: "M5" });

/** "What next?" in a terminal (C100, C102): the options; a required note; PRM-82's confirmation ("No" asks again);
 * an option that isn't built says so and asks again. Null: no terminal, or the input ended. */
async function question(deps: Deps, q: UiQuestion): Promise<UiAnswer> {
  if (!deps.terminal.isTTY) return null;
  for (;;) {
    const i = await choose(deps, q.text, q.options.map((o) => o.label));
    if (i === null) return null;
    const o = q.options[i]!;
    if (o.later) {
      deps.terminal.write(`"${o.label}" isn't in the new engine yet (milestone ${o.later}).\n`);
      continue;
    }
    if (o.note) {
      const note = await askText(deps, o.note.prompt, { required: o.note.required,
        refusal: `"${o.label.replace(/ \(.*\)$/, "")}" needs a note saying what you checked.` });
      return note === null ? null : { choice: o.id, note, confirmed: false };
    }
    if (o.confirm) {
      const c = await choose(deps, o.confirm.text, o.confirm.options);
      if (c === null) return null;
      if (c !== o.confirm.yes) continue;
      return { choice: o.id, note: null, confirmed: true };
    }
    return { choice: o.id, note: null, confirmed: false };
  }
}

function ui(deps: Deps) {
  const base = activityUI(deps);
  return { ...base,
    async ask(kind: "auth" | "quota", text: string) {
      if (!deps.terminal.isTTY) return "cancel" as const;
      const runtime = /codex/i.test(text) ? "Codex" : "Claude";
      const what = kind === "auth" ? `${runtime} is not ready for this build (${text}).`
        : `${runtime}'s usage limit was reached (${text}).`;
      const i = await choose(deps, `${what} What should Rafi do?`, ["Retry", "Switch runtime for this agent " +
        "(from the next turn; the project default is unchanged; a new session loses continuity and may cost " +
        "differently)", "Cancel"]);
      return i === 0 ? "retry" as const : i === 1 ? "switch" as const : "cancel" as const;
    },
    question: (q: UiQuestion) => question(deps, q),
    async confirmNoSandbox(warning: string) {
      const i = await choose(deps, warning, ["Run tests without a sandbox", "Cancel"]);
      return i === 0;
    } };
}

export async function startAction(ctx: ActionContext): Promise<number> {
  const { deps, opts } = ctx;
  const later = Object.keys(LATER).find((k) => opts[k] !== undefined && !(k === "branchPerTicket" && opts[k] === true));
  if (later) {
    deps.terminal.error(line(`--${later.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} isn't in the new engine ` +
      `yet (milestone ${LATER[later]}).`));
    return 1;
  }
  const steps = opts.steps === undefined ? undefined : Number(opts.steps);
  if (steps !== undefined && !(Number.isInteger(steps) && steps > 0)) {
    deps.terminal.error(line("--steps takes a whole number of tickets, 1 or more."));
    return 1;
  }
  if (opts.agent !== undefined && opts.agent !== "claude" && opts.agent !== "codex") {
    deps.terminal.error(line("--agent takes claude or codex."));
    return 1;
  }
  const engine = await openEngine({ projectDir: ctx.project, deps });
  try {
    return await startBuild(engine, { argv: [...ctx.argv], steps, ticket: opts.ticket as string | undefined,
      qa: opts.qa === false ? false : undefined, agent: opts.agent as "claude" | "codex" | undefined,
      model: opts.model as string | undefined, effort: opts.effort as string | undefined,
      fast: opts.fast === true ? true : undefined, autoApprove: Boolean(opts.autoApprove || opts.yes),
      tty: deps.terminal.isTTY }, ui(deps));
  } finally {
    engine.close();
  }
}
