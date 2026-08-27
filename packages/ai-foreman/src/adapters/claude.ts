import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

/** Lazy-load the Claude Agent SDK. Throws an actionable error if not installed. */
export async function requireClaudeSDK() {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    throw new Error(
      "Rafi's Claude Agent SDK dependency is not installed.\n" +
      "Reinstall Rafi/ai-foreman with optional dependencies enabled; do not install the SDK into the target application.\n" +
      "Or use Codex for this run with --agent codex.",
    );
  }
}
import { AsyncQueue } from "../util/asyncQueue.js";
import { BuilderEventQueue, withActivityPhase } from "../activity.js";
import { normalizeRuntimeErrorText } from "../runtimeAuth.js";
import {
  classifyClaudeSdkFailure,
  resolveExecutablePath,
  sanitizeDiagnostics,
} from "../runtimeReadiness.js";
import type {
  BuilderAdapter,
  BuilderAdapterOptions,
  BuilderEvent,
  CompactResult,
  ContextUsage,
  PermissionDecision,
  ProviderSettingSwitch,
  TurnResult,
} from "./types.js";

/**
 * Pure function: build the `options` object passed to `query()`.
 * Extracted so tests can assert on the shape without making a live SDK call.
 * `canUseTool` is omitted here — it's a closure that the constructor adds.
 */
export function buildClaudeQueryOptions(
  opts: Omit<BuilderAdapterOptions, "permission">,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    cwd: opts.cwd,
    pathToClaudeCodeExecutable: opts.runtimeExecutable,
    env: { ...process.env },
    model: opts.model,
    resume: opts.resumeSessionId,
    permissionMode: "acceptEdits",
    effort: opts.effort,
    extraArgs: opts.fast ? { fast: null } : undefined,
    settingSources: ["user", "project", "local"],
  };
  if (opts.systemPromptAppend) {
    base.systemPrompt = { type: "preset", preset: "claude_code", append: opts.systemPromptAppend };
  }
  if (opts.skills !== undefined) {
    base.skills = opts.skills;
  }
  return base;
}

export function permissionDecisionToClaudeResult(
  decision: PermissionDecision,
  toolUseID?: string,
): PermissionResult {
  if (decision.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput,
      updatedPermissions: decision.updatedPermissions as PermissionResult extends { updatedPermissions?: infer T } ? T : never,
      toolUseID,
    };
  }
  return {
    behavior: "deny",
    message: decision.message,
    interrupt: decision.interrupt,
    toolUseID,
  };
}

export function claudeApiRetryEvent(message: {
  error: string;
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
}): BuilderEvent {
  return {
    kind: "retry",
    provider: "claude",
    reason: message.error,
    attempt: message.attempt,
    maximum: message.max_retries,
    delayMs: message.retry_delay_ms,
    managedBy: "provider",
  };
}

/**
 * Drives Claude Code through the Claude Agent SDK in streaming-input mode:
 * one persistent session, follow-up turns pushed as user messages, permission
 * requests routed to the foreman's handler via `canUseTool`.
 */
export class ClaudeAdapter implements BuilderAdapter {
  readonly agent = "claude" as const;

  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly eventQueue = new BuilderEventQueue();
  private readonly query: Query;
  private readonly abort = new AbortController();
  private readonly pumpDone: Promise<void>;
  private _sessionId?: string;
  private readonly stderrChunks: string[] = [];
  private turnSignals: string[] = [];
  private structuredError?: string;
  private apiErrorStatus?: number | null;
  private compactResult?: CompactResult;
  private pending?: {
    resolve: (r: TurnResult) => void;
    reject: (e: Error) => void;
  };
  private closed = false;

