import type { RunSpanV1 } from "rafi-spec";
import { ObservabilityReader } from "./observability.js";

/**
 * Bounded, adapter-redacted output excerpts are host-retained evidence and are
 * delivered to independent QA by default. RAFI_QA_COMMAND_OUTPUT_EXCERPTS=0
 * (or off/false) disables them; a ticket ID limits them to that ticket.
 */
export function qaCommandOutputExcerptsAllowed(workId: string, configured = process.env.RAFI_QA_COMMAND_OUTPUT_EXCERPTS): boolean {
  if (!workId) return false;
  const value = configured?.trim();
  if (!value || ["1", "on", "true"].includes(value.toLowerCase())) return true;
  if (["0", "off", "false"].includes(value.toLowerCase())) return false;
  return value === workId;
}

/** Command text is never forwarded; excerpts are bounded and may be truncated. */
export function selectQaCommandObservations(spans: RunSpanV1[], runId: string, workId: string, includeOutputExcerpts = false): unknown[] {
  const turns = new Set(spans.filter(span => span.runId === runId && span.kind === "provider_turn" && span.role === "builder" && span.ticketId === workId).map(span => span.spanId));
  return spans.filter(span => span.runId === runId && span.kind === "tool" && span.role === "builder" && span.parentSpanId && turns.has(span.parentSpanId) && span.completionKnown && span.endedAt)
    .flatMap(span => {
      const attributes = span.attributes ?? {};
      const input = attributes.input as Record<string, unknown> | undefined;
      const command = typeof input?.command === "string" ? input.command : "";
      const kind = /\bqa-rehearse-rollback\b/.test(command) ? "rollback-rehearsal" : /\bnpm\s+test\b|\bnode\s+--test\b/.test(command) ? "test" : undefined;
      if (!kind) return [];
      const outcome = ["completed", "failed", "cancelled", "timed_out"].includes(span.outcome ?? "") ? span.outcome : "unknown";
      const exitCode = typeof attributes.exitCode === "number" && Number.isSafeInteger(attributes.exitCode) ? attributes.exitCode : undefined;
      const outputDigest = typeof attributes.outputDigest === "string" && /^[a-f0-9]{64}$/.test(attributes.outputDigest) ? attributes.outputDigest : undefined;
      const outputExcerpt = includeOutputExcerpts && typeof attributes.outputSummary === "string" ? attributes.outputSummary.slice(0, 1000) : undefined;
      return [{ spanId: span.spanId, providerTurnId: span.providerTurnId, startedAt: span.startedAt, endedAt: span.endedAt, kind, outcome, exitCode, outputDigest, ...(outputExcerpt === undefined ? {} : { outputExcerpt, excerptMayBeTruncated: true }) }];
    }).slice(-40);
}

export function retainedQaCommandObservations(projectDir: string, runId: string, workId: string, includeOutputExcerpts = false): unknown[] {
  try {
    const reader = new ObservabilityReader(projectDir);
    try { return selectQaCommandObservations(reader.spans(runId), runId, workId, includeOutputExcerpts); }
    finally { reader.close(); }
  } catch { return []; } // Diagnostics are optional; never prevent independent review.
}
