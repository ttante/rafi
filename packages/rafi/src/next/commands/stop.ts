// `rafi stop [project] [--run]` (CMD-11, Q-CMD-6, ARCH 8.5): ask the owner to stop after the current step, or now
// when it's already stopping; exit 0 either way (ARCH 8.8).
import path from "node:path";
import { openEngine, STATE_DB, stopBuild } from "@rafi-ai/engine";
import { line } from "../ui/lines.js";
import type { ActionContext } from "./actions.js";

export async function stopAction(ctx: ActionContext): Promise<number> {
  const { deps } = ctx;
  if (!(await deps.fs.stat(path.join(ctx.project, STATE_DB)))) {
    deps.terminal.error(line("No build is running here."));
    return 0;
  }
  const engine = await openEngine({ projectDir: ctx.project, deps });
  try {
    const said = await stopBuild(engine, { run: ctx.opts.run as string | undefined });
    deps.terminal.error(line(said.line));
    return said.code;
  } finally {
    engine.close();
  }
}
