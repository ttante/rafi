// S-CLI-2 step 4, run after every scenario: no ARCH 12.7 path appears in the project, no dropped prompt is
// shown, and no ENV-5 variable is set on any process rafi starts.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** ARCH 12.7 (REWRITE_ARCHITECTURE.md:1581), verbatim. `<timestamp>.jsonl` is checked by pattern. */
export const FORBIDDEN_PATHS: readonly string[] = Object.freeze([
  ".foreman/runs", ".foreman/qa-report-recovery", ".foreman/qa-recovery-context", ".foreman/delivery-sessions",
  ".foreman/qa-contracts", ".foreman/provider-streams", ".rafi/recovery.sqlite3", ".rafi/observability.sqlite3",
  ".rafi/recovery-archive", ".rafi/reset-stage", ".rafi/start-over-control", ".rafi/communication-quarantine",
  ".rafi/ownership-backups", ".rafi/backups/work-admission-v4", ".rafi/cache/handoffs", ".rafi/staging",
  ".rafi/state-transfer.json", ".rafi/state-transfer-backups", ".rafi/agent-files", ".tickets/ticket-state.sqlite",
  ".tickets/migrations/001_init.sql", "foreman.yaml",
]);

/** The dropped prompts (PRM-80, PRM-84, PRM-93–99, PRM-101; REWRITE_REQUIREMENTS.md:415-439). */
export const DROPPED_PROMPTS: readonly RegExp[] = Object.freeze([
  /is paused until probe cleanup is verified/, /QA report recovery:/, /Specific QA report-recovery instructions/,
  /The saved execution cannot be resumed safely/, /Continue from your preserved files with a fresh Builder/,
  /as the repaired .* checkpoint for run/, /Which ticket should Rafi recover first/,
  /Correct saved start options/, /How should Rafi recover the interrupted build/,
  /How should Rafi recover the rejected successor handoff/, /Guidance for the next fresh successor/,
  /Replace existing local Rafi state in/, /Rebind this copied local build state/,
]);

export const ENV5: readonly RegExp[] = Object.freeze([
  /^RAFI_BUILD_WORKER_RUN$/, /^RAFI_BUILD_WORKER_GENERATION$/, /^RAFI_DETACHED_SUPERVISOR_RUN$/,
  /^RAFI_BUILD_LAUNCH_TOKEN$/, /^RAFI_PROBE_ENV$/, /^RAFI_REHEARSAL_/,
]);

export interface AfterEachInput {
  /** Project folders the scenario used, minus those that are legacy fixtures by design (F-LEGACY). */
  readonly projects: readonly string[];
  readonly outputs: readonly string[];
  /** Every message rafi sent an agent (the transcript), as text. */
  readonly transcripts?: readonly string[];
  /** The environment of every process rafi started (the harness deps record it). */
  readonly childEnvs: readonly Readonly<Record<string, string | undefined>>[];
}

function supervisorLogs(project: string): string[] {
  const dir = path.join(project, ".rafi", "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("supervisor-")).map((f) => path.join(".rafi/logs", f));
}

function timestampLogs(project: string): string[] {
  const dir = path.join(project, ".foreman");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d.*\.jsonl$/.test(f)).map((f) => path.join(".foreman", f));
}

/** Returns the problems found; empty when the scenario left nothing forbidden behind. */
export function afterEachChecks(input: AfterEachInput): string[] {
  const problems: string[] = [];
  for (const project of input.projects) {
    for (const rel of FORBIDDEN_PATHS) {
      if (existsSync(path.join(project, rel))) problems.push(`${rel} appeared in ${project}`);
    }
    for (const rel of [...supervisorLogs(project), ...timestampLogs(project)]) {
      problems.push(`${rel} appeared in ${project}`);
    }
  }
  for (const text of input.outputs) {
    for (const prompt of DROPPED_PROMPTS) if (prompt.test(text)) problems.push(`dropped prompt shown: ${prompt}`);
  }
  for (const text of input.transcripts ?? []) {
    for (const prompt of DROPPED_PROMPTS) {
      if (prompt.test(text)) problems.push(`dropped prompt sent to an agent: ${prompt}`);
    }
  }
  for (const env of input.childEnvs) {
    for (const name of Object.keys(env)) {
      if (ENV5.some((pattern) => pattern.test(name))) problems.push(`${name} set on a process rafi started`);
    }
  }
  return problems;
}
