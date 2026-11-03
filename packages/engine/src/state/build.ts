// nextBuild (ARCH 4.3): seven states, plus the pausing, unpausing and stop-now flags.
import { InvalidTransition, type BuildState, type BuildStateName, type StateEvent } from "./types.js";

type Data = Record<string, unknown>;

export function initialBuild(run: string): BuildState {
  return {
    run, state: "none", pausing: false, unpausing: false, stopMode: null, stopSource: null, cause: null,
    complete: null, ownerReleased: false, startedAt: null, workflow: null, scope: null, tickets: [], settings: {},
  };
}

function label(b: BuildState): string {
  const flags = [b.pausing && "pausing", b.unpausing && "unpausing", b.stopMode === "now" && "now"].filter(Boolean);
  return flags.length ? `${b.state}(${flags.join(",")})` : b.state;
}

function within(b: BuildState, states: readonly (BuildStateName | "none")[]): boolean {
  return states.includes(b.state);
}

function to(b: BuildState, state: BuildStateName, extra: Partial<BuildState> = {}): BuildState {
  return { ...b, state, ...extra };
}

function started(b: BuildState, event: StateEvent): BuildState {
  const data = event.data as Data;
  const scope = data.scope as { kind: string; value: unknown; skip: string[] };
  return {
    ...initialBuild(b.run), state: "running", startedAt: event.at ?? null,
    workflow: data.workflow as BuildState["workflow"], scope, tickets: data.tickets as string[],
    settings: data.settings as BuildState["settings"],
  };
}

function stopRequested(b: BuildState, data: Data): BuildState {
  const mode = data.mode as "graceful" | "now";
  if (within(b, ["running", "waiting", "paused"])) {
    return to(b, "stopping", { stopMode: mode, stopSource: String(data.source), pausing: false });
  }
  if (b.state === "stopping" && mode === "now") return { ...b, stopMode: "now" };
  throw new InvalidTransition(label(b), "build.stop_requested");
}

function causeOfSource(source: string | null): "stop" | "ctrl-c" {
  return source === "ctrl-c" ? "ctrl-c" : "stop";
}

function resumed(b: BuildState): BuildState {
  const clear = { pausing: false, unpausing: false, stopMode: null, stopSource: null, cause: null };
  if (within(b, ["stopped", "failed"])) return to(b, "running", { ...clear, complete: null });
  if (b.state === "waiting" && b.ownerReleased) return to(b, "running", clear);
  if (b.state === "finished" && b.complete === false) return to(b, "running", { ...clear, complete: null });
  if (b.state === "finished" && b.complete === true) return b;
  throw new InvalidTransition(label(b), "build.resumed");
}

/** The build's next state. An invalid pair throws InvalidTransition. */
export function nextBuild(build: BuildState, event: StateEvent): BuildState {
  const b = build;
  const data = (event.data ?? {}) as Data;
  const fail = () => { throw new InvalidTransition(label(b), event.type); };
  switch (event.type) {
    case "build.started":
      return b.state === "none" ? started(b, event) : fail();
    case "build.owner_acquired":
      return b.state === "none" ? fail() : { ...b, ownerReleased: false };
    case "build.owner_released":
      return b.state === "none" ? fail() : { ...b, ownerReleased: true };
    case "build.waiting":
      return b.state === "running" ? to(b, "waiting") : fail();
    case "build.unwaiting":
      return b.state === "waiting" ? to(b, "running") : fail();
    case "build.pause_requested":
      return within(b, ["running", "waiting"]) ? { ...b, pausing: true } : fail();
    case "build.paused":
      return within(b, ["running", "waiting"]) && b.pausing ? to(b, "paused", { pausing: false }) : fail();
    case "build.unpause_requested":
      return b.state === "paused" ? { ...b, unpausing: true } : fail();
    case "build.unpaused":
      return b.state === "paused" ? to(b, "running", { unpausing: false }) : fail();
    case "build.stop_requested":
      return stopRequested(b, data);
    case "build.stopped":
      return b.state === "stopping" ? to(b, "stopped", { cause: data.cause as BuildState["cause"] }) : fail();
    case "build.finished":
      return within(b, ["running", "waiting"])
        ? to(b, "finished", { complete: Boolean(data.complete), pausing: false }) : fail();
    case "build.failed":
      return within(b, ["running", "waiting", "stopping"]) ? to(b, "failed", { pausing: false }) : fail();
    case "build.owner_lost":
      if (within(b, ["running", "waiting", "paused"])) return to(b, "stopped", { cause: "crash", pausing: false });
      if (b.state === "stopping") return to(b, "stopped", { cause: causeOfSource(b.stopSource) });
      return fail();
    case "build.resumed":
      return resumed(b);
  }
  return fail();
}
