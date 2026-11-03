// Process identity for the lease (ARCH 4.3.1): same host, pid running, start time matching.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import type { Owner, Processes } from "../types.js";

function startTime(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
      return out || null;
    }
  } catch {
    return null;
  }
  return null;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function realProcesses(instance: string): Processes {
  const self: Owner = { instance, host: os.hostname(), pid: process.pid, startedAt: startTime(process.pid) };
  return {
    self: () => self,
    async isAlive(owner) {
      if (owner.host !== self.host) return true;
      if (!running(owner.pid)) return false;
      if (owner.startedAt === null) return true;
      return startTime(owner.pid) === owner.startedAt;
    },
  };
}
