// The owner's control watcher (C139): through deps.logChanged, which fires for other connections' commits only, it
// reads the events after the last seq it saw and passes on those that control the build: stop, pause and unpause
// requests, answers and closed questions, granted fixes. It never folds.
import type { Engine } from "../api/engine.js";
import type { Cancel } from "../deps/types.js";
import type { StoredEvent } from "./types.js";

const CONTROL: ReadonlySet<string> = new Set(["build.stop_requested", "build.pause_requested",
  "build.unpause_requested", "question.answered", "question.closed", "fix.granted"]);

export function watchControls(engine: Engine, run: string, on: (event: StoredEvent) => void): Cancel {
  let cursor = engine.lastSeq();
  let busy = false;
  let again = false;
  const scan = async (): Promise<void> => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        for await (const e of engine.events({ from: cursor })) {
          cursor = e.seq;
          if (CONTROL.has(e.type) && (e.run_id === run || e.type.startsWith("question."))) on(e);
        }
      } while (again);
    } finally {
      busy = false;
    }
  };
  return engine.deps.logChanged(engine.logPath, () => void scan());
}
