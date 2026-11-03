// openEngine (ARCH 8.3), M1 part: opens the log, runs the workflow load checks, reads events, folds.
// The rest of the API (start, resume, stop, answer, …) arrives with its milestone.
import path from "node:path";
import type { Deps } from "../deps/types.js";
import { append, type AppendResult } from "../log/append.js";
import { openLog, type Log } from "../log/db.js";
import { redactor } from "../log/redact.js";
import { readEvents } from "../log/read.js";
import type { NewEvent, StoredEvent } from "../log/types.js";
import { applyEvent, emptyAcc, fold, type FoldContext } from "../state/fold.js";
import type { Folded, TicketDefinition } from "../state/types.js";
import { checkWorkflow } from "../workflow/checks.js";
import { builtInWorkflows } from "../workflow/load.js";

export const STATE_DB = path.join(".rafi", "state.sqlite3");

export interface Engine {
  events(q?: { from?: number; run?: string }): AsyncIterable<StoredEvent>;
  fold(definitions?: readonly TicketDefinition[]): Folded;
  append(events: readonly NewEvent[], o?: { idemKey?: string }): Promise<AppendResult>;
  close(): void;
}

export class WorkflowLoadError extends Error {}

function transitionCheck(log: Log, ctx: FoldContext) {
  return (written: readonly StoredEvent[]): string | null => {
    const acc = emptyAcc(ctx);
    const before = readEvents(log.db).events.filter((e) => !written.some((w) => w.seq === e.seq));
    for (const event of before) applyEvent(acc, event, ctx);
    const known = acc.violations.length;
    for (const event of written) applyEvent(acc, event, ctx);
    return acc.violations.slice(known).map((v) => v.reason).join("; ") || null;
  };
}

export async function openEngine(o: { projectDir: string; deps: Deps }): Promise<Engine> {
  for (const workflow of builtInWorkflows) {
    const problems = checkWorkflow(workflow);
    if (problems.length) throw new WorkflowLoadError(`workflow ${workflow.id}: ${problems[0]!.message}`);
  }
  const { deps } = o;
  await deps.fs.mkdir(path.join(o.projectDir, ".rafi"));
  const log = await openLog(deps, path.join(o.projectDir, STATE_DB));
  const ctx: FoldContext = { workflows: builtInWorkflows };
  const appendCtx = {
    log, redact: redactor(deps.env), now: () => deps.clock.now(), newId: () => deps.random.id(),
    checkTransition: transitionCheck(log, ctx),
  };
  return {
    async *events(q = {}) {
      for (const event of readEvents(log.db, { from: q.from, run: q.run }).events) yield event;
    },
    fold: (definitions) => {
      const read = readEvents(log.db);
      const folded = fold(read.events, { ...ctx, definitions });
      return { ...folded, violations: [...read.violations, ...folded.violations] };
    },
    append: (events, opts) => append(appendCtx, events, opts),
    close: () => log.close(),
  };
}
