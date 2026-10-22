import type { BuilderEvent } from "./adapters/types.js";
import { WorkflowDb } from "./workflowDb.js";

export type QaUnresolvedToolDecision =
  | { action: "none" }
  | { action: "retry"; detail: string }
  | { action: "pause"; detail: string };

function unresolvedTools(events: BuilderEvent[]): Array<{ callId: string; digest?: string; name: string }> {
  const latest = new Map<string, Extract<BuilderEvent, { kind: "tool" }>>();
  for (const event of events) if (event.kind === "tool" && event.callId && event.lifecycle === "completed") latest.set(event.callId, event);
  return [...latest.values()].filter(event => event.completionKnown === false).map(event => ({ callId: event.callId!, digest: event.outputDigest, name: event.name }));
}

export function recordQaUnresolvedTools(projectDir: string, runId: string, ticketId: string, events: BuilderEvent[]): void {
  const unresolved = unresolvedTools(events);
  if (!unresolved.length) return;
  const db = new WorkflowDb(projectDir);
  try {
    const prior = db.continuityEvents(runId).filter(event => event.kind === "qa-unresolved-tool-result" && (event.payload as { ticketId?: unknown }).ticketId === ticketId);
    const known = new Set(prior.map(event => JSON.stringify(event.payload)));
    const head = db.qaTicketHead(runId, ticketId);
    for (const item of unresolved) {
      const payload = { ticketId, callId: item.callId, toolName: item.name, outputDigest: item.digest ?? null };
      if (!known.has(JSON.stringify(payload))) db.appendContinuityEvent({ runId, role: "qa", kind: "qa-unresolved-tool-result", payload, authoritativeStateRevision: head.revision });
    }
  } finally { db.close(); }
}

export function qaUnresolvedToolDecision(projectDir: string, runId: string, ticketId: string, events: BuilderEvent[]): QaUnresolvedToolDecision {
  const unresolved = unresolvedTools(events);
  if (!unresolved.length) return { action: "none" };
  const db = new WorkflowDb(projectDir);
  try {
    const records = db.continuityEvents(runId).filter(event => event.kind === "qa-unresolved-tool-result" && (event.payload as { ticketId?: unknown }).ticketId === ticketId);
    const priorKeys = new Set(records.map(event => { const payload = event.payload as { outputDigest?: string | null; toolName: string }; return payload.outputDigest ?? payload.toolName; }));
    const repeated = unresolved.find(item => priorKeys.has(item.digest ?? item.name));
    if (repeated) return { action: "pause", detail: `QA tool result remains unresolved after one controlled recovery (${repeated.name}, ${repeated.digest ?? repeated.name}); no provider action was replayed` };
    return { action: "retry", detail: `QA observed an unresolved ${unresolved[0]!.name} result; starting one fresh review without replaying the uncertain tool action` };
  } finally { db.close(); }
}
