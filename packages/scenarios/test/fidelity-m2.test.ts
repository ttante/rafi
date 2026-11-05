// Milestone: M2
// Item 26 (M2 plan 3.3): the complete adapters over the fakes. Grants per role, model, effort and fast, the MCP
// attachment, usage (latest and total), provider error codes, two final messages, permission routing,
// AskUserQuestion answered at once, and the S-SCN-14 tool shapes; run_check over real HTTP from the Codex executable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAgent, codexAgent, type AgentEvent, type TurnRequest } from "@rafi-ai/engine/agents";
import { realClock, realCodex, realServe } from "@rafi-ai/engine/deps/real";
import { mcpHandler, RAFI_TOOLS } from "@rafi-ai/engine/tools";
import { claudeQuery } from "../fakes/claude/query.js";
import { codexStream } from "../fakes/codex/stream.js";
import type { Behavior } from "../fakes/script/engine.js";
import { writeShims } from "../fakes/shims.js";
import { tempRoot } from "../fixtures/common.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const clock = realClock();

const schema = { name: "builder", json: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"],
  additionalProperties: false } };
const req = (o: Partial<TurnRequest> = {}): TurnRequest => ({ meta: { key: "T1:build:1", role: "builder",
  ticket: "T1", step: "build", attempt: 1 }, message: "Build T1.", schema, grants: [], tools: [], ...o });
const unavailable = (() => { throw new Error("unused"); }) as never;

async function collect(turn: AsyncIterable<AgentEvent>, decide: "allow" | "deny" = "allow") {
  const events: Record<string, unknown>[] = [];
  for await (const event of turn) {
    if (event.kind === "permission") {
      events.push({ kind: "permission", request: event.request });
      event.decide(decide);
    } else {
      events.push(event as unknown as Record<string, unknown>);
    }
  }
  return events;
}

function codex(behaviors: Behavior[], o: Record<string, unknown> = {}) {
  let i = 0;
  const fake = codexStream(() => behaviors[Math.min(i++, behaviors.length - 1)]!);
  const agent = codexAgent({ deps: { clock, agents: { codex: () => fake.stream, claudeQuery: unavailable } },
    cwd: tempRoot(), executable: "codex", env: {}, ...o });
  return { agent, wire: fake.record.wire as Record<string, unknown>[] };
}

const sent = (wire: Record<string, unknown>[], method: string) =>
  wire.find((m) => m.method === method)?.params as Record<string, unknown>;

test("Codex builder: rafi's profile, network off, model, effort, fast and the rafi MCP server", async () => {
  const { agent, wire } = codex([{ reply: { kind: "done" } }], { model: "m-test", effort: "high", fast: true,
    mcp: { url: "http://127.0.0.1:40001/mcp", token: "tok" } });
  await collect(agent.turn(req(), new AbortController().signal));
  const start = sent(wire, "thread/start");
  assert.equal(start.permissions, "rafi_builder", "M2 plan 11 (A7): the profile, not the legacy sandbox");
  assert.equal(start.model, "m-test");
  const config = start.config as Record<string, Record<string, unknown>>;
  assert.deepEqual(config.mcp_servers!.rafi, { url: "http://127.0.0.1:40001/mcp",
    http_headers: { Authorization: "Bearer tok" } });
  assert.equal((config.permissions!.rafi_builder as { network?: unknown }).network, undefined, "network off");
  const turn = sent(wire, "turn/start");
  assert.equal(turn.effort, "high");
  assert.equal(turn.serviceTier, "fast");
  assert.equal(turn.permissions, "rafi_builder");
  await agent.close();
});

test("Codex QA: read-only thread and turn; internet granted turns the network on", async () => {
  const qa = codex([{ reply: { kind: "done" } }], { sandbox: "read-only" });
  await collect(qa.agent.turn(req({ meta: { key: "k", role: "qa", ticket: "T1", step: "review" } }),
    new AbortController().signal));
  assert.equal(sent(qa.wire, "thread/start").sandbox, "read-only");
  assert.deepEqual(sent(qa.wire, "turn/start").sandboxPolicy, { type: "readOnly", networkAccess: false });
  const net = codex([{ reply: { kind: "done" } }], { sandbox: "read-only" });
  await collect(net.agent.turn(req({ meta: { key: "k", role: "qa", ticket: "T1", step: "review" },
    grants: ["internet"] }), new AbortController().signal));
  assert.equal((sent(net.wire, "turn/start").sandboxPolicy as { networkAccess: boolean }).networkAccess, true);
});

