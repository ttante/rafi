// M2 plan 11.4 A7–A10 (threat 30, ARCH 7.11): the Codex builder runs under rafi's permission profile, never the
// legacy sandbox; approvals go to rafi, not Codex's reviewer; an escalation and a permissions request are refused.
// Against the Codex fake's on-request model (fidelity-codex-profile.test.ts). Red runs: .rafi-build/M2-red/add-<n>.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAgent, type AgentEvent, type TurnRequest } from "@rafi-ai/engine/agents";
import type { EventsExport } from "../checks/invariants.js";
import { codexStream } from "../fakes/codex/stream.js";
import { B, on } from "../fakes/script/behaviors.js";
import type { Behavior } from "../fakes/script/engine.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

type Msg = Record<string, unknown>;
const schema = { name: "builder", json: { type: "object" } };
const req = (o: Partial<TurnRequest> = {}): TurnRequest => ({ meta: { key: "T1:build:1", role: "builder",
  ticket: "T1", step: "build", attempt: 1 }, message: "Build T1.", schema, grants: [], tools: [], ...o });
const unavailable = (() => { throw new Error("unused"); }) as never;

async function drain(turn: AsyncIterable<AgentEvent>) {
  for await (const event of turn) if (event.kind === "permission") event.decide("deny");
}

function codex(o: Record<string, unknown> = {}, behaviors: Behavior[] = [{ reply: { kind: "done" } }]) {
  let i = 0;
  const fake = codexStream(() => behaviors[Math.min(i++, behaviors.length - 1)]!);
  const agent = codexAgent({ deps: { agents: { codex: () => fake.stream, claudeQuery: unavailable } },
    cwd: tempRoot(), executable: "codex", env: {}, ...o });
  const all = (method: string) => (fake.record.wire as Msg[]).filter((m) => m.method === method)
    .map((m) => m.params as Msg);
  return { agent, all, record: fake.record };
}

const ROOTS = { ".": "write", ".rafi": "read", ".rafi/cache": "write", ".tickets": "read", ".git": "read" };

test("A7: the builder's thread and every turn select rafi's profile; no legacy sandbox or sandboxPolicy is sent",
  async () => {
    const { agent, all, record } = codex({ sandbox: "workspace-write" });
    await drain(agent.turn(req(), new AbortController().signal));
    await drain(agent.turn(req({ grants: ["internet"] }), new AbortController().signal));
    const [start] = all("thread/start");
    assert.equal("sandbox" in start!, false, "no legacy sandbox on thread/start");
    assert.equal(start!.permissions, "rafi_builder");
    assert.deepEqual((start!.config as Msg).permissions, {
      rafi_builder: { extends: ":workspace", filesystem: { ":project_roots": ROOTS } },
      rafi_builder_internet: { extends: ":workspace", filesystem: { ":project_roots": ROOTS },
        network: { enabled: true } } });
    const turns = all("turn/start");
    assert.deepEqual(turns.map((t) => "sandboxPolicy" in t), [false, false], "no sandboxPolicy on any turn");
    assert.deepEqual(turns.map((t) => t.permissions), ["rafi_builder", "rafi_builder_internet"]);
    assert.deepEqual(record.active, ["rafi_builder", "rafi_builder_internet"], "the profile is active every turn");
    await agent.close();
  });

test("A8 and A12: approvalsReviewer is user on thread/start and thread/resume; QA keeps its read-only sandbox",
  async () => {
    const builder = codex({ sandbox: "workspace-write" });
    await drain(builder.agent.turn(req(), new AbortController().signal));
    assert.equal(builder.all("thread/start")[0]!.approvalsReviewer, "user");
    const resumed = codex({ sandbox: "workspace-write", threadId: "thread-9" });
    await drain(resumed.agent.turn(req(), new AbortController().signal));
    const resume = resumed.all("thread/resume")[0]!;
    assert.equal(resume.approvalsReviewer, "user");
    assert.equal(resume.permissions, "rafi_builder");
    const qa = codex({ sandbox: "read-only" });
    await drain(qa.agent.turn(req({ meta: { key: "k", role: "qa", ticket: "T1", step: "review" } }),
      new AbortController().signal));
    const qaStart = qa.all("thread/start")[0]!;
    assert.deepEqual([qaStart.sandbox, qaStart.approvalsReviewer, qaStart.permissions],
      ["read-only", "user", undefined]);
    assert.deepEqual(qa.all("turn/start")[0]!.sandboxPolicy, { type: "readOnly", networkAccess: false });
  });

/** A Codex build of T1 whose builder first runs `steps`; returns the output, rafi's answers and the events. */
async function codexBuild(steps: Msg[]) {
  const root = tempRoot();
  const project = fTestsLocal(root);
  configure(project, { harness: { targets: ["codex"] } });
  const computer = newComputer(root);
  computer.script.rules.push(on("builder T1#1", (meta, ctx) => {
    const base = (B.done() as (m: typeof meta, c: typeof ctx) => { steps?: Msg[] })(meta, ctx);
    return { ...base, steps: [...steps, ...(base.steps ?? [])] } as never;
  }));
  const rafi = rafiRunner(computer, project);
  const r = await rafi("start . --ticket T1 --steps 1 --no-qa");
  const answers = computer.sentToAgents.map((m) => JSON.parse(m) as Msg).filter((m) => !m.method && m.result)
    .map((m) => m.result as Msg);
  const events = (JSON.parse((await rafi("stats export")).out) as EventsExport).events;
  return { r, answers, events };
}

test("A9: a Codex escalation is declined with the blocked(permission) message and recorded, though the policy " +
  "would allow the command in the sandbox", async () => {
  const command = "X=ra; ${X}fi answer 1 1";
  const { r, answers, events } = await codexBuild([{ escalate: command }]);
  assert.deepEqual(answers.filter((a) => "decision" in a), [{ decision: "decline" }], "declined, never accepted");
  assert.match(r.err, /T1: refused shell: .*outside Codex's sandbox.*blocked\(permission\)/);
  const tool = events.find((e) => e.type === "turn.tool" && e.data.command === command);
  assert.equal(tool?.data.outcome, "cancelled", "the declined command is recorded");
});

test("A10: item/permissions/requestApproval is answered with no added permissions, in the schema's shape",
  async () => {
    const { r, answers } = await codexBuild([{ permissionsRequest: true }]);
    assert.deepEqual(answers.filter((a) => "permissions" in a || "decision" in a), [{ permissions: {} }]);
    assert.match(r.err, /T1: refused permissions: .*blocked\(permission\)/);
  });
