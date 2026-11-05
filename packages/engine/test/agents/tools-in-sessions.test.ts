// M5 plan C222 (ARCH 10.3 "In sessions"): a ticket's MCP tools go into the session's MCP servers beside rafi's own:
// Claude's `mcpServers` query option, and Codex's thread config `mcp_servers`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryOptions } from "../../src/agents/claude/options.js";
import { codexAgent } from "../../src/agents/codex/adapter.js";
import type { TurnRequest } from "../../src/agents/types.js";
import type { JsonRpcStream } from "../../src/deps/types.js";

const external = { playwright: { command: "npx", args: ["@playwright/mcp@1", "--isolated", "--headless"] } };
const first: TurnRequest = { meta: { key: "k", role: "builder" }, message: "m", schema: { name: "s", json: {} },
  grants: [], tools: [] };

test("Claude: the ticket's MCP tools are stdio servers in mcpServers, beside rafi's", () => {
  const o = queryOptions({ cwd: "/p", tools: { rafi: true }, external }, first, {}) as Record<string, unknown>;
  assert.deepEqual(o.mcpServers, { playwright: { type: "stdio", command: "npx",
    args: ["@playwright/mcp@1", "--isolated", "--headless"] }, rafi: { rafi: true } });
  const none = queryOptions({ cwd: "/p", tools: { rafi: true } }, first, {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(none.mcpServers as object), ["rafi"]);
});

test("Codex: the ticket's MCP tools are in the thread config's mcp_servers, beside rafi's endpoint", async () => {
  const sent: { method?: string; params?: Record<string, unknown> }[] = [];
  const fns = new Set<(m: unknown) => void>();
  const stream: JsonRpcStream = {
    write(message) {
      const m = message as { id?: number; method?: string; params?: Record<string, unknown> };
      sent.push(m);
      if (m.id === undefined) return;
      const result = m.method === "turn/start" ? { turn: { id: "turn-1" } } : { thread: { id: "thread-1" } };
      queueMicrotask(() => { for (const fn of fns) fn({ id: m.id, result }); });
      if (m.method === "turn/start") queueMicrotask(() => { for (const fn of fns) fn({ method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }); });
    },
    onMessage: (fn) => { fns.add(fn); return () => fns.delete(fn); },
    onClose: () => () => undefined,
    close: async () => undefined,
    kill: () => undefined,
  };
  const unused = (() => { throw new Error("unused"); }) as never;
  const agent = codexAgent({ deps: { agents: { codex: () => stream, claudeQuery: unused }, clock: unused },
    cwd: "/p", executable: "codex", env: {}, sandbox: "workspace-write", mcp: { url: "http://127.0.0.1:9/mcp",
      token: "t" }, external });
  for await (const _ of agent.turn(first, new AbortController().signal)) { /* drain */ }
  const config = sent.find((m) => m.method === "thread/start")!.params!.config as { mcp_servers: object };
  assert.deepEqual(Object.keys(config.mcp_servers).sort(), ["playwright", "rafi"]);
  assert.deepEqual((config.mcp_servers as Record<string, unknown>).playwright, external.playwright);
});
