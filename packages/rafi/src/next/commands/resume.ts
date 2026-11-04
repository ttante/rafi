// `rafi resume [project]` (CMD-9, ARCH 8.5): take over a stopped or crashed build and continue it, or attach to one
// another process runs; with several things to resume, ask which (PRM-90). --run (a unique prefix), --id and
// --discard (saved interviews), --ticket, one-off -a/--agent and -m/--model, -y. `--allow` is refused as start
// refuses it (C165): grants are M7's and are never recorded as resume settings.
import path from "node:path";
import { openEngine, resumeBuild, STATE_DB, type Deps } from "@rafi-ai/engine";
import { attachView } from "../ui/attach.js";
import { line } from "../ui/lines.js";
import { choose } from "../ui/prompts.js";
import type { ActionContext } from "./actions.js";
import { startUI } from "./start.js";

function resumeUI(deps: Deps) {
  return { ...startUI(deps),
    pick: (question: string, choices: readonly string[]) => choose(deps, question, choices),
    async confirmPaused(run: string) {
      const i = await choose(deps, `Build ${run} is paused. Continue the paused build?`, ["Yes, continue it", "No"]);
      return i === null ? null : i === 0;
    } };
}

export async function resumeAction(ctx: ActionContext): Promise<number> {
  const { deps, opts } = ctx;
  if (opts.allow !== undefined) {
    deps.terminal.error(line("--allow isn't in the new engine yet (milestone M7)."));
    return 1;
  }
  if (opts.agent !== undefined && opts.agent !== "claude" && opts.agent !== "codex") {
    deps.terminal.error(line("--agent takes claude or codex."));
    return 1;
  }
  // With no log yet there's no build to take over; saved interviews are still listed (read-only, C147).
  const readOnly = !(await deps.fs.stat(path.join(ctx.project, STATE_DB)));
  const engine = await openEngine({ projectDir: ctx.project, deps, readOnly });
  try {
    const out = await resumeBuild(engine, { run: opts.run as string | undefined, id: opts.id as string | undefined,
      discard: opts.discard as string | undefined, ticket: opts.ticket as string | undefined,
      agent: opts.agent as "claude" | "codex" | undefined, model: opts.model as string | undefined,
      autoApprove: Boolean(opts.autoApprove || opts.yes), tty: deps.terminal.isTTY }, resumeUI(deps));
    if ("attach" in out) return await attachView(deps, engine, out.attach);
    return out.code;
  } finally {
    engine.close();
  }
}
