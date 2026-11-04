// Agent sessions (C35): one per ticket, role and reply schema, fresh per ticket. Each gets rafi's tools: Codex
// through a local MCP endpoint with a per-session token in the thread config (C36, never argv); Claude in-process
// (C38). The token is registered with the redactor (C39) and the endpoint closes with the session. Each runtime
// gets the agent allowlist (ARCH 7.12), never rafi's whole shell; Codex's shells also drop its API key.
import path from "node:path";
import { replySchemas, type ReplyName } from "rafi-spec/v1";
import { claudeAgent } from "./claude/adapter.js";
import { codexAgent } from "./codex/adapter.js";
import type { Agent, ReplySchema } from "./types.js";
import type { Deps, Env } from "../deps/types.js";
import { mcpHandler, RAFI_TOOLS } from "../tools/mcp.js";
import type { SessionTools } from "../tools/session.js";
import { codexShellPolicy } from "../build/env.js";

export interface SessionSpec {
  readonly runtime: "codex" | "claude";
  readonly role: "builder" | "qa";
  readonly reply: ReplyName;
  readonly project: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly structured: boolean;
  readonly tools: SessionTools;
  /** The agent allowlist for this runtime (build/env.ts agentEnv). */
  readonly env: Env;
  readonly executable: string;
}

export interface Session {
  readonly agent: Agent;
  readonly spec: SessionSpec;
  readonly schema: ReplySchema;
  /** Turns sent so far; the first carries the standing instructions. */
  turns: number;
  close(): Promise<void>;
}

export function schemaOf(reply: ReplyName): ReplySchema {
  return { name: reply, json: replySchemas[reply].json, codex: replySchemas[reply].codex };
}

export async function openSession(deps: Deps, spec: SessionSpec, secret: (token: string) => void): Promise<Session> {
  const writable = spec.role === "builder";
  const common = { model: spec.model ?? undefined, effort: spec.effort ?? undefined, fast: spec.fast,
    structured: spec.structured };
  const closers: (() => Promise<void>)[] = [];
  let agent: Agent;
  if (spec.runtime === "codex") {
    const token = deps.random.secret?.() ?? deps.random.id();
    secret(token);
    const served = await deps.serve({ host: "127.0.0.1", handler: mcpHandler({ token, tools: RAFI_TOOLS,
      call: (name, args) => spec.tools.call(name, args) }) });
    closers.push(() => served.close());
    agent = codexAgent({ deps, cwd: spec.project, executable: spec.executable, env: spec.env, ...common,
      sandbox: writable ? "workspace-write" : "read-only", mcp: { url: served.url, token },
      shellEnvironment: codexShellPolicy() });
  } else {
    const tools = await deps.agents.claudeTools?.("rafi", RAFI_TOOLS.map((t) => ({ ...t,
      call: (args: Record<string, unknown>) => spec.tools.call(t.name, args) })));
    agent = claudeAgent({ deps, cwd: spec.project, ...common, writable, tools, env: spec.env,
      executable: path.isAbsolute(spec.executable) ? spec.executable : undefined });
  }
  return { agent, spec, schema: schemaOf(spec.reply), turns: 0,
    async close() {
      await agent.close();
      for (const close of closers) await close();
    } };
}
