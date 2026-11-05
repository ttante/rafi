// `rafi reset [project]` (CMD-13, Q-CMD-3, ARCH 8.9, 13): this build, everything, or the plan (M8). Each choice is
// previewed with its CLI form first (GUI-R7); `--yes` skips the confirmation. Without a terminal, every choice comes
// from flags.
import path from "node:path";
import { openEngine, resetBuild, resetPlan, STATE_DB, type Deps, type ResetOptions } from "@rafi-ai/engine";
import { line } from "../ui/lines.js";
import { choose } from "../ui/prompts.js";
import type { ActionContext } from "./actions.js";

const ACTIONS = ["restart-current", "archive-restart"] as const;
const CLEANUPS = ["stash", "discard", "handled"] as const;

async function pick<T extends string>(deps: Deps, flag: string, value: unknown, values: readonly T[], question: string,
  labels: readonly string[]): Promise<T | { refusal: string } | null> {
  if (value !== undefined) {
    return values.includes(value as T) ? value as T : { refusal: `${flag} takes ${values.join(", ")}.` };
  }
  if (!deps.terminal.isTTY) return { refusal: `Say ${flag} (${values.join(", ")}); there's no terminal to ask in.` };
  const i = await choose(deps, question, labels);
  return i === null || i >= values.length ? null : values[i]!;
}

async function options(ctx: ActionContext): Promise<ResetOptions | { refusal: string } | null> {
  const { deps, opts } = ctx;
  if (opts.plan !== undefined) return { refusal: "`rafi reset --plan` isn't in the new engine yet (milestone M8)." };
  let scope: "build" | "everything" | "plan" | null = opts.build ? "build" : opts.everything ? "everything" : null;
  if (!scope) {
    if (!deps.terminal.isTTY) return { refusal: "Say what to reset: --build, --everything or --plan." };
    const i = await choose(deps, "Reset this build, everything, or the plan?",
      ["This build", "Everything", "The plan"]);
    if (i === null) return null;
    scope = (["build", "everything", "plan"] as const)[i]!;
  }
  if (scope === "plan") return { refusal: "Resetting the plan isn't in the new engine yet (milestone M8)." };
  const run = opts.run as string | undefined;
  if (scope === "everything") return { scope, run };
  const action = await pick(deps, "--action", opts.action, ACTIONS, "How should Rafi restart this build?",
    ["Restart current: keep the branch and redo the unfinished tickets from your files",
      "Archive and restart: move the unfinished work to an archive branch, then restart from the base", "Cancel"]);
  if (action === null || typeof action === "object") return action;
  if (action === "archive-restart") return { scope, run, action };
  const cleanup = await pick(deps, "--cleanup", opts.cleanup, CLEANUPS, "What about your uncommitted changes?",
    ["Stash them", "Discard them (tracked files only)", "I've handled them"]);
  if (cleanup === null || typeof cleanup === "object") return cleanup;
  return { scope, run, action, cleanup };
}

export async function resetAction(ctx: ActionContext): Promise<number> {
  const { deps } = ctx;
  const o = await options(ctx);
  if (o === null) { deps.terminal.write("Cancelled; nothing was reset.\n"); return 0; }
  if ("refusal" in o) { deps.terminal.error(line(o.refusal)); return 1; }
  if (!(await deps.fs.stat(path.join(ctx.project, STATE_DB)))) {
    deps.terminal.error(line("No build to reset here."));
    return 1;
  }
  const engine = await openEngine({ projectDir: ctx.project, deps });
  try {
    const plan = await resetPlan(engine, o);
    if ("code" in plan) { deps.terminal.error(line(plan.line)); return plan.code; }
    deps.terminal.write(`${plan.lines.join("\n")}\nThe same, as a command: ${plan.form}\n`);
    if (!ctx.opts.yes) {
      if (!deps.terminal.isTTY) { deps.terminal.error(line("Add --yes to reset without a terminal.")); return 1; }
      if ((await choose(deps, "Reset?", ["Reset", "Cancel"])) !== 0) {
        deps.terminal.write("Cancelled; nothing was reset.\n");
        return 0;
      }
    }
    const done = await resetBuild(engine, o);
    for (const l of done.lines) deps.terminal.write(`${l}\n`);
    (done.code === 0 ? deps.terminal.write.bind(deps.terminal) : deps.terminal.error.bind(deps.terminal))(
      done.code === 0 ? `${done.line}\n` : line(done.line));
    return done.code;
  } finally {
    engine.close();
  }
}