test("Codex usage reports the latest sample and the total; capabilities name loopback-without-internet", async () => {
  const { agent } = codex([{ reply: { kind: "done" }, usage: { inputTokens: 500, outputTokens: 40 } }]);
  const events = await collect(agent.turn(req(), new AbortController().signal));
  const usage = events.find((e) => e.kind === "usage")!;
  assert.equal(usage.input, 500);
  assert.equal(usage.output, 40);
  assert.deepEqual(usage.last, { total: 20 });
  assert.equal(agent.capabilities().localServersWithoutInternet, false);
});

test("Codex errors: quota with its reset time, auth, and two final messages", async () => {
  const quota = codex([{ error: "usage limit reached", errorCode: "quota", resetAt: "2026-11-01T19:00:00Z" }]);
  const q = (await collect(quota.agent.turn(req(), new AbortController().signal))).at(-1)!;
  assert.deepEqual([q.kind, q.code, q.resetAt], ["error", "quota", "2026-11-01T19:00:00Z"]);
  const auth = codex([{ error: "401 Unauthorized: please log in", errorCode: "auth" }]);
  assert.equal((await collect(auth.agent.turn(req(), new AbortController().signal))).at(-1)!.code, "auth");
  const two = codex([{ reply: { kind: "done" }, twoFinals: { kind: "blocked" } }]);
  const reply = (await collect(two.agent.turn(req(), new AbortController().signal))).at(-1)!;
  assert.equal(reply.kind, "reply");
  assert.equal(reply.finals, 2);
});

test("Codex: a declined permission is sent back as decline; an edit is a file-change permission with its path",
  async () => {
    // Real on-request asks only for an edit outside the sandbox (M2 plan 11.4 step 6), so the edit is outside the root.
    const { agent, wire } = codex([{ steps: [{ edit: "../T1.txt", content: "x" }], reply: { kind: "done" } }]);
    const events = await collect(agent.turn(req(), new AbortController().signal), "deny");
    const permission = events.find((e) => e.kind === "permission")!.request as Record<string, unknown>;
    assert.equal(permission.tool, "file-change");
    assert.match(String(permission.path), /T1\.txt$/);
    assert.ok(wire.some((m) => (m.result as { decision?: string } | undefined)?.decision === "decline"));
  });

test("Codex compaction (ARCH 11.2): the threshold set at spawn, the window reported, a compaction reported",
  async () => {
    const spawned: string[][] = [];
    const fake = codexStream(() => ({ steps: [{ compact: true }], reply: { kind: "done" }, contextWindow: 200_000 }));
    const deps = { clock, agents: { codex: (o: { args: readonly string[] }) => { spawned.push([...o.args]);
      return fake.stream; }, claudeQuery: unavailable } };
    const agent = codexAgent({ deps, cwd: tempRoot(), executable: "codex", env: {},
      compaction: { thresholdPercent: 65, contextWindow: 200_000 } });
    const events = await collect(agent.turn(req(), new AbortController().signal));
    assert.deepEqual(spawned[0], ["app-server", "--listen", "stdio://", "-c", "model_auto_compact_token_limit=130000",
      "-c", 'model_auto_compact_token_limit_scope="total"']);
    assert.equal(events.find((e) => e.kind === "usage")!.window, 200_000, "the context window is reported");
    const compacted = events.filter((e) => e.kind === "activity" && e.compaction === true);
    assert.equal(compacted.length, 1, "one compaction, reported once, when the provider reports it");
    const plain = codex([{ reply: { kind: "done" } }]);
    const none = await collect(plain.agent.turn(req(), new AbortController().signal));
    assert.ok(!none.some((e) => e.compaction), "no compaction claimed without one");
  });

