// Maps Agent SDK messages to AgentEvents (ARCH 11.6).
import type { AgentEvent } from "../types.js";

type Message = Record<string, unknown>;
type Block = { type?: string; id?: string; name?: string; text?: string; input?: Record<string, unknown>;
  tool_use_id?: string; is_error?: boolean };

export interface ClaudeTurnState {
  sessionId: string | null;
  readonly tools: Map<string, { name: string; command: string | null }>;
}

function blocks(message: Message): Block[] {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function result(message: Message): AgentEvent[] {
  const usage = (message.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const events: AgentEvent[] = [{ kind: "usage", input: Number(usage.input_tokens ?? 0),
    output: Number(usage.output_tokens ?? 0), cost: Number(message.total_cost_usd ?? 0), measured: true }];
  if (message.subtype === "success") {
    events.push({ kind: "reply", text: String(message.result ?? ""), structured: message.structured_output });
  } else {
    const errors = (message.errors as string[] | undefined) ?? [];
    events.push({ kind: "error", code: "unknown", message: errors.join("; ") || String(message.subtype) });
  }
  return events;
}

/** One SDK message's events; a `result` message ends the turn. */
export function mapMessage(message: Message, state: ClaudeTurnState): AgentEvent[] {
  if (message.type === "system" && message.subtype === "init") {
    state.sessionId = String(message.session_id ?? state.sessionId ?? "");
    return [];
  }
  if (message.type === "assistant") {
    const out: AgentEvent[] = [];
    for (const block of blocks(message)) {
      if (block.type === "text" && block.text) out.push({ kind: "activity", text: block.text });
      if (block.type === "tool_use" && block.id && block.name !== "StructuredOutput") {
        const command = typeof block.input?.command === "string" ? block.input.command : null;
        state.tools.set(block.id, { name: block.name ?? "tool", command });
      }
    }
    return out;
  }
  if (message.type === "user") {
    const out: AgentEvent[] = [];
    for (const block of blocks(message)) {
      const tool = block.tool_use_id ? state.tools.get(block.tool_use_id) : undefined;
      if (block.type !== "tool_result" || !tool) continue;
      state.tools.delete(block.tool_use_id!);
      out.push({ kind: "tool", run: { tool: tool.name, command: tool.command,
        outcome: block.is_error ? "failed" : "completed", exitCode: null, durationMs: null } });
    }
    return out;
  }
  if (message.type === "result") return result(message);
  return [];
}
