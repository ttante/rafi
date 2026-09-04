import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { Command } from "commander";
import type { EffortLevel, ProviderSessionUsage } from "../adapters/types.js";
import { createRoleBuilder, readOnlyPermissionConfig } from "../agentRun.js";
import type { ExternalDiagnosticMode } from "../diagnostics.js";
import { Log } from "../log.js";
import { buildManagerEvidencePacket, buildManagerProjectPacket, type ManagerPacketState } from "../managerPacket.js";
import { ManagerSessionRecorder } from "../observability.js";
import { collectManagerProjectDiagnostics, executeManagerEvidenceRequest, MANAGER_LOOKUP_MAX_ROUNDS, parseManagerEvidenceRequest, resolveManagerQuestionRuns } from "../projectDiagnostics.js";

export interface ManagerCommandOptions {
  resolveProject?: (project: string | undefined) => string;
  requireProject?: boolean;
}

export function buildManagerCommand(options: ManagerCommandOptions = {}): Command {
  return new Command("manager")
    .description("Ask a read-only Manager about all retained builds in a project.")
    .argument(options.requireProject ? "<project>" : "[project]", "project directory")
    .option("--run <run-id>", "set the initial focused build run")
    .option("--ask <question>", "ask one question and exit")
    .option("--agent <runtime>", "claude | codex")
    .option("--model <model>", "provider model ID")
    .option("--effort <level>", "low | medium | high | xhigh")
    .option("--fast", "use the provider fast mode")
    .option("--external <mode>", "auto | on | off", "auto")
    .action(async (project: string, opts: Record<string, unknown>) => {
      const root = options.resolveProject ? options.resolveProject(project) : resolve(project ?? ".");
      await runManager(root, {
        runId: stringOption(opts.run), ask: stringOption(opts.ask), agent: stringOption(opts.agent), model: stringOption(opts.model),
        effort: stringOption(opts.effort) as EffortLevel | undefined, fast: Boolean(opts.fast), external: validateExternal(opts.external),
      });
    });
}

