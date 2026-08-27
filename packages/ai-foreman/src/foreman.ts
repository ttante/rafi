import { select, isCancel } from "@clack/prompts";
import { MARKER_SPEC, QA_MARKER_SPEC } from "./markers.js";
import type {
  BuilderAdapter,
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
  TurnResult,
} from "./adapters/types.js";
import type { PermissionPolicy } from "./permissions/policy.js";
import { countProviderQuestions, handleProviderQuestionTool, type AnsweredProviderQuestion } from "./providerQuestions.js";
import type { Log } from "./log.js";
import { fireNotification } from "./notify.js";
import { isTicketsInitialized, loadTicketsConfig } from "./tickets/config.js";
import { cmdUpdate, cmdComplete, cmdBlock, cmdImplementationQueue } from "./tickets/commands.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { runIsolatedQa, type QaNonconvergenceContext, type QaNonconvergenceDecision, type QaStreamState } from "./qaReview.js";
import type { SessionStrategy } from "rafi-spec";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Parsed STEP_STATUS marker from a builder's turn. */
export interface StepStatus {
  kind:
    | "done"
    | "blocked"
    | "plan_complete"
    | "needs_input"
    | "qa_pass"
    | "qa_fail"
    | "unknown";
  summary?: string;
  next?: string;
  reason?: string;
  question?: string;
  choices?: string[];
  issues?: string;
  ticket?: string;
  branchDependency?: string;
  error?: string;
}

/** Phrases that suggest the builder ended its turn by asking the human. */
const QUESTION_HINTS = [
  "should i",
  "would you like",
  "do you want",
  "let me know",
  "please confirm",
  "could you clarify",
  "which option",
];

/**
 * Pull the STEP_STATUS marker out of a turn's final text.
 * Format: `STEP_STATUS: <kind> | key="value" key="value"`.
 */
export function parseStepStatus(text: string): StepStatus {
  const markerCount = (text.match(/STEP_STATUS:/g) ?? []).length;
  if (markerCount > 1) {
    return { kind: "unknown", error: "builder emitted multiple STEP_STATUS markers" };
  }
  const lines = text.trimEnd().split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (!last.includes("STEP_STATUS:")) {
    if (markerCount === 1) {
      return { kind: "unknown", error: "STEP_STATUS marker was not the final non-empty line" };
    }
    return { kind: "unknown" };
  }

  const match = last.match(
    /^STEP_STATUS:\s*(done|blocked|plan_complete|needs_input|qa_pass|qa_fail)\b\s*(?:\|\s*(.*))?$/i,
  );
  if (!match) {
    return { kind: "unknown", error: "malformed STEP_STATUS marker" };
  }
  const kind = match[1].toLowerCase() as StepStatus["kind"];
  const fields = parseMarkerFields(match[2] ?? "");
  if (fields instanceof Error) {
    return { kind: "unknown", error: fields.message };
  }
  return {
    kind,
    summary: fields.summary,
    next: fields.next,
    reason: fields.reason,
    question: fields.question,
    issues: fields.issues,
    ticket: fields.ticket,
    branchDependency: fields.branch_dependency,
    choices: fields.choices
      ? fields.choices.split("|").map((c) => c.trim()).filter(Boolean)
      : undefined,
  };
}

function parseMarkerFields(input: string): Record<string, string> | Error {
  const fields: Record<string, string> = {};
  let rest = input.trim();
  while (rest.length > 0) {
    const key = rest.match(/^(\w+)="/);
    if (!key) return new Error(`malformed STEP_STATUS field near: ${rest.slice(0, 40)}`);
    const name = key[1];
    let i = key[0].length;
    let value = "";
    let closed = false;
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === "\\") {
        const next = rest[i + 1];
        if (next === undefined) return new Error(`unterminated escape in STEP_STATUS field: ${name}`);
        value += next;
        i += 2;
        continue;
      }
      if (ch === "\"") {
        closed = true;
        i++;
        break;
      }
      value += ch;
      i++;
    }
    if (!closed) return new Error(`unterminated STEP_STATUS field: ${name}`);
    if (fields[name] !== undefined) return new Error(`duplicate STEP_STATUS field: ${name}`);
    fields[name] = value;
    rest = rest.slice(i).trim();
  }
  return fields;
}

