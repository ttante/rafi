// rafi's minimal MCP endpoint (C37): JSON-RPC over HTTP POST with JSON responses (initialize, tools/list,
// tools/call, ping, notifications). One handler serves the real server (deps/real/serve.ts) and the harness's
// in-memory endpoint. Every request must come from loopback, with Host 127.0.0.1:<port>, no Origin (a browser
// or DNS rebinding), and the session's bearer token, compared in constant time (ARCH 1.2, 6.9).
import { timingSafeEqual } from "node:crypto";
import type { McpHandler, McpRequest, McpResponse } from "../deps/types.js";

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export const MCP_PATH = "/mcp";
const PROTOCOL = "2025-06-18";

export const RAFI_TOOLS: readonly ToolDef[] = Object.freeze([
  { name: "run_check", description: "Run a test command through rafi. Rafi runs it, records the result and " +
    "returns the run number, exit code, failing tests and an excerpt. Only test commands are accepted.",
  inputSchema: { type: "object", properties: { command: { type: "string",
    description: "One test command, e.g. the test runner with a file argument" } }, required: ["command"],
  additionalProperties: false } },
  { name: "check_output", description: "Return the full output of one of rafi's recorded runs.",
    inputSchema: { type: "object", properties: { run: { type: "integer", minimum: 1,
      description: "The run number" } }, required: ["run"], additionalProperties: false } },
]);

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);

function reply(status: number, body: unknown = null): McpResponse {
  return { status, headers: body === null ? {} : { "content-type": "application/json" },
    body: body === null ? "" : JSON.stringify(body) };
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The request's refusal, if any: wrong peer, Host or Origin is 403; a missing or wrong token is 401. */
function refusal(request: McpRequest, token: string): McpResponse | null {
  const h = request.headers;
  if (!LOOPBACK.has(request.remote)) return reply(403);
  if (h.origin !== undefined) return reply(403);
  if (h.host !== `127.0.0.1:${request.port}`) return reply(403);
  const auth = /^Bearer (\S+)$/.exec(h.authorization ?? "");
  if (!auth || !sameToken(auth[1]!, token)) return reply(401);
  return null;
}

interface Rpc {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const error = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null,
  error: { code, message } });

export function mcpHandler(o: { token: string; tools: readonly ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult> }): McpHandler {
  const result = async (message: Rpc): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: "rafi", version: "1.0.0" } };
      case "ping":
        return {};
      case "tools/list":
        return { tools: o.tools.map((t) => ({ name: t.name, description: t.description,
          inputSchema: t.inputSchema })) };
      case "tools/call": {
        const name = String(params.name ?? "");
        if (!o.tools.some((t) => t.name === name)) return error(message.id, -32602, `unknown tool ${name}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const out = await o.call(name, args);
        return { content: [{ type: "text", text: out.text }], isError: out.isError };
      }
      default:
        return error(message.id, -32601, `method not found: ${String(message.method)}`);
    }
  };
  return async (request) => {
    if (request.path.split("?")[0] !== MCP_PATH) return reply(404);
    const refused = refusal(request, o.token);
    if (refused) return refused;
    if (request.method !== "POST") return { status: 405, headers: { allow: "POST" }, body: "" };
    let message: Rpc;
    try { message = JSON.parse(request.body) as Rpc; } catch { return reply(200, error(null, -32700, "parse error")); }
    if (message.id === undefined || message.id === null) return reply(202);
    const out = await result(message);
    if (out && typeof out === "object" && "error" in out) return reply(200, out);
    return reply(200, { jsonrpc: "2.0", id: message.id, result: out });
  };
}
