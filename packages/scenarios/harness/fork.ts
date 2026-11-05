// P33's snapshot and restore (C163): what a process killed at boundary k leaves, taken from the clean run at k.
// The project's files and git folder (byte copies, symlinks kept, the database files left out); the database through
// `VACUUM INTO` on a separate read-only connection (exactly the committed transactions; WAL frames can't tear); the
// machine-state folder; the clock's time; and the computer's state the next instance reads (ids, consumed rules,
// transcript, sessions, check and environment records, canaries). A restore has no live instance, no timers, fresh
// MCP endpoints and a fresh notifier: what a killed process loses.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openRealDb } from "@rafi-ai/engine/deps/real";
import { FakeClock } from "../fakes/clock.js";
import { FakeNotifier } from "../fakes/notifier.js";
import { memoryServe } from "../fakes/serve.js";
import { scriptUsed } from "./agents.js";
import type { Computer } from "./deps.js";

export interface Snapshot {
  readonly occurrence: string;
  readonly index: number;
  readonly dir: string;
  readonly project: string;
  readonly stateDir: string;
  readonly at: number;
  readonly computer: Computer;
}

const DB = path.join(".rafi", "state.sqlite3");

/** Replaces every form of `from` (as given and as its real path) with `to` in a text file, if it exists. */
function repoint(file: string, pairs: readonly [string, string][]): void {
  if (!existsSync(file)) return;
  let text = readFileSync(file, "utf8");
  for (const [from, to] of pairs) text = text.split(from).join(to);
  writeFileSync(file, text);
}

/**
 * C263 (M5): a copy of a project with git delivery must name itself, not the original: its remote (F-BRANCH's
 * `<project>/../remote.git`, copied beside it), and both gitdir files of each worktree (a worktree's `.git` names
 * its repository by path, and the repository's `worktrees/<id>/gitdir` names the worktree).
 */
export function relinkCopy(original: string, copy: string): void {
  const remote = path.join(path.dirname(original), "remote.git");
  const pairs: [string, string][] = [];
  if (existsSync(remote)) {
    const target = path.join(path.dirname(copy), "remote.git");
    if (!existsSync(target)) cpSync(remote, target, { recursive: true, verbatimSymlinks: true });
    pairs.push([realpathSync(remote), target], [remote, target]);
  }
  pairs.push([realpathSync(original), copy], [original, copy]);
  const dotGit = path.join(copy, ".git");
  repoint(path.join(dotGit, "config"), pairs);
  const linked = path.join(dotGit, "worktrees");
  for (const id of existsSync(linked) ? readdirSync(linked) : []) repoint(path.join(linked, id, "gitdir"), pairs);
  const trees = path.join(copy, ".foreman", "worktrees");
  for (const name of existsSync(trees) ? readdirSync(trees) : []) repoint(path.join(trees, name, ".git"), pairs);
}

/** The fake gh's state, copied (each point's provider is its own). */
const ghCopy = (gh: Computer["gh"]): Computer["gh"] => ({ ...gh, prs: gh.prs.map((p) => ({ ...p })),
  calls: [...gh.calls] });

/** Takes the snapshot synchronously, inside the hook (better-sqlite3's VACUUM INTO is synchronous). */
export function takeSnapshot(computer: Computer, project: string, into: string, occurrence: string, index: number):
  Snapshot {
  const dir = path.join(into, `point-${index}`);
  const copy = path.join(dir, path.basename(project));
  mkdirSync(dir, { recursive: true });
  cpSync(project, copy, { recursive: true, verbatimSymlinks: true,
    filter: (src) => !path.relative(project, src).startsWith(DB) });
  relinkCopy(project, copy);
  const db = path.join(project, DB);
  if (existsSync(db)) {
    const reader = openRealDb(db, { readonly: true });
    try { reader.exec(`VACUUM INTO '${path.join(copy, DB).replace(/'/g, "''")}'`); } finally { reader.close(); }
  }
  const stateDir = path.join(dir, "computer", ".rafi");
  if (existsSync(computer.stateDir)) cpSync(computer.stateDir, stateDir, { recursive: true, verbatimSymlinks: true });
  const at = computer.clock.now().getTime();
  const script = { rules: computer.script.rules, transcript: [...computer.script.transcript],
    sessions: [...(computer.script.sessions ?? [])], used: new Set(scriptUsed(computer.script)) };
  const state: Computer = { ...computer, ids: { next: computer.ids.next }, alive: new Set(), childEnvs:
    [...computer.childEnvs], agentEnvs: [...computer.agentEnvs], canaries: { ...computer.canaries },
  sentToAgents: [...computer.sentToAgents], checks: { ...computer.checks, log: [...computer.checks.log] }, script,
  gh: ghCopy(computer.gh),
  bus: [], stateDir, home: path.dirname(stateDir) };
  return { occurrence, index, dir, project: copy, stateDir, at, computer: state };
}

/** A new computer and project from a snapshot: no live instance, no timers, fresh endpoints. */
export function restore(snap: Snapshot): { computer: Computer; project: string } {
  const c = snap.computer;
  const computer: Computer = { ...c, clock: new FakeClock(snap.at), notifier: new FakeNotifier(), serve: memoryServe(),
    alive: new Set(), bus: [], ids: { next: c.ids.next }, script: { ...c.script, used: new Set(c.script.used) },
    gh: ghCopy(c.gh) };
  return { computer, project: snap.project };
}
