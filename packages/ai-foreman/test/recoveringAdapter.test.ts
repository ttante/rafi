import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveringAdapter } from "../src/adapters/recovering.js";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import type { AgentRuntime } from "../src/runtimeAuth.js";

const FAILURE: TurnResult = {
  text: "Claude failed during planning (authentication).",
  isError: true,
  numTurns: 1,
  costUsd: 0,
  failure: {
    runtime: "claude",
    phase: "planning",
    category: "authentication",
    executable: "/opt/company/bin/claude",
    cwd: "/tmp/project",
    diagnostics: "authentication_failed",
  },
};

const SUCCESS: TurnResult = {
  text: "done",
  isError: false,
  numTurns: 1,
  costUsd: 0,
};

class FakeAdapter implements BuilderAdapter {
  readonly agent: AgentRuntime;
  readonly prompts: string[] = [];

  constructor(runtime: AgentRuntime, private readonly result: TurnResult, private readonly session?: string) {
    this.agent = runtime;
  }

  async sendTurn(text: string): Promise<TurnResult> {
    this.prompts.push(text);
    return this.result;
  }

  sessionId(): string | undefined { return this.session; }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close(): Promise<void> {}
}

test("recovering adapter retries the failed turn with the same runtime and session", async () => {
  const first = new FakeAdapter("claude", FAILURE, "session-1");
  const second = new FakeAdapter("claude", SUCCESS, "session-1");
  const recreated: Array<{ runtime: AgentRuntime; session?: string }> = [];
  const adapter = new RecoveringAdapter({
    initial: first,
    runtime: "claude",
    enabled: true,
    allowSwitch: true,
    label: "planning",
    choose: async () => "retry",
    recreate: async (runtime, session) => {
      recreated.push({ runtime, session });
      return second;
    },
  });

  assert.equal(await adapter.sendTurn("plan"), SUCCESS);
  assert.deepEqual(recreated, [{ runtime: "claude", session: "session-1" }]);
  assert.deepEqual(first.prompts, ["plan"]);
  assert.deepEqual(second.prompts, ["plan"]);
  const event = await adapter.events()[Symbol.asyncIterator]().next();
  assert.deepEqual(event.value, { kind: "retry", provider: "claude", reason: "planning failed", managedBy: "rafi" });
  await adapter.close();
});

test("recovering adapter switches providers only as a fresh session", async () => {
  const recreated: Array<{ runtime: AgentRuntime; session?: string }> = [];
  const adapter = new RecoveringAdapter({
    initial: new FakeAdapter("claude", FAILURE, "claude-session"),
    runtime: "claude",
    enabled: true,
    allowSwitch: true,
    label: "builder turn",
    choose: async () => "switch",
    recreate: async (runtime, session) => {
      recreated.push({ runtime, session });
      return new FakeAdapter("codex", SUCCESS, "codex-session");
    },
  });

  assert.equal((await adapter.sendTurn("build")).isError, false);
  assert.equal(adapter.agent, "codex");
  assert.deepEqual(recreated, [{ runtime: "codex", session: undefined }]);
  await adapter.close();
});

test("recovering adapter returns the original failure when recovery is cancelled", async () => {
  let recreated = false;
  const adapter = new RecoveringAdapter({
    initial: new FakeAdapter("claude", FAILURE),
    runtime: "claude",
    enabled: true,
    allowSwitch: true,
    label: "QA turn",
    choose: async () => "cancel",
    recreate: async () => {
      recreated = true;
      return new FakeAdapter("claude", SUCCESS);
    },
  });

  assert.equal(await adapter.sendTurn("review"), FAILURE);
  assert.equal(recreated, false);
  await adapter.close();
});
