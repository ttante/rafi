import test from "node:test";
import assert from "node:assert/strict";
import { interpretUninstallInstruction } from "../src/uninstall.js";
import { nativeFixtureTurn } from "./helpers/nativeOutput.js";
import { nativePolicy, type RoleInstructionRunResult } from "ai-foreman/agent-run.js";

for (const mode of ["native", "text-only", "blocked"] as const) test(`uninstall interpretation accepts only native proposals: ${mode}`, async () => {
  const proposal = { operations: [{ kind: "keep", target: "README.md", reason: "User explicitly requested preservation", confidence: "high" }] };
  let calls = 0;
  const pending = interpretUninstallInstruction("/tmp", "Keep README.md", async options => {
    calls++;
    assert.equal(options.sandboxMode, "read-only");
    assert.equal(options.output?.operation, "uninstall-proposal");
    const result = mode === "text-only" ? { text: JSON.stringify(proposal), isError: false, numTurns: 1, costUsd: 0 }
      : nativeFixtureTurn(nativePolicy(options.output!), "interpreter", proposal, "codex", mode === "blocked" ? { kind: "blocked", reason: "Ambiguous target", nextAction: "Ask the user" } : undefined);
    return { turn: { result, status: { kind: "done" } } } as RoleInstructionRunResult;
  });
  if (mode === "native") assert.deepEqual(await pending, proposal);
  else await assert.rejects(pending, mode === "blocked" ? /blocked/ : /missing receipt|sealed selected dispatch tuple/);
  assert.equal(calls, 1);
});
