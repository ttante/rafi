// How rafi ends a provider (ARCH 8.5, M4 follow-up 2): SIGTERM to its process group, up to 5 s on deps.clock for it
// to exit, then SIGKILL to whatever is left of the group (at once when it exits sooner: strays it left running).
// Every path that ends a provider comes here through Agent.close(): a build's end, stops, Ctrl+C, timeouts.
import type { Cancel, Clock, ProviderProcess } from "../deps/types.js";

/** ARCH 8.5's grace. Before this decision no locked doc set one, so it's the user's 5 s default. */
export const KILL_GRACE_MS = 5_000;

export function endProvider(clock: Clock, p: ProviderProcess): Promise<void> {
  return new Promise((resolve) => {
    let cancel: Cancel | null = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      cancel?.();
      p.kill();
      resolve();
    };
    p.onGone(end);
    if (ended) return;
    p.terminate();
    // Armed only when the provider is still running, so a provider that exits at once leaves no timer.
    if (!ended) cancel = clock.timer(KILL_GRACE_MS, end, "timeout");
  });
}
