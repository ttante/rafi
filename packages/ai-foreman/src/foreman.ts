import { buildScopeRevision } from "./buildApproval.js";
import { durableHumanDecision, HumanDecisionRequired } from "./humanDecision.js";
import { select, text, isCancel } from "@clack/prompts";
import { MARKER_SPEC, QA_MARKER_SPEC } from "./markers.js";
import type {
  BuilderAdapter,
  CompactResult,
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
  TurnResult,
} from "./adapters/types.js";
import type { PermissionPolicy } from "./permissions/policy.js";
import { countProviderQuestions, handleProviderQuestionTool, type AnsweredProviderQuestion } from "./providerQuestions.js";
import type { Log } from "./log.js";
import { bestEffortDiagnostic } from "./questionTrace.js";
import { signalAttention } from "./notify.js";
import { pauseActivityForInput } from "./activity.js";
import { isTicketsInitialized, loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { StateDb } from "./tickets/stateDb.js";
import { cmdUpdate, cmdComplete, cmdBlock, cmdUnblock, cmdImplementationQueue } from "./tickets/commands.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { beginQaFinalization, completeQaFinalization, verifyPendingQaFinalizationSource, runIsolatedQa, type QaNonconvergenceContext, type QaNonconvergenceDecision, type QaReportRecoveryHandler, type QaSessionBoundaryRecovery, type QaSessionBoundaryResult, type QaSessionHandle, type QaStreamState } from "./qaReview.js";
import { QaFailureDeliveryService } from "./qaFailureDelivery.js";
import { generatedTrackerDirtyPaths } from "./branch/git.js";
import type { SessionStrategy } from "rafi-spec";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SessionUnavailableError, sessionUnavailableErrorFromFailure } from "./adapters/sessionFailure.js";
import type { RunObserver } from "./observability.js";
import type { QaRecoveryPacket } from "./qaRecovery.js";
import { WorkflowDb } from "./workflowDb.js";

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
  const markerLines = text.split(/\r?\n/).filter((line) => /^\s*STEP_STATUS:/.test(line));
  const markerCount = markerLines.length;
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
export function buildPrimer(n: number, trackerPath?: string, ticketsEnabled = false, preferredTicketId?: string): string {
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
  const preferredTicketRule = preferredTicketId
    ? `\n- Resume and finish ticket ${preferredTicketId} first. Do not substitute a different queued ticket.`
    : "";
  return `You are being run by an automated foreman. We will work through your next ${n} tickets or implementation steps, one per turn.

Rules:
- Do exactly ONE ticket or step this turn, then stop.
- ${MARKER_SPEC}
- If a tool action is denied by foreman policy, do not retry it; report it via the blocked marker.${trackerRule}${preferredTicketRule}

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
If anything is off, return the required RAFI_QA_FAILURE_REPORT_START/RAFI_QA_FAILURE_REPORT_END JSON envelope immediately before STEP_STATUS: qa_fail. The report must contain every check, every blocking finding, and all nonblocking observations. Do NOT fix issues on this turn — just report them. Foreman will instruct the Builder to fix them next.

${QA_MARKER_SPEC}`;
}

/** Follow-up turn after qa_fail: have the builder implement the listed fixes. */
export function buildQaFixInstruction(issues: string): string {
  return `Your QA found these issues:

${issues}

Fix every one of them now. Then end with STEP_STATUS: done so foreman can re-run QA on the fixes. Triple-check that your fixes actually resolve the issues before emitting done.`;
}

/** Pre-flight planning turn: ask the builder to list its next N steps without implementing anything. */
export function buildPlanningTurn(n: number, ticketsContent?: string, preferredTicketId?: string): string {
  const header = ticketsContent
    ? `Here is the project's ticket list:\n\n${ticketsContent}\n\n`
    : "";
  const preferred = preferredTicketId
    ? ` The first item must be ticket ${preferredTicketId}; this is an interrupted ticket being resumed.`
    : "";
  return `${header}Before we begin, list the next ${n} ticket(s) or step(s) you plan to implement, in order.${preferred} Be specific — reference ticket IDs or titles where applicable. Do not implement anything yet; output the numbered list only. Do not emit a STEP_STATUS marker on this turn.`;
}

