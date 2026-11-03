// Maps app-server notifications to AgentEvents (ARCH 11.6). Adapters map; they never decide.
import type { AgentEvent } from "../types.js";

type Params = Record<string, unknown>;

export interface TurnState {
  turnId: string | null;
  finalText: string | null;
}

function toolEvent(item: Params): AgentEvent {
  const status = String(item.status ?? "completed");
  const outcome = status === "completed" ? "completed" : status === "declined" ? "cancelled" : "failed";
  return { kind: "tool", run: {
    tool: item.type === "fileChange" ? "file-change" : "shell",
    command: typeof item.command === "string" ? item.command : null, outcome,
    exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
  } };
}

function errorCode(info: unknown): "transient" | "quota" | "auth" | "unknown" {
  const text = JSON.stringify(info ?? "").toLowerCase();
  if (/usage ?limit|rate ?limit|quota/.test(text)) return "quota";
  if (/unauthori[sz]ed|login|auth/.test(text)) return "auth";
  if (/overload|timeout|network|disconnect|5\d\d/.test(text)) return "transient";
  return "unknown";
}

/** One notification's events; the terminal event (if any) comes last. */
export function mapNotification(method: string, params: Params, state: TurnState): AgentEvent[] {
  const item = (params.item ?? {}) as Params;
  switch (method) {
    case "item/completed":
      if (item.type === "agentMessage") {
        if (item.phase === "final_answer") { state.finalText = String(item.text ?? ""); return []; }
        return [{ kind: "activity", text: String(item.text ?? "") }];
      }
      if (item.type === "commandExecution" || item.type === "fileChange") return [toolEvent(item)];
      return [];
    case "thread/tokenUsage/updated": {
      const total = ((params.tokenUsage as Params | undefined)?.total ?? {}) as Params;
      return [{ kind: "usage", input: Number(total.inputTokens ?? 0), output: Number(total.outputTokens ?? 0),
        measured: true }];
    }
    case "turn/completed": {
      const turn = (params.turn ?? {}) as Params;
      if (turn.status === "interrupted") return [{ kind: "cancelled", confirmed: true }];
      if (turn.status === "failed") {
        const error = turn.error as Params | undefined;
        return [{ kind: "error", code: errorCode(error), message: String(error?.message ?? "turn failed") }];
      }
      return [{ kind: "reply", text: state.finalText ?? "", structured: parseJson(state.finalText) }];
    }
    case "error":
      return [{ kind: "error", code: errorCode(params),
        message: String((params.error as Params)?.message ?? "error") }];
    default:
      return [];
  }
}

export function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
