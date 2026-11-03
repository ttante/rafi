// M2 plan 1.1: does a Codex app-server thread reach rafi's local MCP endpoint, per thread, as it will ship?
//   node --conditions=source --import tsx scripts/live/rewrite-codex-mcp.mjs            (Part A, no model turn)
//   RAFI_LIVE_CODEX_MCP=1 RAFI_LIVE_DEADLINE=<future ISO time> … --part-b                (Part B, one tiny turn)
// Part A starts the engine's own endpoint (tools/mcp.ts + deps/real/serve.ts), starts `codex app-server`, opens two
// ephemeral threads with `config.mcp_servers.rafi` (URL plus a per-thread bearer header), and asks
// `mcpServerStatus/list { threadId }` for each. No turn is started, so nothing is billed.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { mcpHandler, RAFI_TOOLS } from "../../packages/engine/src/tools/mcp.ts";
import { realServe } from "../../packages/engine/src/deps/real/serve.ts";

const partB = process.argv.includes("--part-b");
if (partB) {
  const deadline = Date.parse(process.env.RAFI_LIVE_DEADLINE ?? "");
  if (process.env.RAFI_LIVE_CODEX_MCP !== "1" || !(deadline > Date.now())) {
    console.error("Part B needs RAFI_LIVE_CODEX_MCP=1 and a future RAFI_LIVE_DEADLINE (paid activity).");
    process.exit(2);
  }
}

const log = [];
function endpoint(name) {
  const token = randomBytes(32).toString("hex");
  const handler = mcpHandler({ token, tools: RAFI_TOOLS,
    call: async (tool, args) => ({ text: `run_check isn't built yet (${tool} ${JSON.stringify(args)})`, isError: true }) });
  const logged = async (request) => {
    const response = await handler(request);
    let method = "?";
    try { method = JSON.parse(request.body).method ?? "?"; } catch { /* not JSON */ }
    log.push({ endpoint: name, http: request.method, method, status: response.status,
      tokenOk: request.headers.authorization === `Bearer ${token}`, accept: request.headers.accept ?? null,
      session: request.headers["mcp-session-id"] ?? null });
    return response;
  };
  return { token, served: realServe({ host: "127.0.0.1", handler: logged }) };
}

function appServer(env) {
  const args = ["app-server", "--listen", "stdio://"];
  const child = spawn("codex", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let next = 0;
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    } else if (message.method && message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr.slice(-500)}`)), 60_000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  return { request, notify, close: () => { child.stdin.end(); child.kill("SIGTERM"); }, stderr: () => stderr };
}

function rafiConfig(url, token) {
  return { mcp_servers: { rafi: { url, http_headers: { Authorization: `Bearer ${token}` } } },
    sandbox_workspace_write: { network_access: false } };
}

async function main() {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "rafi-codex-mcp-")));
  const one = endpoint("one");
  const two = endpoint("two");
  const [s1, s2] = [await one.served, await two.served];
  const server = appServer({ ...process.env });
  const results = { part: partB ? "B" : "A", mode: "thread config", threads: [] };
  try {
    const init = await server.request("initialize", { clientInfo: { name: "rafi-mcp-probe", version: "0" } });
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    server.notify("initialized", {});
    for (const [name, s, e] of [["one", s1, one], ["two", s2, two]]) {
      const started = await server.request("thread/start", { cwd, sandbox: "workspace-write", ephemeral: true,
        approvalPolicy: "never", config: rafiConfig(s.url, e.token) });
      if (started.error) throw new Error(`thread/start: ${started.error.message}`);
      const threadId = started.result.thread.id;
      const status = await server.request("mcpServerStatus/list", { threadId, serverName: "rafi" });
      const item = status.result?.data?.find((d) => d.name === "rafi") ?? status.result?.data?.[0] ?? null;
      results.threads.push({ name, threadId, statusError: status.error?.message ?? null,
        tools: item ? Object.keys(item.tools ?? {}) : [], status: item ? { ...item, tools: undefined } : null });
    }
  } finally {
    server.close();
    await s1.close();
    await s2.close();
  }
  results.endpointLog = log;
  const perThread = ["one", "two"].map((n) => {
    const hits = log.filter((l) => l.endpoint === n && l.status === 200);
    const thread = results.threads.find((t) => t.name === n);
    return hits.some((h) => h.method === "initialize" && h.tokenOk) && hits.some((h) => h.method === "tools/list")
      && ["run_check", "check_output"].every((t) => thread?.tools.some((x) => x.endsWith(t)));
  });
  results.pass = perThread.every(Boolean);
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.pass ? 0 : 1;
}

await main();
