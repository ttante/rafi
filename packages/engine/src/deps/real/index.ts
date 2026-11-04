// The real deps set. Seams no milestone has built yet throw "not available until M<n>".
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Deps } from "../types.js";
import { realClaudeQuery, realClaudeTools, realCodex } from "./agents.js";
import { backgroundSpawner } from "./background.js";
import { realChecks } from "./checks.js";
import { realClock } from "./clock.js";
import { openRealDb } from "./db.js";
import { realLogChanged } from "./watch.js";
import { realExec, realGit } from "./exec.js";
import { realFs } from "./fs.js";
import { realProcesses } from "./processes.js";
import { realServe } from "./serve.js";
import { realTerminal } from "./terminal.js";

function later(name: string, milestone: string): never {
  throw new Error(`${name} isn't available until ${milestone}.`);
}

export function realDeps(): Deps {
  const random = { id: () => randomUUID(), jitter: () => Math.random() * 2 - 1,
    secret: () => randomBytes(32).toString("hex") };
  return {
    agents: { codex: realCodex, claudeQuery: realClaudeQuery, claudeTools: realClaudeTools },
    clock: realClock(),
    notifier: {
      send: () => later("notifications", "M6"), update: () => later("notifications", "M6"),
      close: () => later("notifications", "M6"), onAnswer: () => () => undefined,
    },
    terminal: realTerminal(),
    fs: realFs(random),
    git: realGit,
    exec: realExec,
    checks: realChecks(),
    serve: realServe,
    spawnBackground: backgroundSpawner(process.argv[1] ?? ""),
    db: { open: openRealDb },
    processes: realProcesses(random.id()),
    hooks: { crash: () => undefined, pause: () => undefined },
    machine: { stateDir: path.join(os.homedir(), ".rafi"), host: os.hostname(), platform: process.platform },
    env: Object.freeze({ ...process.env }),
    cwd: process.cwd(),
    random,
    logChanged: realLogChanged,
  };
}

export { realLogChanged } from "./watch.js";
export { openRealDb, realChecks, realClock, realExec, realFs, realGit, realProcesses, realServe, realTerminal,
  realCodex };
