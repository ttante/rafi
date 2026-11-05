// One writer at a time for rafi's own edits of a committed file (`rafi-config.yaml`, `.tickets/tickets.yaml`): M5
// plan C187 and C210 asked for the read-modify-write inside the log's write lock, but that lock is a synchronous
// SQLite transaction and file access is asynchronous, so the read and the rename can't sit inside it (10.3 h). This
// is the lock instead: a folder `.rafi/locks/<name>` holding one record `holder-<id>.json`, taken by renaming a
// prepared folder onto that name; a rename onto a folder that exists and isn't empty fails on POSIX and Windows
// alike, so exactly one taker wins. Every change to a held lock starts with one atomic rename of its holder record,
// which only one process can make (10.8, the follow-up): letting go renames `holder-<id>` to `released-<id>`, and
// breaking a dead holder's lock renames that holder's record to `broken-<id>`; a taker that saw the dead holder but
// lost that rename leaves the lock alone. Only then is the folder (never empty, never holding a holder record any
// more) moved to a unique trash name and deleted. A live holder means a `backoff` wait on the clock.
import path from "node:path";
import type { Deps, Owner } from "../deps/types.js";

const TRIES = 40;
const WAIT_MS = 250;

export type Locked<T> = { ok: true; value: T } | { ok: false; message: string };
type LockDeps = Pick<Deps, "fs" | "clock" | "processes" | "random">;

async function holder(deps: LockDeps, dir: string): Promise<{ file: string; owner: Owner } | null> {
  try {
    const file = (await deps.fs.list(dir)).find((f) => /^holder-.+\.json$/.test(f));
    return file ? { file, owner: JSON.parse(await deps.fs.read(path.join(dir, file))) as Owner } : null;
  } catch {
    return null;
  }
}

/** Claims the lock's holder record by renaming it to `to`; false when someone else changed the lock first. */
async function claim(deps: LockDeps, dir: string, file: string, to: string): Promise<boolean> {
  try {
    await deps.fs.rename(path.join(dir, file), path.join(dir, to));
    return true;
  } catch {
    return false;
  }
}

/** Moves a claimed lock folder (it has no holder record, so nobody else touches it) away, then deletes it. */
async function discard(deps: LockDeps, locks: string, dir: string): Promise<void> {
  const trash = path.join(locks, `.trash.${deps.random.id()}`);
  await deps.fs.rename(dir, trash);
  await deps.fs.remove(trash, { recursive: true });
}

/** Runs fn while holding `.rafi/locks/<name>`; another rafi's edit of the same file waits for it. */
export async function withFileLock<T>(deps: LockDeps, project: string, name: string, fn: () => Promise<T>):
  Promise<Locked<T>> {
  const locks = path.join(project, ".rafi", "locks");
  const dir = path.join(locks, name);
  await deps.fs.mkdir(locks);
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const id = deps.random.id();
    const mine = path.join(locks, `.${name}.${id}`);
    await deps.fs.mkdir(mine);
    await deps.fs.writeAtomic(path.join(mine, `holder-${id}.json`), JSON.stringify(deps.processes.self()));
    try {
      await deps.fs.rename(mine, dir);
    } catch {
      await deps.fs.remove(mine, { recursive: true });
      const held = await holder(deps, dir);
      if (held && !(await deps.processes.isAlive(held.owner))) {
        if (await claim(deps, dir, held.file, `broken-${id}`)) await discard(deps, locks, dir);
        continue;
      }
      await deps.clock.sleep(WAIT_MS, "backoff");
      continue;
    }
    try {
      return { ok: true, value: await fn() };
    } finally {
      if (await claim(deps, dir, `holder-${id}.json`, `released-${id}`)) await discard(deps, locks, dir);
    }
  }
  return { ok: false, message: `Another rafi command is changing ${name} right now; try again in a moment (if ` +
    `none is, delete ${dir}).` };
}
