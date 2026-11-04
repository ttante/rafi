// The build loop (ARCH 4.5): fold → decide → run one step → safe point, until decide says finish. Steps are
// looked up by the workflow node's step name; the workflow is the one build.started pinned (ARCH 4.8).
import { askWhatNext, openWhatNext } from "../ask/blocked.js";
import { openQuestions } from "../ask/questions.js";
import { decide } from "../state/decide.js";
import type { Folded, TicketDefinition } from "../state/types.js";
import { standard } from "../workflow/standard.js";
import { writeProgress } from "../progress/write.js";
import { append, closeSessions, type BuildContext } from "./context.js";
import { checkNode } from "./steps/check.js";
import { deliverStep } from "./steps/deliver.js";
import { prepareStep } from "./steps/prepare.js";
import { reviewStep } from "./steps/review.js";
import { workStep } from "./steps/work.js";

const ACTIVE: ReadonlySet<string> = new Set(["building", "reviewing", "fixing"]);

async function runStep(ctx: BuildContext, view: Folded, ticket: string, nodeId: string, redo: boolean) {
  const node = standard.nodes.find((n) => n.id === nodeId);
  const attempt = view.tickets[ticket]?.attempt ?? 1;
  switch (node?.step) {
    case "prepare": return prepareStep(ctx, ticket, attempt, redo);
    case "build":
    case "fix": return workStep(ctx, ticket, node.step, attempt, redo);
    case "check": return checkNode(ctx, ticket, attempt);
    case "review": return reviewStep(ctx, ticket, attempt, redo);
    case "deliver": return deliverStep(ctx, ticket, attempt);
    default: throw new Error(`no step for workflow node ${nodeId}`);
  }
}

/** C99: a blocked(what-next) ticket with no open what-next question gets one (after boundary 4). */
async function openMissing(ctx: BuildContext, view: Folded): Promise<boolean> {
  let opened = false;
  for (const t of Object.values(view.tickets)) {
    if (t.state !== "blocked" || t.block?.kind !== "what-next") continue;
    const asked = Object.values(view.questions).some((q) => q.status === "open" && q.kind === "what-next" &&
      q.tickets.includes(t.id));
    if (!asked) opened = Boolean(await openWhatNext(ctx.engine, ctx.deps, ctx.run, t.id, t.fixesUsed)) || opened;
  }
  return opened;
}

/** Boundary 4, then any question a blocked ticket asks, then the progress file; a ticket that left its active
 * states gets fresh sessions next time. */
async function safePoint(ctx: BuildContext, defs: readonly TicketDefinition[], ticket: string): Promise<void> {
  ctx.deps.hooks.crash(`4: recorded, before progress write (${ticket})`);
  let view = ctx.engine.fold(defs);
  if (await openMissing(ctx, view)) view = ctx.engine.fold(defs);
  await writeProgress(ctx.engine, view);
  if (!ACTIVE.has(view.tickets[ticket]?.state ?? "")) await closeSessions(ctx, ticket);
}

/** C100: with nothing else to build, the open what-next questions are asked in the terminal, oldest first. */
async function askInTerminal(ctx: BuildContext, defs: readonly TicketDefinition[]): Promise<boolean> {
  const ask = ctx.ui.question;
  if (!ask) return false;
  const view = ctx.engine.fold(defs);
  const open = openQuestions(view).filter((q) => q.kind === "what-next");
  if (!open.length) return false;
  const ids = open.map((q) => q.id);
  await append(ctx, null, { type: "build.waiting", data: { questions: ids } });
  for (const q of open) {
    const fixes = view.tickets[q.tickets[0] ?? ""]?.fixesUsed ?? 0;
    if (!(await askWhatNext(ctx.engine, ctx.deps, ctx.run, q, (u) => ask.call(ctx.ui, u), fixes))) return false;
  }
  await append(ctx, null, { type: "build.unwaiting", data: { questions: ids } });
  await writeProgress(ctx.engine, ctx.engine.fold(defs));
  return true;
}

export async function runLoop(ctx: BuildContext, defs: readonly TicketDefinition[]): Promise<number> {
  try {
    for (;;) {
      const view = ctx.engine.fold(defs);
      if (view.violations.length) throw new Error(`the event log is inconsistent: ${view.violations[0]!.reason}`);
      const action = decide(view, { safePoint: true, stepInFlight: false });
      if (action.kind === "start-ticket") {
        await append(ctx, action.ticket, { type: "ticket.started", data: { resume_step: action.resumeNode } });
        continue;
      }
      if (action.kind === "step") {
        await runStep(ctx, view, action.ticket, action.node, action.redo);
        await safePoint(ctx, defs, action.ticket);
        continue;
      }
      if (action.kind === "finish") {
        await append(ctx, null, { type: "build.finished", data: { complete: action.complete, done: action.done,
          left: action.left } }, { type: "build.owner_released", data: { reason: "finished" } });
        await writeProgress(ctx.engine, ctx.engine.fold(defs));
        return action.complete ? 0 : 1;
      }
      if (action.kind === "wait" && await askInTerminal(ctx, defs)) continue;
      await append(ctx, null, { type: "build.owner_released", data: { reason: "waiting" } });
      await writeProgress(ctx.engine, ctx.engine.fold(defs));
      for (const q of openQuestions(ctx.engine.fold(defs))) {
        ctx.ui.line(`${q.tickets.join(", ") || "The build"} is waiting on question ${q.no} (${q.kind === "what-next"
          ? "What next?" : q.kind}): answer it in a terminal with \`rafi start . --ticket ${q.tickets[0] ?? ""}\`; ` +
          "`rafi answer` comes in a later version.");
      }
      return 1;
    }
  } finally {
    await closeSessions(ctx);
  }
}
