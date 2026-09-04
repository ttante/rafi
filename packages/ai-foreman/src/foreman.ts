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
import { signalAttention } from "./notify.js";
import { pauseActivityForInput } from "./activity.js";
import { isTicketsInitialized, loadTicketsConfig } from "./tickets/config.js";
import { cmdUpdate, cmdComplete, cmdBlock, cmdUnblock, cmdImplementationQueue } from "./tickets/commands.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { buildDurableQaFixHandoff, runIsolatedQa, type QaNonconvergenceContext, type QaNonconvergenceDecision, type QaReportRecoveryHandler, type QaSessionBoundaryRecovery, type QaSessionHandle, type QaStreamState } from "./qaReview.js";
import { changeManifestAsync, deterministicChangeSummaryAsync } from "./qaSnapshot.js";
import type { SessionStrategy } from "rafi-spec";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SessionUnavailableError, sessionUnavailableErrorFromFailure } from "./adapters/sessionFailure.js";
import type { RunObserver } from "./observability.js";
import type { QaRecoveryPacket } from "./qaRecovery.js";

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
  private readonly fallbackQaRunId = `qa-${randomUUID()}`;

  constructor(
    private builder: BuilderAdapter,
    private readonly log: Log,
    notifications: boolean | ForemanNotificationOptions = false,
    private readonly qaEnabled = true,
    private readonly qaMaxCycles = 3,
    private readonly projectDir?: string,
    /** @deprecated QA must be created by qaFactory in a disposable snapshot. */
    _deprecatedSameSessionReviewer?: BuilderAdapter,
    private readonly qaFactory?: (cwd: string, sessionId?: string) => Promise<BuilderAdapter | QaSessionHandle>,
    private readonly qaSessionStrategy: SessionStrategy = "compact",
    private readonly builderFactory?: (cwd: string, sessionId?: string) => Promise<BuilderAdapter>,
    private readonly builderSessionStrategy: SessionStrategy = "compact",
    private readonly qaNonconvergence?: (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision>,
    private readonly beforeBuilderTurn?: (adapter: BuilderAdapter, frozenAction: string) => Promise<BuilderAdapter>,
    private readonly builderSessionBoundary?: (adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy) => Promise<BuilderAdapter>,
    private readonly qaSessionBoundary?: (adapter: BuilderAdapter, frozenAction: string, strategy: SessionStrategy, cwd: string, recovery?: QaSessionBoundaryRecovery) => Promise<BuilderAdapter>,
    private readonly observeQaNativeCompactions?: (adapter: BuilderAdapter) => Promise<void>,
    /** Persist a Builder's provider-native event immediately after every turn. */
    private readonly observeBuilderNativeCompactions?: (adapter: BuilderAdapter) => Promise<void>,
    private readonly observer?: RunObserver,
    private readonly qaRuntimeContext?: unknown,
    private readonly qaContinuityManaged = false,
    private readonly qaReportRecovery?: QaReportRecoveryHandler,
    private qaResumedRecovery?: QaRecoveryPacket,
  ) {
    void _deprecatedSameSessionReviewer;
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
    if (adapter === this.builder && this.beforeBuilderTurn) {
      this.builder = await this.beforeBuilderTurn(this.builder, instruction);
      adapter = this.builder;
    }
    let result = await adapter.sendTurn(instruction);
    await this.observeBuilderNative(adapter);
    let status = parseStepStatus(result.text);
    if (result.failure?.category === "session-unavailable") return { result, status };
    if (status.kind === "unknown") {
      if (!status.error && looksLikeQuestion(result.text)) {
        status = { kind: "needs_input", question: lastLine(result.text), choices: ["Continue", "Cancel"] };
      } else {
        if (adapter === this.builder && this.beforeBuilderTurn) {
          this.builder = await this.beforeBuilderTurn(this.builder, instruction);
          adapter = this.builder;
        }
        result = await adapter.sendTurn(mode === "qa"
          ? "Protocol correction only: based on the review already completed, return exactly one final STEP_STATUS: qa_pass or STEP_STATUS: qa_fail marker. Do not repeat QA, tests, tools, or compaction."
          : "Protocol correction only: based on the work already completed, return exactly one final STEP_STATUS: done, plan_complete, blocked, or needs_input marker. Do not repeat implementation, tools, or compaction.");
        await this.observeBuilderNative(adapter);
        status = parseStepStatus(result.text);
        if (status.kind === "unknown") status = { ...status, error: `protocol correction exhausted: ${status.error ?? "missing final marker"}` };
      }
    }

    while (true) {
      while (status.kind === "needs_input") {
        const question = status.question ?? "The builder has a question";
        const choices = status.choices?.length ? status.choices : ["Continue"];
        this.log.write("needs_input", { question, choices });
        signalAttention("Foreman needs your input", question, this.notificationsEnabled, this.terminalBellEnabled);

        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error(`foreman: input required: ${question}`);
          console.error("foreman: resume this run in an interactive terminal, or provide explicit guidance through the printed resume command");
          result = { text: result.text, isError: false, numTurns: result.numTurns, costUsd: result.costUsd };
          status = { kind: "blocked", reason: `input required in an interactive terminal: ${question}` };
          break;
        }

        const answer = await this.waitForUserInput(async () => {
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
        console.log();

        if (answer === undefined) {
          result = { text: "", isError: false, numTurns: 0, costUsd: 0 };
          status = { kind: "blocked", reason: "user chose safe pause at an input prompt" };
          break;
        }

        if (adapter === this.builder && this.beforeBuilderTurn) {
          this.builder = await this.beforeBuilderTurn(this.builder, answer);
          adapter = this.builder;
        }
        result = await adapter.sendTurn(answer);
        await this.observeBuilderNative(adapter);
        status = parseStepStatus(result.text);
      }

      if (status.kind !== "blocked" || status.reason?.startsWith("user chose safe pause") || !process.stdin.isTTY || !process.stdout.isTTY) break;

      const reason = status.reason ?? "the agent reported an unspecified blocker";
      this.log.write("blocked-recovery", { reason, role: adapter === this.builder ? "builder" : "qa" });
      const recoveryInstruction = buildBlockerRecoveryInstruction(reason);
      if (adapter === this.builder && this.beforeBuilderTurn) {
        this.builder = await this.beforeBuilderTurn(this.builder, recoveryInstruction);
        adapter = this.builder;
      }
      result = await adapter.sendTurn(recoveryInstruction);
      await this.observeBuilderNative(adapter);
      status = parseStepStatus(result.text);
      if (status.kind === "unknown") {
        result = await adapter.sendTurn('Protocol correction only: return the blocker approaches now using exactly one final STEP_STATUS: needs_input marker with question="..." and choices="recommended (Recommended)|alternative|alternative". Do not repeat tools or implementation.');
        await this.observeBuilderNative(adapter);
        status = parseStepStatus(result.text);
      }
    }

    return { result, status };
  }

  /** Send a planning turn and return the builder's response text. Does not count toward steps. */
  async runPreflight(n: number, ticketsContent?: string, preferredTicketId?: string): Promise<string> {
    const instruction = buildPlanningTurn(n, ticketsContent, preferredTicketId);
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
  }> {
    if (this.projectDir && this.qaFactory) {
      const resumedRecovery = this.qaResumedRecovery;
      this.qaResumedRecovery = undefined;
      const review = await runIsolatedQa({
        ticket: this.ticketForQa(stepIndex, ticketId),
        builderWorktree: this.projectDir,
        builderSummary: builderResult ?? "Builder result unavailable at this explicit QA-only API boundary",
        qaStrategy: this.qaSessionStrategy,
        state: this.qaStream,
        createQa: this.qaFactory,
        sessionBoundary: this.qaSessionBoundary,
        observeNativeCompactions: this.observeQaNativeCompactions,
        maxCycles: this.qaMaxCycles,
        recovery: { projectDir: this.projectDir, runId: this.observer?.runId ?? this.fallbackQaRunId },
        observer: this.observer,
        qaRuntimeContext: this.qaRuntimeContext,
        continuityManaged: this.qaContinuityManaged,
        onReportRecovery: this.qaReportRecovery,
        resumedRecovery,
        fix: async (request) => {
          const manifest = await changeManifestAsync(this.projectDir!);
          const changeSummary = await deterministicChangeSummaryAsync(this.projectDir!);
          const instruction = buildDurableQaFixHandoff(this.ticketForQa(stepIndex, ticketId), request, this.projectDir!, request.latestBuilderResult, manifest.diffDigest, changeSummary);
          await this.prepareBuilderBoundary(instruction); this.builderWorkSessions += 1;
          const fix = await this.doTurn(instruction);
          this.log.write("qa-fix", { stepIndex, statusKind: fix.status.kind, costUsd: fix.result.costUsd, isError: fix.result.isError });
          return fix.result.isError || fix.status.kind !== "done"
            ? { ok: false, detail: fix.status.reason ?? fix.status.error ?? fix.result.text.slice(0, 200) }
            : { ok: true, response: fix.result.text, summary: fix.status.summary ?? fix.result.text };
        },
        evidence: ({ cycle, outcome, detail, qaDiff }) => this.log.write("qa", { stepIndex, cycle, outcome, detail, qaDiff, disposable: true }),
        onNonconvergence: this.qaNonconvergence,
        resolveBlocked: (adapter, reason) => this.resolveBlocker(adapter, reason, "qa"),
      });
      if (review.outcome === "nonconverged") return { outcome: "needs-human", detail: review.detail };
      return { outcome: review.outcome, detail: review.detail, summary: review.summary };
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
  ): Promise<BatchResult> {
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
          const next = i === 1 && preferredTicketId
            ? queue.find((row) => row.ticket === preferredTicketId)
            : queue.find((row) => row.status === "next");
          if (i === 1 && preferredTicketId && !next) {
            outcome = "needs-human";
            detail = `recovery ticket ${preferredTicketId} is no longer available in the implementation queue`;
            break;
          }
          if (i === 1 && preferredTicketId && next?.status === "blocked") {
            cmdUnblock(this.projectDir, preferredTicketId, { actor: "foreman", summary: "Reopened by explicit build recovery" });
          } else if (i === 1 && preferredTicketId && next && next.status !== "next" && next.status !== "in_progress") {
            outcome = "needs-human";
            detail = `recovery ticket ${preferredTicketId} cannot resume while its status is ${next.status}`;
            break;
          }
          if (next) {
            pendingTicketId = next.ticket;
            await onTicketStart?.(next.ticket);
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
        ? buildPrimer(n, trackerPath, this.ticketsEnabled, preferredTicketId)
        : buildNextStepInstruction(i, n);
      if (i > 1) await this.prepareBuilderBoundary(instruction);
      this.builderWorkSessions += 1;
      const turn = () => this.doTurn(instruction);
      const { result, status } = this.observer
        ? await this.observer.withContext({ role: "builder", stream: "builder", ticketId: pendingTicketId }, turn)
        : await turn();

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
          const qa = await this.runQa(i, status.ticket ?? pendingTicketId, result.text);
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
