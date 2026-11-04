// engine.resume (ARCH 8.5): which build (`--run` prefix, else the latest), whether its owner is alive, then attach
// (C141) or take it over: the lease with build.owner_lost / build.resumed / build.owner_acquired in one transaction
// (C132) that refuses when the checkout changed since the decision (build/claim.ts), the redo line (C135), and the
// loop, which redoes the interrupted step (4.5 rule 3). The narrowed ticket and the one-off agent and model go in
// build.resumed (P32, C144, C165).
import type { Settings } from "rafi-spec/v1";
import { runLoop } from "../build/loop.js";
import { closeStale, redoLine, takeover } from "../build/resume.js";
import {
  discardInterview, findInterview, pruneInterviews, readInterviews, unfinishedInterviews,
} from "../setup/interviews.js";
import { interviewCandidates, interviewResult, type Candidate } from "../setup/picker.js";
import { definitions, findRun, ownerOf } from "../build/runs.js";
import type { Engine } from "./engine.js";
import { contextFor, prepareRun, type RunUI } from "../build/run.js";
import { acquired, claimRun, type Ready } from "../build/claim.js";
import type { BuildState } from "../state/types.js";
import { outcomeOf } from "../stats/status.js";
import { unpauseBuild } from "./stop.js";

export interface ResumeOptions {
  readonly run?: string;
  /** `--id`: a saved interview (C150). */
  readonly id?: string;
  /** `--discard`: remove a saved interview. */
  readonly discard?: string;
  readonly ticket?: string;
  readonly agent?: "claude" | "codex";
  readonly model?: string;
  readonly autoApprove: boolean;
  readonly tty: boolean;
}

export type ResumeResult = { code: number } | { attach: string };

/** The picker (PRM-90, C143) and "Continue the paused build?" (C140), in the CLI's terminal. */
export interface ResumeUI extends RunUI {
  pick?(question: string, choices: readonly string[]): Promise<number | null>;
  confirmPaused?(run: string): Promise<boolean | null>;
}

/** This resume's one-off overrides, with source `flag` (FLAG-RS-11; P32: only agent and model, C165). */
function overrides(o: ResumeOptions): Settings {
  const out: Settings = {};
  if (o.agent) out["agent.runtime"] = { value: o.agent, source: "flag" };
  if (o.model) out["agent.model"] = { value: o.model, source: "flag" };
  return out;
}

/** C140: a paused build with a live owner continues only once you say so (auto-approve: yes). Null: decide again. */
async function pausedAttach(engine: Engine, run: string, o: ResumeOptions, ui: ResumeUI, since: number):
  Promise<ResumeResult | null> {
  const yes = o.autoApprove ? true : o.tty && ui.confirmPaused ? await ui.confirmPaused(run) : null;
  if (yes === null && !o.tty) {
    ui.line(`Build ${run} is paused. \`rafi resume -y\` continues it; \`rafi stop\` stops it.`);
    return { code: 1 };
  }
  if (!yes) return { code: 0 };
  const said = await unpauseBuild(engine, run, { actor: "user", source: "terminal" }, since);
  if (said) ui.line(said.line);
  return said && { attach: run };
}

export async function resumeRun(engine: Engine, run: string, o: ResumeOptions, ui: ResumeUI): Promise<ResumeResult> {
  const defs = await definitions(engine);
  const extra = overrides(o);
  type Take = Ready & { build: BuildState; redo: boolean };
  const decide = async (): Promise<Take | { done: ResumeResult }> => {
    const since = engine.buildSeq();
    const build = engine.fold(defs).builds[run]!;
    const heartbeat = engine.lease(run)?.heartbeat_at ?? engine.deps.clock.now().toISOString();
    const owner = await ownerOf(engine, build);
    const plan = takeover(build, owner, { ticket: o.ticket ?? null, settings: extra, heartbeat });
    if (plan.kind === "nothing") { ui.line(plan.why); return { done: { code: 0 } }; }
    if (plan.kind === "attach") {
      const paused = build.state === "paused" ? await pausedAttach(engine, run, o, ui, since) : { attach: run };
      return paused ? { done: paused } : decide();
    }
    return { since, build, redo: plan.events.length > 0, events: [...plan.events.map((e) => ({ ...e, run_id: run,
      actor: e.type === "build.resumed" ? "user" : "engine", source: e.type === "build.resumed" ? "terminal" : null })),
    acquired(engine, run)] };
  };
  const first = await decide();
  if ("done" in first) return first.done;
  const settings = { ...first.build.settings, ...extra } as Settings;
  if (o.autoApprove) settings["approvals.mode"] = { value: "auto", source: "flag" };
  const prepared = await prepareRun(engine, settings, { tty: o.tty, ticket: o.ticket }, ui);
  if (typeof prepared === "number") return { code: prepared };
  const claimed = await claimRun<Take, ResumeResult>(engine, run, first, decide);
  if ("done" in claimed) return claimed.done;
  if ("live" in claimed) return { attach: claimed.live };
  if ("lost" in claimed) { ui.line(`Build ${run} kept changing; run \`rafi resume\` again.`); return { code: 1 }; }
  for (const said of await closeStale(engine, run)) ui.line(said);
  if (claimed.owned.redo) ui.line(redoLine(engine.fold(defs), run));
  return { code: await runLoop(contextFor(engine, run, settings, prepared, ui), defs) };
}

