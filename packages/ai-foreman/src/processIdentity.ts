import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { linuxProbeInventory } from "./linuxProbeInventory.js";

export type ProcessClassification = { state: "live" | "dead" | "unknown"; reason: string };

/** Field 2 is parenthesized and may itself contain whitespace/parentheses. */
export function linuxProcessStart(stat: string): string | undefined {
  const end = stat.lastIndexOf(")");
  if (end < 0) return undefined;
  const value = stat.slice(end + 1).trim().split(/\s+/)[19];
  return value && /^\d+$/.test(value) ? value : undefined;
}

export function classifyProcess(pid: number, expectedStart: string | undefined, host = hostname(),
  probe: { kill: (pid: number) => void; identity: (pid: number) => string } = {
    kill: pid => { process.kill(pid, 0); }, identity: processStartIdentity,
  }): ProcessClassification {
  if (host !== hostname()) return { state: "unknown", reason: "owner is on another host" };
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown", reason: "owner PID is missing or invalid" };
  try { probe.kill(pid); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? { state: "dead", reason: "recorded process no longer exists" }
      : { state: "unknown", reason: "process visibility is unavailable" };
  }
  const actual = probe.identity(pid);
  if (!expectedStart || expectedStart === "unavailable" || actual === "unavailable") return { state: "unknown", reason: "process incarnation cannot be verified" };
  return actual === expectedStart ? { state: "live", reason: "owner process verified" } : { state: "dead", reason: "PID belongs to a different process incarnation" };
}

/**
 * A stable, host-local process incarnation marker. Linux exposes it through
 * procfs; macOS does not, so use `ps lstart` instead. The value is persisted
 * only to detect PID reuse and is never treated as a portable identifier.
 */
export function processStartIdentity(pid = process.pid, timeoutMs = 5000): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unavailable";
  if (process.platform === "win32") {
    try {
      const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const script = `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToFileTimeUtc()`;
      const value = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: Math.max(1, timeoutMs) }).trim();
      if (/^\d+$/.test(value)) return `win:${value}`;
    } catch { /* Missing process or unavailable identity remains unverified. */ }
    return "unavailable";
  }
  try {
    const value = linuxProcessStart(readFileSync(`/proc/${pid}/stat`, "utf8"));
    // Preserve the historical Linux representation so an upgrade does not
    // invalidate a lease that was created by the prior release.
    if (value) return value;
  } catch {
    // procfs is intentionally absent on macOS and some constrained hosts.
  }
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: Math.max(1, Math.min(1000, timeoutMs)),
    }).trim();
    if (value) return `ps:${value}`;
  } catch {
    // A caller will treat unavailable identity as unverified, never matching.
  }
  return "unavailable";
}

/** True only when the PID exists and represents the recorded incarnation. */
export function isLiveProcessIdentity(pid: number, expectedStart: string): boolean {
  return classifyProcess(pid, expectedStart).state === "live";
}

/** Complete local process inventory, including orphan descendants of a known group. */
export function processGroupQuiescent(group: number, timeoutMs = 1000): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(group) || group <= 1) return false;
  if (process.platform === "linux") {
    const rows = linuxProbeInventory(undefined, timeoutMs);
    return rows !== undefined && rows.filter(row => row.group === group).every(row => row.state === "Z" || row.state === "X");
  }
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: Math.max(1, timeoutMs), maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)).filter(row => row !== null);
    return rows.some(row => Number(row[1]) === process.pid) && rows.filter(row => Number(row[2]) === group).every(row => row[3]!.startsWith("Z"));
  } catch { return false; }
}

/** Inventory inherited probe tags without exposing process environments in diagnostics.
 * This covers reparented/setsid children that retain their launch environment.
 * It is not an OS sandbox: deliberately scrubbed environments cannot be traced.
 */
export function taggedProcesses(tag: string, timeoutMs = 1000): Array<{pid: number; start: string}> | undefined {
  if (!/^[a-f0-9-]{36}$/.test(tag) || process.platform === "win32") return undefined;
  if (process.platform === "linux") return linuxProbeInventory(tag, timeoutMs)?.filter(row => row.tagged).map(({ pid, start }) => ({ pid, start }));
  try {
    const deadline = Date.now() + timeoutMs;
    const rows = execFileSync("ps", ["eww", "-axo", "pid=,stat=,command="], { encoding: "utf8", timeout: Math.max(1, timeoutMs), maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\n");
    if (!rows.some(row => Number(row.trim().split(/\s+/)[0]) === process.pid)) return undefined;
    return rows.flatMap(row => {
      const match = /^\s*(\d+)\s+(\S+)\s+/.exec(row);
      if (!match || match[2]!.startsWith("Z") || !row.includes(`RAFI_PROBE_OWNER=${tag}`)) return [];
      const pid = Number(match[1]);
      if (Date.now() >= deadline) throw new Error("Tag inventory deadline exceeded");
      return [{ pid, start: processStartIdentity(pid, deadline - Date.now()) }];
    });
  } catch { return undefined; }
}
