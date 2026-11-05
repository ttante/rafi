// `rafi status` (ARCH 8.10, C48): a read-only view of the fold and the lease (C147). The build's shown outcome
// (C134, C145), its scope and progress, one plain line per blocked ticket, the current turn's liveness; for a build
// rafi resume continues: the last step that finished, the step it redoes, the open questions and the exact command
// (S-CRASH-4 step 5); one line per delivery unit (C228, `units.ts`). Never JSON; only 1.0 command names.
import { escapeControl } from "../log/redact.js";
import { interrupted } from "../build/resume.js";
import { openQuestions } from "../ask/questions.js";
import { shownOutcome, type Outcome } from "../state/labels.js";
import type { BuildState, Folded } from "../state/types.js";
import type { Engine } from "../api/engine.js";
import { definitions, ownerOf, runIds } from "../build/runs.js";
import { pendingImport } from "../progress/import.js";
import { status } from "../progress/write.js";
import { fold } from "../state/fold.js";
import { builtInWorkflows } from "../workflow/load.js";
import { unitLines } from "./units.js";

const PROGRESS_SHOWN = ".rafi/progress.yaml";

type Data = Record<string, unknown>;
type Ev = { type: string; run_id: string | null; ticket_id: string | null; data: unknown; at: string };
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const OUTCOMES: ReadonlySet<string> = new Set(["requirements.written", "builder.reported", "checks.passed",
  "checks.failed", "verdict.recorded", "delivery.done", "step.failed", "ticket.blocked"]);

/** The last step with a recorded outcome in this run: its ticket and step. */
export function lastFinished(events: readonly Ev[]): { ticket: string; step: string } | null {
  const started: Record<string, string> = {};
  let last: { ticket: string; step: string } | null = null;
  for (const e of events) {
    if (!e.ticket_id) continue;
    if (e.type === "step.started") started[e.ticket_id] = String((e.data as Data).step);
    else if (OUTCOMES.has(e.type) && started[e.ticket_id]) last = { ticket: e.ticket_id, step: started[e.ticket_id]! };
  }
  return last;
}

/** The outcome a build shows now (C134): status, stats show and the picker use this. */
export async function outcomeOf(engine: Engine, view: Folded, build: BuildState, events: readonly Ev[]):
  Promise<Outcome> {
  const owner = await ownerOf(engine, build);
  const mine = events.filter((e) => e.run_id === build.run);
  const since = mine.filter((e) => e.type === "build.waiting").at(-1)?.at ?? null;
  const later = runIds(view).slice(runIds(view).indexOf(build.run) + 1);
  return shownOutcome(build, { owner, since, heartbeat: engine.lease(build.run)?.heartbeat_at ?? null,
    superseded: later.length > 0 });
}

function scopeText(build: BuildState): string {
  const kind = build.scope?.kind;
  return kind === "steps" ? `${String(build.scope!.value)} ticket(s)` : kind === "ticket"
    ? `ticket ${String(build.scope!.value)}` : "every ticket";
}

function turnLine(engine: Engine, build: BuildState, mine: readonly Ev[]): string | null {
  const lastTurn = mine.filter((e) => ["turn.retry", "turn.intent", "turn.reply"].includes(e.type)).at(-1);
  if (lastTurn?.type === "turn.retry") {
    const d = lastTurn.data as Data;
    const retries = Number((build.settings["retries.turn"]?.value as number | undefined) ?? 3);
    const next = Date.parse(lastTurn.at) + Number(d.delay_ms);
    return `Waiting on the provider: retry ${String(d.attempt)} of ${retries} (${String(d.category)}); next try at ` +
      `${hhmmss(next)}.`;
  }
  if (lastTurn?.type !== "turn.intent") return null;
  const last = mine.filter((e) => e.type === "turn.activity" || e.type === "turn.intent").at(-1)!;
  const quiet = engine.deps.clock.now().getTime() - Date.parse(last.at);
  return quiet >= 120_000 ? `The agent is active but quiet (${Math.round(quiet / 60_000)} min).`
    : "The agent is working.";
}

