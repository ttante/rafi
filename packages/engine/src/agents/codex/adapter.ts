// The Codex adapter (ARCH 11.4, 11.6, 7.11): thread/start with the role's sandbox, the model and rafi's MCP endpoint
// (C36), turn/start with outputSchema, effort and the fast tier; turn/interrupt; approvals become permission events;
// events mapped from the app-server's notifications. The builder runs under rafi's permission profile (profile.ts),
// selected per thread and turn; QA keeps the legacy read-only sandbox and per-turn sandboxPolicy (C84). Approvals
// come to rafi (`approvalsReviewer: user`, C86); each one asks to act beyond the sandbox, so it's an escalation (C85).
import type { Deps, Env } from "../../deps/types.js";
import { codexCapabilities } from "../capabilities.js";
import { EventQueue } from "../queue.js";
import type { Agent, AgentEvent, TurnRequest } from "../types.js";
import { mapNotification, newTurnState, PERMISSIONS, permissionOf, trackItem, type TurnState } from "./events.js";
import { builderProfile, builderProfiles } from "./profile.js";
import { CodexTransport } from "./transport.js";

export interface CodexOptions {
  readonly deps: Pick<Deps, "agents" | "clock">;
  readonly cwd: string;
  readonly executable: string;
  readonly env: Env;
  readonly model?: string;
  readonly effort?: string;
  readonly fast?: boolean;
  readonly threadId?: string;
  readonly sandbox?: "read-only" | "workspace-write";
  /** rafi's local MCP endpoint for this session (C36); the token travels in the thread config, never argv. */
  readonly mcp?: { readonly url: string; readonly token: string };
  /** The ticket's MCP tools (C222), in the thread config's `mcp_servers` beside rafi's endpoint. */
  readonly external?: Readonly<Record<string, { command: string; args: string[] }>>;
  /** false: no outputSchema; the reply format is in the instructions (C52's text fallback). */
  readonly structured?: boolean;
  /**
   * Native auto-compaction (ARCH 11.2), for the reuse override: compact when the context passes this share of the
   * model's window. Set as `-c` when the app-server starts, as 0.10.x does (`ai-foreman/src/adapters/codex.ts:164`).
   */
  readonly compaction?: { readonly thresholdPercent: number; readonly contextWindow: number };
  /** Codex's `shell_environment_policy` for the thread (ARCH 7.12: the agent's shells without its API key). */
  readonly shellEnvironment?: Record<string, unknown>;
}

/** The token count Codex compacts at: the threshold's share of the window, at least 1. */
export function compactTokenLimit(contextWindow: number, thresholdPercent: number): number {
  return Math.max(1, Math.floor(contextWindow * thresholdPercent / 100));
}

function appServerArgs(o: CodexOptions): string[] {
  const args = ["app-server", "--listen", "stdio://"];
  if (o.compaction) {
    args.push("-c", `model_auto_compact_token_limit=${compactTokenLimit(o.compaction.contextWindow,
      o.compaction.thresholdPercent)}`, "-c", 'model_auto_compact_token_limit_scope="total"');
  }
  return args;
}

const APPROVALS: ReadonlySet<string> = new Set(["item/commandExecution/requestApproval",
  "item/fileChange/requestApproval", PERMISSIONS]);

const readOnly = (o: CodexOptions) => o.sandbox === "read-only";

/** The role's sandbox on thread/start, thread/resume and turn/start: the builder's profile, or QA's read-only. */
function sandboxFields(o: CodexOptions, grants: readonly string[], on: "thread" | "turn"): Record<string, unknown> {
  if (!readOnly(o)) return { permissions: builderProfile(grants) };
  if (on === "thread") return { sandbox: "read-only" };
  return { sandboxPolicy: { type: "readOnly", networkAccess: grants.includes("internet") ||
    grants.includes("local-servers") } };
}

