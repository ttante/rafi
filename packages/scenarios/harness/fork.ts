// P33's snapshot and restore (C163): what a process killed at boundary k leaves, taken from the clean run at k.
// The project's files and git folder (byte copies, symlinks kept, the database files left out); the database through
// `VACUUM INTO` on a separate read-only connection (exactly the committed transactions; WAL frames can't tear); the
// machine-state folder; the clock's time; and the computer's state the next instance reads (ids, consumed rules,
// transcript, sessions, check and environment records, canaries). A restore has no live instance, no timers, fresh
// MCP endpoints and a fresh notifier: what a killed process loses.
import { cpSync, existsSync, mkdirSync } from "node:fs";
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

/** Takes the snapshot synchronously, inside the hook (better-sqlite3's VACUUM INTO is synchronous). */
export function takeSnapshot(computer: Computer, project: string, into: string, occurrence: string, index: number):
  Snapshot {
  const dir = path.join(into, `point-${index}`);
  const copy = path.join(dir, path.basename(project));
  mkdirSync(dir, { recursive: true });
  cpSync(project, copy, { recursive: true, verbatimSymlinks: true,
    filter: (src) => !path.relative(project, src).startsWith(DB) });
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
  bus: [], stateDir, home: path.dirname(stateDir) };
  return { occurrence, index, dir, project: copy, stateDir, at, computer: state };
}

/** A new computer and project from a snapshot: no live instance, no timers, fresh endpoints. */
export function restore(snap: Snapshot): { computer: Computer; project: string } {
  const c = snap.computer;
  const computer: Computer = { ...c, clock: new FakeClock(snap.at), notifier: new FakeNotifier(), serve: memoryServe(),
    alive: new Set(), bus: [], ids: { next: c.ids.next }, script: { ...c.script, used: new Set(c.script.used) } };
  return { computer, project: snap.project };
}