/** Heuristic: did a marker-less turn end by asking the human something? */
export function looksLikeQuestion(text: string): boolean {
  const tail = text.trim().toLowerCase().slice(-400);
  if (tail.endsWith("?")) return true;
  return QUESTION_HINTS.some((hint) => tail.includes(hint));
}

export { MARKER_SPEC } from "./markers.js";

export { QA_MARKER_SPEC } from "./markers.js";

/** Instruction sent on the first turn of a batch. */
export function buildPrimer(n: number, trackerPath?: string, ticketsEnabled = false): string {
  let trackerRule: string;
  if (ticketsEnabled) {
    const progressDoc = trackerPath ?? "docs/ticket-progress.md";
    trackerRule = `\n- Ticket state is managed by foreman — you do NOT need to manually edit ${progressDoc}.` +
      `\n- Use \`foreman tickets discover --summary "..." --rationale "..."\` to log newly discovered work.` +
      `\n- Use \`foreman tickets update <id> --next-action "..."\` to record mid-turn notes.` +
      `\n- Always include ticket="<id>" in your STEP_STATUS marker so foreman can update the tracker.`;
  } else if (trackerPath) {
    trackerRule = `\n- After completing each ticket or step, update its status in the ticket progress tracker at \`${trackerPath}\`, following the Standard Update Workflow documented in that file.`;
  } else {
    trackerRule = "";
  }
  return `You are being run by an automated foreman. We will work through your next ${n} tickets or implementation steps, one per turn.

Rules:
- Do exactly ONE ticket or step this turn, then stop.
- ${MARKER_SPEC}
- If a tool action is denied by foreman policy, do not retry it; report it via the blocked marker.${trackerRule}

This is step 1 of ${n}. Implement the next ticket or step now.`;
}

/** Instruction sent on turns 2–N. */
export function buildNextStepInstruction(i: number, n: number): string {
  return `Implement the next ticket or step now (exactly one) — this is step ${i} of ${n}. Then end with the STEP_STATUS marker line.`;
}

/** QA review turn: ask the builder to triple-check the ticket or step it just completed. */
export function buildQaInstruction(): string {
  return `Now QA the ticket or step you just completed. Triple-check your work. Verify:
- Accuracy — does the implementation actually do what the ticket describes?
- Test existence — are there tests covering the new behavior? If tests are expected and missing, that is a QA failure.
- Test execution — run the test suite (or the relevant subset). Do all tests pass?
- Ticket satisfaction — are the ticket's acceptance criteria fully met?
- Confidence — would you bet money this works as described in production?

Triple-check. Do not rubber-stamp your own work. Be skeptical.

If everything is solid, end with STEP_STATUS: qa_pass.
If anything is off, end with STEP_STATUS: qa_fail and list every concrete issue in the issues="..." field. Do NOT fix issues on this turn — just report them. Foreman will instruct you to fix them next.

${QA_MARKER_SPEC}`;
}

/** Follow-up turn after qa_fail: have the builder implement the listed fixes. */
export function buildQaFixInstruction(issues: string): string {
  return `Your QA found these issues:

${issues}

Fix every one of them now. Then end with STEP_STATUS: done so foreman can re-run QA on the fixes. Triple-check that your fixes actually resolve the issues before emitting done.`;
}

/** Pre-flight planning turn: ask the builder to list its next N steps without implementing anything. */
export function buildPlanningTurn(n: number, ticketsContent?: string): string {
  const header = ticketsContent
    ? `Here is the project's ticket list:\n\n${ticketsContent}\n\n`
    : "";
  return `${header}Before we begin, list the next ${n} ticket(s) or step(s) you plan to implement, in order. Be specific — reference ticket IDs or titles where applicable. Do not implement anything yet; output the numbered list only. Do not emit a STEP_STATUS marker on this turn.`;
}