/** The latest build when rafi resume continues it, plus unfinished interviews, newest first (C142). */
async function candidates(engine: Engine, ui: ResumeUI): Promise<{ live: string | null; list: Candidate[] }> {
  const view = engine.fold(await definitions(engine));
  const list: Candidate[] = [];
  let live: string | null = null;
  if (view.run) {
    const all = [];
    for await (const e of engine.events({ run: view.run })) all.push(e);
    const build = view.builds[view.run]!;
    const owner = await ownerOf(engine, build);
    if (owner === "alive" || owner === "not-responding") live = view.run;
    const outcome = await outcomeOf(engine, view, build, all);
    if (!live && outcome.resumable) {
      list.push({ at: all.at(-1)?.at ?? "", run: view.run, label: `Build ${view.run} (${outcome.text})` });
    }
  }
  list.push(...await interviewCandidates(engine, (text) => ui.line(text)));
  return { live, list: list.sort((a, b) => b.at.localeCompare(a.at)) };
}

/** `rafi resume`: --discard and --id for interviews; --run; else the live build, the one candidate, or a pick. */
export async function resumeBuild(engine: Engine, o: ResumeOptions, ui: ResumeUI): Promise<ResumeResult> {
  const { fs, clock } = engine.deps;
  await pruneInterviews(fs, engine.projectDir, clock.now());
  if (o.discard) {
    const out = await discardInterview(fs, engine.projectDir, o.discard);
    ui.line(out.ok ? `Discarded saved interview ${out.record.id}.` : out.message);
    return { code: out.ok ? 0 : 1 };
  }
  if (o.id) {
    const found = findInterview(unfinishedInterviews((await readInterviews(fs, engine.projectDir)).records), o.id);
    if ("message" in found) { ui.line(found.message); return { code: 1 }; }
    return interviewResult(engine, (text) => ui.line(text), found);
  }
  if (o.run) {
    const picked = findRun(engine.fold(await definitions(engine)), o.run);
    if ("message" in picked) { ui.line(picked.message); return { code: 1 }; }
    return resumeRun(engine, picked.run, o, ui);
  }
  const { live, list } = await candidates(engine, ui);
  if (live) return resumeRun(engine, live, o, ui);
  if (!list.length) { ui.line("Nothing to resume."); return { code: 0 }; }
  let chosen: Candidate | undefined = list.length === 1 ? list[0] : undefined;
  if (!chosen && o.tty && ui.pick) {
    const i = await ui.pick("What should Rafi resume?", list.map((c) => c.label));
    if (i === null) { ui.line("Nothing was resumed."); return { code: 0 }; }
    chosen = list[i];
  } else if (!chosen && o.autoApprove) {
    chosen = list.find((c) => c.run) ?? list[0];
  } else if (!chosen) {
    ui.line(`There's more than one thing to resume: ${list.map((c) => c.label).join("; ")}. Pick one with ` +
      "`rafi resume --run <id>` or `rafi resume --id <id>`.");
    return { code: 1 };
  }
  if (chosen!.run) return resumeRun(engine, chosen!.run, o, ui);
  return interviewResult(engine, (text) => ui.line(text), chosen!.interview!);
}
