import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A single structured log record. */
export interface LogRecord {
  ts: string;
  event:
    | "batch-start"
    | "batch-end"
    | "step"
    | "permission"
    | "escalation"
    | "needs_input"
    | "preflight"
    | "ticket-populate"
    | "qa"
    | "qa-fix"
    | "error";
  [key: string]: unknown;
}

/** Append-only JSONL logger. One line per record, plus an echo to the console. */
export class Log {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(event: LogRecord["event"], fields: Record<string, unknown>): void {
    const record: LogRecord = {
      ts: new Date().toISOString(),
      event,
      ...fields,
    };
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }
}