/** Builds the permission callback: classify, log, allow or escalate. */
export function createPermissionHandler(
  policy: PermissionPolicy,
  log: Log,
  opts: {
    interactive?: boolean;
    onAnsweredQuestion?: (event: AnsweredProviderQuestion) => void;
    onProviderQuestion?: (request: PermissionRequest) => void;
  } = {},
): PermissionHandler {
  return async (req: PermissionRequest): Promise<PermissionDecision> => {
    if (req.toolName === "AskUserQuestion") opts.onProviderQuestion?.(req);
    const providerQuestion = await handleProviderQuestionTool(req, {
      interactive: opts.interactive ?? true,
      onAnsweredQuestion: opts.onAnsweredQuestion,
    });
    if (providerQuestion) {
      log.write("permission", {
        tool: req.toolName,
        decision: providerQuestion.behavior,
        reason: "provider question prompt",
        questionCount: countProviderQuestions(req.input),
      });
      return providerQuestion;
    }

    const verdict = policy.classify(req);
    log.write("permission", {
      tool: req.toolName,
      decision: verdict.decision,
      reason: verdict.reason,
    });
    if (verdict.decision === "allow") return { behavior: "allow" };

    log.write("escalation", {
      tool: req.toolName,
      reason: verdict.reason,
      input: req.input,
    });
    return {
      behavior: "deny",
      message:
        `Foreman policy: this action needs human approval (${verdict.reason}) ` +
        `and was NOT performed. Do not retry it. If this step depends on it, ` +
        `end your turn with: STEP_STATUS: blocked | reason="needs human approval: ${verdict.reason}".`,
    };
  };
}

export interface BatchResult {
  completed: number;
  requested: number;
  outcome: "all-done" | "plan-complete" | "blocked" | "needs-human";
  detail?: string;
}

/** Drives one builder through a batch of N steps via the STEP_STATUS protocol. */
export class Foreman {
  private readonly ticketsEnabled: boolean;
  private readonly qaStream: QaStreamState = { reviews: 0, modificationViolations: 0 };
  private builderWorkSessions = 0;

