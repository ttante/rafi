import type { ConfigurableAgentRole, WorkflowIssue, WorkflowIssueCode } from "rafi-spec";
import type { StepStatus } from "./foreman.js";

export interface IssueContext {
  role?: ConfigurableAgentRole; phase: string; step?: number; ticket?: string; stack?: string; qaCycle?: number;
  provider?: "claude" | "codex"; model?: string; now?: Date;
}

export function protocolIssue(status: StepStatus, context: IssueContext): WorkflowIssue {
  const detail = status.error ?? "role did not emit a final marker";
  let code: WorkflowIssueCode = "role_marker_missing";
  if (/multiple|duplicate/i.test(detail)) code = "role_marker_duplicated";
  else if (/not the final/i.test(detail)) code = "role_marker_non_final";
  else if (/malformed|unterminated|field/i.test(detail)) code = "role_marker_malformed";
  else if (/exhausted/i.test(detail)) code = "role_protocol_exhausted";
  else if (status.kind !== "unknown") code = "role_marker_invalid";
  return issue(code, context, detail, true, true, "Inspect the saved output and resume the exact checkpoint after correcting the protocol response.");
}

export function issue(code: WorkflowIssueCode, context: IssueContext, detail: string, humanRequired: boolean, recoverable: boolean, suggestedAction: string): WorkflowIssue {
  return {
    code, role: context.role, phase: context.phase, step: context.step, ticket: context.ticket, stack: context.stack,
    qa_cycle: context.qaCycle, provider: context.provider, model: context.model, detail,
    human_required: humanRequired, recoverable, suggested_action: suggestedAction,
    occurred_at: (context.now ?? new Date()).toISOString(),
  };
}

export function formatWorkflowIssue(value: WorkflowIssue): string {
  const scope = [value.role, value.ticket && `ticket=${value.ticket}`, value.stack && `stack=${value.stack}`, value.step && `step=${value.step}`].filter(Boolean).join(" ");
  return `${value.code}${scope ? ` (${scope})` : ""}: ${value.detail}\nSuggested action: ${value.suggested_action}`;
}
