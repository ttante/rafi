// The build loop (ARCH 4.5): fold → decide → run one step → safe point, until decide says finish. Steps are
// looked up by the workflow node's step name; the workflow is the one build.started pinned (ARCH 4.8). M4: the
// owner holds the lease with a heartbeat (C132, C136), watches the log for stop, pause and answers (C139), acts on
// decide's stop, pause and hold (C137, C140), and Ctrl+C in its terminal stops it now (C137).
import { openQuestions } from "../ask/questions.js";
import type { StoredEvent } from "../log/types.js";
import { watchControls } from "../log/watch.js";
import { decide } from "../state/decide.js";
import type { Folded, TicketDefinition } from "../state/types.js";
import { standard } from "../workflow/standard.js";
import { writeProgress } from "../progress/write.js";
import { append, type BuildContext } from "./context.js";
import { closeSessions } from "../turns/agent.js";
import { askInTerminal, safePoint, stopCauseOf, type Prompting } from "./safepoint.js";
import { checkNode } from "./steps/check.js";
import { deliverStep } from "./steps/deliver.js";
import { prepareStep } from "./steps/prepare.js";
import { reviewStep } from "./steps/review.js";
import { workStep } from "./steps/work.js";
import { BuildStopped, stopControl, type StopControl } from "./stop.js";

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

/** C132: build.owner_released and the lease row go together; a crash leaves the row (that's "crashed"). */
async function release(ctx: BuildContext, reason: string, ...before: { type: string; data: unknown }[]) {
  await ctx.engine.disown(ctx.run, [...before, { type: "build.owner_released", data: { reason } }]
    .map((e) => ({ ...e, run_id: ctx.run, ticket_id: null, actor: "engine" })));
}

/** What the watcher and Ctrl+C reach while the loop runs: the stop control, the open prompt, a held pause. */
interface Live {
  readonly control: StopControl;
  readonly prompting: Prompting;
  wake: () => void;
  /** Ctrl+C's own request, so the loop sees it in the log before it decides again. */
  requested: Promise<unknown> | null;
}

function onControl(live: Live, e: StoredEvent): void {
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (e.type === "build.stop_requested" && d.mode === "now") {
    live.control.now.abort(d.source === "ctrl-c" ? "ctrl-c" : "stop");
  }
  const asking = live.prompting.current;
  if (asking && (e.type === "question.answered" || e.type === "question.closed") && d.id === asking.question) {
    live.prompting.closed = { why: "answered", by: e.actor === "manager" ? "Manager" : (e.source ?? e.actor) };
    asking.controller.abort();
  } else if (asking && ["build.stop_requested", "build.pause_requested"].includes(e.type)) {
    live.prompting.closed = { why: "control" };
    asking.controller.abort();
  }
  live.wake();
}

/** C137: the first Ctrl+C stops now (the turn is cancelled and confirmed); a second ends the provider at once. */
function interrupt(ctx: BuildContext, live: Live): void {
  if (live.control.now.signal.aborted) { live.control.kill.abort(); return; }
  const state = ctx.engine.fold().builds[ctx.run]?.state;
  if (state && ["running", "waiting", "paused", "stopping"].includes(state)) {
    live.requested = ctx.engine.append([{ type: "build.stop_requested", run_id: ctx.run, actor: "user",
      source: "terminal", data: { mode: "now", source: "ctrl-c" } }]).catch(() => undefined);
  }
  live.control.now.abort("ctrl-c");
  if (live.prompting.current) {
    live.prompting.closed = { why: "control" };
    live.prompting.current.controller.abort();
  }
  live.wake();
}

/** A paused build holds, keeping its lease and heartbeat (C140), until an unpause or a stop request arrives. */
function held(live: Live): Promise<void> {
  return new Promise((resolve) => { live.wake = () => { live.wake = () => undefined; resolve(); }; });
}

async function stopped(ctx: BuildContext, defs: readonly TicketDefinition[], view: Folded): Promise<number> {
  const cause = stopCauseOf(view.builds[ctx.run]!);
  await release(ctx, "stopped", { type: "build.stopped", data: { cause } });
  await writeProgress(ctx.engine, ctx.engine.fold(defs));
  ctx.ui.line(cause === "stop" ? `Build ${ctx.run} stopped after the current step. \`rafi resume\` continues it.`
    : `Build ${ctx.run} stopped; \`rafi resume\` redoes the interrupted step.`);
  return cause === "ctrl-c" ? 130 : 0;
}