  constructor(
    private builder: BuilderAdapter,
    private readonly log: Log,
    private readonly notificationsEnabled = false,
    private readonly qaEnabled = true,
    private readonly qaMaxCycles = 3,
    private readonly projectDir?: string,
    private readonly qaReviewer?: BuilderAdapter,
    private readonly qaFactory?: (cwd: string, sessionId?: string) => Promise<BuilderAdapter>,
    private readonly qaSessionStrategy: SessionStrategy = "compact",
    private readonly builderFactory?: (cwd: string, sessionId?: string) => Promise<BuilderAdapter>,
    private readonly builderSessionStrategy: SessionStrategy = "compact",
    private readonly qaNonconvergence?: (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision>,
  ) {
    this.ticketsEnabled = !!(projectDir && isTicketsInitialized(projectDir));
  }

  /**
   * Send one instruction and resolve any needs_input exchanges before returning.
   * The returned result and status always reflect the final (non-needs_input) turn.
   */
  private async doTurn(
    instruction: string,
  ): Promise<{ result: TurnResult; status: StepStatus }> {
    return this.doTurnWith(this.builder, instruction);
  }

  private async prepareBuilderBoundary(): Promise<void> {
    if (!this.builderFactory || !this.projectDir) return;
    if (this.builderSessionStrategy === "fresh") {
      await this.builder.close(); this.builder = await this.builderFactory(this.projectDir);
      this.log.write("branch-session", { role: "builder", transition: "fresh", workSession: this.builderWorkSessions + 1 });
      return;
    }
    const priorSession = this.builder.sessionId();
    if (priorSession && this.builder.compact) {
      let error = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await this.builder.compact().catch((cause) => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
        if (result.ok) { this.log.write("branch-session", { role: "builder", transition: attempt === 1 ? "compacted" : "compaction-retry-succeeded", workSession: this.builderWorkSessions + 1, sessionId: priorSession }); return; }
        error = result.error ?? "native compaction failed";
        if (attempt === 1) this.log.write("branch-session", { role: "builder", transition: "compaction-retry", detail: error });
      }
      await this.builder.close(); this.builder = await this.builderFactory(this.projectDir);
      this.log.write("branch-session", { role: "builder", transition: "compaction-fallback-fresh", continuityLost: true, detail: error });
      return;
    }
    await this.builder.close(); this.builder = await this.builderFactory(this.projectDir);
    this.log.write("branch-session", { role: "builder", transition: "missing-session-fresh", continuityLost: true });
  }

  private async doTurnWith(
    adapter: BuilderAdapter,
    instruction: string,
  ): Promise<{ result: TurnResult; status: StepStatus }> {
    let result = await adapter.sendTurn(instruction);
    let status = parseStepStatus(result.text);
    if (status.kind === "unknown") {
      if (!status.error && looksLikeQuestion(result.text)) {
        status = { kind: "needs_input", question: lastLine(result.text), choices: ["Continue", "Cancel"] };
      } else {
        const qa = /\bQA\b|qa_pass|qa_fail/i.test(instruction);
        result = await adapter.sendTurn(qa
          ? "Protocol correction only: based on the review already completed, return exactly one final STEP_STATUS: qa_pass or STEP_STATUS: qa_fail marker. Do not repeat QA, tests, tools, or compaction."
          : "Protocol correction only: based on the work already completed, return exactly one final STEP_STATUS: done, plan_complete, blocked, or needs_input marker. Do not repeat implementation, tools, or compaction.");
        status = parseStepStatus(result.text);
        if (status.kind === "unknown") status = { ...status, error: `protocol correction exhausted: ${status.error ?? "missing final marker"}` };
      }
    }

    while (status.kind === "needs_input") {
      const question = status.question ?? "The builder has a question";
      const choices = status.choices?.length
        ? status.choices
        : ["Continue", "Cancel"];

      this.log.write("needs_input", { question, choices });

      if (this.notificationsEnabled) {
        fireNotification("Foreman needs your input", question);
      }

      console.log();
      const answer = await select({
        message: question,
        options: choices.map((c) => ({ value: c, label: c })),
      });
      console.log();

      if (isCancel(answer)) {
        result = { text: "", isError: false, numTurns: 0, costUsd: 0 };
        status = { kind: "blocked", reason: "user cancelled at input prompt" };
        break;
      }

      result = await adapter.sendTurn(String(answer));
      status = parseStepStatus(result.text);
    }

    return { result, status };
  }

  /** Send a planning turn and return the builder's response text. Does not count toward steps. */
  async runPreflight(n: number, ticketsContent?: string): Promise<string> {
    const instruction = buildPlanningTurn(n, ticketsContent);
    const result = await this.builder.sendTurn(instruction);
    this.log.write("preflight", {
      ticketsProvided: ticketsContent !== undefined,
      costUsd: result.costUsd,
      isError: result.isError,
    });
    if (result.isError) throw new Error(result.text);
    return result.text;
  }

  /** Send user feedback on the plan; builder responds with a revised list. Does not count toward steps. */
  async sendPreflightFeedback(feedback: string): Promise<void> {
    const result = await this.builder.sendTurn(feedback);
    this.log.write("preflight", { feedback: true, costUsd: result.costUsd, isError: result.isError });
    if (result.isError) throw new Error(result.text);
  }

  /** Send one custom instruction through the same needs_input loop as a batch turn. */
  async runInstruction(
    instruction: string,
  ): Promise<{ result: TurnResult; status: StepStatus }> {
    return this.doTurn(instruction);
  }

  /**
   * Run a QA review pass on the ticket the builder just completed.
   * Loops on qa_fail → fix → re-QA until qa_pass or the cycle cap is reached.
   * QA turns are free — they do not advance the step counter.
   */
  private async runQa(stepIndex: number): Promise<{
    outcome: "passed" | "blocked" | "needs-human" | "waived";
    detail?: string;
    summary?: string;
  }> {
    if (this.projectDir && this.qaFactory) {
      const review = await runIsolatedQa({
        ticket: this.ticketForQa(stepIndex),
        builderWorktree: this.projectDir,
        builderSummary: `Builder completed step ${stepIndex}`,
        qaStrategy: this.qaSessionStrategy,
        state: this.qaStream,
        createQa: this.qaFactory,
        maxCycles: this.qaMaxCycles,
        fix: async (issues) => {
          await this.prepareBuilderBoundary(); this.builderWorkSessions += 1;
          const fix = await this.doTurn(buildQaFixInstruction(issues));
          this.log.write("qa-fix", { stepIndex, statusKind: fix.status.kind, costUsd: fix.result.costUsd, isError: fix.result.isError });
          return fix.result.isError || fix.status.kind !== "done"
            ? { ok: false, detail: fix.status.reason ?? fix.status.error ?? fix.result.text.slice(0, 200) }
            : { ok: true };
        },
        evidence: ({ cycle, outcome, detail, qaDiff }) => this.log.write("qa", { stepIndex, cycle, outcome, detail, qaDiff, disposable: true }),
        onNonconvergence: this.qaNonconvergence,
      });
      if (review.outcome === "nonconverged") return { outcome: "needs-human", detail: review.detail };
      return { outcome: review.outcome, detail: review.detail, summary: review.summary };
    }
    for (let cycle = 1; cycle <= this.qaMaxCycles; cycle++) {
      const before = this.qaReviewer && this.projectDir ? fingerprintProtectedTree(this.projectDir) : undefined;
      const qa = await this.doTurnWith(this.qaReviewer ?? this.builder, buildQaInstruction());
      if (before && this.projectDir) {
        const changes = changedProtectedFiles(before, fingerprintProtectedTree(this.projectDir));
        if (changes.length > 0) {
          this.log.write("qa-protected-files-changed", { stepIndex, cycle, paths: changes });
          return { outcome: "needs-human", detail: `independent QA changed protected files: ${changes.join(", ")}` };
        }
      }
      this.log.write("qa", {
        stepIndex,
        cycle,
        statusKind: qa.status.kind,
        issues: qa.status.issues,
        costUsd: qa.result.costUsd,
        isError: qa.result.isError,
      });

      if (qa.result.isError) {
        return { outcome: "blocked", detail: `QA turn errored: ${qa.result.text.slice(0, 200)}` };
      }
      if (qa.status.kind === "qa_pass") {
        return { outcome: "passed", summary: qa.status.summary };
      }
      if (qa.status.kind === "blocked") {
        return { outcome: "blocked", detail: qa.status.reason ?? "QA reported blocked" };
      }
      if (qa.status.kind !== "qa_fail") {
        return {
          outcome: "needs-human",
          detail: qa.status.error ?? `QA turn did not emit a valid marker (got ${qa.status.kind})`,
        };
      }

      const fix = await this.doTurn(
        buildQaFixInstruction(qa.status.issues ?? "(no issues listed)"),
      );
      this.log.write("qa-fix", {
        stepIndex,
        cycle,
        statusKind: fix.status.kind,
        costUsd: fix.result.costUsd,
        isError: fix.result.isError,
      });

      if (fix.result.isError) {
        return { outcome: "blocked", detail: `QA fix turn errored: ${fix.result.text.slice(0, 200)}` };
      }
      if (fix.status.kind === "blocked") {
        return { outcome: "blocked", detail: fix.status.reason ?? "QA fix reported blocked" };
      }
      if (fix.status.kind !== "done") {
        return {
          outcome: "needs-human",
          detail: fix.status.error ?? `QA fix turn did not emit done (got ${fix.status.kind})`,
        };
      }
      // loop back into QA
    }
    return {
      outcome: "needs-human",
      detail: `QA could not converge after ${this.qaMaxCycles} cycles`,
    };
  }

  async runQaReview(stepIndex: number): Promise<{
    outcome: "passed" | "blocked" | "needs-human" | "waived";
    detail?: string;
    summary?: string;
  }> {
    return this.runQa(stepIndex);
  }

  qaSessionId(): string | undefined { return this.qaStream.sessionId ?? this.qaReviewer?.sessionId(); }
  builderSessionId(): string | undefined { return this.builder.sessionId(); }
  builderAdapter(): BuilderAdapter { return this.builder; }
  async close(): Promise<void> { await this.builder.close(); }

  private ticketForQa(stepIndex: number): TicketDef {
    if (this.projectDir && this.ticketsEnabled) {
      const config = loadTicketsConfig(this.projectDir);
      const active = cmdImplementationQueue(this.projectDir).find((row) => row.status === "next" || row.status === "in_progress");
      const ticket = loadTickets(join(this.projectDir, config.paths.tickets)).find((candidate) => candidate.id === active?.ticket);
      if (ticket) return ticket;
    }
    return {
      id: `STEP-${stepIndex}`, order: stepIndex, title: `Implementation step ${stepIndex}`, area: "project",
      priority: "P2", size: "M", risk: "Low", depends_on: [], summary: `Review implementation step ${stepIndex}`,
      acceptance: ["The requested implementation step is complete"], required_tests: ["Run the relevant project validation"], likely_files: [],
    };
  }

  async runBatch(n: number, trackerPath?: string): Promise<BatchResult> {
    this.log.write("batch-start", { requested: n, agent: this.builder.agent });
    let completed = 0;
    let outcome: BatchResult["outcome"] = "all-done";
    let detail: string | undefined;

    for (let i = 1; i <= n; i++) {
      // Determine which ticket we're about to work on (for in_progress marking)
      let pendingTicketId: string | undefined;
      if (this.ticketsEnabled && this.projectDir) {
        try {
          const queue = cmdImplementationQueue(this.projectDir);
          const next = queue.find((r) => r.status === "next");
          if (next) {
            pendingTicketId = next.ticket;
            cmdUpdate(this.projectDir, next.ticket, {
              status: "in_progress",
              actor: "foreman",
              summary: `Starting step ${i} of ${n}`,
            });
          }
        } catch (err) {
          outcome = "needs-human";
          detail = `failed to update ticket tracker before step ${i}: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }

      const instruction = i === 1
        ? buildPrimer(n, trackerPath, this.ticketsEnabled)
        : buildNextStepInstruction(i, n);
      if (i > 1) await this.prepareBuilderBoundary();
      this.builderWorkSessions += 1;
      const { result, status } = await this.doTurn(instruction);

      this.log.write("step", {
        index: i,
        statusKind: status.kind,
        summary: status.summary,
        next: status.next,
        reason: status.reason,
        ticket: status.ticket,
        costUsd: result.costUsd,
        isError: result.isError,
      });

      if (result.isError) {
        outcome = "blocked";
        detail = `builder turn errored: ${result.text.slice(0, 200)}`;
        break;
      }

      if (status.kind === "done" || status.kind === "plan_complete") {
        let qaSummary: string | undefined;
        let qaWaived = false;
        if (this.qaEnabled) {
          const qa = await this.runQa(i);
          if (qa.outcome === "blocked") {
            outcome = "blocked";
            detail = qa.detail;
            break;
          }
          if (qa.outcome === "needs-human") {
            outcome = "needs-human";
            detail = qa.detail;
            break;
          }
          qaWaived = qa.outcome === "waived";
          qaSummary = qa.summary;
        }

        // Update ticket state only after QA has passed, so generated tracker
        // state does not claim done before verification has completed.
        if (this.ticketsEnabled && this.projectDir) {
          const ticketId = status.ticket ?? pendingTicketId;
          if (ticketId) {
            try {
              cmdComplete(this.projectDir, ticketId, {
                actor: "foreman",
                summary: status.summary ?? `Step ${i} complete`,
                validationResult: qaWaived ? "failed" : this.qaEnabled ? "passed" : "not_applicable",
                validationNotes: this.qaEnabled
                  ? qaWaived ? "User explicitly waived unresolved QA failures" : "Foreman QA emitted qa_pass"
                  : "Foreman QA disabled for this run",
                evidence: this.qaEnabled
                  ? (qaSummary ?? (qaWaived ? "Unresolved QA issues preserved in run evidence" : "Foreman QA emitted qa_pass"))
                  : undefined,
              });
            } catch (err) {
              outcome = "needs-human";
              detail = `failed to complete ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`;
              break;
            }
          }
        }
        completed++;
        if (status.kind === "plan_complete") {
          outcome = "plan-complete";
          detail = status.summary;
          break;
        }
        continue;
      }

      if (status.kind === "blocked") {
        // Mark ticket blocked in the tracker
        if (this.ticketsEnabled && this.projectDir) {
          const ticketId = status.ticket ?? pendingTicketId;
          if (ticketId) {
            try {
              cmdBlock(this.projectDir, ticketId, {
                summary: status.reason ?? "builder reported blocked",
                actor: "foreman",
              });
            } catch (err) {
              detail =
                `${status.reason ?? "builder reported blocked"}; failed to update ticket tracker: ` +
                `${err instanceof Error ? err.message : String(err)}`;
            }
          }
        }
        outcome = "blocked";
        detail = detail ?? status.reason ?? "builder reported blocked";
        break;
      }

      // No marker: treat as a blocker so we never loop blindly.
      outcome = "needs-human";
      detail = status.error
        ? status.error
        : looksLikeQuestion(result.text)
        ? `builder ended with a question: ${lastLine(result.text)}`
        : "builder did not emit a STEP_STATUS marker";
      break;
    }

    this.log.write("batch-end", { completed, requested: n, outcome, detail, sessionId: this.builder.sessionId() });
    return { completed, requested: n, outcome, detail };
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").slice(0, 200);
}

function fingerprintProtectedTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const ignored = new Set([".git", "node_modules", "dist", "coverage"]);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (
          ignored.has(entry.name)
          || rel === ".foreman"
          || rel.startsWith(".foreman/")
          || rel === ".rafi/cache"
          || rel.startsWith(".rafi/cache/")
        ) continue;
        visit(path);
      } else if (entry.isFile() && statSync(path).size <= 10 * 1024 * 1024) {
        out.set(rel, createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

function changedProtectedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}
