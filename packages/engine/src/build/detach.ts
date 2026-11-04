// `--detach` (ARCH 8.7, D5; C151, C152): the parent has already asked what needs a terminal (the sandbox decision
// today, the upfront check from M7) and written build.started with no owner (start's checks, no lease). This starts
// one ordinary `rafi resume --run <id>` in the background and waits up to 15 s for that child's
// build.owner_acquired: then 8.7's line and 0. If the child exits first, its first line from `.rafi/background.log`
// and 1. The child takes the build as its first owner (no build.owner_lost, no build.resumed).
import path from "node:path";
import type { Engine } from "../api/engine.js";

export const DETACH_WAIT_MS = 15_000;
const POLL_MS = 250;
export const BACKGROUND_LOG = path.join(".rafi", "background.log");

async function firstLine(engine: Engine): Promise<string> {
  const text = await engine.deps.fs.read(path.join(engine.projectDir, BACKGROUND_LOG)).catch(() => "");
  const line = text.split("\n").map((l) => l.replace(/^rafi:\s*/, "").trim()).find(Boolean);
  return engine.redact(line ?? "it printed nothing");
}

/** `afterStart`: what the parent records once build.started is in (start's stale-waiver check for `--ticket`). */
export async function detachBuild(engine: Engine, run: string, ui: { line(text: string): void },
  afterStart?: () => Promise<unknown>): Promise<number> {
  const { deps } = engine;
  await afterStart?.();
  const child = deps.spawnBackground(["resume", "--run", run], { cwd: engine.projectDir, log: BACKGROUND_LOG });
  const owner = { instance: "", host: deps.processes.self().host, pid: child.pid, startedAt: null };
  for (let waited = 0; ; waited += POLL_MS) {
    if (engine.fold().builds[run]?.everOwned) {
      ui.line(`build ${run} started in the background. Follow it with \`rafi status\` or \`rafi resume\`.`);
      return 0;
    }
    if (!(await deps.processes.isAlive(owner))) {
      ui.line(`The background build ${run} stopped before it started: ${await firstLine(engine)}`);
      return 1;
    }
    if (waited >= DETACH_WAIT_MS) break;
    await deps.clock.sleep(POLL_MS, "poll");
  }
  ui.line(`The background build ${run} didn't start within 15 seconds; see ${BACKGROUND_LOG}. \`rafi resume ` +
    `--run ${run}\` continues it.`);
  return 1;
}
