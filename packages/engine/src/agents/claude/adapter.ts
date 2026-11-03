// The thin Claude adapter (ARCH 11.5, 11.6): one streaming-input query per session, outputFormat per turn,
// canUseTool routed to a permission event, interrupt and abort. `meta` rides under a Symbol key the SDK
// can't serialize (plan choice C11). Completed in M2.
import type { ClaudeQuery, Deps } from "../../deps/types.js";
import { EventQueue } from "../queue.js";
import type { Agent, AgentEvent, Decision, TurnRequest } from "../types.js";
import { mapMessage, type ClaudeTurnState } from "./events.js";
import { queryOptions, type ClaudeOptions } from "./options.js";

export const META = Symbol.for("rafi.turn-meta");

interface Session {
  readonly input: EventQueue<unknown>;
  readonly iterator: AsyncIterator<unknown>;
  readonly query: ReturnType<ClaudeQuery>;
  readonly abort: AbortController;
}

export function claudeAgent(o: ClaudeOptions & { deps: Pick<Deps, "agents"> }): Agent & { sessionId(): string | null } {
  const state: ClaudeTurnState = { sessionId: o.resume ?? null, tools: new Map() };
  let session: Session | null = null;
  let current: EventQueue<AgentEvent> | null = null;
  let repair = false;
  const canUseTool = (tool: string, input: Record<string, unknown>) => new Promise((resolve) => {
    const decide = (d: Decision) => resolve(d === "allow" && !repair ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: repair ? "No tools during a repair." : "Refused by rafi's permission policy." });
    if (!current) return decide("deny");
    current.push({ kind: "permission", decide, request: { tool,
      command: typeof input.command === "string" ? input.command : null,
      path: typeof input.file_path === "string" ? input.file_path : null, reason: null } });
  });
  const start = (first: TurnRequest): Session => {
    const input = new EventQueue<unknown>();
    const abort = new AbortController();
    const query = o.deps.agents.claudeQuery({ prompt: input, options: queryOptions(o, first,
      { canUseTool, abortController: abort }) });
    return { input, query, abort, iterator: query[Symbol.asyncIterator]() };
  };
  const pump = async (s: Session, queue: EventQueue<AgentEvent>, signal: AbortSignal) => {
    try {
      for (;;) {
        const next = await s.iterator.next();
        if (next.done) return queue.push({ kind: "exit", code: null });
        const events = mapMessage(next.value as Record<string, unknown>, state);
        for (const event of events) {
          if (signal.aborted && event.kind === "error") return queue.push({ kind: "cancelled", confirmed: true });
          queue.push(event);
        }
        if (events.some((e) => e.kind === "reply" || e.kind === "error")) return;
      }
    } catch (error) {
      queue.push(signal.aborted ? { kind: "cancelled", confirmed: false }
        : { kind: "error", code: "unknown", message: (error as Error).message });
    } finally {
      queue.end();
    }
  };
  return {
    runtime: "claude",
    sessionId: () => state.sessionId,
    capabilities: () => ({ structuredReplies: true, exitCodes: false, resume: true, images: true,
      enforceableGrants: true, compaction: true }),
    turn(request, signal) {
      const queue = new EventQueue<AgentEvent>();
      current = queue;
      repair = Boolean(request.repair);
      const s = session ?? (session = start(request));
      const onAbort = () => { void s.query.interrupt().catch(() => s.abort.abort()); };
      signal.addEventListener("abort", onAbort, { once: true });
      s.input.push({ type: "user", message: { role: "user", content: request.message }, parent_tool_use_id: null,
        session_id: state.sessionId ?? "", [META]: request.meta });
      void pump(s, queue, signal).finally(() => signal.removeEventListener("abort", onAbort));
      return queue;
    },
    async close() {
      session?.input.end();
      session?.abort.abort();
      session = null;
    },
  };
}