async function waiting(ctx: BuildContext, defs: readonly TicketDefinition[]): Promise<number> {
  await release(ctx, "waiting");
  await writeProgress(ctx.engine, ctx.engine.fold(defs));
  for (const q of openQuestions(ctx.engine.fold(defs))) {
    ctx.ui.line(`${q.tickets.join(", ") || "The build"} is waiting on question ${q.no} (${q.kind === "what-next"
      ? "What next?" : q.kind}): answer it in a terminal with \`rafi resume\`; \`rafi answer\` comes in a later ` +
      "version.");
  }
  return 1;
}

/** decide's pause and a held pause (C140). True: the loop goes on deciding. */
async function pauseOrHold(ctx: BuildContext, defs: readonly TicketDefinition[], view: Folded, live: Live,
  kind: string): Promise<boolean> {
  const build = view.builds[ctx.run];
  if (kind === "pause") {
    await append(ctx, null, { type: "build.paused", data: { source: "engine", boundary: null } });
    await writeProgress(ctx.engine, ctx.engine.fold(defs));
    ctx.ui.line("Paused at a safe point. `rafi resume` continues it; `rafi stop` stops it.");
    return true;
  }
  if (kind !== "hold" || build?.state !== "paused") return false;
  if (build.unpausing) {
    await append(ctx, null, { type: "build.unpaused", data: { source: "engine", boundary: null } });
    ctx.ui.line("Continuing the paused build.");
  } else {
    await held(live);
  }
  return true;
}

export async function runLoop(ctx: BuildContext, defs: readonly TicketDefinition[]): Promise<number> {
  const live: Live = { control: ctx.control ?? stopControl(), prompting: { current: null, closed: null },
    wake: () => undefined, requested: null };
  const run: BuildContext = { ...ctx, control: live.control };
  const beat = ctx.engine.heartbeat(ctx.run);
  const unwatch = watchControls(ctx.engine, ctx.run, (e) => onControl(live, e));
  const offInterrupt = ctx.ui.onInterrupt?.(() => interrupt(run, live)) ?? (() => undefined);
  try {
    for (;;) {
      if (live.requested) { await live.requested; live.requested = null; }
      const view = ctx.engine.fold(defs);
      if (view.violations.length) throw new Error(`the event log is inconsistent: ${view.violations[0]!.reason}`);
      const action = decide(view, { safePoint: true, stepInFlight: false });
      if (action.kind === "stop") return await stopped(run, defs, view);
      if (await pauseOrHold(run, defs, view, live, action.kind)) continue;
      if (action.kind === "start-ticket") {
        await append(run, action.ticket, { type: "ticket.started", data: { resume_step: action.resumeNode } });
        continue;
      }
      if (action.kind === "step") {
        try {
          await runStep(run, view, action.ticket, action.node, action.redo);
        } catch (error) {
          if (!(error instanceof BuildStopped)) throw error;
          // The request is normally in the log already (rafi stop, or Ctrl+C's own append); never loop without it.
          if (ctx.engine.fold(defs).builds[ctx.run]?.state !== "stopping") {
            await append(run, null, { type: "build.stop_requested", data: { mode: "now",
              source: error.cause === "ctrl-c" ? "ctrl-c" : "rafi-stop" } });
          }
          continue;
        }
        await safePoint(run, defs, action.ticket);
        continue;
      }
      if (action.kind === "finish") {
        await release(run, "finished", { type: "build.finished", data: { complete: action.complete,
          done: action.done, left: action.left } });
        await writeProgress(ctx.engine, ctx.engine.fold(defs));
        return action.complete ? 0 : 1;
      }
      if (action.kind === "wait" || action.kind === "hold") {
        const asked = await askInTerminal(run, defs, live.prompting);
        if (asked === "answered" || asked === "interrupted") continue;
      }
      return await waiting(run, defs);
    }
  } finally {
    offInterrupt();
    unwatch();
    beat();
    await closeSessions(ctx);
  }
}