test("Codex compaction: without a threshold the app-server keeps its own default", async () => {
  const spawned: string[][] = [];
  const fake = codexStream(() => ({ reply: { kind: "done" } }));
  const agent = codexAgent({ deps: { clock, agents: { codex: (o) => { spawned.push([...o.args]); return fake.stream; },
    claudeQuery: unavailable } }, cwd: tempRoot(), executable: "codex", env: {} });
  await collect(agent.turn(req(), new AbortController().signal));
  assert.deepEqual(spawned[0], ["app-server", "--listen", "stdio://"]);
});

test("threat 22: the session token reaches Codex only in the thread config over stdio, never argv or env",
  async () => {
    const spawned: { args: readonly string[]; env?: unknown }[] = [];
    const fake = codexStream(() => ({ reply: { kind: "done" } }));
    const token = "t0k".repeat(20);
    const agent = codexAgent({ deps: { clock, agents: { codex: (o) => { spawned.push(o); return fake.stream; },
      claudeQuery: unavailable } }, cwd: tempRoot(), executable: "codex", env: { PATH: "/usr/bin" },
    mcp: { url: "http://127.0.0.1:40001/mcp", token } });
    await collect(agent.turn(req(), new AbortController().signal));
    assert.equal(spawned.length, 1);
    assert.doesNotMatch(JSON.stringify(spawned[0]), new RegExp(token), "not in the app-server's argv or env");
    const start = sent(fake.record.wire as Record<string, unknown>[], "thread/start");
    assert.match(JSON.stringify(start), new RegExp(token), "only in thread/start's config");
  });

function claude(behaviors: Behavior[], o: Record<string, unknown> = {}) {
  let i = 0;
  const options: Record<string, unknown>[] = [];
  const query = claudeQuery(() => behaviors[Math.min(i++, behaviors.length - 1)]!);
  const agent = claudeAgent({ deps: { clock, agents: { codex: unavailable, claudeQuery: (p) => {
    options.push(p.options);
    return query(p);
  } } }, cwd: tempRoot(), ...o });
  return { agent, options };
}

test("Claude builder and QA: setting sources, sandbox, no TMPDIR from rafi for QA (P20), the rafi tools, model, effort",
  async () => {
    const tools = { type: "sdk", name: "rafi" };
    const builder = claude([{ reply: { kind: "done" } }], { model: "m-test", effort: "high", tools });
    await collect(builder.agent.turn(req(), new AbortController().signal));
    const b = builder.options[0]!;
    assert.deepEqual(b.settingSources, ["user", "project", "local"]);
    assert.equal(b.model, "m-test");
    assert.equal(b.effort, "high");
    assert.deepEqual((b.mcpServers as Record<string, unknown>).rafi, tools);
    const sandbox = b.sandbox as { network: unknown; filesystem: { allowWrite: string[] } };
    assert.deepEqual(sandbox.network, { allowedDomains: [], deniedDomains: ["*"] });
    assert.deepEqual(sandbox.filesystem.allowWrite, [b.cwd]);
    // ARCH 7.11 (P20, live check f): QA's temp files go to Claude Code's own sandbox temp folder.
    // The session's env comes from agentEnv, which drops TMPDIR for Claude QA (security-sec "review 2, finding 3").
    const qa = claude([{ reply: { kind: "done" } }], { writable: false, env: { PATH: "/usr/bin" } });
    await collect(qa.agent.turn(req({ meta: { key: "k", role: "qa", ticket: "T1", step: "review" } }),
      new AbortController().signal));
    const q = qa.options[0]!;
    assert.deepEqual(q.settingSources, ["user"]);
    assert.deepEqual(q.env, { PATH: "/usr/bin" }, "the adapter adds no TMPDIR or scratch of its own for QA");
    assert.deepEqual((q.sandbox as { filesystem: unknown }).filesystem, { allowWrite: [], denyWrite: [q.cwd] });
  });

test("Claude AskUserQuestion is answered at once: a question event, and the tool is refused with needs-input",
  async () => {
    const { agent } = claude([{ steps: [{ ask: { question: "Which currency?", options: ["USD", "EUR"] } }],
      reply: { kind: "needs-input" } }]);
    const events = await collect(agent.turn(req(), new AbortController().signal));
    assert.deepEqual(events.find((e) => e.kind === "question"), { kind: "question", text: "Which currency?",
      choices: ["USD", "EUR"] });
    assert.ok(!events.some((e) => e.kind === "permission"), "never reaches the permission policy");
    assert.equal(events.at(-1)!.kind, "reply");
  });

