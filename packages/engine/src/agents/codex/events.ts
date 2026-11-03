// Maps app-server notifications to AgentEvents (ARCH 11.6). Adapters map; they never decide.
import path from "node:path";
import type { AgentEvent, PermissionRequest, ToolRun } from "../types.js";

type Params = Record<string, unknown>;

export interface TurnState {
  turnId: string | null;
  finalText: string | null;
  finals: number;
  /** fileChange items by id, for the path an approval request is about. */
  readonly items: Map<string, Params>;
}

export function newTurnState(): TurnState {
  return { turnId: null, finalText: null, finals: 0, items: new Map() };
}

function outcomeOf(status: string): ToolRun["outcome"] {
  if (status === "completed") return "completed";
  if (status === "declined" || status === "interrupted") return "cancelled";
  return "failed";
}

function toolEvent(item: Params): AgentEvent {
  const status = String(item.status ?? "completed");
  const mcp = item.type === "mcpToolCall";
  const tool = item.type === "fileChange" ? "file-change" : mcp ? `mcp:${String(item.server)}/${String(item.tool)}`
    : "shell";
  const error = (item.error as { message?: string } | undefined)?.message ?? null;
  return { kind: "tool", run: {
    tool, callId: typeof item.id === "string" ? item.id : null,
    command: typeof item.command === "string" ? item.command : mcp ? JSON.stringify(item.arguments ?? {}) : null,
    outcome: outcomeOf(status), exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    durationMs: typeof item.durationMs === "number" ? item.durationMs : null, error,
  } };
}

const QUOTA_INFO: ReadonlySet<string> = new Set(["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"]);
const TRANSIENT_INFO: ReadonlySet<string> = new Set(["httpConnectionFailed", "responseStreamConnectionFailed",
  "responseStreamDisconnected", "internalServerError", "responseTooManyFailedAttempts", "serverOverloaded"]);

function errorCode(info: unknown): "transient" | "quota" | "auth" | "unknown" {
  const kind = (info as { codexErrorInfo?: unknown } | null)?.codexErrorInfo;
  if (typeof kind === "string") {
    if (QUOTA_INFO.has(kind)) return "quota";
    if (kind === "unauthorized") return "auth";
    if (TRANSIENT_INFO.has(kind)) return "transient";
  }
  const text = JSON.stringify(info ?? "").toLowerCase();
  if (/usage ?limit|rate ?limit|quota/.test(text)) return "quota";
  if (/unauthori[sz]ed|login|auth/.test(text)) return "auth";
  if (/overload|timeout|network|disconnect|5\d\d/.test(text)) return "transient";
  return "unknown";
}

function errorEvent(error: Params | undefined, fallback: string): AgentEvent {
  const resetAt = error?.resetsAt ?? (error?.codexErrorInfo as Params | undefined)?.resetsAt;
  return { kind: "error", code: errorCode(error), message: String(error?.message ?? fallback),
    ...(typeof resetAt === "string" ? { resetAt } : {}) };
}

/** Keeps item/started items so an approval can name what it's about. */
export function trackItem(method: string, params: Params, state: TurnState): void {
  const item = params.item as Params | undefined;
  if (method === "item/started" && item && typeof item.id === "string") state.items.set(item.id, item);
}

export const PERMISSIONS = "item/permissions/requestApproval";

/**
 * An approval request as a permission event. Under `on-request` Codex asks only to act beyond its sandbox (an
 * escalation, C85), so every one is marked; the policy decides (ARCH 11.6).
 */
export function permissionOf(method: string, params: Params, state: TurnState, cwd: string): PermissionRequest {
  const item = state.items.get(String(params.itemId ?? ""));
  const change = ((item?.changes as Params[] | undefined) ?? [])[0];
  const file = typeof change?.path === "string" ? path.resolve(cwd, change.path) : null;
  return { tool: method === PERMISSIONS ? "permissions" : method.includes("fileChange") ? "file-change" : "shell",
    command: typeof params.command === "string" ? params.command : null, path: file,
    reason: typeof params.reason === "string" ? params.reason : null, escalation: true };
}

function usage(params: Params): AgentEvent {
  const tokenUsage = (params.tokenUsage ?? {}) as Params;
  const total = (tokenUsage.total ?? {}) as Params;
  const last = tokenUsage.last as Params | undefined;
  const window = tokenUsage.modelContextWindow;
  return { kind: "usage", input: Number(total.inputTokens ?? 0), output: Number(total.outputTokens ?? 0),
    measured: true, ...(last ? { last: { total: Number(last.totalTokens ?? 0) } } : {}),
    ...(typeof window === "number" && window > 0 ? { window } : {}) };
}

/** One notification's events; the terminal event (if any) comes last. */
export function mapNotification(method: string, params: Params, state: TurnState): AgentEvent[] {
  const item = (params.item ?? {}) as Params;
  switch (method) {
    case "item/completed":
      if (item.type === "agentMessage") {
        if (item.phase === "final_answer") {
          state.finals += 1;
          if (state.finals === 1) state.finalText = String(item.text ?? "");
          return [];
        }
        return [{ kind: "activity", text: String(item.text ?? "") }];
      }
      if (["commandExecution", "fileChange", "mcpToolCall"].includes(String(item.type))) return [toolEvent(item)];
      if (item.type === "contextCompaction") {
        return [{ kind: "activity", text: "Codex compacted the conversation's context.", compaction: true }];
      }
      return [];
    case "thread/tokenUsage/updated":
      return [usage(params)];
    case "turn/completed": {
      const turn = (params.turn ?? {}) as Params;
      if (turn.status === "interrupted") return [{ kind: "cancelled", confirmed: true }];
      if (turn.status === "failed") return [errorEvent(turn.error as Params | undefined, "turn failed")];
      return [{ kind: "reply", text: state.finalText ?? "", structured: parseJson(state.finalText),
        ...(state.finals > 1 ? { finals: state.finals } : {}) }];
    }
    case "error":
      return [errorEvent(params.error as Params | undefined, "error")];
    default:
      return [];
  }
}

export function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
