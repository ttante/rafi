import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../util/asyncQueue.js";
import type {
  BuilderAdapter,
  BuilderAdapterOptions,
  BuilderEvent,
  TurnResult,
} from "./types.js";

/**
 * Drives Claude Code through the Claude Agent SDK in streaming-input mode:
 * one persistent session, follow-up turns pushed as user messages, permission
 * requests routed to the foreman's handler via `canUseTool`.
 */
export class ClaudeAdapter implements BuilderAdapter {
  readonly agent = "claude" as const;

  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly eventQueue = new AsyncQueue<BuilderEvent>();
  private readonly query: Query;
  private readonly abort = new AbortController();
  private readonly pumpDone: Promise<void>;
  private _sessionId?: string;
  private pending?: {
    resolve: (r: TurnResult) => void;
    reject: (e: Error) => void;
  };
  private closed = false;

  constructor(opts: BuilderAdapterOptions) {
    this.query = query({
      prompt: this.inbox,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        resume: opts.resumeSessionId,
        permissionMode: "acceptEdits",
        abortController: this.abort,
        effort: opts.effort,
        extraArgs: opts.fast ? { fast: null } : undefined,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ): Promise<PermissionResult> => {
          const decision = await opts.permission({ toolName, input });
          return decision.behavior === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: decision.message };
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
        const message = err instanceof Error ? err.message : String(err);
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
    } else if (msg.type === "result") {
      const text =
        "result" in msg && typeof msg.result === "string"
          ? msg.result
          : "errors" in msg
            ? msg.errors.join("; ")
            : "";
      const result: TurnResult = {
        text,
        isError: msg.is_error,
        numTurns: msg.num_turns,
        costUsd: msg.total_cost_usd,
      };
      this.eventQueue.push({ kind: "turn-complete", result });
      this.pending?.resolve(result);
      this.pending = undefined;
    }
  }

  sendTurn(text: string): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error("builder is closed"));
    if (this.pending) {
      return Promise.reject(new Error("a turn is already in progress"));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.inbox.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
    });
  }

  sessionId(): string | undefined {
    return this._sessionId;
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