test("Claude S-SCN-14 tool shapes: outcomes, call ids, a duplicate shown once, TIME_ELAPSED as unknown", async () => {
  const { agent } = claude([{ steps: [{ toolFail: 2 }, { toolShapes: true }], reply: { kind: "done" } }]);
  const tools = (await collect(agent.turn(req(), new AbortController().signal)))
    .filter((e) => e.kind === "tool").map((e) => e.run as Record<string, unknown>);
  assert.deepEqual(tools.map((t) => t.outcome),
    ["failed", "failed", "failed", "timed-out", "cancelled", "completed", "completed", "unknown"]);
  assert.ok(tools.every((t) => typeof t.callId === "string" && t.callId), "every completion names its call id");
  assert.equal(new Set(tools.map((t) => t.callId)).size, tools.length, "the duplicate result shows once");
  assert.match(String(tools[0]!.error), /does not exist/i);
  const elapsed = tools.find((t) => t.tool === "Bash" && t.command === "sleep 1");
  assert.equal(elapsed?.durationMs, null);
});

test("Claude error_max_structured_output_retries is an error with that detail; api_retry is activity", async () => {
  const { agent } = claude([{ resultSubtype: "error_max_structured_output_retries" }]);
  const last = (await collect(agent.turn(req(), new AbortController().signal))).at(-1)!;
  assert.deepEqual([last.kind, last.detail], ["error", "error_max_structured_output_retries"]);
});

test("the Codex executable calls run_check over real HTTP with the token from its thread config",
  { skip: process.platform === "win32" ? "PATH shims need a shell on Windows" : false }, async () => {
    const dir = tempRoot("rafi-fidelity-");
    const calls: unknown[] = [];
    const token = "z".repeat(64);
    const served = await realServe({ host: "127.0.0.1", handler: mcpHandler({ token, tools: RAFI_TOOLS,
      call: async (name, args) => {
        calls.push({ name, args });
        return { text: "run 1: passed (exit 0)", isError: false };
      } }) });
    const shims = writeShims(dir, { codex: [{ steps: [{ runCheck: "npm test" }], reply: { kind: "done" } }],
      claude: [] });
    const agent = codexAgent({ deps: { clock, agents: { codex: realCodex, claudeQuery: unavailable } }, cwd: dir,
      executable: shims.codex, env: { PATH: process.env.PATH }, mcp: { url: served.url, token } });
    const events = await collect(agent.turn(req(), new AbortController().signal));
    assert.deepEqual(calls, [{ name: "run_check", args: { command: "npm test" } }]);
    const tool = events.find((e) => e.kind === "tool")!.run as Record<string, unknown>;
    assert.equal(tool.tool, "mcp:rafi/run_check");
    await agent.close();
    await served.close();
  });

test("threat 28: Claude's sandboxed Bash still asks rafi's policy, stays in the sandbox, can't write rafi's folders",
  async () => {
    const { agent, options } = claude([{ steps: [{ shell: "rafi answer 1 1" }], reply: { kind: "done" } }]);
    const events = await collect(agent.turn(req(), new AbortController().signal), "deny");
    const sandbox = options[0]!.sandbox as Record<string, unknown> & { filesystem: { denyWrite?: string[] } };
    assert.equal(sandbox.autoAllowBashIfSandboxed, false, "Claude Code's default (true) skips canUseTool");
    assert.equal(sandbox.allowUnsandboxedCommands, false, "dangerouslyDisableSandbox would run outside it");
    const cwd = String(options[0]!.cwd);
    // M5 (P48): rafi-config.yaml joins the builder's read-only list.
    assert.deepEqual(sandbox.filesystem.denyWrite, [".git", ".rafi", ".tickets", "rafi-config.yaml"]
      .map((d) => path.join(cwd, d)));
    const asked = events.filter((e) => e.kind === "permission")
      .map((e) => e.request as { tool: string; command: string });
    assert.deepEqual(asked.map((r) => [r.tool, r.command]), [["Bash", "rafi answer 1 1"]], "the policy saw it");
  });

