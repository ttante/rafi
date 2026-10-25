import { structuredCapacityPages } from "./structured-capacity-fixture.mjs";
import type { BuilderAdapter, BuilderAdapterOptions } from "../../packages/ai-foreman/src/adapters/types.js";
/** Capacity experiment using the registered native ticket-page contract. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerWireContract, ticketPopulationPageOutput, validateStructuredCandidate } from "../../packages/spec/src/index.js";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { CodexAdapter } from "../../packages/ai-foreman/src/adapters/codex.js";
import { journalStructuredDispatch, nativePolicy } from "../../packages/ai-foreman/src/structuredOperation.js";
import { runSupervisedStructuredLive } from "./structured-live-supervisor.mjs";
import { createLiveWorkspace } from "./workspace.mjs";

await runSupervisedStructuredLive("structured-capacity-probe", async (supervisor) => {
  const { pages, maxTickets } = structuredCapacityPages();
  const { streamTicketPopulation } = await import("../../packages/ai-foreman/src/ticketPopulationPaging.js");
  const { workspaceRoot: cwd, evidenceRoot } = createLiveWorkspace("structured-capacity-probe", { evidenceRoot: supervisor.evidenceRoot });
  execFileSync("git", ["init", "-q"], { cwd });
  const report: Record<string, unknown> = { kind: "structured-capacity-probe", maxTickets, expectedPages: pages.length, results: [] };
  const save = () => writeFileSync(join(evidenceRoot, "results.json"), JSON.stringify(report, null, 2));
  save();
  try {
    for (const provider of supervisor.config.providers) {
      supervisor.check();
      const options: BuilderAdapterOptions = { cwd, queryBudget: supervisor,
        runtimeExecutable: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_EXECUTABLE ?? "claude" : "codex",
        model: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_MODEL ?? "sonnet" : process.env.RAFI_LIVE_CODEX_MODEL,
        permission: async () => ({ behavior: "deny", message: "No domain tools in capacity fixture" }),
        turnDeadlineMs: Math.min(90_000, supervisor.config.deadline - Date.now()) };
      const adapter: BuilderAdapter = provider === "claude" ? await ClaudeAdapter.create(options) : new CodexAdapter(options);
      supervisor.track(() => adapter.close());
      try {
        let pageIndex = 0;
        const result = await streamTicketPopulation({ projectDir: cwd, interviewId: "capacity", correction: 0,
          instruction: `Serialization fixture only. No tools. Return exactly the requested ordinal page from this native page sequence, one page per host request: ${JSON.stringify(pages)}`,
          checkpoint() {},
          async dispatch(instruction, policy) {
            const turn = await journalStructuredDispatch(cwd, adapter, instruction, nativePolicy(policy.output, { ...policy, responseOnly: true }),
              (text, sealed) => adapter.sendTurn(text, sealed));
            assert.deepEqual(validateStructuredCandidate(ticketPopulationPageOutput, turn.structured,
              providerWireContract(ticketPopulationPageOutput, provider), turn.selectedDispatch!), pages[pageIndex++]);
            return { result: turn, status: { kind: "done" } };
          } });
        assert.equal(pageIndex, pages.length, "Provider did not complete every forced page");
        (report.results as unknown[]).push({ provider, pages: pageIndex, proposal: result.proposal });
      } finally { await adapter.close(); }
    }
  } finally { report.finishedAt = new Date().toISOString(); save(); }
});
