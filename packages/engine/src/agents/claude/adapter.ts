// The thin Claude adapter (ARCH 11.5, 11.6): one streaming-input query per session, outputFormat per turn,
// canUseTool routed to a permission event, interrupt and abort. `meta` rides under a Symbol key the SDK
// can't serialize (plan choice C11). Completed in M2.
import type { ClaudeQuery, Deps } from "../../deps/types.js";
import { claudeCapabilities } from "../capabilities.js";
import { endProvider } from "../ending.js";
import { EventQueue } from "../queue.js";
import type { Agent, AgentEvent, Decision, TurnRequest } from "../types.js";
import { mapMessage, newClaudeState, type ClaudeTurnState } from "./events.js";
import { queryOptions, type ClaudeOptions } from "./options.js";

export const META = Symbol.for("rafi.turn-meta");
export const ASK_REFUSAL = "The user isn't available in this turn. Reply needs-input with this question.";

/** AskUserQuestion's first question, as text and choices (ARCH 5.1 "provider-question"). */
function askedQuestion(input: Record<string, unknown>): { text: string; choices: string[] } {
  const first = ((input.questions as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
  const options = (first.options as { label?: string }[] | undefined) ?? [];
  return { text: String(first.question ?? input.question ?? ""), choices: options.map((o) => String(o.label ?? "")) };
}

/** Claude Code's tool for the structured reply (`outputFormat`). */
const REPLY_TOOL = "StructuredOutput";

type Gate = { allow: boolean; message: string };

interface Session {
  readonly input: EventQueue<unknown>;
  readonly iterator: AsyncIterator<unknown>;
  readonly query: ReturnType<ClaudeQuery>;
  readonly abort: AbortController;
}

export function claudeAgent(o: ClaudeOptions & { deps: Pick<Deps, "agents" | "clock"> }):
  Agent & { sessionId(): string | null } {
  const state: ClaudeTurnState = newClaudeState(o.resume ?? null);
  let session: Session | null = null;
  let closing: Promise<void> | null = null;
  let current: EventQueue<AgentEvent> | null = null;
  let repair = false;
  /**
   * The one gate for every tool use, from canUseTool and from the PreToolUse hook, which Claude Code runs even for
   * tools it would allow itself (reads, a project's allow rules): AskUserQuestion is answered at once; the rest
   * goes to rafi's permission policy (threat-model 10.7, threat 29). The reply tool is rafi's own channel.
   */
  const gate = (tool: string, input: Record<string, unknown>) => new Promise<Gate>((resolve) => {
    if (tool === REPLY_TOOL) return resolve({ allow: true, message: "the reply" });
    const decide = (d: Decision) => resolve(d === "allow" && !repair ? { allow: true, message: "allowed by rafi" }
      : { allow: false, message: repair ? "No tools during a repair." : "Refused by rafi's permission policy." });
    if (!current) return decide("deny");
    if (tool === "AskUserQuestion") {
      current.push({ kind: "question", ...askedQuestion(input) });
      return resolve({ allow: false, message: ASK_REFUSAL });
    }
    current.push({ kind: "permission", decide, request: { tool,
      command: typeof input.command === "string" ? input.command : null,
      path: typeof input.file_path === "string" ? input.file_path : null, reason: null } });
  });
  const canUseTool = async (tool: string, input: Record<string, unknown>) => {
    const g = await gate(tool, input);
    return g.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: g.message };
  };
  const preToolUse = async (hook: Record<string, unknown>) => {
    if (hook.hook_event_name !== "PreToolUse") return {};
    const g = await gate(String(hook.tool_name ?? ""), (hook.tool_input ?? {}) as Record<string, unknown>);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: g.allow ? "allow" : "deny",
      permissionDecisionReason: g.message } };
  };
  const start = (first: TurnRequest): Session => {
    const input = new EventQueue<unknown>();
    const abort = new AbortController();
    const query = o.deps.agents.claudeQuery({ prompt: input, options: queryOptions(o, first,
      { canUseTool, abortController: abort, hooks: { PreToolUse: [{ hooks: [preToolUse] }] } }) });
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
    capabilities: () => claudeCapabilities(o.structured !== false),
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
    async models() {
      const input = new EventQueue<unknown>();
      const q = o.deps.agents.claudeQuery({ prompt: input, options: { cwd: o.cwd,
        ...(o.executable ? { pathToClaudeCodeExecutable: o.executable } : {}) } }) as
        ReturnType<ClaudeQuery> & { supportedModels?(): Promise<{ value?: string }[]> };
      try {
        const list = ((await q.supportedModels?.()) ?? []).map((m) => m.value ?? "").filter(Boolean);
        return list.length ? list : null;
      } finally {
        input.end();
      }
    },
    /** The SDK's input ends and its query aborts, then the `claude` it spawned is ended (ending.ts). */
    close() {
      session?.input.end();
      session?.abort.abort();
      if (session?.query.process) closing = endProvider(o.deps.clock, session.query.process);
      session = null;
      return closing ?? Promise.resolve();
    },
  };
}
