// Maps Agent SDK messages to AgentEvents (ARCH 11.6, 8.4 OUT-8, SCN-14). Each tool completion names its tool and
// call id; a duplicated result shows once; a call whose result never arrives is `unknown` at the turn's end;
// Claude gives no exit codes or durations (NEW-REF-2), so those are null.
import type { AgentEvent, ToolRun } from "../types.js";

type Message = Record<string, unknown>;
type Block = { type?: string; id?: string; name?: string; text?: string; input?: Record<string, unknown>;
  tool_use_id?: string; is_error?: boolean; content?: unknown };

export interface ClaudeTurnState {
  sessionId: string | null;
  readonly tools: Map<string, { name: string; command: string | null }>;
  readonly done: Set<string>;
  /** StructuredOutput calls this turn: more than one is two final replies (S-MAL-4). */
  finals: number;
}

export function newClaudeState(resume: string | null): ClaudeTurnState {
  return { sessionId: resume, tools: new Map(), done: new Set(), finals: 0 };
}

function blocks(message: Message): Block[] {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c as { text?: string }).text ?? "").join("");
  return "";
}

function outcomeOf(block: Block): ToolRun["outcome"] {
  if (!block.is_error) return "completed";
  const text = textOf(block.content);
  if (/timed out|timeout/i.test(text)) return "timed-out";
  if (/interrupt|cancel/i.test(text)) return "cancelled";
  return "failed";
}

/** Tool calls still open when the turn ends: their outcome never arrived. */
export function unfinishedTools(state: ClaudeTurnState): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const [id, tool] of state.tools) {
    out.push({ kind: "tool", run: { tool: tool.name, callId: id, command: tool.command, outcome: "unknown",
      exitCode: null, durationMs: null, error: null } });
  }
  state.tools.clear();
  return out;
}

function result(message: Message, state: ClaudeTurnState): AgentEvent[] {
  const usage = (message.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const events: AgentEvent[] = [...unfinishedTools(state), { kind: "usage", input: Number(usage.input_tokens ?? 0),
    output: Number(usage.output_tokens ?? 0), cost: Number(message.total_cost_usd ?? 0), measured: true }];
  if (message.subtype === "success") {
    events.push({ kind: "reply", text: String(message.result ?? ""), structured: message.structured_output,
      ...(state.finals > 1 ? { finals: state.finals } : {}) });
    state.finals = 0;
  } else {
    const errors = (message.errors as string[] | undefined) ?? [];
    const text = errors.join("; ") || String(message.subtype);
    const code = /usage limit|rate limit|quota/i.test(text) ? "quota" : /authenticat|log ?in|unauthori[sz]ed|401/i
      .test(text) ? "auth" : "unknown";
    events.push({ kind: "error", code, message: text, detail: String(message.subtype) });
  }
  return events;
}

function assistant(message: Message, state: ClaudeTurnState): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const block of blocks(message)) {
    if (block.type === "text" && block.text) out.push({ kind: "activity", text: block.text });
    if (block.type === "tool_use" && block.name === "StructuredOutput") state.finals += 1;
    if (block.type === "tool_use" && block.id && block.name !== "StructuredOutput") {
      const input = block.input ?? {};
      const command = typeof input.command === "string" ? input.command
        : typeof input.file_path === "string" ? input.file_path : null;
      state.tools.set(block.id, { name: block.name ?? "tool", command });
    }
  }
  return out;
}

function toolResults(message: Message, state: ClaudeTurnState): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const block of blocks(message)) {
    if (block.type !== "tool_result" || !block.tool_use_id || state.done.has(block.tool_use_id)) continue;
    const tool = state.tools.get(block.tool_use_id);
    if (!tool) continue;
    state.tools.delete(block.tool_use_id);
    state.done.add(block.tool_use_id);
    out.push({ kind: "tool", run: { tool: tool.name, callId: block.tool_use_id, command: tool.command,
      outcome: outcomeOf(block), exitCode: null, durationMs: null,
      error: block.is_error ? textOf(block.content).slice(0, 500) : null } });
  }
  return out;
}

/** One SDK message's events; a `result` message ends the turn. */
export function mapMessage(message: Message, state: ClaudeTurnState): AgentEvent[] {
  if (message.type === "system" && message.subtype === "init") {
    state.sessionId = String(message.session_id ?? state.sessionId ?? "");
    return [];
  }
  if (message.type === "system" && message.subtype === "api_retry") {
    return [{ kind: "activity", text: `Claude is retrying a request (attempt ${String(message.attempt ?? "?")})` }];
  }
  if (message.type === "assistant") return assistant(message, state);
  if (message.type === "user") return toolResults(message, state);
  if (message.type === "result") return result(message, state);
  return [];
}
