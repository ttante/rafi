// Temp folders made by a test process (fixtures, snapshots, process-set projects, the fixture cache): each is
// recorded, and all are removed when the process exits after every test passed (exit code 0). A failing run keeps
// them for inspection. Without this, every run left hundreds of `rafi-*` folders behind (M4 plan 10.2 "Disk").
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const made = new Set<string>();
const hooked = { done: false };

function removeAll(): void {
  if ((process.exitCode ?? 0) !== 0) return;
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  made.clear();
}

/** A new `<tmpdir>/<prefix>XXXXXX` folder (real path), removed at a passing exit. */
export function madeTemp(prefix: string): string {
  return trackTemp(realpathSync(mkdtempSync(path.join(tmpdir(), prefix))));
}

/** A temp folder something else made (the legacy fixture generator), removed at a passing exit too. */
export function trackTemp(dir: string): string {
  made.add(dir);
  if (!hooked.done) {
    hooked.done = true;
    process.on("exit", removeAll);
  }
  return dir;
}

/** How many folders this process has recorded and not yet removed (for the cleanup test). */
export function tempCount(): number {
  return made.size;
}