  static async create(opts: BuilderAdapterOptions): Promise<ClaudeAdapter> {
    try {
      const runtimeExecutable = opts.runtimeExecutable ?? resolveExecutablePath("claude");
      if (!runtimeExecutable) {
        throw new Error("Claude Code executable not found on PATH. Install your organization-approved Claude Code CLI, then retry.");
      }
      const { query } = await requireClaudeSDK();
      return new ClaudeAdapter({ ...opts, runtimeExecutable }, query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(normalizeRuntimeErrorText("claude", message, null, "adapter startup"), { cause: err });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(private readonly opts: BuilderAdapterOptions, query: (o: any) => Query) {
    this.query = query({
      prompt: this.inbox,
      options: {
        ...buildClaudeQueryOptions(opts),
        abortController: this.abort,
        stderr: (data: string) => this.captureStderr(data),
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          requestOptions: {
            signal?: AbortSignal;
            title?: string;
            displayName?: string;
            description?: string;
            decisionReason?: string;
            blockedPath?: string;
            toolUseID?: string;
          } = {},
        ): Promise<PermissionResult> => {
          const decision = await opts.permission({
            toolName,
            input,
            signal: requestOptions.signal,
            title: requestOptions.title,
            displayName: requestOptions.displayName,
            description: requestOptions.description,
            decisionReason: requestOptions.decisionReason,
            blockedPath: requestOptions.blockedPath,
            toolUseID: requestOptions.toolUseID,
          });
          return permissionDecisionToClaudeResult(decision, requestOptions.toolUseID);
        },
      },
    });
    this.pumpDone = this.pump();
  }

  /** Background loop: consume the SDK message stream until it ends. */
  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) {
        this.handle(msg);
      }
    } catch (err) {
      // Suppress the AbortError that fires when close() aborts the stream.
      const isShutdownAbort =
        this.closed &&
        (err instanceof Error &&
          (err.name === "AbortError" || err.message.includes("aborted")));
      if (!isShutdownAbort) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message = normalizeRuntimeErrorText("claude", rawMessage, null, "builder stream");
        this.eventQueue.push({ kind: "error", message });
        this.pending?.reject(new Error(message));
        this.pending = undefined;
      }
    } finally {
      this.eventQueue.close();
    }
  }

  private handle(msg: SDKMessage): void {
    if ("session_id" in msg && typeof msg.session_id === "string") {
      this._sessionId = msg.session_id;
    }
    if (msg.type === "assistant") {
      if (msg.error) {
        this.structuredError = msg.error;
        this.turnSignals.push(`assistant error: ${msg.error}`);
      }
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          this.eventQueue.push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          this.eventQueue.push({
            kind: "tool",
            name: block.name,
            input: block.input,
          });
        }
      }
    } else if (msg.type === "auth_status") {
      if (msg.error) this.turnSignals.push(`auth status: ${msg.error}`);
      if (msg.output.length > 0) this.turnSignals.push(...msg.output.map((line) => `auth: ${line}`));
    } else if (msg.type === "system" && msg.subtype === "status") {
      if (msg.status === "compacting") this.eventQueue.push({ kind: "session-transition", transition: "compacting" });
      if (msg.compact_result === "success") {
        this.compactResult = { ok: true };
        this.eventQueue.push({ kind: "session-transition", transition: "compacted" });
      } else if (msg.compact_result === "failed") {
        this.compactResult = { ok: false, error: sanitizeDiagnostics(msg.compact_error ?? "Claude native compaction failed") };
      }
    } else if (msg.type === "system" && msg.subtype === "api_retry") {
      this.structuredError = msg.error;
      this.apiErrorStatus = msg.error_status;
      this.turnSignals.push(`API retry ${msg.attempt}/${msg.max_retries}: ${msg.error}${msg.error_status === null ? "" : ` (HTTP ${msg.error_status})`}`);
      this.eventQueue.push(claudeApiRetryEvent(msg));
    } else if (msg.type === "tool_progress") {
      this.eventQueue.push({ kind: "activity", provider: "claude", state: "running tool", detail: `${msg.tool_name} (${Math.floor(msg.elapsed_time_seconds)}s)`, transient: true });
    } else if (msg.type === "system") {
      const system = msg as unknown as Record<string, unknown>;
      if (system.subtype === "task_started" || system.subtype === "task_progress" || system.subtype === "task_updated") {
        this.eventQueue.push({ kind: "activity", provider: "claude", state: "working on task", detail: typeof system.summary === "string" ? system.summary : undefined, transient: system.subtype === "task_progress" });
      } else if (system.subtype === "session_state_changed") {
        this.eventQueue.push({ kind: "activity", provider: "claude", state: "provider working", detail: typeof system.state === "string" ? system.state : undefined });
      }
    } else if (msg.type === "result") {
      if ("api_error_status" in msg) this.apiErrorStatus = msg.api_error_status;
      const text =
        "result" in msg && typeof msg.result === "string"
          ? msg.result
          : "errors" in msg
            ? msg.errors.join("; ")
            : "";
      const rawDiagnostics = sanitizeDiagnostics([
        text,
        ...this.turnSignals,
        ...this.stderrChunks,
      ].filter(Boolean).join("\n"));
      const failure = msg.is_error ? {
        runtime: "claude" as const,
        phase: this.opts.runtimePhase ?? "builder",
        category: classifyClaudeSdkFailure(this.structuredError, this.apiErrorStatus, rawDiagnostics),
        executable: this.opts.runtimeExecutable ?? "claude",
        cwd: this.opts.cwd,
        diagnostics: rawDiagnostics,
      } : undefined;
      const result: TurnResult = {
        text: failure ? formatClaudeFailure(failure) : text,
        isError: msg.is_error,
        numTurns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        failure,
      };
      this.eventQueue.push({ kind: "turn-complete", result });
      this.pending?.resolve(result);
      this.pending = undefined;
      this.turnSignals = [];
      this.structuredError = undefined;
      this.apiErrorStatus = undefined;
      this.stderrChunks.length = 0;
    }
  }

  sendTurn(text: string): Promise<TurnResult> {
    return withActivityPhase(`Claude ${activityPhase(this.opts.runtimePhase)}`, () => this.sendTurnInternal(text));
  }

  private sendTurnInternal(text: string): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error("builder is closed"));
    if (this.pending) {
      return Promise.reject(new Error("a turn is already in progress"));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      this.eventQueue.push({ kind: "activity", state: "starting Claude turn", provider: "claude", model: this.opts.model });
      this.turnSignals = [];
      this.structuredError = undefined;
      this.apiErrorStatus = undefined;
      this.pending = { resolve, reject };
      this.inbox.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
    });
  }

  private captureStderr(data: string): void {
    this.stderrChunks.push(data);
    while (this.stderrChunks.join("").length > 8 * 1024) this.stderrChunks.shift();
  }

  sessionId(): string | undefined {
    return this._sessionId;
  }

  async compact(): Promise<CompactResult> {
    this.compactResult = undefined;
    const result = await this.sendTurn("/compact");
    if (this.compactResult) return this.compactResult;
    return { ok: false, error: sanitizeDiagnostics(result.text || "Claude did not emit an explicit compact status") };
  }

  async contextUsage(): Promise<ContextUsage | undefined> {
    try {
      const usage = await this.query.getContextUsage();
      const result = { used: usage.totalTokens, maximum: usage.maxTokens, percentage: usage.percentage };
      this.eventQueue.push({ kind: "context-usage", ...result });
      return result;
    } catch { return undefined; }
  }

  async switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> {
    if (settings.effort !== this.opts.effort || settings.fast !== this.opts.fast) return { ok: false, error: "Claude SDK cannot change reasoning/fast controls on an existing transport" };
    if (settings.model === this.opts.model) return { ok: true };
    const result = await this.sendTurn(`/model ${settings.model ?? "default"}`);
    if (result.isError) return { ok: false, error: result.text };
    this.opts.model = settings.model; return { ok: true };
  }

  events(): AsyncIterable<BuilderEvent> {
    return this.eventQueue;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inbox.close();
    try {
      await this.query.interrupt();
    } catch {
      // interrupt is best-effort — ignore if no turn is active
    }
    this.abort.abort();
    await this.pumpDone.catch(() => {});
  }
}

