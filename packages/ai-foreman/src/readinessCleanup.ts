import { hostname } from "node:os";
import { classifyProcess, processGroupQuiescent, taggedProcesses, processStartIdentity } from "./processIdentity.js";
import { windowsProbeJobState } from "./windowsProbeJob.js";

export interface ReadinessProcess {
  id: string; run_id: string; owner: string; pid: number | null; process_start: string | null;
  host: string; state: string; outcome_json: string | null;
}
export interface CleanupEvidence { state: "quiescent" | "unknown"; reason: string }
export function readinessMetadata(row: ReadinessProcess): Record<string, any> {
  try { const value = JSON.parse(row.outcome_json ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
/** Read-only evidence. Never infer that an authorized helper cannot still spawn. */
export function inspectReadiness(row: ReadinessProcess, deadline = Date.now() + 5000): CleanupEvidence {
  const remaining = () => Math.max(1, deadline - Date.now());
  const identityOf = (pid: number, start: string | undefined, host: string) => classifyProcess(pid, start, host, { kill: pid => { process.kill(pid, 0); }, identity: pid => processStartIdentity(pid, remaining()) });
  if (row.state === "quiescent") return { state: "quiescent", reason: "durable cleanup receipt" };
  const metadata = readinessMetadata(row);
  if (row.host !== hostname()) return { state: "unknown", reason: "probe belongs to another host" };
  if (metadata.protocol === "gated-v3" && ["intended", "registered"].includes(metadata.startup)) return { state: "unknown", reason: "startup capability must be revoked atomically" };
  if (metadata.protocol === "gated-v3" && metadata.startup === "revoked") return { state: "quiescent", reason: "execution capability irrevocably revoked" };
  if (!["gated-v3", "tagged-v2", "windows-job-v1"].includes(metadata.protocol)) return { state: "unknown", reason: "missing or unsupported probe protocol" };
  if (!row.pid) return { state: "unknown", reason: "missing registered process identity" };
  if (Date.now() >= deadline) return { state: "unknown", reason: "cleanup inventory deadline exceeded" };
  const identity = identityOf(row.pid, row.process_start ?? undefined, row.host);
  if (identity.state === "unknown") return { state: "unknown", reason: identity.reason };
  if (process.platform === "win32") {
    if (metadata.protocol === "tagged-v2") return { state: "unknown", reason: "Unix containment unavailable" };
    // Both the gated Node helper and the Job creator must be unable to create late work.
    const creator = metadata.creator;
    if (metadata.protocol === "gated-v3" && (creator && identityOf(creator.pid, creator.start, row.host).state !== "dead")) return { state: "unknown", reason: "Windows job creator remains live or unregistered" };
    if (identity.state !== "dead") return { state: "unknown", reason: "creating helper remains live" };
    return ["empty", "absent"].includes(windowsProbeJobState(row.id, remaining())) ? { state: "quiescent", reason: "helper exited and job empty" } : { state: "unknown", reason: "Windows job active or unavailable" };
  }
  if (metadata.protocol === "windows-job-v1") return { state: "unknown", reason: "Windows containment unavailable" };
  if (metadata.protocol === "gated-v3" && identity.state !== "dead" && !processGroupQuiescent(row.pid, remaining())) return { state: "unknown", reason: "authorized helper can still execute" };
  if (!processGroupQuiescent(row.pid, remaining())) return { state: "unknown", reason: "owned process group remains active or group inventory is unavailable" };
  const members = taggedProcesses(row.id, remaining());
  if (!members) return { state: "unknown", reason: "inherited probe tag inventory is unavailable" };
  return members.length === 0 ? { state: "quiescent", reason: "group and inherited tag inventory empty" }
    : { state: "unknown", reason: "tagged probe descendants remain active" };
}

const cleanupInFlight = new Map<string, Promise<CleanupEvidence>>();
/** Coalesce identical observations in this process; cross-process callers use DB CAS. */
export function cleanupReadiness(row: ReadinessProcess, deadline = Date.now() + 5000): Promise<CleanupEvidence> {
  const key = JSON.stringify(row);
  const existing = cleanupInFlight.get(key);
  if (existing) return existing;
  const operation = cleanReadiness(row, deadline).finally(() => { if (cleanupInFlight.get(key) === operation) cleanupInFlight.delete(key); });
  cleanupInFlight.set(key, operation);
  return operation;
}
/** Shared by worker settlement, supervisor death handling and restricted recovery. */
async function cleanReadiness(row: ReadinessProcess, deadline: number): Promise<CleanupEvidence> {
  const metadata = readinessMetadata(row);
  const remaining = () => Math.max(1, deadline - Date.now());
  const identityOf = (pid: number, start: string | undefined, host = row.host) => classifyProcess(pid, start, host, { kill: pid => { process.kill(pid, 0); }, identity: pid => processStartIdentity(pid, remaining()) });
  if (row.host !== hostname() || !["gated-v3", "tagged-v2", "windows-job-v1"].includes(metadata.protocol)) return inspectReadiness(row, deadline);
  if (metadata.protocol === "gated-v3" && metadata.startup === "revoked" && row.pid && identityOf(row.pid, row.process_start ?? undefined, row.host).state === "live") {
    try { process.kill(row.pid, "SIGTERM"); } catch { /* capability is already fenced */ }
  }
  let attempt = 0;
  let lastEvidence: CleanupEvidence = { state: "unknown", reason: "cleanup inventory unavailable" };
  do {
    const evidence = inspectReadiness(row, deadline);
    if (evidence.state === "quiescent") return evidence;
    if (evidence.reason !== "cleanup inventory deadline exceeded") lastEvidence = evidence;
    if (Date.now() >= deadline) break;
    const signal = attempt++ < 3 ? "SIGTERM" : "SIGKILL";
    if (row.pid) {
      const identity = identityOf(row.pid, row.process_start ?? undefined, row.host);
      if (identity.state === "live") {
        try { process.kill(process.platform === "win32" ? row.pid : -row.pid, signal); } catch { /* verify again */ }
      }
    }
    if (process.platform !== "win32") for (const member of taggedProcesses(row.id, remaining()) ?? []) {
      if (identityOf(member.pid, member.start).state === "live") try { process.kill(member.pid, signal); } catch { /* verify again */ }
    }
    else if (metadata.creator && identityOf(metadata.creator.pid, metadata.creator.start, row.host).state === "live") {
      try { process.kill(metadata.creator.pid, signal); } catch { /* verify again */ }
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return { state: "unknown", reason: `${lastEvidence.reason}; cleanup verification deadline exceeded` };
}
