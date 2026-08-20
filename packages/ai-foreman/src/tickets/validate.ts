import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketsConfig } from "./config.js";
import type { TicketDef } from "./ticketSchema.js";
import type { TicketState, StateDb } from "./stateDb.js";
import { validateTicketDefs, detectCycles } from "./ticketLoader.js";
import { buildNextQueue } from "./queue.js";
import { loadDeliveryConfig, validateDeliveryConfig } from "./delivery.js";

export interface ValidationIssue {
  pass: 1 | 2 | 3 | 4;
  severity: "error" | "warn";
  message: string;
}

export function runAllValidation(
  config: TicketsConfig,
  projectDir: string,
  ticketDefs: TicketDef[],
  states: Map<string, TicketState>,
  db: StateDb,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Pass 1: schema and source
  for (const err of validateTicketDefs(ticketDefs)) {
    issues.push({ pass: 1, severity: "error", message: `[schema] ${err.path}: ${err.message}` });
  }
  for (const cycle of detectCycles(ticketDefs)) {
    issues.push({ pass: 1, severity: "error", message: `[cycle] dependency cycle: ${cycle}` });
  }
  try {
    const delivery = loadDeliveryConfig(projectDir);
    if (delivery) {
      for (const issue of validateDeliveryConfig(delivery, ticketDefs)) {
        issues.push({ pass: 1, severity: "error", message: `[delivery] ${issue.path}: ${issue.message}` });
      }
    }
  } catch (err) {
    issues.push({ pass: 1, severity: "error", message: `[delivery] ${err instanceof Error ? err.message : String(err)}` });
  }

  // Pass 2: state validation
  const ticketIds = new Set(ticketDefs.map((t) => t.id));
  for (const [id, state] of states) {
    if (!ticketIds.has(id)) {
      issues.push({ pass: 2, severity: "error", message: `[state] ticket_state row for unknown ticket: ${id}` });
    }
    if (state.status === "done" && !state.completed_at) {
      issues.push({ pass: 2, severity: "error", message: `[state] done ticket ${id} missing completed_at` });
    }
    if (state.status === "done" && !state.evidence && config.behavior.requireValidationEvidenceForDone) {
      issues.push({ pass: 2, severity: "warn", message: `[state] done ticket ${id} has no evidence` });
    }
  }

  // Pass 3: queue validation
  const queueRows = buildNextQueue(ticketDefs, states, config.implementationLimit);
  const remaining = ticketDefs.filter((t) => {
    const s = states.get(t.id);
    return s?.status !== "done" && s?.status !== "canceled";
  });
  const expectedLen = Math.min(config.implementationLimit, remaining.length);
  if (queueRows.length !== expectedLen) {
    issues.push({ pass: 3, severity: "error", message: `[queue] expected ${expectedLen} rows, got ${queueRows.length}` });
  }
  for (let i = 0; i < queueRows.length; i++) {
    if (queueRows[i].rank !== i + 1) {
      issues.push({ pass: 3, severity: "error", message: `[queue] rank gap at position ${i + 1}: got ${queueRows[i].rank}` });
    }
  }
  const blockedWithNone = queueRows.filter((r) => r.status === "blocked" && r.blockedBy === "None");
  for (const r of blockedWithNone) {
    issues.push({ pass: 3, severity: "error", message: `[queue] ${r.ticket} is blocked but Blocked By is None` });
  }

  // Pass 4: generated Markdown doc
  const progressDocPath = join(projectDir, config.paths.progressDoc);
  if (!existsSync(progressDocPath)) {
    issues.push({ pass: 4, severity: "error", message: `[doc] ${config.paths.progressDoc} does not exist; run \`foreman tickets render\`` });
  } else {
    const doc = readFileSync(progressDocPath, "utf8");
    const requiredMarkers = [
      "LLM_NEXT_QUEUE_START", "LLM_NEXT_QUEUE_END",
      "ACTIVE_TICKET_STATUS_START", "ACTIVE_TICKET_STATUS_END",
      "BLOCKED_TICKETS_START", "BLOCKED_TICKETS_END",
      "WORK_LOG_START", "WORK_LOG_END",
    ];
    for (const marker of requiredMarkers) {
      if (!doc.includes(`<!-- ${marker} -->`)) {
        issues.push({ pass: 4, severity: "error", message: `[doc] missing marker: <!-- ${marker} -->` });
      }
    }
    if (!doc.includes("## LLM_NEXT_QUEUE")) {
      issues.push({ pass: 4, severity: "error", message: "[doc] missing ## LLM_NEXT_QUEUE section" });
    }
  }

  return issues;
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "All validation passes clean.";
  return issues.map((i) => `  [pass ${i.pass}] [${i.severity}] ${i.message}`).join("\n");
}
