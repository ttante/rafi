import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { AsyncQueue } from "../util/asyncQueue.js";
import type {
  BuilderAdapter,
  BuilderAdapterOptions,
  BuilderEvent,
  TurnResult,
} from "./types.js";

/** Result of parsing one JSONL line from `codex exec --json` output. */
export interface CodexLineResult {
  /** Events to emit to the BuilderEvent stream. */
  events: BuilderEvent[];
  /** If set, update the stored session ID to this value. */
  sessionId?: string;
  /** If set, append this to the turn's accumulated text. */
  text?: string;
}

/**
 * Pure function: parse one JSONL event from `codex exec --json` output into
 * structured actions. Exported for unit testing; production code calls this
 * via handleEvent().
 */
export function parseCodexLine(raw: Record<string, unknown>): CodexLineResult {
  const type = raw.type as string | undefined;

  if (type === "thread.started") {
    const sessionId = raw.thread_id as string | undefined;
    return { events: [], sessionId };
  }

  if (type === "item.completed") {
    const item = raw.item as Record<string, unknown> | undefined;
    if (!item) return { events: [] };

    if (item.type === "agent_message") {
      const text = item.text as string | undefined;
      if (!text) return { events: [] };
      return { events: [{ kind: "text", text }], text };
    }

    if (item.type === "command_execution") {
      return {
        events: [{ kind: "tool", name: "command_execution", input: { command: item.command } }],
      };
    }

    return { events: [] };
  }

  if (type === "error") {
    const msg =
      (raw.error as Record<string, unknown> | undefined)?.message as string | undefined
      ?? JSON.stringify(raw);
    return { events: [{ kind: "error", message: msg }] };
  }

  return { events: [] };
}

/**
 * Drives Codex CLI as a subprocess. Each sendTurn() spawns `codex exec --json`
 * and reads JSONL from stdout. Session continuity is maintained via the
 * thread_id captured from the first run and passed as `resume <id>` on
 * subsequent turns.
 *
 * NOTE: opts.permission is accepted for interface conformance but is not
 * invoked. Codex manages its own tool sandboxing via --sandbox workspace-write.
 */
export class CodexAdapter implements BuilderAdapter {
  readonly agent = "codex" as const;

  private readonly eventQueue = new AsyncQueue<BuilderEvent>();
  private _sessionId?: string;
  private _closed = false;
  private _activeProc?: ChildProcess;

  constructor(private readonly opts: BuilderAdapterOptions) {}

  /** Build the `codex exec` argument list for the given instruction. */
  buildArgs(instruction: string): string[] {
    const args: string[] = ["exec", "--json", "--sandbox", "workspace-write", "-C", this.opts.cwd];

    if (this.opts.model) args.push("-m", this.opts.model);

    if (this.opts.effort) {
      args.push("-c", `model_reasoning_effort=${this.opts.effort}`);
    } else if (this.opts.fast) {
      args.push("-c", "model_reasoning_effort=low");
    }

    if (this._sessionId) {
      args.push("resume", this._sessionId);
    }

    args.push(instruction);
    return args;
  }

  sendTurn(instruction: string): Promise<TurnResult> {
    if (this._closed) return Promise.reject(new Error("builder is closed"));

    const args = this.buildArgs(instruction);
    const textParts: string[] = [];
    const stderrChunks: Buffer[] = [];

    return new Promise<TurnResult>((resolve, reject) => {
      const proc = spawn("codex", args, {
        cwd: this.opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this._activeProc = proc;

      const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const result = parseCodexLine(raw);
        if (result.sessionId) this._sessionId = result.sessionId;
        if (result.text) textParts.push(result.text);
        for (const ev of result.events) this.eventQueue.push(ev);
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      proc.on("close", (code) => {
        this._activeProc = undefined;
        let text = textParts.join("\n");
        if (!text && code !== 0) {
          text = Buffer.concat(stderrChunks).toString().trim();
        }
        const result: TurnResult = {
          text,
          isError: code !== 0,
          numTurns: 1,
          costUsd: 0,
        };
        this.eventQueue.push({ kind: "turn-complete", result });
        resolve(result);
      });

      proc.on("error", (err) => {
        this._activeProc = undefined;
        this.eventQueue.push({ kind: "error", message: err.message });
        reject(err);
      });
    });
  }

  sessionId(): string | undefined {
    return this._sessionId;
  }

  events(): AsyncIterable<BuilderEvent> {
    return this.eventQueue;
  }

  close(): Promise<void> {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    this._activeProc?.kill("SIGTERM");
    this.eventQueue.close();
    return Promise.resolve();
  }
}
