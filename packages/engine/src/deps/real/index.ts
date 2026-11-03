// The M1 real deps set. Seams nothing in M1 calls throw "not available until M<n>".
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Deps } from "../types.js";
import { realClaudeQuery, realCodex } from "./agents.js";
import { realClock } from "./clock.js";
import { openRealDb } from "./db.js";
import { realExec, realGit } from "./exec.js";
import { realFs } from "./fs.js";
import { realProcesses } from "./processes.js";
import { realTerminal } from "./terminal.js";

function later(name: string, milestone: string): never {
  throw new Error(`${name} isn't available until ${milestone}.`);
}

export function realDeps(): Deps {
  const random = { id: () => randomUUID(), jitter: () => Math.random() * 2 - 1 };
  return {
    agents: { codex: realCodex, claudeQuery: realClaudeQuery },
    clock: realClock(),
    notifier: {
      send: () => later("notifications", "M6"), update: () => later("notifications", "M6"),
      close: () => later("notifications", "M6"), onAnswer: () => () => undefined,
    },
    terminal: realTerminal(),
    fs: realFs(random),
    git: realGit,
    exec: realExec,
    checks: { run: () => later("run_check", "M2") },
    serve: () => later("the local MCP endpoint", "M2"),
    spawnBackground: () => later("--detach", "M4"),
    db: { open: openRealDb },
    processes: realProcesses(random.id()),
    hooks: { crash: () => undefined, pause: () => undefined },
    machine: { stateDir: path.join(os.homedir(), ".rafi"), host: os.hostname(), platform: process.platform },
    env: Object.freeze({ ...process.env }),
    cwd: process.cwd(),
    random,
    logChanged: () => later("watching the log", "M4"),
  };
}

export { openRealDb, realClock, realExec, realFs, realGit, realProcesses, realTerminal, realCodex };
