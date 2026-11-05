// D9 (ARCH 11.7 step 3; SCN 7.3): the fake `claude` executable in the process set. The built engine's Claude
// adapter, over the real Agent SDK query, spawns the fake from its PATH shim as a real process: one turn with a
// schema, activity, a permission request and a tool; then a cancelled turn; then the process ends on close.
// The fake records its environment, so S-CLI-2 step 4's ENV-5 check runs on a real child process too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type * as Agents from "@rafi-ai/engine/agents";
import type * as Real from "@rafi-ai/engine/deps/real";
import { writeShims } from "../fakes/shims.js";
import { tempRoot } from "../fixtures/common.js";
import { ENV5 } from "../harness/after-each.js";
import { builtEngine } from "../harness/process.js";

const schema = { name: "builder", json: { type: "object", properties: { kind: { type: "string" },
  summary: { type: "string" } }, required: ["kind", "summary"], additionalProperties: false } };
const request = (attempt: number): Agents.TurnRequest => ({ meta: { key: `T1:build:${attempt}`, role: "builder",
  ticket: "T1", step: "build", attempt }, message: "Build T1.", schema, grants: [], tools: [] });

async function turn(agent: Agents.Agent, attempt: number, cancelAfterMs?: number): Promise<Agents.AgentEvent[]> {
  const controller = new AbortController();
  const events: Agents.AgentEvent[] = [];
  if (cancelAfterMs !== undefined) setTimeout(() => controller.abort(), cancelAfterMs);
  for await (const event of agent.turn(request(attempt), controller.signal)) {
    events.push(event);
    if (event.kind === "permission") event.decide("allow");
  }
  return events;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
}

test("D9: the built Claude adapter drives the fake `claude` executable as a real process",
  { skip: process.platform === "win32" ? "a shebang shim; Windows uses claude.cmd" : false, timeout: 60_000 },
  async () => {
    const { claudeAgent } = await builtEngine<typeof Agents>("agents");
    const { realDeps } = await builtEngine<typeof Real>("deps/real");
    const dir = tempRoot("rafi-d9-process-");
    const shims = writeShims(dir, { codex: [], claude: [
      { activity: "working on T1", bash: "npm test", reply: { kind: "done", summary: "ok" } }, { hang: true },
    ] });
    const real = realDeps();
    const agent = claudeAgent({ deps: { agents: real.agents, clock: real.clock }, cwd: dir, executable: shims.claude });
    let first: Agents.AgentEvent[];
    let second: Agents.AgentEvent[];
    try {
      first = await turn(agent, 1);
      second = await turn(agent, 2, 300);
    } finally {
      await agent.close();
    }
    assert.deepEqual(first.map((e) => e.kind), ["activity", "permission", "tool", "usage", "reply"]);
    assert.deepEqual((first.at(-1) as { structured?: unknown }).structured, { kind: "done", summary: "ok" });
    assert.deepEqual(second.at(-1), { kind: "cancelled", confirmed: true });
    const log = () => readFileSync(shims.logs.claude, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(await waitFor(() => log().some((e) => e.op === "exit"), 10_000), "the fake process exited");
    const ops = log().map((e) => e.op);
    for (const op of ["start", "initialize", "permission", "turn", "interrupt"]) assert.ok(ops.includes(op), op);
    const start = log().find((e) => e.op === "start");
    assert.deepEqual(Object.keys(start.env).filter((name) => ENV5.some((p) => p.test(name))), [],
      "no ENV-5 variable on the process rafi started");
    assert.doesNotMatch(readFileSync(shims.logs.claude, "utf8"), /T1:build|"meta"/, "meta never reaches the wire");
  });
