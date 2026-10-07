import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A stable, host-local process incarnation marker. Linux exposes it through
 * procfs; macOS does not, so use `ps lstart` instead. The value is persisted
 * only to detect PID reuse and is never treated as a portable identifier.
 */
export function processStartIdentity(pid = process.pid): string {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21];
    // Preserve the historical Linux representation so an upgrade does not
    // invalidate a lease that was created by the prior release.
    if (value) return value;
  } catch {
    // procfs is intentionally absent on macOS and some constrained hosts.
  }
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000,
    }).trim();
    if (value) return `ps:${value}`;
  } catch {
    // A caller will treat unavailable identity as unverified, never matching.
  }
  return "unavailable";
}

/** True only when the PID exists and represents the recorded incarnation. */
export function isLiveProcessIdentity(pid: number, expectedStart: string): boolean {
  try {
    process.kill(pid, 0);
    return expectedStart !== "unavailable" && processStartIdentity(pid) === expectedStart;
  } catch {
    return false;
  }
}
