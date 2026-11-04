// `rafi manager --ask "/<command> …"`: Manager's thin host commands only, for now (C153): /pause, /request-attempt,
// /answer-question. Every other use of Manager is milestone M9.
import path from "node:path";
import { openEngine, parseHost, runHost, STATE_DB } from "@rafi-ai/engine";
import { line, notBuiltLine } from "../ui/lines.js";
import type { ActionContext } from "./actions.js";

export async function managerAction(ctx: ActionContext): Promise<number> {
  const { deps } = ctx;
  const ask = ctx.opts.ask as string | undefined;
  if (!ask?.trim().startsWith("/")) {
    deps.terminal.error(notBuiltLine("manager", "M9"));
    return 1;
  }
  const parsed = parseHost(ask);
  if ("error" in parsed) {
    deps.terminal.error(line(parsed.error));
    return 1;
  }
  if (!(await deps.fs.stat(path.join(ctx.project, STATE_DB)))) {
    deps.terminal.error(line("No build has run here yet."));
    return 1;
  }
  const engine = await openEngine({ projectDir: ctx.project, deps });
  try {
    const said = await runHost(engine, parsed);
    (said.code === 0 ? deps.terminal.write.bind(deps.terminal) : deps.terminal.error.bind(deps.terminal))(
      said.code === 0 ? `${said.line}\n` : line(said.line));
    return said.code;
  } finally {
    engine.close();
  }
}
