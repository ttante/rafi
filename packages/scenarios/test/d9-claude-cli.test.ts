// D9 (ARCH 11.7): the installed Agent SDK drives the fake `claude` executable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AbortError, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const fakePath = fileURLToPath(new URL("../fakes/claude-cli.mjs", import.meta.url));
const schema = {
  type: "object",
  properties: { kind: { type: "string" }, summary: { type: "string" } },
  required: ["kind", "summary"],
  additionalProperties: false,
};

function shim(rules: unknown[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "rafi-d9-"));
  const log = path.join(dir, "log.jsonl");
  const scriptPath = path.join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ log, rules }));
  const shimPath = path.join(dir, "claude.mjs");
  const target = pathToFileURL(fakePath).href;
  writeFileSync(shimPath, `import { main } from ${JSON.stringify(target)};\nmain(${JSON.stringify(scriptPath)});\n`);
  const entries = () =>
    readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { shimPath, entries, dir };
}

function userTurn(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" };
}

function inputQueue() {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(message: SDKUserMessage) { items.push(message); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) { yield items.shift()!; continue; }
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

function startQuery(shimPath: string, cwd: string, abortController = new AbortController()) {
  const input = inputQueue();
  const permissions: string[] = [];
  const hooks: string[] = [];
  const q = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: shimPath,
      cwd,
      abortController,
      outputFormat: { type: "json_schema", schema },
      canUseTool: async (toolName, toolInput) => {
        permissions.push(`${toolName}:${String((toolInput as { command?: string }).command)}`);
        return { behavior: "allow", updatedInput: toolInput };
      },
      hooks: {
        SessionStart: [{ hooks: [async (hookInput) => { hooks.push(hookInput.hook_event_name); return {}; }] }],
      },
    },
  });
  return { q, input, permissions, hooks, abortController };
}

test("D9: structured_output arrives, the hook and canUseTool fire", async () => {
  const fake = shim([{ bash: "npm test", activity: "working", reply: { kind: "done", summary: "ok" } }]);
  const run = startQuery(fake.shimPath, fake.dir);
  run.input.push(userTurn("Build T1."));
  const seen: SDKMessage[] = [];
  for await (const message of run.q) {
    seen.push(message);
    if (message.type === "result") break;
  }
  run.input.close();
  const result = seen.find((m) => m.type === "result");
  assert.ok(result && result.type === "result" && result.subtype === "success");
  assert.deepEqual((result as { structured_output?: unknown }).structured_output, { kind: "done", summary: "ok" });
  assert.equal(result.usage.input_tokens, 120);
  assert.deepEqual(run.permissions, ["Bash:npm test"]);
  assert.deepEqual(run.hooks, ["SessionStart"]);
  assert.ok(seen.some((m) => m.type === "system" && m.subtype === "init"));
  const log = fake.entries();
  assert.ok(log.some((e) => e.op === "initialize" && e.schema === true));
  assert.ok(log.some((e) => e.op === "permission" && e.behavior === "allow"));
});

test("D9: interrupt ends a hanging turn without an SDK error", async () => {
  const fake = shim([{ behavior: "hang" }]);
  const run = startQuery(fake.shimPath, fake.dir);
  run.input.push(userTurn("Build T1."));
  let result: SDKMessage | undefined;
  for await (const message of run.q) {
    if (message.type === "system" && message.subtype === "init") await run.q.interrupt();
    if (message.type === "result") { result = message; break; }
  }
  run.input.close();
  assert.ok(result && result.type === "result" && result.subtype === "error_during_execution");
  assert.ok(fake.entries().some((e) => e.op === "interrupt"));
});

test("D9: abort ends the fake process", async () => {
  const fake = shim([{ behavior: "hang" }]);
  const run = startQuery(fake.shimPath, fake.dir);
  run.input.push(userTurn("Build T1."));
  let error: unknown;
  try {
    for await (const message of run.q) {
      if (message.type === "system" && message.subtype === "init") run.abortController.abort();
    }
  } catch (caught) {
    error = caught;
  }
  run.input.close();
  // An abort is the caller's choice: the SDK ends the iterator quietly or with its own AbortError, never another error.
  if (error) assert.ok(error instanceof AbortError, `unexpected ${String(error)}`);
  const deadline = Date.now() + 5000;
  while (!fake.entries().some((e) => e.op === "exit") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fake.entries().some((e) => e.op === "exit"), "the fake process exited");
});

test("D9: --resume keeps the session id", async () => {
  const fake = shim([{ reply: { kind: "done", summary: "again" } }]);
  const first = startQuery(fake.shimPath, fake.dir);
  first.input.push(userTurn("one"));
  let sessionId = "";
  for await (const message of first.q) {
    if (message.type === "result") { sessionId = message.session_id; break; }
  }
  first.input.close();
  const input = inputQueue();
  const resumed = query({
    prompt: input,
    options: { pathToClaudeCodeExecutable: fake.shimPath, cwd: fake.dir, resume: sessionId,
      outputFormat: { type: "json_schema", schema } },
  });
  input.push(userTurn("two"));
  let resumedId = "";
  for await (const message of resumed) {
    if (message.type === "result") { resumedId = message.session_id; break; }
  }
  input.close();
  assert.equal(resumedId, sessionId);
  assert.ok(fake.entries().some((e) => e.op === "start" && e.resumed === true));
});

test("D9: the extensionless `claude` PATH shim is spawned directly by the SDK", {
  skip: process.platform === "win32" ? "a shebang shim; Windows uses claude.cmd" : false,
}, async () => {
  const { writeShims } = await import("../fakes/shims.js");
  const dir = mkdtempSync(path.join(tmpdir(), "rafi-d9-shim-"));
  const shims = writeShims(dir, { codex: [], claude: [{ reply: { kind: "done", summary: "shim" } }] });
  const run = startQuery(shims.claude, dir);
  run.input.push(userTurn("Build T1."));
  let structured: unknown;
  for await (const message of run.q) {
    if (message.type !== "result") continue;
    structured = (message as { structured_output?: unknown }).structured_output;
    break;
  }
  run.input.close();
  assert.deepEqual(structured, { kind: "done", summary: "shim" });
});
