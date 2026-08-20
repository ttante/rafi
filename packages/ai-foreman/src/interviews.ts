/**
 * Durable, local state for commands that ask a human questions.  This lives in
 * ai-foreman (rather than a CLI package) because `rafi tickets` is implemented
 * there too.  Records deliberately contain decisions and small diagnostics,
 * never a transcript or command output.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export const INTERVIEW_STATE_VERSION = 2;
export const INTERVIEW_DIRECTORY = ".rafi/interviews";
const MAX_FAILURE_LENGTH = 1_000;
const COMPLETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type InterviewWorkflow = "create" | "plan" | "tickets-plan" | "tickets-setup-init" | "tickets-setup-update";
export type InterviewStatus = "in_progress" | "paused" | "needs_review" | "completed" | "incompatible";
export type InterviewStageStatus = "not_offered" | "offered" | "accepted" | "running" | "completed" | "skipped" | "paused" | "failed" | "cancelled";

export interface InterviewRuntimeState {
  runtime?: "claude" | "codex";
  model?: string;
  sessionId?: string;
  /** True when a session id could not be resumed and a fresh session is needed. */
  continuityLost?: boolean;
}

export interface InterviewOutputFingerprint {
  path: string;
  sha256: string | null;
}

export interface InterviewFailure {
  checkpoint: string;
  summary: string;
  at: string;
}

