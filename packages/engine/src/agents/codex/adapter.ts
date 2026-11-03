// The thin Codex adapter (ARCH 11.4, 11.6): thread/start or thread/resume, turn/start with outputSchema,
// turn/interrupt; events mapped from the app-server's notifications. Completed in M2.
import type { Deps, Env } from "../../deps/types.js";
import { EventQueue } from "../queue.js";
import type { Agent, AgentEvent, TurnRequest } from "../types.js";
import { mapNotification, type TurnState } from "./events.js";
import { CodexTransport } from "./transport.js";

export interface CodexOptions {
  readonly deps: Pick<Deps, "agents">;
  readonly cwd: string;
  readonly executable: string;
  readonly env: Env;
  readonly model?: string;
  readonly threadId?: string;
  readonly sandbox?: "read-only" | "workspace-write";
}

const APPROVALS: ReadonlySet<string> = new Set(["item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"]);

export function codexAgent(o: CodexOptions): Agent & { threadId(): string | null } {
  const transport = new CodexTransport(o.deps.agents.codex({ cwd: o.cwd, executable: o.executable,
    args: ["app-server", "--listen", "stdio://"], env: o.env }));
  let thread: string | null = o.threadId ?? null;
  let opened = false;
  const open = async (request: TurnRequest) => {
    const method = thread ? "thread/resume" : "thread/start";
    const result = await transport.request(method, { threadId: thread ?? undefined, cwd: o.cwd, model: o.model,
      sandbox: o.sandbox ?? "workspace-write", approvalPolicy: "on-request" }, request.meta) as
      { thread?: { id?: string } };
    thread = result.thread?.id ?? thread;
    opened = true;
  };
  return {
    runtime: "codex",
    threadId: () => thread,
    capabilities: () => ({ structuredReplies: true, exitCodes: true, resume: true, images: true,
      enforceableGrants: true, compaction: true }),
    turn(request, signal) {
      const queue = new EventQueue<AgentEvent>();
      const state: TurnState = { turnId: null, finalText: null };
      const finish = (events: AgentEvent[]) => {
        for (const event of events) queue.push(event);
        if (events.some((e) => ["reply", "error", "exit", "cancelled"].includes(e.kind))) cleanup();
      };
      const cancels = [
        transport.onNotification((method, params) => {
          if (params.turn && (params.turn as { id?: string }).id !== state.turnId && state.turnId) return;
          finish(mapNotification(method, params, state));
        }),
        transport.onServerRequest((id, method, params) => {
          if (!APPROVALS.has(method)) return transport.respond(id, { decision: "decline" });
          queue.push({ kind: "permission", request: { tool: method.includes("fileChange") ? "file-change" : "shell",
            command: typeof params.command === "string" ? params.command : null, path: null,
            reason: typeof params.reason === "string" ? params.reason : null },
          decide: (d) => transport.respond(id, {
            decision: d === "allow" && !request.repair ? "accept" : "decline" }) });
        }),
        transport.onExit((code) => finish([{ kind: "exit", code }])),
      ];
      const onAbort = () => {
        if (thread && state.turnId) void transport.request("turn/interrupt", { threadId: thread, turnId: state.turnId })
          .catch(() => finish([{ kind: "cancelled", confirmed: false }]));
        else finish([{ kind: "cancelled", confirmed: false }]);
      };
      const cleanup = () => {
        for (const cancel of cancels) cancel();
        signal.removeEventListener("abort", onAbort);
        queue.end();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void (async () => {
        try {
          if (!opened) await open(request);
          const text = request.instructions ? `${request.instructions}\n\n${request.message}` : request.message;
          const result = await transport.request("turn/start", { threadId: thread,
            input: [{ type: "text", text }], outputSchema: request.schema.codex ?? request.schema.json },
            request.meta) as
            { turn?: { id?: string } };
          state.turnId = result.turn?.id ?? null;
          if (signal.aborted) onAbort();
        } catch (error) {
          finish([{ kind: "error", code: "unknown", message: (error as Error).message }]);
        }
      })();
      return queue;
    },
    close: () => transport.close(),
  };
}
