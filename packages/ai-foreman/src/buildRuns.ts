import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { BuildRunRecordV1, ResolvedAgentSettings } from "rafi-spec";

export const BUILD_RUN_VERSION = 1;
export const BUILD_RUN_DIRECTORY = ".foreman/runs";
export const BUILD_HEARTBEAT_MS = 10_000;
export const BUILD_LEASE_STALE_MS = 45_000;

export interface CreateBuildRunInput {
  tickets: string[];
  deliveryUnit?: string;
  branchMode?: BuildRunRecordV1["branchMode"];
  repositoryRoot: string;
  worktree?: string;
  branch?: string;
  baseHead?: string;
  startHead?: string;
  builder?: ResolvedAgentSettings;
  qa?: ResolvedAgentSettings;
  now?: Date;
}

export function createBuildRun(input: CreateBuildRunInput): BuildRunRecordV1 {
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const run: BuildRunRecordV1 = {
    version: 1,
    runId: randomUUID(),
    status: "running",
    tickets: [...input.tickets],
    deliveryUnit: input.deliveryUnit,
    branchMode: input.branchMode ?? "current",
    checkpoint: "created",
    currentTicket: input.tickets[0],
    builder: input.builder ? { settings: input.builder } : undefined,
    qa: input.qa ? { settings: input.qa } : undefined,
    repository: {
      root: resolve(input.repositoryRoot),
      worktree: resolve(input.worktree ?? input.repositoryRoot),
      branch: input.branch,
      baseHead: input.baseHead,
      startHead: input.startHead,
      partialFingerprint: fingerprintWorkingFiles(input.worktree ?? input.repositoryRoot),
    },
    receipts: {},
    lease: currentLease(now),
    createdAt: stamp,
    updatedAt: stamp,
  };
  return saveBuildRun(input.repositoryRoot, run, now);
}

export function saveBuildRun(projectDir: string, run: BuildRunRecordV1, now = new Date()): BuildRunRecordV1 {
  validateBuildRun(run);
  const directory = join(resolve(projectDir), BUILD_RUN_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const next = { ...run, updatedAt: now.toISOString() };
  const target = join(directory, `${run.runId}.json`);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  return next;
}

export function checkpointBuildRun(
  projectDir: string,
  run: BuildRunRecordV1,
  checkpoint: string,
  patch: Partial<BuildRunRecordV1> = {},
): BuildRunRecordV1 {
  return saveBuildRun(projectDir, { ...run, ...patch, checkpoint, receipts: patch.receipts ?? run.receipts });
}

export function persistBuildSession(
  projectDir: string,
  run: BuildRunRecordV1,
  role: "builder" | "qa",
  sessionId: string,
): BuildRunRecordV1 {
  const current = run[role];
  if (!current) throw new Error(`${role} settings were not captured for run ${run.runId}`);
  return checkpointBuildRun(projectDir, { ...run, [role]: { ...current, sessionId } }, `${role}-session-ready`);
}

export function recordBuildReceipt(
  projectDir: string,
  run: BuildRunRecordV1,
  operationId: string,
  detail?: { externalId?: string; detail?: string },
): BuildRunRecordV1 {
  if (run.receipts[operationId]) return run;
  return saveBuildRun(projectDir, {
    ...run,
    receipts: { ...run.receipts, [operationId]: { completedAt: new Date().toISOString(), ...detail } },
  });
}

export function heartbeatBuildRun(projectDir: string, run: BuildRunRecordV1, now = new Date()): BuildRunRecordV1 {
  return saveBuildRun(projectDir, { ...run, lease: { ...(run.lease ?? currentLease(now)), heartbeatAt: now.toISOString() } }, now);
}

export function releaseBuildLease(projectDir: string, run: BuildRunRecordV1, status: BuildRunRecordV1["status"] = "interrupted"): BuildRunRecordV1 {
  return saveBuildRun(projectDir, { ...run, status, lease: undefined });
}

export function completeBuildRun(projectDir: string, run: BuildRunRecordV1, now = new Date()): BuildRunRecordV1 {
  return saveBuildRun(projectDir, { ...run, status: "completed", checkpoint: "complete", lease: undefined, completedAt: now.toISOString() }, now);
}

export function readBuildRuns(projectDir: string): BuildRunRecordV1[] {
  const directory = join(resolve(projectDir), BUILD_RUN_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try {
      const run = JSON.parse(readFileSync(join(directory, name), "utf8")) as BuildRunRecordV1;
      validateBuildRun(run);
      return [run];
    } catch {
      return [];
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function recoverableBuildRuns(projectDir: string, now = new Date()): Array<BuildRunRecordV1 & { active: boolean }> {
  return readBuildRuns(projectDir)
    .filter((run) => run.status !== "completed")
    .map((run) => ({ ...run, active: isLeaseActive(run, now) }));
}

export function isLeaseActive(run: BuildRunRecordV1, now = new Date()): boolean {
  if (!run.lease) return false;
  const age = now.getTime() - new Date(run.lease.heartbeatAt).getTime();
  if (age > BUILD_LEASE_STALE_MS) return false;
  if (run.lease.hostname !== hostname()) return true;
  try {
    process.kill(run.lease.pid, 0);
    return run.lease.processStart === processStartIdentity(run.lease.pid);
  } catch {
    return false;
  }
}

export function buildRecoveryPreview(run: BuildRunRecordV1): string[] {
  const completed = Object.keys(run.receipts).sort();
  return [
    `run ${run.runId}`,
    `ticket ${run.currentTicket ?? run.tickets[0] ?? "unknown"}`,
    `checkpoint ${run.checkpoint}`,
    `worktree ${run.repository.worktree}`,
    `branch ${run.repository.branch ?? "current"}`,
    `partial files fingerprint ${run.repository.partialFingerprint ?? "unavailable"}`,
    `completed operations ${completed.length ? completed.join(", ") : "none"}`,
    `session ${run.builder?.sessionId ? "exact Builder session available" : "fresh Builder session required"}`,
    `QA session ${run.qa?.sessionId ? "exact QA session available" : "fresh QA session required"}`,
  ];
}

function currentLease(now: Date): NonNullable<BuildRunRecordV1["lease"]> {
  return { hostname: hostname(), pid: process.pid, processStart: processStartIdentity(process.pid), heartbeatAt: now.toISOString() };
}

function processStartIdentity(pid: number): string {
  try {
    return statSync(`/proc/${pid}`).birthtimeMs.toString();
  } catch {
    return pid === process.pid ? `${Date.now() - Math.round(process.uptime() * 1000)}` : "unknown";
  }
}

function fingerprintWorkingFiles(worktree: string): string | undefined {
  try {
    const stat = statSync(resolve(worktree));
    return createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.mtimeMs}`).digest("hex");
  } catch {
    return undefined;
  }
}

function validateBuildRun(run: BuildRunRecordV1): void {
  if (run.version !== BUILD_RUN_VERSION || !run.runId || !run.repository?.root || !run.repository.worktree || !run.createdAt || !run.updatedAt) {
    throw new Error("invalid build run record");
  }
}
