import assert from "node:assert/strict";
import { test } from "node:test";
import { collectCreateStackInterview, type CreateStackPrompts } from "../src/createStackInterview.js";
import { defaultAnswers } from "../src/project.js";
import type { DiscoveryResult } from "../src/discovery.js";

function discovery(frontend: string, backend: string, database: string): DiscoveryResult {
  return {
    projectDir: "/existing-app",
    initialized: false,
    answers: { online: [], background: [], local: [] },
    inventory: [],
    output: "",
    envelope: { version: 1, detected_stack: { frontend, backend, database } },
    savedSources: [],
    snapshots: [],
    pendingSources: [],
  };
}

function prompts(responses: unknown[]): { prompts: CreateStackPrompts; calls: Array<{ kind: string; options: Record<string, unknown> }>; info: string[] } {
  const calls: Array<{ kind: string; options: Record<string, unknown> }> = [];
  const info: string[] = [];
  const next = () => {
    const value = responses.shift();
    assert.notEqual(value, undefined, "unexpected prompt");
    return Promise.resolve(value);
  };
  return {
    prompts: {
      text: (options) => { calls.push({ kind: "text", options }); return next(); },
      confirm: (options) => { calls.push({ kind: "confirm", options }); return next(); },
      select: (options) => { calls.push({ kind: "select", options }); return next(); },
      isCancel: () => false,
      info: (message) => { info.push(message); },
    },
    calls,
    info,
  };
}

test("existing-app review can accept detected stack without repeating stack prompts", async () => {
  const input = prompts(["existing", true, "accept"]);
  const checkpoints: Array<[string, string, unknown]> = [];
  const result = await collectCreateStackInterview({
    targetDir: "/existing-app",
    answers: defaultAnswers(),
    prompts: input.prompts,
    checkpoint: (checkpoint, key, value) => { checkpoints.push([checkpoint, key, value]); },
    discover: async (options) => {
      assert.deepEqual(options, { project: "/existing-app", suppressNextCommand: true });
      return discovery("Next.js", "Fastify", "PostgreSQL");
    },
  });

  assert.deepEqual(result, { frontend: "Next.js", backend: "Fastify", database: "PostgreSQL", planningSources: undefined });
  assert.deepEqual(input.calls.map((call) => call.kind), ["select", "confirm", "select"]);
  assert.match(input.info[0]!, /Frontend: Next\.js[\s\S]*Backend: Fastify[\s\S]*Database: PostgreSQL/);
  assert.deepEqual(checkpoints, [
    ["existing-app-review", "projectKind", "existing"],
    ["stack-review", "runDiscovery", true],
    ["cloud", "stackReviewAccepted", true],
  ]);
});

test("existing-app review edit path pre-fills and saves the standard stack answers", async () => {
  const input = prompts(["existing", true, "edit", "React", "NestJS", "SQLite"]);
  const checkpoints: Array<[string, string, unknown]> = [];
  const result = await collectCreateStackInterview({
    targetDir: "/existing-app",
    answers: defaultAnswers(),
    prompts: input.prompts,
    checkpoint: (checkpoint, key, value) => { checkpoints.push([checkpoint, key, value]); },
    discover: async () => discovery("Vue", "Express", "MySQL"),
  });

  assert.deepEqual(result, { frontend: "React", backend: "NestJS", database: "SQLite", planningSources: undefined });
  const textCalls = input.calls.filter((call) => call.kind === "text");
  assert.deepEqual(textCalls.map((call) => call.options.initialValue), ["Vue", "Express", "MySQL"]);
  assert.deepEqual(checkpoints, [
    ["existing-app-review", "projectKind", "existing"],
    ["stack-review", "runDiscovery", true],
    ["frontend", "stackReviewAccepted", false],
    ["backend", "frontend", "React"],
    ["database", "backend", "NestJS"],
    ["cloud", "database", "SQLite"],
  ]);
});
