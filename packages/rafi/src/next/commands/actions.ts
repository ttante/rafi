// The built commands (M2): each parses, calls one engine action and renders (ARCH 8.3). Others print "not built".
import type { Deps } from "@rafi-ai/engine";
import { managerAction } from "./manager.js";
import { resetAction } from "./reset.js";
import { resumeAction } from "./resume.js";
import { stopAction } from "./stop.js";
import { startAction } from "./start.js";
import { statsExportAction, statsShowAction, statusAction, ticketsShowAction } from "./views.js";

export interface ActionContext {
  readonly deps: Deps;
  readonly project: string;
  readonly args: readonly unknown[];
  readonly opts: Record<string, unknown>;
  readonly argv: readonly string[];
}

export type Action = (ctx: ActionContext) => Promise<number>;

export const actions: Readonly<Record<string, Action>> = Object.freeze({
  start: startAction,
  resume: resumeAction,
  stop: stopAction,
  reset: resetAction,
  manager: managerAction,
  "tickets show": ticketsShowAction,
  "stats export": statsExportAction,
  "stats show": statsShowAction,
  status: statusAction,
});