export interface InterviewRecord {
  version: number;
  id: string;
  journeyId: string;
  parentId?: string;
  childIds: string[];
  workflow: InterviewWorkflow;
  status: InterviewStatus;
  /** Arguments/context required to re-enter the runner. No environment secrets. */
  invocation: Record<string, unknown>;
  answers: Record<string, unknown>;
  /** V2 name for compact persisted answers; `answers` remains as a compatibility alias. */
  decisions: Record<string, unknown>;
  checkpoint: string;
  stages: Record<string, { status: InterviewStageStatus; updatedAt: string }>;
  planningMode?: "standard" | "exhaustive";
  runtime: InterviewRuntimeState;
  runtimeAttempts: Array<{ runtime: "claude" | "codex"; at: string; outcome: "ready" | "failed" | "cancelled"; category?: string }>;
  sessionIds: Record<string, string>;
  continuityLost: boolean;
  outputs: InterviewOutputFingerprint[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: InterviewFailure;
}

export interface InterviewRecordProblem {
  path: string;
  reason: string;
}

export interface InterviewReadResult {
  records: InterviewRecord[];
  problems: InterviewRecordProblem[];
}

export function interviewDirectory(projectDir: string): string {
  return join(resolve(projectDir), INTERVIEW_DIRECTORY);
}

export function createInterviewRecord(input: {
  workflow: InterviewWorkflow;
  invocation: Record<string, unknown>;
  answers?: Record<string, unknown>;
  checkpoint: string;
  outputs?: string[];
  now?: Date;
  parentId?: string;
  journeyId?: string;
  planningMode?: "standard" | "exhaustive";
}): InterviewRecord {
  const stamp = (input.now ?? new Date()).toISOString();
  return {
    version: INTERVIEW_STATE_VERSION,
    id: randomUUID(),
    journeyId: input.journeyId ?? randomUUID(),
    parentId: input.parentId,
    childIds: [],
    workflow: input.workflow,
    status: "in_progress",
    invocation: { ...input.invocation },
    answers: { ...(input.answers ?? {}) },
    decisions: { ...(input.answers ?? {}) },
    checkpoint: input.checkpoint,
    stages: { [input.checkpoint]: { status: "running", updatedAt: stamp } },
    planningMode: input.planningMode,
    runtime: {},
    runtimeAttempts: [],
    sessionIds: {},
    continuityLost: false,
    outputs: fingerprintOutputs(String(input.invocation.projectDir ?? ""), input.outputs ?? []),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** Ensure ignored local state exists without modifying unrelated gitignore text. */
export function ensureInterviewGitignore(projectDir: string): void {
  const root = resolve(projectDir);
  const path = join(root, ".gitignore");
  const line = ".rafi/interviews/";
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split(/\r?\n/).some((entry) => entry.trim() === line)) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${current}${prefix}${line}\n`, "utf8");
}

export function saveInterviewRecord(projectDir: string, record: InterviewRecord, now = new Date()): InterviewRecord {
  validateRecord(record);
  const directory = interviewDirectory(projectDir);
  mkdirSync(directory, { recursive: true });
  ensureInterviewGitignore(projectDir);
  const next: InterviewRecord = { ...record, updatedAt: now.toISOString() };
  const path = interviewRecordPath(projectDir, next.id);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  return next;
}

export function checkpointInterview(
  projectDir: string,
  record: InterviewRecord,
  update: Partial<Pick<InterviewRecord, "answers" | "decisions" | "checkpoint" | "runtime" | "outputs" | "invocation" | "status" | "stages" | "planningMode" | "runtimeAttempts" | "sessionIds" | "continuityLost" | "childIds">>,
): InterviewRecord {
  const nextAnswers = update.answers ?? update.decisions ?? record.answers;
  const stamp = new Date().toISOString();
  const stages = update.stages ?? (update.checkpoint && update.checkpoint !== record.checkpoint
    ? {
        ...record.stages,
        [record.checkpoint]: { status: stageCompletionStatus(record.status), updatedAt: stamp },
        [update.checkpoint]: { status: "running" as const, updatedAt: stamp },
      }
    : record.stages);
  const next: InterviewRecord = {
    ...record,
    ...update,
    answers: { ...nextAnswers },
    decisions: { ...nextAnswers },
    stages,
    runtime: update.runtime ? { ...update.runtime } : record.runtime,
    sessionIds: update.runtime?.sessionId
      ? { ...record.sessionIds, [update.runtime.runtime ?? "agent"]: update.runtime.sessionId }
      : update.sessionIds ? { ...update.sessionIds } : record.sessionIds,
    continuityLost: update.runtime?.continuityLost ?? update.continuityLost ?? record.continuityLost,
    invocation: update.invocation ? { ...update.invocation } : record.invocation,
    outputs: update.outputs ? update.outputs.map((output) => ({ ...output })) : record.outputs,
  };
  return saveInterviewRecord(projectDir, next);
}

export function failInterview(projectDir: string, record: InterviewRecord, checkpoint: string, error: unknown): InterviewRecord {
  const at = new Date().toISOString();
  return saveInterviewRecord(projectDir, {
    ...record,
    status: record.status === "needs_review" ? "needs_review" : "in_progress",
    checkpoint,
    failure: { checkpoint, at, summary: redactFailure(error) },
  });
}

export function completeInterview(projectDir: string, record: InterviewRecord, now = new Date()): InterviewRecord {
  const stamp = now.toISOString();
  return saveInterviewRecord(projectDir, {
    ...record,
    status: "completed",
    completedAt: stamp,
    stages: { ...record.stages, [record.checkpoint]: { status: "completed", updatedAt: stamp } },
    failure: undefined,
  }, now);
}

export function readInterviewRecords(projectDir: string): InterviewReadResult {
  const directory = interviewDirectory(projectDir);
  if (!existsSync(directory)) return { records: [], problems: [] };
  const records: InterviewRecord[] = [];
  const problems: InterviewRecordProblem[] = [];
  for (const name of readFileNames(directory)) {
    const path = join(directory, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const record = parseInterviewRecord(parsed);
      records.push(record);
    } catch (error) {
      problems.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { records, problems };
}

export function unfinishedInterviews(projectDir: string): InterviewRecord[] {
  return readInterviewRecords(projectDir).records.filter((record) =>
    record.status === "in_progress" || record.status === "paused" || record.status === "needs_review" || record.status === "incompatible",
  );
}

export function findInterviewRecord(projectDir: string, id: string): InterviewRecord | undefined {
  return readInterviewRecords(projectDir).records.find((record) => record.id === id || record.id.startsWith(id));
}

export function discardInterview(projectDir: string, id: string): boolean {
  const record = findInterviewRecord(projectDir, id);
  if (!record) return false;
  rmSync(interviewRecordPath(projectDir, record.id));
  return true;
}

/** Remove only completed records past retention; malformed/incompatible files stay for explicit discard. */
export function pruneCompletedInterviews(projectDir: string, now = new Date()): string[] {
  const removed: string[] = [];
  for (const record of readInterviewRecords(projectDir).records) {
    if (record.status !== "completed" || !record.completedAt) continue;
    if (now.getTime() - new Date(record.completedAt).getTime() <= COMPLETE_RETENTION_MS) continue;
    rmSync(interviewRecordPath(projectDir, record.id));
    removed.push(record.id);
  }
  return removed;
}

export function fingerprintOutputs(projectDir: string, paths: string[]): InterviewOutputFingerprint[] {
  if (!projectDir) return paths.map((path) => ({ path, sha256: null }));
  return paths.map((path) => ({ path, sha256: fingerprintFile(projectDir, path) }));
}

export function outputsChanged(projectDir: string, fingerprints: InterviewOutputFingerprint[]): string[] {
  return fingerprints
    .filter((fingerprint) => fingerprintFile(projectDir, fingerprint.path) !== fingerprint.sha256)
    .map((fingerprint) => fingerprint.path);
}

export function redactFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:])\s*[^\s,;]+/gi, "$1<redacted>")
    .replace(/\b(?:sk|rk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, MAX_FAILURE_LENGTH);
}

function interviewRecordPath(projectDir: string, id: string): string {
  return join(interviewDirectory(projectDir), `${id}.json`);
}

function readFileNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".json"));
}

function fingerprintFile(projectDir: string, path: string): string | null {
  const root = resolve(projectDir);
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith("..")) return null;
  if (!existsSync(absolute)) return null;
  return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

function parseInterviewRecord(value: unknown): InterviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid interview record");
  const record = value as Partial<InterviewRecord>;
  if (record.version === 1) return migrateV1Record(value as Record<string, unknown>);
  if (record.version !== INTERVIEW_STATE_VERSION) {
    // Preserve it on disk. The caller can show it and require an explicit discard.
    if (typeof record.id === "string" && typeof record.workflow === "string") {
      return { ...record, status: "incompatible" } as InterviewRecord;
    }
    throw new Error(`unsupported interview record version: ${String(record.version)}`);
  }
  validateRecord(record as InterviewRecord);
  return record as InterviewRecord;
}

function migrateV1Record(value: Record<string, unknown>): InterviewRecord {
  const legacy = value as unknown as Partial<InterviewRecord>;
  if (!legacy.id || !legacy.workflow || !legacy.checkpoint || !legacy.createdAt || !legacy.updatedAt) {
    throw new Error("invalid V1 interview record");
  }
  const outputs = Array.isArray(legacy.outputs) ? legacy.outputs : [];
  const evidenceIsComplete = outputs.length > 0 && outputs.every((item) => item && typeof item.path === "string" && typeof item.sha256 === "string");
  const answers = legacy.answers && typeof legacy.answers === "object" ? legacy.answers : {};
  const runtime = legacy.runtime && typeof legacy.runtime === "object" ? legacy.runtime : {};
  const stamp = legacy.updatedAt;
  return {
    version: 2,
    id: legacy.id,
    journeyId: legacy.id,
    childIds: [],
    workflow: legacy.workflow,
    status: legacy.status === "completed" ? "completed" : evidenceIsComplete ? "paused" : "needs_review",
    invocation: legacy.invocation && typeof legacy.invocation === "object" ? legacy.invocation : {},
    answers,
    decisions: { ...answers },
    checkpoint: legacy.checkpoint,
    stages: { [legacy.checkpoint]: { status: evidenceIsComplete ? "paused" : "failed", updatedAt: stamp } },
    runtime,
    runtimeAttempts: [],
    sessionIds: runtime.sessionId ? { [runtime.runtime ?? "agent"]: runtime.sessionId } : {},
    continuityLost: Boolean(runtime.continuityLost || !runtime.sessionId),
    outputs,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    completedAt: legacy.completedAt,
    failure: legacy.failure,
  };
}

function stageCompletionStatus(status: InterviewStatus): InterviewStageStatus {
  if (status === "paused" || status === "needs_review") return "paused";
  if (status === "completed") return "completed";
  return "completed";
}

function validateRecord(record: InterviewRecord): void {
  if (record.version !== INTERVIEW_STATE_VERSION) throw new Error("unsupported interview record version");
  if (!record.id || !record.journeyId || !record.workflow || !record.checkpoint || !record.createdAt || !record.updatedAt) {
    throw new Error("invalid interview record");
  }
}