function activityPhase(phase: BuilderAdapterOptions["runtimePhase"]): string {
  if (phase === "planning") return "planning";
  if (phase === "ticket-population") return "populating tickets";
  if (phase === "qa") return "reviewing with QA";
  if (phase === "uninstaller") return "planning uninstall";
  return "building";
}

function formatClaudeFailure(failure: NonNullable<TurnResult["failure"]>): string {
  const environmentNames = Object.keys(process.env)
    .filter((name) => /^(ANTHROPIC|CLAUDE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)(_|$)/i.test(name))
    .sort();
  const lines = [
    `Claude failed during ${failure.phase} (${failure.category}).`,
    `Executable: ${failure.executable}`,
    `Working directory: ${failure.cwd}`,
    "Settings: user, project, local, and managed policy",
    `Relevant environment variables set: ${environmentNames.length > 0 ? environmentNames.join(", ") : "none"}`,
  ];
  if (failure.category === "authentication") {
    lines.push("Authenticate using the Claude Code login method approved by your organization, then verify the exact executable with `claude -p \"Return exactly OK\"`.");
  } else if (failure.category === "network") {
    lines.push("Check the organization proxy/CA configuration, including HTTPS_PROXY, NODE_EXTRA_CA_CERTS, and CLAUDE_CODE_CERT_STORE where applicable.");
  }
  if (failure.diagnostics) lines.push("", "Runtime diagnostics:", failure.diagnostics);
  return lines.join("\n");
}
