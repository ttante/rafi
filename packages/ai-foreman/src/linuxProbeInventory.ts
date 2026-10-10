import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LinuxProbeProcess { pid: number; group: number; state: string; start: string; tagged: boolean }

/** procfs avoids ps dialects, PATH, output limits and environment truncation.
 * Probe descendants inherit our uid; unreadable same-user environments fail closed.
 * Privilege changes and deliberately scrubbed tags are outside tagged containment.
 */
export function linuxProbeInventory(tag?: string, timeoutMs = 1000, root = "/proc", uid = process.getuid?.(), self = process.pid): LinuxProbeProcess[] | undefined {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  try {
    const rows: LinuxProbeProcess[] = [];
    for (const entry of readdirSync(root)) {
      if (!/^\d+$/.test(entry)) continue;
      if (Date.now() >= deadline) return undefined;
      const directory = join(root, entry);
      try {
        const stat = readFileSync(join(directory, "stat"), "utf8");
        const end = stat.lastIndexOf(")");
        const fields = stat.slice(end + 1).trim().split(/\s+/);
        if (end < 0 || !/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[2] ?? "")) return undefined;
        let tagged = false;
        if (tag && fields[0] !== "Z" && fields[0] !== "X" && statSync(directory).uid === uid) {
          const environment = readFileSync(join(directory, "environ"));
          tagged = environment.toString("utf8").split("\0").includes(`RAFI_PROBE_OWNER=${tag}`);
        }
        rows.push({ pid: Number(entry), group: Number(fields[2]), state: fields[0]!, start: fields[19]!, tagged });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try { readFileSync(join(directory, "stat")); } catch (gone) {
            if ((gone as NodeJS.ErrnoException).code === "ENOENT") continue; // process exited during enumeration
          }
        }
        return undefined;
      }
    }
    return rows.some(row => row.pid === self) ? rows : undefined;
  } catch { return undefined; }
}