test("threat 29: tools the project's settings allow, and reads Claude allows itself, still meet rafi's policy",
  async () => {
    const cwd = tempRoot();
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: {
      allow: ["Write", "Bash(*)"], defaultMode: "acceptEdits" } }));
    const { agent } = claude([{ steps: [{ edit: ".rafi/state.sqlite3", content: "forged" }], reply: { kind: "done" } },
      { steps: [{ read: "src/a.ts" }], reply: { kind: "done" } }], { cwd });
    const first = await collect(agent.turn(req(), new AbortController().signal), "deny");
    const asked = first.find((e) => e.kind === "permission")?.request as { tool: string; path: string } | undefined;
    assert.equal(asked?.tool, "Write", "the allowed Write reached rafi's policy");
    assert.equal(existsSync(path.join(cwd, ".rafi", "state.sqlite3")), false, "the policy's deny held");
    const repair = await collect(agent.turn(req({ repair: true }), new AbortController().signal), "allow");
    assert.ok(repair.some((e) => e.kind === "permission" && (e.request as { tool: string }).tool === "Read"),
      "a read in a repair turn reached rafi's policy");
    assert.equal(repair.filter((e) => e.kind === "tool" && (e.run as { outcome: string }).outcome === "completed")
      .length, 0, "and was refused: no tools during a repair");
  });

// Found by the live adapter check (M2 plan 10.8): real codex 0.164 answers every request before `initialize` with
// -32600 "Not initialized"; the fake now does the same.
test("live 1: Codex sends initialize, then the initialized notification, before thread/start and model/list",
  async () => {
    const { agent, wire } = codex([{ reply: { kind: "done" } }]);
    const events = await collect(agent.turn(req(), new AbortController().signal));
    assert.equal(events.at(-1)!.kind, "reply", JSON.stringify(events.at(-1)));
    assert.deepEqual(wire.slice(0, 3).map((m) => m.method), ["initialize", "initialized", "thread/start"]);
    const init = wire[0]!.params as { clientInfo: { name: string }; capabilities: { experimentalApi: boolean } };
    assert.equal(init.clientInfo.name, "rafi");
    assert.equal(init.capabilities.experimentalApi, true, "as 0.10.x sends it (ai-foreman/src/adapters/codex.ts:702)");
    assert.equal("id" in wire[1]!, false, "initialized is a notification");
    await agent.close();
    const listing = codex([]);
    assert.ok((await listing.agent.models!())?.length, "model/list works as the first call too");
    assert.equal(listing.wire.filter((m) => m.method === "initialize").length, 1);
  });

// Live check 10.8: SDK 0.3.159's query() reads `systemPrompt` (a string, or the claude_code preset with `append`)
// and silently drops `appendSystemPrompt`, so rafi's standing instructions never reached real Claude.
test("live 2: Claude's standing instructions go in systemPrompt's claude_code preset append", async () => {
  const { agent, options } = claude([{ reply: { kind: "done" } }]);
  await collect(agent.turn(req({ instructions: "Standing rule: say PAPAYA." }), new AbortController().signal));
  assert.deepEqual(options[0]!.systemPrompt, { type: "preset", preset: "claude_code",
    append: "Standing rule: say PAPAYA." });
  assert.equal("appendSystemPrompt" in options[0]!, false, "not an Agent SDK option");
});

// Live check 10.8 (b): on real Claude Code 2.1.317 (macOS), `allowLocalBinding` with no allowed domains let a
// test listen on 127.0.0.1 and connect to itself while a public connect got EPERM.
test("live 3: Claude's sandbox allows local servers without internet: the capability, and the grant's settings",
  async () => {
    const { agent, options } = claude([{ reply: { kind: "done" } }]);
    assert.equal(agent.capabilities().localServersWithoutInternet, true);
    await collect(agent.turn(req({ grants: ["local-servers"] }), new AbortController().signal));
    assert.deepEqual((options[0]!.sandbox as { network: unknown }).network,
      { allowedDomains: [], deniedDomains: ["*"], allowLocalBinding: true });
  });
