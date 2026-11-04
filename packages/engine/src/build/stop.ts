// Stopping a build mid-step (C137): one control per build. `now` aborts the current turn (rafi cancels it and waits
// up to 30 s for the provider to confirm) and any test run; `kill` (a second Ctrl+C) ends the provider at once. A
// step that was stopped records no outcome, so `rafi resume` redoes it (ARCH 4.5 rule 3).
export interface StopControl {
  readonly now: AbortController;
  readonly kill: AbortController;
}

export function stopControl(): StopControl {
  return { now: new AbortController(), kill: new AbortController() };
}

/** Thrown out of a step stopped by `rafi stop` (now) or Ctrl+C; the loop records build.stopped. */
export class BuildStopped extends Error {
  constructor(readonly cause: "stop" | "ctrl-c") {
    super(`the build was stopped (${cause})`);
  }
}

export function stopCause(signal: AbortSignal): "stop" | "ctrl-c" {
  return signal.reason === "ctrl-c" ? "ctrl-c" : "stop";
}

export function throwIfStopped(control: StopControl | undefined): void {
  if (control?.now.signal.aborted) throw new BuildStopped(stopCause(control.now.signal));
}
