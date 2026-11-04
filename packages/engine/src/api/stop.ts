// engine.stop, engine.pause, engine.unpause (ARCH 8.5, 4.3; C137, C138, C140). `rafi stop` asks the owner to stop
// after the current step, or now when it's already stopping (Q-CMD-6); with no live owner a waiting or paused build
// is stopped here (build/claim.ts `stopUnowned`), a crashed one is left for `rafi resume` or `rafi reset`. Pause and
// unpause are requests the owner acts on at its next safe point.
import type { Engine } from "./engine.js";
import { pruneInterviews } from "../setup/interviews.js";
import { ownerOf, pickBuild as pick } from "../build/runs.js";
import { stopUnowned, writeSince } from "../build/claim.js";

export const STOP_LINE = "Stopping after the current step. Run `rafi stop` again or press Ctrl+C to stop now.";

export interface Said {
  readonly code: number;
  readonly line: string;
}

type Who = { actor: string; source: "terminal" | "manager" | "gui" };
type StopOptions = { run?: string; who?: Who; ctrlC?: boolean };
const SOURCE: Readonly<Record<string, "rafi-stop" | "manager" | "gui" | "ctrl-c">> = Object.freeze({
  terminal: "rafi-stop", manager: "manager", gui: "gui" });

/** `ctrlC`: the second Ctrl+C in an attached view (Q2, C169): a graceful stop whose source is ctrl-c. */
export async function stopBuild(engine: Engine, o: StopOptions = {}): Promise<Said> {
  await pruneInterviews(engine.deps.fs, engine.projectDir, engine.deps.clock.now());
  for (let tries = 1; tries <= 3; tries++) {
    const said = await stopOnce(engine, o, o.who ?? { actor: "user", source: "terminal" });
    if (said) return said;
  }
  return { code: 1, line: "The build kept changing while `rafi stop` looked at it; run `rafi stop` again." };
}

/** One decision; null when a build event came before stop could write what it decided (M4 review fixes 8 and 9). */
async function stopOnce(engine: Engine, o: StopOptions, who: Who): Promise<Said | null> {
  const since = engine.buildSeq();
  const p = await pick(engine, o.run);
  if (!("build" in p) || !p.build) return { code: p.code ?? 0, line: p.message ?? "No build is running here." };
  const { build } = p;
  const event = (mode: "graceful" | "now") => ({ type: "build.stop_requested", run_id: build.run, actor: who.actor,
    source: who.source, data: { mode, source: o.ctrlC ? "ctrl-c" : SOURCE[who.source]! } });
  if (!["running", "waiting", "paused", "stopping"].includes(build.state)) {
    return { code: 0, line: "No build is running here." };
  }
  const owner = await ownerOf(engine, build);
  if (owner === "alive" || owner === "not-responding") {
    // A request to the live owner: graceful, or now when it's already stopping (not for Ctrl+C's second press).
    const now = build.state === "stopping" && !o.ctrlC;
    const events = build.state !== "stopping" ? [event("graceful")] : now && build.stopMode !== "now" ? [event("now")]
      : [];
    if (events.length && !(await writeSince(engine, events, since))) return null;
    return { code: 0, line: o.ctrlC ? `Stopping build ${build.run} after its current step…` : now ? `Stopping build ` +
      `${build.run} now: the current turn is cancelled and its work so far is kept.` : STOP_LINE };
  }
  if (build.state === "waiting" || build.state === "paused") {
    return stopUnowned(engine, build.run, [event("graceful"), { type: "build.stopped", run_id: build.run,
      actor: "engine", data: { cause: "stop" } }], since);
  }
  const at = engine.lease(build.run)?.heartbeat_at.slice(11, 16) ?? "an unknown time";
  return { code: 0, line: `Build ${build.run} crashed at ${at}; nothing is running. \`rafi resume\` continues it; ` +
    "`rafi reset` drops it." };
}

/** C140: a pause request; the owner pauses at its next safe point (a waiting build at once). */
export async function pauseBuild(engine: Engine, run: string, who: Who): Promise<Said> {
  const p = await pick(engine, run);
  if (!("build" in p) || !p.build) return { code: 1, line: p.message ?? `There's no build ${run} here.` };
  const { build } = p;
  if (build.pausing || build.state === "paused") return { code: 0, line: `Build ${build.run} is already pausing.` };
  if (build.state !== "running" && build.state !== "waiting") {
    return { code: 1, line: `Build ${build.run} isn't running (${build.state}); there's nothing to pause.` };
  }
  await engine.append([{ type: "build.pause_requested", run_id: build.run, actor: who.actor, source: who.source,
    data: { source: who.source, boundary: null } }]);
  return { code: 0, line: `Pausing build ${build.run} at its next safe point.` };
}

/** C140: `rafi resume` on a paused build with a live owner asks to continue, then writes this; null (decide again)
 * when a build event came after `since`, the caller's decision (M4 review fix 10: another resume took it over). */
export async function unpauseBuild(engine: Engine, run: string, who: Who, since = engine.buildSeq()):
  Promise<Said | null> {
  const build = engine.fold().builds[run];
  if (build?.state !== "paused") return { code: 0, line: `Build ${run} isn't paused.` };
  const event = { type: "build.unpause_requested", run_id: run, actor: who.actor, source: who.source,
    data: { source: who.source, boundary: null } };
  if (!build.unpausing && !(await writeSince(engine, [event], since))) return null;
  return { code: 0, line: `Continuing build ${run}.` };
}
