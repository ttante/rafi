// Item 25 (M2 plan 3.3): rafi's local MCP endpoint. The handler (tools/mcp.ts, C37) and the real server
// (deps/real/serve.ts): handshake, tools/list, tools/call, and the token, Host and Origin checks (ARCH 1.2, 6.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mcpHandler, RAFI_TOOLS } from "../../src/tools/mcp.js";
import { realServe } from "../../src/deps/real/serve.js";
import type { McpRequest } from "../../src/deps/types.js";

const TOKEN = "a".repeat(64);

function handler(calls: unknown[] = []) {
  return mcpHandler({
    token: TOKEN, tools: RAFI_TOOLS,
    call: async (name, args) => { calls.push({ name, args }); return { text: `ran ${name}`, isError: false }; },
  });
}

function req(body: unknown, o: Partial<McpRequest> = {}): McpRequest {
  return {
    method: "POST", path: "/mcp", remote: "127.0.0.1", port: 4242, body: JSON.stringify(body),
    headers: { host: "127.0.0.1:4242", authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
      accept: "application/json, text/event-stream" },
    ...o,
  };
}

const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
const note = (method: string) => ({ jsonrpc: "2.0", method, params: {} });

test("initialize answers with rafi's server info and the tools capability", async () => {
  const r = await handler()(req(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "codex", version: "0.164.0" } })));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.id, 1);
  assert.equal(body.result.serverInfo.name, "rafi");
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.ok(body.result.capabilities.tools);
});

test("notifications get 202 and no body; ping answers {}", async () => {
  const h = handler();
  const n = await h(req(note("notifications/initialized")));
  assert.equal(n.status, 202);
  assert.equal(n.body, "");
  assert.deepEqual(JSON.parse((await h(req(rpc("ping")))).body).result, {});
});

test("tools/list lists run_check and check_output with input schemas", async () => {
  const body = JSON.parse((await handler()(req(rpc("tools/list")))).body);
  const names = body.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, ["run_check", "check_output"]);
  for (const tool of body.result.tools) assert.equal(tool.inputSchema.type, "object");
  const runCheck = body.result.tools[0];
  assert.deepEqual(runCheck.inputSchema.required, ["command"]);
});

test("tools/call routes to the session's tool function and wraps its text", async () => {
  const calls: unknown[] = [];
  const body = JSON.parse((await handler(calls)(req(rpc("tools/call",
    { name: "run_check", arguments: { command: "npm test" } })))).body);
  assert.deepEqual(calls, [{ name: "run_check", args: { command: "npm test" } }]);
  assert.deepEqual(body.result, { content: [{ type: "text", text: "ran run_check" }], isError: false });
});

test("an unknown tool or method is a JSON-RPC error, not a crash", async () => {
  const h = handler();
  const unknownTool = JSON.parse((await h(req(rpc("tools/call", { name: "rm", arguments: {} })))).body);
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = JSON.parse((await h(req(rpc("resources/list")))).body);
  assert.equal(unknownMethod.error.code, -32601);
  const bad = await h(req(rpc("ping"), { body: "{not json" }));
  assert.equal(JSON.parse(bad.body).error.code, -32700);
});

test("no token, a wrong token or another session's token is 401 and nothing runs", async () => {
  const calls: unknown[] = [];
  const h = handler(calls);
  const call = rpc("tools/call", { name: "run_check", arguments: { command: "npm test" } });
  const { authorization: _drop, ...noAuth } = req(call).headers;
  for (const headers of [noAuth, { ...noAuth, authorization: `Bearer ${"b".repeat(64)}` },
    { ...noAuth, authorization: `Bearer ${TOKEN.slice(1)}` }, { ...noAuth, authorization: TOKEN }]) {
    const r = await h(req(call, { headers }));
    assert.equal(r.status, 401, JSON.stringify(headers));
  }
  assert.deepEqual(calls, []);
});

test("a Host other than 127.0.0.1:<port>, any Origin, or a non-loopback peer is 403", async () => {
  const calls: unknown[] = [];
  const h = handler(calls);
  const call = rpc("tools/call", { name: "run_check", arguments: { command: "npm test" } });
  const base = req(call).headers;
  for (const o of [{ headers: { ...base, host: "localhost:4242" } }, { headers: { ...base, host: "127.0.0.1:9999" } },
    { headers: { ...base, host: "evil.example:4242" } }, { headers: { ...base, origin: "http://evil.example" } },
    { headers: { ...base, origin: "null" } }, { remote: "10.0.0.5" }]) {
    assert.equal((await h(req(call, o))).status, 403, JSON.stringify(o));
  }
  assert.deepEqual(calls, []);
});

test("only POST to /mcp: GET is 405, another path is 404", async () => {
  const h = handler();
  assert.equal((await h(req(rpc("ping"), { method: "GET", body: "" }))).status, 405);
  assert.equal((await h(req(rpc("ping"), { path: "/other" }))).status, 404);
});

function post(url: string, body: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request(url, { method: "POST", headers, agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

test("the real server binds 127.0.0.1 on a random port, enforces Host, and refuses after close", async () => {
  const served = await realServe({ host: "127.0.0.1", handler: handler() });
  const url = new URL(served.url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(Number(url.port) > 0);
  assert.equal(url.pathname, "/mcp");
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const ok = await post(served.url, JSON.stringify(rpc("tools/list")), auth);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).result.tools.length, 2);
  const wrongHost = await post(served.url, JSON.stringify(rpc("tools/list")), { ...auth, host: "localhost" });
  assert.equal(wrongHost.status, 403);
  const noToken = await post(served.url, JSON.stringify(rpc("tools/list")), { "content-type": "application/json" });
  assert.equal(noToken.status, 401);
  await served.close();
  await assert.rejects(post(served.url, JSON.stringify(rpc("ping")), auth), /ECONNREFUSED/);
});

test("threat 23: a request body over 1 MB is refused before the handler; nothing runs", async () => {
  const calls: unknown[] = [];
  const served = await realServe({ host: "127.0.0.1", handler: handler(calls) });
  const big = JSON.stringify(rpc("tools/call", { name: "run_check", arguments: { command: "x".repeat(2 << 20) } }));
  const out = await post(served.url, big, { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" })
    .then((r) => r.status, (e: NodeJS.ErrnoException) => e.code);
  assert.ok([413, "ECONNRESET", "EPIPE"].includes(out as never), String(out));
  assert.deepEqual(calls, [], "the handler never ran");
  const ok = await post(served.url, JSON.stringify(rpc("ping")), { authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json" });
  assert.equal(ok.status, 200, "the server still answers");
  await served.close();
});

test("threat 20: the real session token is 32 random bytes, fresh each time", async () => {
  const { realDeps } = await import("../../src/deps/real/index.js");
  const random = realDeps().random;
  const [a, b] = [random.secret!(), random.secret!()];
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
