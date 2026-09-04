import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A single structured log record. */
export interface LogRecord {
  ts: string;
  event:
    | "batch-start"
    | "batch-end"
    | "branch-plan"
    | "branch-start"
    | "branch-session"
    | "branch-resume"
    | "branch-issue"
    | "branch-complete"
    | "branch-push"
    | "github-readiness-failed"
    | "gitlab-readiness-failed"
    | "pr-created"
    | "pr-existing"
    | "pr-failed"
    | "pr-auto-merge-enabled"
    | "pr-auto-merge-failed"
    | "mr-created"
    | "mr-existing"
    | "mr-failed"
    | "mr-auto-merge-enabled"
    | "mr-auto-merge-failed"
    | "branch-auto-merge-wait"
    | "branch-direct-merge"
    | "step"
    | "permission"
    | "escalation"
    | "needs_input"
    | "blocked-recovery"
    | "preflight"
    | "rafi-plan"
    | "ticket-populate"
    | "uninstall-proposal"
    | "qa"
    | "qa-fix"
    | "qa-protected-files-changed"
    | "qa-evidence"
    | "agent-status"
    | "context-lifecycle"
    | "handoff-transfer"
    | "recovery-handoff-accepted"
    | "guided-recovery-required"
    | "safe-boundary-paused"
    | "session-unavailable"
    | "error";
  [key: string]: unknown;
}

/** Append-only JSONL logger. One line per record, plus an echo to the console. */
export class Log {
  constructor(private readonly path?: string) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  write(event: LogRecord["event"], fields: Record<string, unknown>): void {
    if (!this.path) return;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      event,
      ...fields,
    };
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }
}