function threadConfig(o: CodexOptions): Record<string, unknown> {
  const config: Record<string, unknown> = readOnly(o) ? { sandbox_workspace_write: { network_access: false } }
    : { permissions: builderProfiles() };
  if (o.mcp || o.external) {
    config.mcp_servers = { ...(o.external ?? {}), ...(o.mcp ? { rafi: { url: o.mcp.url,
      http_headers: { Authorization: `Bearer ${o.mcp.token}` } } } : {}) };
  }
  if (o.shellEnvironment) config.shell_environment_policy = o.shellEnvironment;
  return config;
}

export function codexAgent(o: CodexOptions): Agent & { threadId(): string | null } {
  const transport = new CodexTransport(o.deps.agents.codex({ cwd: o.cwd, executable: o.executable,
    args: appServerArgs(o), env: o.env }));
  let thread: string | null = o.threadId ?? null;
  let opened = false;
  let closing: Promise<void> | null = null;
  /** The handshake real app-servers require before any other request (live check, M2 plan 10.8). */
  let handshake: Promise<void> | null = null;
  const ready = () => handshake ??= transport.request("initialize", { clientInfo: { name: "rafi", title: "rafi",
    version: "1" }, capabilities: { experimentalApi: true } }).then(() => transport.notify("initialized"));
  const open = async (request: TurnRequest) => {
    await ready();
    const method = thread ? "thread/resume" : "thread/start";
    const result = await transport.request(method, { threadId: thread ?? undefined, cwd: o.cwd, model: o.model,
      ...sandboxFields(o, request.grants, "thread"), approvalPolicy: "on-request", approvalsReviewer: "user",
      config: threadConfig(o) }, request.meta) as { thread?: { id?: string } };
    thread = result.thread?.id ?? thread;
    opened = true;
  };
  const startParams = (request: TurnRequest) => {
    const text = request.instructions ? `${request.instructions}\n\n${request.message}` : request.message;
    return { threadId: thread, input: [{ type: "text", text }],
      ...(o.structured === false ? {} : { outputSchema: request.schema.codex ?? request.schema.json }),
      ...(o.effort ? { effort: o.effort } : {}), ...(o.fast ? { serviceTier: "fast" } : {}),
      ...sandboxFields(o, request.grants, "turn") };
  };
  return {
    runtime: "codex",
    threadId: () => thread,
    capabilities: () => codexCapabilities(o.structured !== false),
    turn(request, signal) {
      const queue = new EventQueue<AgentEvent>();
      const state: TurnState = newTurnState();
      const finish = (events: AgentEvent[]) => {
        for (const event of events) queue.push(event);
        if (events.some((e) => ["reply", "error", "exit", "cancelled"].includes(e.kind))) cleanup();
      };
      const cancels = [
        transport.onNotification((method, params) => {
          if (params.turn && (params.turn as { id?: string }).id !== state.turnId && state.turnId) return;
          trackItem(method, params, state);
          finish(mapNotification(method, params, state));
        }),
        transport.onServerRequest((id, method, params) => {
          if (!APPROVALS.has(method)) return transport.respond(id, { decision: "decline" });
          // ARCH 7.11: a permissions request is answered with no added permissions, whatever the policy says.
          queue.push({ kind: "permission", request: permissionOf(method, params, state, o.cwd),
            decide: (d) => transport.respond(id, method === PERMISSIONS ? { permissions: {} }
              : { decision: d === "allow" && !request.repair ? "accept" : "decline" }) });
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
          const result = await transport.request("turn/start", startParams(request), request.meta) as
            { turn?: { id?: string } };
          state.turnId = result.turn?.id ?? null;
          if (signal.aborted) onAbort();
        } catch (error) {
          finish([{ kind: "error", code: "unknown", message: (error as Error).message }]);
        }
      })();
      return queue;
    },
    async models() {
      await ready();
      const r = await transport.request("model/list", { includeHidden: true }) as
        { data?: { model?: string; id?: string }[] };
      const list = (r.data ?? []).map((m) => m.model ?? m.id ?? "").filter(Boolean);
      return list.length ? list : null;
    },
    async compact() {
      if (thread) await transport.request("thread/compact/start", { threadId: thread });
    },
    close: () => (closing ??= transport.close(o.deps.clock)),
  };
}
