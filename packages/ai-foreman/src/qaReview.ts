import type { ProviderSessionRefV1, SessionStrategy } from "rafi-spec";
import type { BuilderAdapter, CompactResult } from "./adapters/types.js";
import { SessionUnavailableError } from "./adapters/sessionFailure.js";
import { currentActivity, withActivityPhase } from "./activity.js";
import { buildQaFixInstruction, buildQaInstruction, parseStepStatus } from "./foreman.js";
import { createDisposableQaSnapshotAsync } from "./qaSnapshot.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { loadTicketSetupConfigWithDefaults } from "./tickets/setupConfig.js";

export interface QaStreamState { sessionId?: string; sessionRef?: ProviderSessionRefV1; reviews: number; modificationViolations: number }
export interface QaNonconvergenceContext { ticket: TicketDef; history: Array<{ cycle: number; outcome: string; detail: string }>; builderWorktree: string }
export type QaNonconvergenceDecision = { action: "retry" | "pause" | "waive" | "remediate"; remediation?: string };
export interface IsolatedQaOptions {
  ticket: TicketDef;
  builderWorktree: string;
  builderSummary: string;
  qaStrategy: SessionStrategy;
  state: QaStreamState;
  createQa: (cwd: string, sessionId?: string) => Promise<BuilderAdapter>;
  /** Host-owned ordinary QA boundary. Fresh strategies must return a validated successor. */
  sessionBoundary?: (adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy, cwd: string) => Promise<BuilderAdapter>;
  fix: (issues: string) => Promise<{ ok: boolean; detail?: string }>;
  maxCycles: number;
  evidence?: (entry: { cycle: number; outcome: string; detail: string; qaDiff?: string[] }) => void;
  onNonconvergence?: (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision>;
}

export interface IsolatedQaResult { outcome: "passed" | "blocked" | "needs-human" | "nonconverged" | "waived"; detail?: string; summary?: string }

export async function runIsolatedQa(opts: IsolatedQaOptions): Promise<IsolatedQaResult> {
  const history: QaNonconvergenceContext["history"] = [];
  for (let cycle = 1; cycle <= opts.maxCycles; cycle++) {
    const review = await withActivityPhase(`running QA cycle ${cycle}/${opts.maxCycles}`, () => oneReview(opts, cycle));
    if (review.outcome === "retry-modification") { cycle -= 1; continue; }
    if (review.outcome === "passed") return review;
    if (review.outcome !== "failed") return review;
    history.push({ cycle, outcome: "qa_fail", detail: review.detail });
    if (cycle === opts.maxCycles) break;
    const fix = await withActivityPhase("applying QA fixes", () => opts.fix(review.detail ?? "QA reported unspecified issues"));
    if (!fix.ok) return { outcome: "blocked", detail: fix.detail ?? "Builder QA fix failed" };
  }
  const detail = `QA could not converge after ${opts.maxCycles} automatic cycle(s); choose retry, pause, waive, or Planner remediation`;
  if (!opts.onNonconvergence) return { outcome: "nonconverged", detail };
  const decision = await opts.onNonconvergence({ ticket: opts.ticket, history, builderWorktree: opts.builderWorktree });
  if (decision.action === "pause") return { outcome: "nonconverged", detail };
  if (decision.action === "waive") return { outcome: "waived", detail: history.at(-1)?.detail ?? detail, summary: "QA explicitly waived by user" };
  const issues = decision.action === "remediate" ? decision.remediation : history.at(-1)?.detail;
  if (!issues) return { outcome: "nonconverged", detail: "Planner remediation did not produce approved fix instructions" };
  const fix = await withActivityPhase("applying QA remediation", () => opts.fix(issues));
  if (!fix.ok) return { outcome: "blocked", detail: fix.detail ?? "Builder QA fix failed" };
  return runIsolatedQa(opts);
}

async function oneReview(opts: IsolatedQaOptions, cycle: number): Promise<IsolatedQaResult | { outcome: "retry-modification" } | { outcome: "failed"; detail: string }> {
  const progress = (state: string, detail?: string): void => currentActivity()?.update(state, detail);
  const snapshot = await withActivityPhase("preparing disposable QA snapshot", () => createDisposableQaSnapshotAsync(opts.builderWorktree, progress));
  let qa: BuilderAdapter | undefined;
  try {
    const handoff = buildQaReviewHandoff(opts.ticket, opts.builderSummary, snapshot.manifest.diffDigest, loadTicketSetupConfigWithDefaults(opts.builderWorktree).build.validation_checklist);
    // Every disposable snapshot has a distinct cwd and therefore must have a
    // fresh provider conversation. Cumulative QA state remains in the durable
    // continuity/checkpoint stream; an old provider session is never moved
    // into a newly-created /tmp/rafi-qa-* directory.
    qa = await opts.createQa(snapshot.path);
    const turn = await qa.sendTurn(handoff); const status = parseStepStatus(turn.text);
    opts.state.reviews += 1; opts.state.sessionId = qa.sessionId(); opts.state.sessionRef = qa.sessionRef?.();
    const changes = await withActivityPhase("checking QA file changes", () => snapshot.qaChanges());
    if (changes.length) {
      opts.state.modificationViolations += 1;
      opts.evidence?.({ cycle, outcome: "qa_file_modification", detail: "QA modified the disposable review copy", qaDiff: changes });
      if (opts.state.modificationViolations === 1) return { outcome: "retry-modification" };
      return { outcome: "needs-human", detail: `QA modified files twice: ${changes.join(", ")}` };
    }
    opts.state.modificationViolations = 0;
    if (turn.isError) return { outcome: "blocked", detail: turn.text.slice(0, 500) };
    if (status.kind === "qa_pass") { opts.evidence?.({ cycle, outcome: "passed", detail: status.summary ?? "qa_pass" }); return { outcome: "passed", summary: status.summary }; }
    if (status.kind === "qa_fail") { const detail = status.issues ?? "QA reported no issue text"; opts.evidence?.({ cycle, outcome: "failed", detail }); return { outcome: "failed", detail }; }
    return { outcome: "needs-human", detail: status.error ?? `QA returned ${status.kind}` };
  } finally {
    if (qa) await withActivityPhase("closing QA session", () => qa!.close().catch(() => {}));
    await withActivityPhase("cleaning up disposable QA snapshot", () => snapshot.remove());
  }
}

export function buildQaReviewHandoff(ticket: TicketDef, builderSummary: string, diffDigest: string, validationChecklist: string[]): string {
  return [
    buildQaInstruction(), "", "QA handoff:", `Ticket: ${ticket.id} — ${ticket.title}`,
    `Acceptance: ${ticket.acceptance.join("; ")}`, `Builder summary: ${builderSummary}`,
    `Changed files/diff digest: ${diffDigest}`, `Required tests: ${ticket.required_tests.join("; ")}`,
    `Project validation checklist: ${validationChecklist.join("; ")}`,
    "Do not change source, configuration, documentation, tickets, or control files. Only ignored cache, coverage, and build output is allowed.",
  ].join("\n");
}

export async function compactWithRetry(adapter: BuilderAdapter): Promise<CompactResult> {
  if (!adapter.compact) return { ok: false, error: "native compaction unavailable" };
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await adapter.compact();
      if (result.ok) return { ok: true };
      if (result.failure?.category === "session-unavailable") return result;
      error = result.error ?? "compaction failed";
    } catch (failure) {
      if (failure instanceof SessionUnavailableError) return { ok: false, error: failure.message, failure: failure.failure };
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  return { ok: false, error };
}

export function buildDurableQaFixHandoff(ticket: TicketDef, issues: string, worktree: string, priorResult: string, diffDigest: string): string {
  return [buildQaFixInstruction(issues), "", `Ticket: ${ticket.id} — ${ticket.title}`, `Acceptance: ${ticket.acceptance.join("; ")}`, `Worktree: ${worktree}`, `Current diff: ${diffDigest}`, `Prior result: ${priorResult}`, `All QA issues: ${issues}`].join("\n");
}