/** Builds the permission callback: classify, log, allow or escalate. */
export function createPermissionHandler(
  policy: PermissionPolicy,
  log: Log,
  opts: {
    interactive?: boolean;
    durable?: () => { projectDir: string; runId: string; ticketId?: string };
    onAnsweredQuestion?: (event: AnsweredProviderQuestion) => void;
    onProviderQuestion?: (request: PermissionRequest) => void;
  } = {},
): PermissionHandler {
  return async (req: PermissionRequest): Promise<PermissionDecision> => {
    if (req.toolName === "AskUserQuestion") opts.onProviderQuestion?.(req);
    const providerQuestion = await handleProviderQuestionTool(req, {
      interactive: opts.interactive ?? true,
      durable: opts.durable?.(),
      onAnsweredQuestion: opts.onAnsweredQuestion,
    });
    if (providerQuestion) {
      bestEffortDiagnostic(() => log.write("permission", {
        tool: req.toolName,
        decision: providerQuestion.behavior,
        reason: "provider question prompt",
        questionCount: countProviderQuestions(req.input),
      }));
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

export interface ForemanNotificationOptions {
  desktop: boolean;
  terminalBell: boolean;
}

/** Drives one builder through a batch of N steps via the STEP_STATUS protocol. */
export class Foreman {
  private readonly ticketsEnabled: boolean;
  private readonly notificationsEnabled: boolean;
  private readonly terminalBellEnabled: boolean;
  private readonly qaStream: QaStreamState = { reviews: 0, modificationViolations: 0 };
  private builderWorkSessions = 0;
  private currentTicketId?: string;

  constructor(
    private builder: BuilderAdapter,
    private readonly log: Log,
    notifications: boolean | ForemanNotificationOptions = false,
    private readonly qaEnabled = true,
    private readonly qaMaxCycles = 3,
    private readonly projectDir?: string,
    /** @deprecated QA must be created by qaFactory in a disposable snapshot. */
    _deprecatedSameSessionReviewer?: BuilderAdapter,
    private readonly qaFactory?: (cwd: string, sessionId?: string) => Promise<QaSessionHandle>,
    private readonly qaSessionStrategy: SessionStrategy = "compact",
    private readonly builderFactory?: (cwd: string, sessionId?: string) => Promise<BuilderAdapter>,
    private readonly builderSessionStrategy: SessionStrategy = "compact",
    private readonly qaNonconvergence?: (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision>,
    private readonly beforeBuilderTurn?: (adapter: BuilderAdapter, frozenAction: string) => Promise<BuilderAdapter>,
    private readonly builderSessionBoundary?: (adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy) => Promise<BuilderAdapter>,
    private readonly qaSessionBoundary?: (handle: QaSessionHandle, frozenAction: string, strategy: SessionStrategy, cwd: string, recovery?: QaSessionBoundaryRecovery) => Promise<QaSessionBoundaryResult>,
    private readonly observeQaNativeCompactions?: (adapter: BuilderAdapter) => Promise<void>,
    /** Persist a Builder's provider-native event immediately after every turn. */
    private readonly observeBuilderNativeCompactions?: (adapter: BuilderAdapter) => Promise<void>,
    private readonly observer?: RunObserver,
    private readonly qaRuntimeContext?: unknown,
    private readonly qaContinuityManaged = false,
    private readonly qaReportRecovery?: QaReportRecoveryHandler,
    private qaResumedRecovery?: QaRecoveryPacket,
    /** Exact durable build-run scope. Observability is never an identity authority. */
    private readonly qaRunId: string = `qa-${randomUUID()}`,
    private readonly continueIndependentTickets = true,
    initialTicketId?: string,
  ) {
    void _deprecatedSameSessionReviewer;
    this.currentTicketId = initialTicketId;
    this.notificationsEnabled = typeof notifications === "boolean" ? notifications : notifications.desktop;
    this.terminalBellEnabled = typeof notifications === "boolean" ? true : notifications.terminalBell;
    this.ticketsEnabled = !!(projectDir && isTicketsInitialized(projectDir));
  }

  private async waitForUserInput<T>(operation: () => Promise<T>): Promise<T> {
    const paused = () => pauseActivityForInput(operation);
    if (!this.observer) return paused();
    return this.observer.withContext({ role: "builder", stream: "user-input" }, async () => {
      const spanId = this.observer!.store.startSpan(this.observer!.context(), { kind: "user_wait", name: "Builder input prompt" });
      try {
        const value = await paused();
        this.observer!.store.finishSpan(spanId, { outcome: value === undefined ? "paused" : "answered" });
        return value;
      } catch (error) {
        this.observer!.store.finishSpan(spanId, { outcome: "error" });
        throw error;
      }
    });
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

  private async prepareBuilderBoundary(frozenAction: string): Promise<void> {
    if (!this.builderFactory || !this.projectDir) return;
    if (this.builderSessionBoundary) {
      this.builder = await this.builderSessionBoundary(this.builder, frozenAction, this.builderSessionStrategy);
      this.log.write("branch-session", { role: "builder", transition: this.builderSessionStrategy === "fresh" ? "validated-handoff" : "accounted-compaction", workSession: this.builderWorkSessions + 1, sessionId: this.builder.sessionId() });
      return;
    }
    if (this.builderSessionStrategy === "fresh") {
      await this.builder.close(); this.builder = await this.builderFactory(this.projectDir);
      this.log.write("branch-session", { role: "builder", transition: "fresh", workSession: this.builderWorkSessions + 1 });
      return;
    }
    const priorSession = this.builder.sessionId();
    if (priorSession && this.builder.compact) {
      let error = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        let result: CompactResult;
        try { result = await this.builder.compact(); }
        catch (cause) {
          if (cause instanceof SessionUnavailableError) throw cause;
          result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
        if (result.failure?.category === "session-unavailable") throw sessionUnavailableErrorFromFailure(result.failure);
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
    mode: "builder" | "qa" = "builder",
  ): Promise<{ result: TurnResult; status: StepStatus }> {
    const ticket = mode === "builder" ? this.currentTicketId : undefined;
    const scopedInstruction = (text: string): string => !ticket || text.includes(`Ticket scope: ${ticket}.`) ? text
      : `${text}\nTicket scope: ${ticket}. Do not substitute another ticket. Include ticket="${ticket}" in any STEP_STATUS marker.`;
    instruction = scopedInstruction(instruction);
    const send = (text: string, policy?: Parameters<BuilderAdapter["sendTurn"]>[1]) => adapter.sendTurn(scopedInstruction(text), policy);
    if (adapter === this.builder && this.beforeBuilderTurn) {
      this.builder = await this.beforeBuilderTurn(this.builder, instruction);
      adapter = this.builder;
    }
    const turnPolicy = { logicalActionId: this.currentTicketId ?? createHash("sha256").update(instruction).digest("hex") };
    let result = await send(instruction, turnPolicy);
    await this.observeBuilderNative(adapter);
    let status = parseStepStatus(result.text);
    if (result.isError || result.failure) return { result: { ...result, isError: true }, status };
    if (status.kind === "unknown") {
      if (!status.error && looksLikeQuestion(result.text)) {
        status = { kind: "needs_input", question: lastLine(result.text), choices: ["Continue", "Cancel"] };
      } else {
        if (adapter === this.builder && this.beforeBuilderTurn) {
          this.builder = await this.beforeBuilderTurn(this.builder, instruction);
          adapter = this.builder;
        }
        if (this.projectDir) {
          const budget = new WorkflowDb(this.projectDir);
          try {
            if (!budget.reserveRecoveryAllowance(this.qaRunId, turnPolicy.logicalActionId, "protocol-correction", budget.autonomyPolicy(this.qaRunId)?.limits.protocolCorrections ?? 1)) return { result, status: { kind: "blocked", reason: "shared protocol correction budget exhausted" } };
          } finally { budget.close(); }
        }
        result = await send(mode === "qa"
          ? "Protocol correction only: based on the review already completed, return exactly one final STEP_STATUS: qa_pass or STEP_STATUS: qa_fail marker. Do not repeat QA, tests, tools, or compaction."
          : "Protocol correction only: based on the work already completed, return exactly one final STEP_STATUS: done, plan_complete, blocked, or needs_input marker. Do not repeat implementation, tools, or compaction.", { ...turnPolicy, responseOnly: true });
        await this.observeBuilderNative(adapter);
        if (result.isError || result.failure) return { result: { ...result, isError: true }, status: { kind: "blocked", reason: result.text } };
        status = parseStepStatus(result.text);
        if (status.kind === "unknown") status = { ...status, error: `protocol correction exhausted: ${status.error ?? "missing final marker"}` };
      }
    }

    let blockerExplanations = 0;
    while (true) {
      while (status.kind === "needs_input") {
        const question = status.question ?? "The builder has a question";
        const choices = status.choices?.length ? status.choices : ["Continue"];
        this.log.write("needs_input", { question, choices });
        signalAttention("Foreman needs your input", question, this.notificationsEnabled, this.terminalBellEnabled);

        const prompt = async () => this.waitForUserInput(async () => {
          console.log();
          const selected = await select<string>({
            message: question,
            options: [
              ...choices.map((choice) => ({ value: choice, label: choice })),
              { value: "__rafi_custom__", label: "Custom response", hint: "Type a different answer" },
              { value: "__rafi_pause__", label: "Pause safely", hint: "Keep the run recoverable and return to the terminal" },
            ],
          });
          if (isCancel(selected) || selected === "__rafi_pause__") return undefined;
          if (selected !== "__rafi_custom__") return selected;
          const custom = await text({ message: "Custom response:", validate: (value) => String(value ?? "").trim() ? undefined : "Enter a response" });
          return isCancel(custom) ? undefined : String(custom);
        });
        if (!this.projectDir && (!process.stdin.isTTY || !process.stdout.isTTY)) {
          status = { kind: "blocked", reason: `input required in an interactive terminal: ${question}` };
          break;
        }
        let answer: string | undefined;
        try {
          answer = this.projectDir ? await durableHumanDecision({ projectDir: this.projectDir, runId: this.qaRunId, key: `builder:${this.currentTicketId ?? "step"}:${buildScopeRevision(this.projectDir)}`, ticketId: this.currentTicketId,
            prompt: question, choices: [...choices.map(choice => ({ id: choice, label: choice })), { id: "custom", label: "Custom response" }],
            defer: Boolean(this.currentTicketId && this.continueIndependentTickets), operation: prompt }) : await prompt();
        } catch (error) {
          if (!(error instanceof HumanDecisionRequired)) throw error;
          status = { kind: "blocked", reason: error.message };
          break;
        }
        console.log();

        if (answer === undefined) {
          result = { text: "", isError: false, numTurns: 0, costUsd: 0 };
          status = { kind: "blocked", reason: "user chose safe pause at an input prompt" };
          break;
        }

        if (adapter === this.builder && this.beforeBuilderTurn) {
          this.builder = await this.beforeBuilderTurn(this.builder, scopedInstruction(answer));
          adapter = this.builder;
        }
        result = await send(answer, turnPolicy);
        await this.observeBuilderNative(adapter);
        if (result.isError || result.failure) return { result: { ...result, isError: true }, status: { kind: "blocked", reason: result.text } };
        status = parseStepStatus(result.text);
      }

      if (status.kind !== "blocked" || (status.reason?.startsWith("user chose safe pause") || status.reason?.includes("Rafi is waiting for input")) || !process.stdin.isTTY || !process.stdout.isTTY) break;

      if (blockerExplanations++ >= 1) break;
      if (this.projectDir) {
        const budget = new WorkflowDb(this.projectDir);
        try { if (!budget.reserveRecoveryAllowance(this.qaRunId, this.currentTicketId ?? "instruction", "blocker-explanation", 1)) break; }
        finally { budget.close(); }
      }
      const reason = status.reason ?? "the agent reported an unspecified blocker";
      this.log.write("blocked-recovery", { reason, role: adapter === this.builder ? "builder" : "qa" });
      const recoveryInstruction = buildBlockerRecoveryInstruction(reason);
      if (adapter === this.builder && this.beforeBuilderTurn) {
        this.builder = await this.beforeBuilderTurn(this.builder, scopedInstruction(recoveryInstruction));
        adapter = this.builder;
      }
      result = await send(recoveryInstruction, turnPolicy);
      await this.observeBuilderNative(adapter);
      if (result.isError || result.failure) return { result: { ...result, isError: true }, status: { kind: "blocked", reason: result.text } };
      status = parseStepStatus(result.text);
      if (status.kind === "unknown") {
        if (this.projectDir && this.qaRunId) {
          const budget = new WorkflowDb(this.projectDir);
          try {
            if (!budget.reserveRecoveryAllowance(this.qaRunId, turnPolicy.logicalActionId, "protocol-correction", budget.autonomyPolicy(this.qaRunId)?.limits.protocolCorrections ?? 1)) break;
          } finally { budget.close(); }
        }
        result = await send('Protocol correction only: return the blocker approaches now using exactly one final STEP_STATUS: needs_input marker with question="..." and choices="recommended (Recommended)|alternative|alternative". Do not repeat tools or implementation.', { ...turnPolicy, responseOnly: true });
        await this.observeBuilderNative(adapter);
        if (result.isError || result.failure) return { result: { ...result, isError: true }, status: { kind: "blocked", reason: result.text } };
        status = parseStepStatus(result.text);
      }
    }

    return { result, status };
  }

  /** Send a planning turn and return the builder's response text. Does not count toward steps. */
  async runPreflight(n: number, ticketsContent?: string, preferredTicketId?: string, executionTickets?: readonly string[]): Promise<string> {
    const instruction = buildPlanningTurn(n, ticketsContent, preferredTicketId) + (executionTickets ? `\nAuthorized ticket scope: ${executionTickets.join(", ")}. Plan only these tickets. Tickets awaiting answers are not eligible for implementation.` : "");
    if (this.beforeBuilderTurn) this.builder = await this.beforeBuilderTurn(this.builder, instruction);
    const result = await this.builder.sendTurn(instruction);
    await this.observeBuilderNative(this.builder);
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
    if (this.beforeBuilderTurn) this.builder = await this.beforeBuilderTurn(this.builder, feedback);
    const result = await this.builder.sendTurn(feedback);
    await this.observeBuilderNative(this.builder);
    this.log.write("preflight", { feedback: true, costUsd: result.costUsd, isError: result.isError });
    if (result.isError) throw new Error(result.text);
  }

  /** Send one custom instruction through the same needs_input loop as a batch turn. */
  async runInstruction(
    instruction: string,
  ): Promise<{ result: TurnResult; status: StepStatus }> {
    return this.doTurn(instruction);
  }

  /** Ask an already-active role session to propose choices for its reported blocker. */
  async resolveBlocker(
    adapter: BuilderAdapter,
    reason: string,
    mode: "builder" | "qa" = "builder",
  ): Promise<{ result: TurnResult; status: StepStatus }> {
    return this.doTurnWith(adapter, buildBlockerRecoveryInstruction(reason), mode);
  }

  private async observeBuilderNative(adapter: BuilderAdapter): Promise<void> {
    if (adapter === this.builder) await this.observeBuilderNativeCompactions?.(adapter);
  }

  /**
   * Run a QA review pass on the ticket the builder just completed.
   * Loops on qa_fail → fix → re-QA until qa_pass or the cycle cap is reached.
   * QA turns are free — they do not advance the step counter.
   */
  private async runQa(stepIndex: number, ticketId?: string, builderResult?: string): Promise<{
    outcome: "passed" | "blocked" | "needs-human" | "waived";
    detail?: string;
    summary?: string;
    passCertificateId?: string;
    sourceStateDigest?: string;
  }> {
    if (this.projectDir && this.qaFactory) {
      const resumedRecovery = this.qaResumedRecovery;
      const review = await runIsolatedQa({
        ticket: this.ticketForQa(stepIndex, ticketId),
        builderWorktree: this.projectDir,
        builderSummary: builderResult ?? "Builder result unavailable at this explicit QA-only API boundary",
        qaStrategy: this.qaSessionStrategy,
        state: this.qaStream,
        createQa: this.qaFactory,
        sessionBoundary: this.qaSessionBoundary ?? (async () => { throw new Error("QA recovery requires a validated durable session boundary"); }),
        observeNativeCompactions: this.observeQaNativeCompactions,
        maxCycles: this.qaMaxCycles,
        recovery: { projectDir: this.projectDir, runId: this.qaRunId },
        observer: this.observer,
        qaRuntimeContext: this.qaRuntimeContext,
        continuityManaged: this.qaContinuityManaged,
        onReportRecovery: this.qaReportRecovery,
        resumedRecovery,
        deliverFailure: async (request) => {
          this.builderWorkSessions += 1;
          const delivery = new QaFailureDeliveryService();
          const result = await delivery.deliver(request, {
            adapter: () => this.builder,
            setAdapter: (adapter) => { this.builder = adapter; },
            sessionStrategy: this.builderSessionStrategy,
            prepareBoundary: async (_adapter, instruction) => { await this.prepareBuilderBoundary(instruction); return this.builder; },
            beforeTurn: async (adapter, instruction) => this.beforeBuilderTurn ? this.beforeBuilderTurn(adapter, instruction) : adapter,
            recordSession: (session) => {
              const sessionId = typeof session === "string" ? session : session.sessionId;
              this.log.write("qa-fix", { stepIndex, sessionId });
            },
          });
          this.log.write("qa-fix", { stepIndex, ok: result.ok, outcome: result.outcome, turnRecordId: result.turnRecordId, detail: result.detail, providerTurnId: result.providerTurnId, handoffId: result.handoffId, operationId: result.operationId });
          return result;
        },
        evidence: ({ cycle, outcome, detail, qaDiff }) => this.log.write("qa", { stepIndex, cycle, outcome, detail, qaDiff, disposable: true }),
        onNonconvergence: this.qaNonconvergence,
        resolveBlocked: (adapter, reason) => this.resolveBlocker(adapter, reason, "qa"),
      });
      if (resumedRecovery) {
        const recoveryDb = new WorkflowDb(this.projectDir);
        try { if (recoveryDb.qaRecoveryHead(resumedRecovery.manifest.runId, resumedRecovery.manifest.ticketId)?.pendingAction === "resolved") this.qaResumedRecovery = undefined; }
        finally { recoveryDb.close(); }
      }
      if (review.outcome === "nonconverged") return { outcome: "needs-human", detail: review.detail };
      return { outcome: review.outcome, detail: review.detail, summary: review.summary, passCertificateId: review.passCertificateId, sourceStateDigest: review.sourceStateDigest };
    }
    return {
      outcome: "needs-human",
      detail: "QA is enabled but no fresh disposable QA factory and durable session boundary were configured",
    };
  }

  async runQaReview(stepIndex: number, builderResult: string): Promise<{
    outcome: "passed" | "blocked" | "needs-human" | "waived";
    detail?: string;
    summary?: string;
  }> {
    return this.runQa(stepIndex, undefined, builderResult);
  }

  /** Resume an already-built ticket at the QA boundary without dispatching Builder preflight/work. */
  async runPendingQaRecovery(ticketId: string, builderResult: string): Promise<{
    outcome: "passed" | "blocked" | "needs-human" | "waived";
    detail?: string;
    summary?: string;
    passCertificateId?: string;
    sourceStateDigest?: string;
  }> {
    if (this.qaResumedRecovery && this.qaResumedRecovery.manifest.ticketId !== ticketId) throw new Error(`pending QA recovery belongs to ${this.qaResumedRecovery.manifest.ticketId}, not ${ticketId}`);
    return this.runQa(1, ticketId, builderResult);
  }

  /** Complete only the pending QA boundary and its tracker transition. No Builder work turn is sent. */
  async completePendingQaRecovery(ticketId: string): Promise<{
    outcome: "passed" | "blocked" | "needs-human" | "waived";
    detail?: string;
  }> {
    if (!this.projectDir || !this.ticketsEnabled) throw new Error("pending QA recovery requires an initialized ticket project");
    const qa = await this.runPendingQaRecovery(ticketId, "Resuming the exact durable QA failure/review boundary; no new Builder work was dispatched.");
    if (qa.outcome !== "passed" && qa.outcome !== "waived") return qa;
    if (qa.outcome === "passed") {
      if (!qa.passCertificateId || !qa.sourceStateDigest) throw new Error("QA passed without a durable pass certificate");
      await beginQaFinalization(this.projectDir, this.projectDir, this.qaRunId, ticketId, qa.passCertificateId, qa.sourceStateDigest, `ticket-complete:${ticketId}`, generatedTrackerDirtyPaths(loadTicketsConfig(this.projectDir).paths));
    }
    cmdComplete(this.projectDir, ticketId, {
      actor: "foreman",
      summary: qa.summary ?? "Completed after exact QA recovery",
      validationResult: qa.outcome === "waived" ? "failed" : "passed",
      validationNotes: qa.outcome === "waived" ? "User explicitly waived unresolved QA failures" : "Durable QA recovery emitted qa_pass",
      evidence: qa.summary ?? (qa.outcome === "waived" ? "Unresolved QA issues preserved in durable run evidence" : "Durable QA recovery emitted qa_pass"),
    });
    if (qa.outcome === "passed") completeQaFinalization(this.projectDir, this.qaRunId, ticketId);
    return qa;
  }

  /** Reconcile a crash between certificate consumption, tracker completion, and the final receipt. */
  async completePendingQaFinalization(ticketId: string): Promise<void> {
    if (!this.projectDir || !this.ticketsEnabled) throw new Error("pending QA finalization requires an initialized ticket project");
    const protocol = new WorkflowDb(this.projectDir);
    try {
      if (protocol.qaTicketHead(this.qaRunId, ticketId).state !== "finalizing") throw new Error(`QA finalization is not pending for ${ticketId}`);
    } finally { protocol.close(); }
    const paths = resolveTicketPaths(loadTicketsConfig(this.projectDir), this.projectDir);
    const stateDb = new StateDb(paths.stateDb);
    const alreadyDone = stateDb.getState(ticketId)?.status === "done";
    stateDb.close();
    await verifyPendingQaFinalizationSource(this.projectDir, this.projectDir, this.qaRunId, ticketId, alreadyDone);
    if (!alreadyDone) {
      cmdComplete(this.projectDir, ticketId, {
        actor: "foreman", summary: "Completed after reconciling durable QA finalization",
        validationResult: "passed", validationNotes: "Pass certificate was consumed before the interrupted tracker transition",
        evidence: "Durable QA pass certificate and finalization intent reconciled after restart",
      });
    }
    completeQaFinalization(this.projectDir, this.qaRunId, ticketId);
  }

  qaSessionId(): string | undefined { return this.qaStream.sessionId; }
  qaSessionRef(): import("rafi-spec").ProviderSessionRefV1 | undefined { return this.qaStream.sessionRef; }
  builderSessionId(): string | undefined { return this.builder.sessionId(); }
  builderAdapter(): BuilderAdapter { return this.builder; }
  async close(): Promise<void> { await this.builder.close(); }

  private ticketForQa(stepIndex: number, ticketId?: string): TicketDef {
    if (this.projectDir && this.ticketsEnabled) {
      const config = loadTicketsConfig(this.projectDir);
      const active = ticketId
        ? { ticket: ticketId }
        : cmdImplementationQueue(this.projectDir).find((row) => row.status === "next" || row.status === "in_progress");
      const ticket = loadTickets(join(this.projectDir, config.paths.tickets)).find((candidate) => candidate.id === active?.ticket);
      if (ticket) return ticket;
    }
    return {
      id: `STEP-${stepIndex}`, order: stepIndex, title: `Implementation step ${stepIndex}`, area: "project",
      priority: "P2", size: "M", risk: "Low", depends_on: [], summary: `Review implementation step ${stepIndex}`,
      acceptance: ["The requested implementation step is complete"], required_tests: ["Run the relevant project validation"], likely_files: [],
    };
  }

  async runBatch(
    n: number,
    trackerPath?: string,
    onTicketStart?: (ticketId: string) => void | Promise<void>,
    preferredTicketId?: string,
    recoveryTickets?: readonly string[],
  ): Promise<BatchResult> {
    this.log.write("batch-start", { requested: n, agent: this.builder.agent });
    let completed = 0;
    let outcome: BatchResult["outcome"] = "all-done";
    let detail: string | undefined;
    const deferred = new Set<string>();

    for (let i = 1; completed < n; i++) {
      const decisionRevision = this.projectDir ? buildScopeRevision(this.projectDir) : "";
      const decisions = this.projectDir ? (() => {
        const db = new WorkflowDb(this.projectDir!);
        try {
          const revision = decisionRevision;
          db.refreshStaleTicketDecisions(this.qaRunId, revision, recoveryTickets);
          return { answered: db.answeredTicketDecisions(this.qaRunId, revision), pending: db.pendingHumanDecisions(this.qaRunId) };
        } finally { db.close(); }
      })() : { answered: [], pending: [] };
      const answered = decisions.answered.filter(decision => !recoveryTickets || recoveryTickets.includes(decision.interruptionId.slice(7)));
      if (decisions.pending.some(decision => !decision.interruptionId.startsWith("ticket:"))) {
        outcome = "needs-human"; detail = "Rafi is waiting for an answer to a build-wide question"; break;
      }
      const waiting = new Set(decisions.pending.map(decision => decision.interruptionId.slice(7)));
      for (const ticket of waiting) if (!recoveryTickets || recoveryTickets.includes(ticket)) deferred.add(ticket);
      if (waiting.size && !this.continueIndependentTickets) { outcome = "needs-human"; detail = "Rafi is waiting for ticket answers"; break; }
      // Determine which ticket we're about to work on (for in_progress marking)
      let pendingTicketId: string | undefined;
      if (this.ticketsEnabled && this.projectDir) {
        try {
          const queue = cmdImplementationQueue(this.projectDir).filter(row => !recoveryTickets || recoveryTickets.includes(row.ticket));
          const preferred = i === 1 && preferredTicketId ? queue.find(row => row.ticket === preferredTicketId) : undefined;
          const canAnswer = (ticket: string) => answered.some(decision => decision.interruptionId === `ticket:${ticket}`);
          if (preferred && preferred.blockedBy !== "None") deferred.add(preferred.ticket);
          const next = preferred && preferred.blockedBy === "None" && !waiting.has(preferred.ticket) ? preferred
            : queue.find(row => row.blockedBy === "None" && !waiting.has(row.ticket) && (!deferred.has(row.ticket) || canAnswer(row.ticket)) && (row.status === "next" || (row.status === "blocked" && canAnswer(row.ticket))));
          if (i === 1 && preferredTicketId && !preferred && !next) {
            outcome = "needs-human";
            detail = `recovery ticket ${preferredTicketId} is no longer available in the implementation queue`;
            break;
          }
          if (!next && (recoveryTickets || deferred.size)) break;
          if (next && next.status !== "next" && next.status !== "in_progress" && next.status !== "blocked") {
            outcome = "needs-human"; detail = `recovery ticket ${next.ticket} cannot resume while its status is ${next.status}`; break;
          }
          if (next) {
            pendingTicketId = next.ticket;
            await onTicketStart?.(next.ticket);
            // Approval/feedback can change definitions while selection is awaiting it.
            if (decisionRevision !== buildScopeRevision(this.projectDir)) { i--; continue; }
            const boundaryDb = new WorkflowDb(this.projectDir);
            try {
              const pending = boundaryDb.pendingHumanDecisions(this.qaRunId);
              if (pending.some(decision => !decision.interruptionId.startsWith("ticket:") || decision.interruptionId === `ticket:${next.ticket}`)) {
                i--; continue;
              }
            } finally { boundaryDb.close(); }
            const latest = cmdImplementationQueue(this.projectDir).find(row => row.ticket === next.ticket);
            if (!latest || latest.status !== next.status || latest.blockedBy !== "None") { i--; continue; }
            if (next.status === "blocked") cmdUnblock(this.projectDir, next.ticket, { actor: "foreman", summary: canAnswer(next.ticket) ? "Scoped question answered" : "Reopened by build recovery" });
            deferred.delete(next.ticket);
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

      this.currentTicketId = pendingTicketId;
      let instruction = i === 1
        ? buildPrimer(n, trackerPath, this.ticketsEnabled, pendingTicketId)
        : buildNextStepInstruction(i, n);
      if (pendingTicketId) instruction += `\n\nAssigned ticket: ${pendingTicketId}. Implement exactly this ticket. Do not substitute another ticket. End with ticket="${pendingTicketId}" in the STEP_STATUS marker.`;
      const continuations = answered.filter(decision => decision.interruptionId === `ticket:${pendingTicketId}`);
      if (continuations.length) {
        instruction += "\n\nScoped answers authorizing this ticket continuation:\n" + continuations.map(decision => `${decision.prompt}\nAnswer: ${decision.answer ?? decision.selectedChoiceId}`).join("\n");
        const db = new WorkflowDb(this.projectDir!);
        try {
          db.atomic(() => {
            for (const decision of continuations) {
              const key = `decision-continuation:${decision.decisionId}`;
              db.planOperation({ runId: this.qaRunId, idempotencyKey: key, kind: "decision-continuation", intent: { decisionId: decision.decisionId, ticketId: pendingTicketId } });
              db.updateOperation(key, "in_progress");
            }
          });
        } finally { db.close(); }
      }
      if (i > 1) await this.prepareBuilderBoundary(instruction);
      this.builderWorkSessions += 1;
      const turn = () => this.doTurn(instruction);
      const { result, status } = this.observer
        ? await this.observer.withContext({ role: "builder", stream: "builder", ticketId: pendingTicketId }, turn)
        : await turn();

      if (continuations.length) {
        const db = new WorkflowDb(this.projectDir!);
        try { for (const decision of continuations) db.updateOperation(`decision-continuation:${decision.decisionId}`, result.failure?.dispatchState === "unknown" ? "uncertain" : "confirmed", { result: { isError: result.isError } }); }
        finally { db.close(); }
      }
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

      if (recoveryTickets && pendingTicketId && status.ticket !== pendingTicketId && (status.kind === "done" || status.kind === "plan_complete" || Boolean(status.ticket))) {
        outcome = "needs-human";
        detail = `Builder response named ${status.ticket ?? "no ticket"}, but this recovery turn was scoped to ${pendingTicketId}`;
        break;
      }

      if (status.kind === "done" || status.kind === "plan_complete") {
        let qaSummary: string | undefined;
        let qaWaived = false;
        let qaPassCertificateId: string | undefined;
        let qaSourceStateDigest: string | undefined;
        if (this.qaEnabled) {
          const qa = await this.runQa(i, status.ticket ?? pendingTicketId, result.text);
          if (qa.outcome === "blocked" || qa.outcome === "needs-human") {
            outcome = qa.outcome;
            detail = qa.detail;
            if (pendingTicketId && this.continueIndependentTickets && this.ticketsEnabled && this.projectDir) {
              cmdBlock(this.projectDir, pendingTicketId, { summary: qa.detail ?? "QA requires recovery", actor: "foreman" });
              deferred.add(pendingTicketId);
              continue;
            }
            break;
          }
          qaWaived = qa.outcome === "waived";
          qaSummary = qa.summary;
          qaPassCertificateId = qa.passCertificateId;
          qaSourceStateDigest = qa.sourceStateDigest;
        }

        // Update ticket state only after QA has passed, so generated tracker
        // state does not claim done before verification has completed.
        if (this.ticketsEnabled && this.projectDir) {
          const ticketId = status.ticket ?? pendingTicketId;
          if (ticketId) {
            try {
              if (this.qaEnabled && !qaWaived) {
                if (!qaPassCertificateId || !qaSourceStateDigest) throw new Error("QA passed without a durable pass certificate");
                await beginQaFinalization(this.projectDir, this.projectDir, this.qaRunId, ticketId, qaPassCertificateId, qaSourceStateDigest, `ticket-complete:${ticketId}`, generatedTrackerDirtyPaths(loadTicketsConfig(this.projectDir).paths));
              }
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
              if (this.qaEnabled && !qaWaived) completeQaFinalization(this.projectDir, this.qaRunId, ticketId);
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
        if (pendingTicketId && this.continueIndependentTickets && this.ticketsEnabled) { deferred.add(pendingTicketId); continue; }
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

    if (deferred.size) { outcome = "blocked"; detail = `Deferred tickets: ${[...deferred].join(", ")}. ${detail ?? "Input or prerequisite recovery is required."}`; }
    this.log.write("batch-end", { completed, requested: n, outcome, detail, sessionId: this.builder.sessionId() });
    return { completed, requested: n, outcome, detail };
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").slice(0, 200);
}

function buildBlockerRecoveryInstruction(reason: string): string {
  return [
    `You reported this blocker: ${reason}`,
    "Do not end the run. Analyze the durable state and propose two or three safe, materially different approaches the user can choose from.",
    "Put your recommended approach first and end its label with (Recommended). Include the important consequence or tradeoff in every choice label.",
    "Do not perform more implementation or QA work until the user chooses. End exactly with:",
    'STEP_STATUS: needs_input | question="How should Rafi unblock this work?" choices="recommended approach and consequence (Recommended)|alternative and consequence|another alternative and consequence"',
    "After the user answers, apply that guidance in this same session. If still blocked, report blocked again so Rafi can offer a new set of approaches.",
  ].join("\n\n");
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
