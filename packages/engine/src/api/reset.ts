// engine.reset (ARCH 8.9; P31; C154): this build (restart-current or archive-restart, then the cleanup) or
// everything. A preview with its CLI form comes first (GUI-R7); a build with a live owner is refused and nothing
// changes (FLAG-RE-3). Reset holds the build's lease while it works (taken as start and resume take it, so nothing
// can take the build meanwhile); the git actions run, then `build.reset` puts the tickets back and the lease is
// dropped in one transaction. The log is only appended to.
import { resetWorktree, type ResetAction } from "../git/reset.js";
import { pruneInterviews } from "../setup/interviews.js";
import type { Engine } from "./engine.js";
import { definitions, findRun, ownerOf } from "../build/runs.js";
import type { Said } from "./stop.js";

export interface ResetOptions {
  readonly scope: "build" | "everything";
  readonly run?: string;
  readonly action?: "restart-current" | "archive-restart";
  readonly cleanup?: "stash" | "discard" | "handled";
}

export interface ResetPlan {
  readonly run: string;
  readonly tickets: string[];
  readonly lines: string[];
  /** The same reset as one command (GUI-R7). */
  readonly form: string;
  /** The newest build event when this was decided (engine.own's `since`). */
  readonly since: number;
}

export function resetForm(o: ResetOptions): string {
  if (o.scope === "everything") return `rafi reset --everything${o.run ? ` --run ${o.run}` : ""} --yes`;
  return `rafi reset --build${o.run ? ` --run ${o.run}` : ""} --action ${o.action}` +
    `${o.action === "restart-current" ? ` --cleanup ${o.cleanup}` : ""} --yes`;
}

const CLEANUP: Readonly<Record<string, string>> = Object.freeze({ stash: "your changes to tracked files go into a " +
  "git stash", discard: "tracked files go back to the branch's last commit", handled: "your files are left as " +
  "they are (you've dealt with them)" });

const running = (run: string): Said => ({ code: 1, line: `Build ${run} is running; reset changes nothing while a ` +
  "build runs. Stop it with `rafi stop` first." });

export async function resetPlan(engine: Engine, o: ResetOptions): Promise<ResetPlan | Said> {
  const since = engine.buildSeq();
  const defs = await definitions(engine);
  const view = engine.fold(defs);
  const picked = o.run ? findRun(view, o.run) : view.run ? { run: view.run } : { message: "No build to reset here." };
  if ("message" in picked) return { code: 1, line: picked.message };
  const build = view.builds[picked.run]!;
  if (build.state === "stopped" && build.cause === "reset") {
    return { code: 0, line: `Build ${build.run} is already reset.` };
  }
  const owner = await ownerOf(engine, build);
  if (owner === "alive" || owner === "not-responding") return running(build.run);
  const touched = new Set<string>();
  for await (const e of engine.events({ run: build.run })) if (e.ticket_id) touched.add(e.ticket_id);
  const open = (id: string) => view.tickets[id] && view.tickets[id]!.state !== "dropped";
  const tickets = o.scope === "everything" ? defs.map((d) => d.id).filter(open)
    : defs.map((d) => d.id).filter((id) => open(id) && touched.has(id) && view.tickets[id]!.state !== "done");
  const what = tickets.length ? `${tickets.join(", ")} go${tickets.length === 1 ? "es" : ""} back to queued, at ` +
    "attempt 1 with no fixes used" : "no ticket changes";
  const files = o.scope === "everything" ? "your branch and files stay as they are"
    : o.action === "archive-restart" ? `the unfinished work is committed to rafi/archive/${build.run} and tracked ` +
      "files go back to the branch's last commit" : `your branch stays, and ${CLEANUP[o.cleanup ?? "handled"]}`;
  return { run: build.run, tickets, since, form: resetForm({ ...o, run: o.run }),
    lines: [`This resets ${o.scope === "everything" ? "everything" : `build ${build.run}`}: ${what}; ${files}. ` +
      "Untracked files are never touched, nothing is pushed, and the old run stays in `rafi stats`."] };
}

export async function resetBuild(engine: Engine, o: ResetOptions): Promise<Said & { lines: string[] }> {
  await pruneInterviews(engine.deps.fs, engine.projectDir, engine.deps.clock.now());
  const plan = await resetPlan(engine, o);
  if ("code" in plan) return { ...plan, lines: [] };
  const held = await engine.own(plan.run, [], { since: plan.since });
  if (!held.ok) {
    return { ...(held.owner ? running(held.owner.run_id) : { code: 1, line: `Build ${plan.run} changed while reset ` +
      "was getting ready; nothing was reset. Run `rafi reset` again." }), lines: [] };
  }
  try {
    let archive: string | null = null;
    const lines: string[] = [];
    if (o.scope === "build") {
      const action: ResetAction = o.action === "archive-restart" ? { action: o.action, cleanup: null, run: plan.run }
        : { action: "restart-current", cleanup: o.cleanup ?? "handled", run: plan.run };
      const done = await resetWorktree(engine.deps, engine.projectDir, action);
      if (!done.ok) {
        await engine.disown(plan.run, []);
        return { code: 1, line: `Reset stopped before changing the log: ${done.message}`, lines: [] };
      }
      archive = done.archive;
      lines.push(...done.lines);
    }
    await engine.disown(plan.run, [{ type: "build.reset", run_id: plan.run, actor: "user", source: "terminal", data: {
      scope: o.scope, action: o.scope === "build" ? o.action ?? "restart-current" : null,
      cleanup: o.scope === "build" && o.action !== "archive-restart" ? o.cleanup ?? "handled" : null,
      tickets: plan.tickets, archive_branch: archive } }]);
    return { code: 0, line: `Reset ${o.scope === "everything" ? "everything" : `build ${plan.run}`}. Start again ` +
      "with `rafi start`.", lines };
  } catch (error) {
    await engine.disown(plan.run, []).catch(() => undefined);
    throw error;
  }
}
