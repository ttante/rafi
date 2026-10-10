import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { ProviderTurnPurpose } from "../src/providerPhase.js";

test("actual Claude SDK PreToolUse hook denies planning/repair/startup mutations before automatically accepted tools", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-boundary-"))), sentinel = join(root, "product.txt"); writeFileSync(sentinel, "original");
  const messages = new AsyncQueue<SDKMessage>(); let preTool!: HookCallback, preCompact!: HookCallback; let shouldCompact = false; const denials: string[] = [];
  const callbackOptions = { signal: new AbortController().signal };
  let pump!: Promise<void>;
  const query = (input: { prompt: AsyncIterable<SDKUserMessage>; options: { hooks: Record<string, Array<{ hooks: HookCallback[] }>>; abortController: AbortController } }): Query => {
    preTool = input.options.hooks.PreToolUse![0]!.hooks[0]!; preCompact = input.options.hooks.PreCompact![0]!.hooks[0]!;
    input.options.abortController.signal.addEventListener("abort", () => messages.close());
    pump = (async () => {
      for await (const _prompt of input.prompt) {
        if (shouldCompact) await preCompact({ hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null, session_id: "builder", cwd: root, transcript_path: join(root, "transcript") }, undefined, callbackOptions);
        for (const name of ["Write", "Edit", "Bash", "Agent"]) {
          const result = await preTool({ hook_event_name: "PreToolUse", tool_name: name, tool_input: { file_path: sentinel, command: "install && mutate" }, tool_use_id: name, session_id: "builder", cwd: root, transcript_path: join(root, "transcript") }, undefined, callbackOptions) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
          if (result.hookSpecificOutput?.permissionDecision === "deny") denials.push(result.hookSpecificOutput.permissionDecisionReason!);
          else writeFileSync(sentinel, "mutated");
        }
        messages.push({ type: "result", subtype: "success", session_id: "builder", result: "done", is_error: false, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {} } as unknown as SDKMessage);
      }
    })();
    return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), initializationResult: async () => ({}), interrupt: async () => messages.close() } as unknown as Query;
  };
  const adapter = Reflect.construct(ClaudeAdapter, [{ cwd: root, configRoot: root, sessionRole: "builder", permission: async () => ({ behavior: "allow" }) }, query]) as ClaudeAdapter;
  try {
    for (const purpose of ["planning", "preparation", "assessment", "contract-acceptance", "initialization", "response-repair"] as ProviderTurnPurpose[]) {
      await adapter.sendTurn("Attempt mutation", { purpose }); assert.equal(readFileSync(sentinel, "utf8"), "original");
    }
    assert.equal(denials.length, 24);
    adapter.enableContractEnforcement(); shouldCompact = true;
    await adapter.sendTurn("Implement", { purpose: "implementation" }); assert.equal(readFileSync(sentinel, "utf8"), "original");
    assert.equal(adapter.contractCompactionSequence(), 1); assert.ok(denials.some(reason => reason.includes("renewal")));
    shouldCompact = false; adapter.acceptContractDelivery(1);
    await adapter.sendTurn("Continue after host acceptance", { purpose: "implementation" }); assert.equal(readFileSync(sentinel, "utf8"), "mutated");
  } finally { await adapter.close(); await pump; rmSync(root, { recursive: true, force: true }); }
});

test("actual Codex turn/start RPC uses readOnly and never escalation for every non-implementation phase", async () => {
  const adapter = new CodexAdapter({ cwd: "/private/tmp", sessionRole: "builder", approvalPolicy: "on-request", permission: async () => ({ behavior: "allow" }) });
  const internal = adapter as unknown as { ensureThread(): Promise<void>; request(method: string, params: Record<string, unknown>): Promise<unknown>; waitFor(): Promise<unknown>; sendTurnInternal(text: string, policy: { purpose: ProviderTurnPurpose }): Promise<unknown> };
  let dispatched: Record<string, unknown> | undefined;
  internal.ensureThread = async () => {}; internal.waitFor = async () => ({ turn: { status: "completed" } });
  internal.request = async (method, params) => { assert.equal(method, "turn/start"); dispatched = params; return { turn: { id: "native" } }; };
  for (const purpose of ["planning", "preparation", "assessment", "contract-acceptance", "initialization", "response-repair"] as ProviderTurnPurpose[]) {
    await internal.sendTurnInternal("Inspect", { purpose }); assert.deepEqual(dispatched?.sandboxPolicy, { type: "readOnly", networkAccess: false }); assert.equal(dispatched?.approvalPolicy, "never");
  }
  await internal.sendTurnInternal("Implement", { purpose: "implementation" }); assert.equal((dispatched?.sandboxPolicy as { type: string }).type, "workspaceWrite");
  assert.equal(adapter.contractCapabilities().nativeCompactionBarrier, false);
});
