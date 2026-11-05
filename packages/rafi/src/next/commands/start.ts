// `rafi start <project>` (CMD-7): parse, call engine.start, render. --steps N, --ticket, --no-qa, --agent, --model,
// --effort, --fast, -y, --detach (M4); the other flags are later milestones and are refused by name for now.
import {
  openEngine, startBuild, type Deps, type ScopeChoice, type UiAnswer, type UiQuestion,
} from "@rafi-ai/engine";
import { activityUI } from "../ui/activity.js";
import { attachView } from "../ui/attach.js";
import { askText, choose } from "../ui/prompts.js";
import { line } from "../ui/lines.js";
import type { ActionContext } from "./actions.js";

const LATER: Readonly<Record<string, string>> = Object.freeze({ allow: "M7" });
const COMPLETIONS: readonly string[] = ["pr", "pr-ready", "auto-merge", "direct-merge", "none"];

/** "What next?" in a terminal (C100, C102): the options; a required note; PRM-82's confirmation ("No" asks again);
 * an option that isn't built says so and asks again. Null: no terminal, or the input ended. */
async function question(deps: Deps, q: UiQuestion, signal?: AbortSignal): Promise<UiAnswer> {
  if (!deps.terminal.isTTY) return null;
  for (;;) {
    const i = await choose(deps, q.text, q.options.map((o) => o.label), signal);
    if (i === null) return null;
    const o = q.options[i]!;
    if (o.later) {
      deps.terminal.write(`"${o.label}" isn't in the new engine yet (milestone ${o.later}).\n`);
      continue;
    }
    if (o.note) {
      const note = await askText(deps, o.note.prompt, { required: o.note.required,
        refusal: `"${o.label.replace(/ \(.*\)$/, "")}" needs a note saying what you checked.` }, signal);
      return note === null ? null : { choice: o.id, note, confirmed: false };
    }
    if (o.confirm) {
      const c = await choose(deps, o.confirm.text, o.confirm.options, signal);
      if (c === null) return null;
      if (c !== o.confirm.yes) continue;
      return { choice: o.id, note: null, confirmed: true };
    }
    return { choice: o.id, note: null, confirmed: false };
  }
}

/** PRM-70 (C190): the stopping point; then the count, or the ticket typed by its id. */
async function chooseScope(deps: Deps, queue: readonly { id: string; title: string }[]): Promise<ScopeChoice | null> {
  const kind = await choose(deps, "Build tickets or complete delivery stacks?",
    ["Tickets (Recommended)", "Complete stacks", "Up to a ticket"]);
  if (kind === null) return null;
  if (kind === 2) {
    const ids = queue.map((t) => t.id);
    for (let tries = 0; tries < 3; tries += 1) {
      const id = await askText(deps, `Up to which ticket? (${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ", …"
        : ""})`, { required: true, refusal: "Type a ticket id." });
      if (id === null) return null;
      if (ids.includes(id)) return { kind: "to_ticket", value: id };
      deps.terminal.write(`There's no ticket ${id} in the queue.\n`);
    }
    return null;
  }
  const what = kind === 0 ? "How many tickets?" : "How many complete stacks?";
  for (let tries = 0; tries < 3; tries += 1) {
    const typed = await askText(deps, what, { required: true, refusal: "Type a whole number, 1 or more." });
    if (typed === null) return null;
    const n = Number(typed);
    if (Number.isInteger(n) && n > 0) return { kind: kind === 0 ? "steps" : "stacks", value: n };
    deps.terminal.write("Type a whole number, 1 or more.\n");
  }
  return null;
}

export function startUI(deps: Deps) {
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
    question: (q: UiQuestion, signal?: AbortSignal) => question(deps, q, signal),
    onInterrupt: (fn: () => void) => deps.terminal.onInterrupt(fn),
    onHangup: (fn: () => void) => deps.terminal.onInterrupt(fn, ["SIGHUP", "SIGTERM"]),
    chooseScope: (queue: readonly { id: string; title: string }[]) => chooseScope(deps, queue),
    async approvePlan(changed: boolean) {
      if (changed) deps.terminal.write("The plan's tickets changed since you approved them.\n");
      const i = await choose(deps, "How does this plan look?", ["Proceed — start implementing",
        "Give feedback — revise the plan", "Cancel"]);
      return i === null ? null : (["proceed", "feedback", "cancel"] as const)[i]!;
    },
    async confirm(text: string, yes: string, no = "Cancel") {
      const i = await choose(deps, text, [`${yes} (Recommended)`, no]);
      return i === null ? null : i === 0;
    },
    // PRM-75 (C206).
    async chooseDirty(files: readonly string[]) {
      deps.terminal.write(`${files.length} uncommitted ${files.length === 1 ? "file" : "files"}: ${files.slice(0, 5)
        .join(", ")}${files.length > 5 ? ", …" : ""}\n`);
      const i = await choose(deps, "Uncommitted work found. How should the isolated build start?",
        ["From committed code (Recommended)", "Include my uncommitted work", "Cancel"]);
      return i === null ? null : (["preserve", "include", "cancel"] as const)[i]!;
    },
    async confirmNoSandbox(warning: string) {
      const i = await choose(deps, warning, ["Run tests without a sandbox", "Cancel"]);
      return i === 0;
    } };
}

export async function startAction(ctx: ActionContext): Promise<number> {
  const { deps, opts } = ctx;
  const later = Object.keys(LATER).find((k) => opts[k] !== undefined);
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
  const stacks = opts.stacks === undefined ? undefined : Number(opts.stacks);
  if (stacks !== undefined && !(Number.isInteger(stacks) && stacks > 0)) {
    deps.terminal.error(line("--stacks takes a whole number of delivery stacks, 1 or more."));
    return 1;
  }
  if (opts.completion !== undefined && !COMPLETIONS.includes(String(opts.completion))) {
    deps.terminal.error(line(`--completion takes ${COMPLETIONS.join(", ")}.`));
    return 1;
  }
  if (opts.dirtyWork !== undefined && opts.dirtyWork !== "preserve" && opts.dirtyWork !== "include") {
    deps.terminal.error(line("--dirty-work takes preserve or include."));
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
      tty: deps.terminal.isTTY, detach: opts.detach === true, set: opts.set as string[] | undefined,
      completion: opts.completion as string | undefined, branchPerTicket: opts.branchPerTicket as boolean | undefined,
      base: opts.base as string | undefined, dirtyWork: opts.dirtyWork as "preserve" | "include" | undefined,
      toTicket: opts.toTicket as string | undefined, stacks,
      skip: opts.skip as string[] | undefined }, { ...startUI(deps),
      // ARCH 8.5: a live build here; attaching follows it as `rafi resume` does.
      async offerAttach(run: string, q: string) {
        return (await choose(deps, q, ["Attach to it", "Cancel"])) === 0 ? attachView(deps, engine, run) : null;
      } });
  } finally {
    engine.close();
  }
}