export async function runManager(projectDir: string, options: { runId?: string; ask?: string; agent?: string; model?: string; effort?: EffortLevel; fast?: boolean; external?: ExternalDiagnosticMode }): Promise<void> {
  if (!options.ask && (!input.isTTY || !output.isTTY)) throw new Error("non-TTY Manager use requires --ask <question>");
  const initialCollection = collectManagerProjectDiagnostics(projectDir, { initialFocusRunId: options.runId, question: options.ask, external: "off" });
  const initialReport = initialCollection.report;
  let currentFocusRunId = initialReport.initialFocusRunId;
  let referencedRunIds: string[] = [currentFocusRunId];
  output.write(`rafi manager: ${initialReport.totalRunCount} retained build run${initialReport.totalRunCount === 1 ? "" : "s"}\n`);
  output.write(`rafi manager: verified active run ${initialReport.verifiedActiveRunId ?? "none"}\n`);
  output.write(`rafi manager: initial focus ${currentFocusRunId}\n`);
  if (initialReport.staleRecoveryRunIds.length) output.write(`rafi manager: stale recovery state ${initialReport.staleRecoveryRunIds.join(", ")}\n`);
  const metadata = new ManagerSessionRecorder(projectDir);
  const managerSessionId = randomUUID();
  const startedAt = new Date().toISOString();
  metadata.record({ sessionId: managerSessionId, runId: initialReport.initialFocusRunId, startedAt, reportDigest: initialReport.digest, scope: "project", latestFocusRunId: currentFocusRunId, projectReportDigest: initialReport.projectDigest });
  let role: Awaited<ReturnType<typeof createRoleBuilder>> | undefined;
  let packetState: ManagerPacketState | undefined;
  let usage: ProviderSessionUsage | undefined;
  let lookupRounds = 0;
  let lookupOperations = 0;
  try {
    const activeRole = role = await createRoleBuilder({ projectDir, role: "manager", agent: options.agent, model: options.model, effort: options.effort, fast: options.fast,
      yes: true, allowSwitch: false, label: "Manager", log: new Log(), permissionConfig: denyManagerTools(), sandboxMode: "read-only", persistSessionBindings: false });
    const ask = async (question: string): Promise<void> => {
      const refreshed = collectManagerProjectDiagnostics(projectDir, { initialFocusRunId: initialReport.initialFocusRunId, currentFocusRunId, referencedRunIds, question, external: "off" });
      const resolved = resolveManagerQuestionRuns(refreshed.allSummaries, question, currentFocusRunId, referencedRunIds);
      currentFocusRunId = resolved.focusRunId;
      referencedRunIds = resolved.referencedRunIds.length ? resolved.referencedRunIds : referencedRunIds;
      const collection = collectManagerProjectDiagnostics(projectDir, { initialFocusRunId: initialReport.initialFocusRunId, currentFocusRunId, referencedRunIds, question, external: options.external });
      const report = collection.report;
      const packet = buildManagerProjectPacket(report, question, packetState, referencedRunIds);
      packetState = packet.state;
      let result = await activeRole.builder.sendTurn(packet.prompt);
      let questionLookupRounds = 0;
      while (questionLookupRounds < MANAGER_LOOKUP_MAX_ROUNDS) {
        const request = parseManagerEvidenceRequest(result.text);
        if (!request) {
          if (!looksLikeEvidenceRequest(result.text)) break;
          questionLookupRounds += 1; lookupRounds += 1;
          result = await activeRole.builder.sendTurn(buildManagerEvidencePacket({ version: 1, requestId: "invalid-request", results: [{ kind: "list_runs", status: "invalid", limitation: "The evidence envelope was invalid. Use only the documented fixed fields and read-only operations, then answer with any remaining limitation disclosed." }], lookupRound: questionLookupRounds, remainingRounds: MANAGER_LOOKUP_MAX_ROUNDS - questionLookupRounds, digest: report.digest }, question));
          continue;
        }
        questionLookupRounds += 1;
        lookupRounds += 1;
        lookupOperations += Math.min(6, request.operations.length);
        const response = executeManagerEvidenceRequest(projectDir, request, collection, questionLookupRounds);
        packetState.lastEvidenceScope = request.operations.flatMap(operation => "runIds" in operation ? operation.runIds : []);
        result = await activeRole.builder.sendTurn(buildManagerEvidencePacket(response, question));
      }
      const unfulfilled = parseManagerEvidenceRequest(result.text);
      if (unfulfilled) {
        const limitation = { version: 1 as const, requestId: unfulfilled.requestId, results: unfulfilled.operations.slice(0, 6).map(operation => ({ kind: operation.kind, status: "limited" as const, limitation: "the two-round evidence lookup budget is exhausted; answer with this limitation disclosed" })), lookupRound: MANAGER_LOOKUP_MAX_ROUNDS, remainingRounds: 0, digest: report.digest };
        result = await activeRole.builder.sendTurn(buildManagerEvidencePacket(limitation, question));
      }
      output.write(`${parseManagerEvidenceRequest(result.text) || looksLikeEvidenceRequest(result.text) ? "Manager could not complete an answer within the bounded evidence lookup budget; the available project report remains partial." : result.text.trim()}\n`);
      usage = await activeRole.builder.sessionUsage?.() ?? usage;
      metadata.record({ sessionId: managerSessionId, runId: initialReport.initialFocusRunId, provider: activeRole.builder.agent, startedAt, reportDigest: report.digest,
        inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, costUsd: usage?.authoritativeCostUsd, scope: "project", latestFocusRunId: currentFocusRunId,
        projectReportDigest: report.projectDigest, lookupRounds, lookupOperations });
    };
    if (options.ask) await ask(options.ask);
    else {
      const readline = createInterface({ input, output });
      let interrupted = false;
      const onInterrupt = (): void => { interrupted = true; readline.close(); };
      readline.on("SIGINT", onInterrupt);
      try {
        while (true) {
          const question = await readline.question("manager> ");
          if (question.trim() === "/exit") break;
          if (question.trim()) await ask(question.trim());
        }
      } catch (error) {
        if (!interrupted && (error as NodeJS.ErrnoException).code !== "ABORT_ERR" && (error as NodeJS.ErrnoException).code !== "ERR_USE_AFTER_CLOSE") throw error;
      } finally { readline.off("SIGINT", onInterrupt); readline.close(); }
    }
    metadata.record({ sessionId: managerSessionId, runId: initialReport.initialFocusRunId, provider: activeRole.builder.agent, startedAt, endedAt: new Date().toISOString(), outcome: "completed", reportDigest: packetState?.digest ?? initialReport.digest, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, costUsd: usage?.authoritativeCostUsd, scope: "project", latestFocusRunId: currentFocusRunId, projectReportDigest: packetState?.projectDigest ?? initialReport.projectDigest, lookupRounds, lookupOperations });
  } catch (error) {
    metadata.record({ sessionId: managerSessionId, runId: initialReport.initialFocusRunId, provider: role?.builder.agent, startedAt, endedAt: new Date().toISOString(), outcome: "error", reportDigest: packetState?.digest ?? initialReport.digest, errorCode: "manager_error", scope: "project", latestFocusRunId: currentFocusRunId, projectReportDigest: packetState?.projectDigest ?? initialReport.projectDigest, lookupRounds, lookupOperations });
    throw error;
  } finally { await role?.builder.close().catch(() => {}); metadata.close(); }
}

function denyManagerTools() {
  return { ...readOnlyPermissionConfig(), allowBash: [], allowTools: [], escalateBash: [""], escalateTools: ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "WebFetch", "WebSearch", "Bash"] };
}
function stringOption(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function validateExternal(value: unknown): ExternalDiagnosticMode { if (value === "auto" || value === "on" || value === "off") return value; throw new Error("--external must be auto, on, or off"); }
function looksLikeEvidenceRequest(value: string): boolean { return /^\s*(?:```(?:json)?\s*)?\{[\s\S]*"(?:operations|requestId)"/i.test(value); }