/** For a build rafi resume continues: the last step that finished, the redo, the open questions, the command. */
function resumeLines(view: Folded, build: BuildState, mine: readonly Ev[]): string[] {
  const lines: string[] = [];
  const last = lastFinished(mine);
  lines.push(last ? `The last step that finished: ${last.ticket}'s ${last.step} step.` : "No step has finished yet.");
  const redo = interrupted(view, build.narrowed);
  lines.push(redo ? `\`rafi resume\` redoes ${redo.ticket}'s ${redo.step} step.`
    : "`rafi resume` continues the build.");
  const open = openQuestions(view);
  if (!open.length) lines.push("No open questions.");
  for (const q of open) lines.push(`Question ${q.no} (${q.kind === "what-next" ? "What next?" : q.kind}): ${q.text}`);
  lines.push("Continue with `rafi resume`.");
  return lines;
}

/** ARCH 3.6 `:390`: a progress file newer than this database is folded in memory, never imported by a reader; the
 * lines say so and name what it changes (C302). */
async function withFile(engine: Engine, all: readonly (Ev & { seq: number })[]):
  Promise<{ view: Folded; said: string[] }> {
  const defs = await definitions(engine);
  const view = engine.fold(defs);
  const pending = await pendingImport(engine, defs.map((d) => d.id));
  if (!pending?.events.length) return { view, said: [] };
  const at = engine.deps.clock.now().toISOString();
  const seq = all.at(-1)?.seq ?? 0;
  const extra = pending.events.map((e, i) => ({ ...e, seq: seq + i + 1, at, class: "state" as const }));
  const shown = fold([...all, ...extra], { workflows: builtInWorkflows, definitions: defs });
  const changed = Object.values(shown.tickets).filter((t) => !view.tickets[t.id] ||
    status(view.tickets[t.id]!) !== status(t)).map((t) => `${t.id} ${status(t)}`);
  return { view: shown, said: [`Shown with ${PROGRESS_SHOWN}'s newer entries, folded in memory: this computer's ` +
    `database is older (${changed.join(", ")}). The next command that writes, such as \`rafi resume\`, ` +
    "imports them."] };
}

export async function statusLines(engine: Engine): Promise<string[]> {
  const all: (Ev & { seq: number })[] = [];
  for await (const e of engine.events()) all.push(e);
  const { view, said } = await withFile(engine, all);
  const lines = await viewLines(engine, view, all);
  return [...lines.slice(0, 1), ...said, ...lines.slice(1)];
}

async function viewLines(engine: Engine, view: Folded, all: readonly Ev[]): Promise<string[]> {
  if (!view.run) return ["No build has run here yet. Start one with `rafi start . --steps 1`."];
  const build = view.builds[view.run]!;
  const mine = all.filter((e) => e.run_id === view.run);
  const done = view.doneInRun[view.run] ?? [];
  const outcome = await outcomeOf(engine, view, build, all);
  const lines = [`Build ${view.run}: ${outcome.text}; scope: ${scopeText(build)}; ${done.length} done ` +
    `(${done.join(", ") || "none"}).`];
  const live = ["running", "pausing", "stopping", "recovering", "not-responding"].includes(outcome.kind);
  for (const t of Object.values(view.tickets)) {
    if (live && ["building", "reviewing", "fixing"].includes(t.state)) lines.push(`${t.id}: ${t.state} (${t.node})`);
    if (t.state === "blocked" && t.block) lines.push(`${t.id} is blocked: ${escapeControl(t.block.reason)}`);
  }
  lines.push(...unitLines(engine, view, all));
  if (live) {
    const turn = turnLine(engine, build, mine);
    if (turn) lines.push(turn);
    lines.push("Follow it with `rafi resume`, or stop it with `rafi stop`.");
  } else if (outcome.kind === "paused" || outcome.kind === "waiting") {
    for (const q of openQuestions(view)) lines.push(`Question ${q.no}: ${q.text}`);
    lines.push(outcome.kind === "paused" ? "Continue it with `rafi resume`; stop it with `rafi stop`."
      : "Answer in its terminal, or continue with `rafi resume`.");
  } else if (outcome.resumable) {
    lines.push(...resumeLines(view, build, mine));
  } else if (outcome.kind === "reset" || outcome.kind === "finished") {
    lines.push("Start a new build with `rafi start`.");
  }
  return lines;
}
