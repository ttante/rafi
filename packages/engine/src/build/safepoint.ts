// ARCH 4.6's safe point, moved out of the loop (M4): boundary 4, the questions a blocked ticket asks, the progress
// file; the terminal's "What next?" questions, which close when answered elsewhere (C146) or when a stop or pause
// arrives; "Pause at this checkpoint" (C149); and the build's own stop and pause records (C137, C140).
import { askWhatNext, openWhatNext } from "../ask/blocked.js";
import { openQuestions } from "../ask/questions.js";
import { boundary } from "../deps/hooks.js";
import path from "node:path";
import { readProgress } from "../progress/read.js";
import { PROGRESS, writeProgress } from "../progress/write.js";
import type { BuildState, Folded, TicketDefinition } from "../state/types.js";
import { append, type BuildContext } from "./context.js";
import { closeSessions } from "../turns/agent.js";

const ACTIVE: ReadonlySet<string> = new Set(["building", "reviewing", "fixing"]);

/** The open terminal prompt, so the watcher can close it (C146). */
export interface Prompting {
  current: { question: string; controller: AbortController } | null;
  /** Why the last prompt closed: answered elsewhere (and by whom), or the build is stopping or pausing. */
  closed: { why: "answered"; by: string } | { why: "control" } | null;
}

/** S-CRASH-2: a damaged progress file (torn, conflicted, invalid) is rewritten from the database, said once. */
async function checkProgress(ctx: BuildContext): Promise<void> {
  const file = path.join(ctx.project, PROGRESS);
  const text = (await ctx.deps.fs.stat(file)) ? await ctx.deps.fs.read(file) : null;
  const read = readProgress(text);
  if (read.kind === "damaged") {
    ctx.ui.line(`.rafi/progress.yaml was damaged (${read.why}); rafi rewrote it from its database.`);
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
export async function safePoint(ctx: BuildContext, defs: readonly TicketDefinition[], ticket: string): Promise<void> {
  await boundary(ctx.deps.hooks, `4: recorded, before progress write (${ticket})`);
  let view = ctx.engine.fold(defs);
  if (await openMissing(ctx, view)) view = ctx.engine.fold(defs);
  await checkProgress(ctx);
  await writeProgress(ctx.engine, view);
  if (!ACTIVE.has(view.tickets[ticket]?.state ?? "")) await closeSessions(ctx, ticket);
}

export type Asked = "answered" | "ended" | "interrupted" | "none";

/** C100: with nothing else to build, the open what-next questions are asked in the terminal, oldest first. */
export async function askInTerminal(ctx: BuildContext, defs: readonly TicketDefinition[], p: Prompting):
  Promise<Asked> {
  const ask = ctx.ui.question;
  if (!ask) return "none";
  const view = ctx.engine.fold(defs);
  const open = openQuestions(view).filter((q) => q.kind === "what-next");
  if (!open.length) return "none";
  const ids = open.map((q) => q.id);
  if (view.builds[ctx.run]?.state !== "waiting") {
    await append(ctx, null, { type: "build.waiting", data: { questions: ids } });
  }
  for (const q of open) {
    if (ctx.engine.fold(defs).questions[q.id]?.status !== "open") continue;
    const fixes = view.tickets[q.tickets[0] ?? ""]?.fixesUsed ?? 0;
    const controller = new AbortController();
    p.current = { question: q.id, controller };
    p.closed = null;
    const asked = await askWhatNext(ctx.engine, ctx.deps, ctx.run, q, (u) => ask.call(ctx.ui, u, controller.signal),
      fixes);
    p.current = null;
    if (asked === "pause") {
      await ctx.engine.append([{ type: "build.pause_requested", run_id: ctx.run, actor: "user", source: "terminal",
        data: { source: "terminal", boundary: null } }]);
      ctx.ui.line(`Paused with ${q.tickets[0] ?? "the build"}'s question open. \`rafi resume\` from another shell ` +
        "continues; Ctrl+C stops.");
      return "interrupted";
    }
    if (asked) continue;
    const closed = p.closed as Prompting["closed"];
    if (closed?.why === "answered") { ctx.ui.line(`Question ${q.no} was answered by ${closed.by}.`); continue; }
    return closed?.why === "control" ? "interrupted" : "ended";
  }
  await append(ctx, null, { type: "build.unwaiting", data: { questions: ids } });
  await writeProgress(ctx.engine, ctx.engine.fold(defs));
  return "answered";
}

/** C137: the cause build.stopped records for a stopping build. */
export function stopCauseOf(build: BuildState): "stop" | "cancel" | "ctrl-c" {
  if (build.stopMode !== "now") return "stop";
  return build.stopSource === "ctrl-c" ? "ctrl-c" : "cancel";
}
