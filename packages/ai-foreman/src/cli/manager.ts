import { prepareOwnershipRepair, repairOwnership } from "../buildOwnershipRepair.js";
import { BuildInterventionControl, parseManagerAction } from "../buildInterventions.js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ManagerEvidenceService, parseManagerEvidenceRequestV2 } from "../managerEvidence.js";
import { buildManagerEvidencePacketV2 } from "../managerPacket.js";
import { Command } from "commander";
import type { EffortLevel, ProviderSessionUsage } from "../adapters/types.js";
import type { ManagerEvidencePageV2 } from "rafi-spec";
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
    .description("Inspect retained builds and enqueue explicitly scoped Builder/QA guidance.")
    .argument(options.requireProject ? "<project>" : "[project]", "project directory")
    .option("--run <run-id>", "set the initial focused build run")
    .option("--ask <question>", "ask one question and exit")
    .option("--agent <runtime>", "claude | codex")
    .option("--model <model>", "provider model ID")
    .option("--effort <level>", "low | medium | high | xhigh")
    .option("--fast", "use the provider fast mode")
    .option("--external <mode>", "auto | on | off", "auto")
    .addHelpText("after", "\nHost evidence commands (also accepted by --ask):\n  /qa-work <run>\n  /qa-attempts <run> <ticket>\n  /qa-report <run> <ticket> <attempt> [occurrence]\n  /qa-timeline <run> <ticket>\n  /qa-conflicts <run>\n  /qa-instruction <run> <work> <instruction>\n  /qa-repair-plan <run> <work>\n  /qa-repair <JSON request>\n  /more <cursor>\n  /artifact <handle>\n  /qa-export <run> <ticket> <attempt> [occurrence]\n  /qa-export <handle>  Export protected raw bytes to a private local file.\nScoped controls:\n  /guide-builder <run> <work> <text>\n  /guide-qa <run> <work> <text>\n  /guide-both <run> <work> <text>\n  /pause <run> <work> [run]\n  /withdraw <run> <work> <instruction>\n  /supersede <run> <work> <instruction> <text>\n  /request-attempt <run> <work> <reason>\n  /answer-question <run> <work> <decision> <revision> <text>\n")
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
  const evidence = new ManagerEvidenceService(projectDir);
  if (options.ask && (options.ask.trim().startsWith("/") || parseManagerAction(options.ask))) {
    try { if (!executeManagerHostCommand(evidence, options.ask, text => output.write(text), true)) throw new Error("Unknown Manager host command; see manager --help"); }
    finally { evidence.close(); }
    return;
  }
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
      if (executeManagerHostCommand(evidence, question, text => output.write(text), Boolean(options.ask))) return;
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
        const evidenceRequest = parseManagerEvidenceRequestV2(result.text);
        if (evidenceRequest) {
          questionLookupRounds++; lookupRounds++; lookupOperations++;
          const response = evidence.execute(evidenceRequest);
          if (options.ask) output.write(`${JSON.stringify(completeManagerHostEvidence(evidence, response))}\n`);
          else {
            if (response.nextCursor) output.write(`Evidence continuation: /more ${response.nextCursor}\n`);
            for (const item of response.items) if (item && typeof item === "object" && "handle" in item) output.write(`Complete report: /artifact ${String(item.handle)}\n`);
          }
          result = await activeRole.builder.sendTurn(buildManagerEvidencePacketV2(response, question));
          continue;
        }
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
      const pendingEvidence = parseManagerEvidenceRequestV2(result.text);
      if (pendingEvidence) {
        const page = evidence.execute(pendingEvidence);
        if (options.ask) output.write(`${JSON.stringify(completeManagerHostEvidence(evidence, page))}\n`);
        else output.write(`${JSON.stringify(page)}\n${page.nextCursor ? `Continue with /more ${page.nextCursor}` : "Browse reports with /qa-attempts <run> <ticket> and /qa-report <run> <ticket> <attempt>"}\n`);
      }
      if (unfulfilled) {
        const limitation = { version: 1 as const, requestId: unfulfilled.requestId, results: unfulfilled.operations.slice(0, 6).map(operation => ({ kind: operation.kind, status: "limited" as const, limitation: "the two-round evidence lookup budget is exhausted; answer with this limitation disclosed" })), lookupRound: MANAGER_LOOKUP_MAX_ROUNDS, remainingRounds: 0, digest: report.digest };
        result = await activeRole.builder.sendTurn(buildManagerEvidencePacket(limitation, question));
      }
      if (!pendingEvidence) output.write(`${parseManagerEvidenceRequest(result.text) || looksLikeEvidenceRequest(result.text) ? "Manager could not complete an answer within the bounded evidence lookup budget. Continue with /qa-attempts <run> <ticket> or /qa-report <run> <ticket> <attempt>." : result.text.trim()}\n`);
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
          if (question.trim()) await ask(question);
        }
      } catch (error) {
        if (!interrupted && (error as NodeJS.ErrnoException).code !== "ABORT_ERR" && (error as NodeJS.ErrnoException).code !== "ERR_USE_AFTER_CLOSE") throw error;
      } finally { readline.off("SIGINT", onInterrupt); readline.close(); }
    }
    metadata.record({ sessionId: managerSessionId, runId: initialReport.initialFocusRunId, provider: activeRole.builder.agent, startedAt, endedAt: new Date().toISOString(), outcome: "completed", reportDigest: packetState?.digest ?? initialReport.digest, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, costUsd: usage?.authoritativeCostUsd, scope: "project", latestFocusRunId: currentFocusRunId, projectReportDigest: packetState?.projectDigest ?? initialReport.projectDigest, lookupRounds, lookupOperations });
  } catch (error) {
    metadata.record({ sessionId: managerSessionId, runId: initialReport.initialFocusRunId, provider: role?.builder.agent, startedAt, endedAt: new Date().toISOString(), outcome: "error", reportDigest: packetState?.digest ?? initialReport.digest, errorCode: "manager_error", scope: "project", latestFocusRunId: currentFocusRunId, projectReportDigest: packetState?.projectDigest ?? initialReport.projectDigest, lookupRounds, lookupOperations });
    throw error;
  } finally { await role?.builder.close().catch(() => {}); metadata.close(); evidence.close(); }
}

/** Only original user commands enter here. Model output and retained reports cannot export raw bytes. */
export function executeManagerHostCommand(service: ManagerEvidenceService, command: string, write: (text: string) => void, complete = false): boolean {
  if (command.trim().startsWith("/qa-repair ")) {write(`${JSON.stringify(repairOwnership(service.projectDir,JSON.parse(command.trim().slice("/qa-repair ".length)),command))}\n`);return true;}
  if (command.trim().startsWith("/qa-repair-plan ")) {
    const args=command.trim().split(/\s+/);if(args.length!==3)throw new Error("/qa-repair-plan requires run and work identities");
    write(`${JSON.stringify(prepareOwnershipRepair(service.projectDir,args[1]!,args[2]!))}\n`);return true;
  }
  const proposed = parseManagerAction(command);
  if (proposed) {
    const control = new BuildInterventionControl(service.projectDir, proposed.runId, proposed.workId);
    try {
      const request = parseManagerAction(command, proposed.requestId, control.revision())!;
      const queued = control.enqueue(request, command);
      write(`${JSON.stringify(queued)}\n${request.action === "withdraw" ? "Withdrawn before reservation." : "Queued at the next eligible safe boundary. An active provider turn continues; a stopped owner must resume to consume this instruction."}\n`);
    } finally { control.close(); }
    return true;
  }
  if (!command.trim().startsWith("/")) return false;
  const [name, ...args] = command.trim().split(/\s+/);
  if (name === "/artifact" || name === "/qa-export" && args.length === 1) {
    if (args.length !== 1) throw new Error(`${name} requires one host artifact handle`);
    if (name === "/artifact") write(`${JSON.stringify(service.artifacts.metadata(args[0]!))}\n${service.artifacts.bytes(args[0]!).toString("utf8")}\n`);
    else {
      const path = join(mkdtempSync(join(tmpdir(), "rafi-qa-evidence-")), "protected-evidence.txt");
      writeFileSync(path, service.artifacts.bytes(args[0]!, true), { mode: 0o600 });
      write(`Protected raw evidence exported to ${path}\n${JSON.stringify(service.artifacts.metadata(args[0]!))}\n`);
    }
    return true;
  }
  if (name === "/more") {
    if (args.length !== 1) throw new Error("/more requires one cursor");
    const page = service.more(args[0]!);
    write(`${JSON.stringify(complete ? completeManagerHostEvidence(service, page) : page)}\n`); return true;
  }
  const requestId = randomUUID();
  const runId = args[0] ?? "";
  const workId = args[1] ?? "";
  let page;
  if (name === "/qa-work" || name === "/qa-conflicts") {
    if (args.length !== 1) throw new Error(`${name} requires a run ID`);
    page = service.execute({ version: 2, requestId, operation: { kind: name === "/qa-work" ? "list_build_work" : "get_ownership_conflicts", runId } });
  } else if (name === "/qa-attempts" || name === "/qa-timeline") {
    if (args.length !== 2) throw new Error(`${name} requires run and ticket IDs`);
    page = service.execute({ version: 2, requestId, operation: { kind: name === "/qa-attempts" ? "list_qa_attempts" : "get_qa_timeline", runId, workId } });
  } else if (name === "/qa-instruction") {
    if (args.length !== 3) throw new Error("/qa-instruction requires run, work and instruction identities");
    page=service.execute({version:2,requestId,operation:{kind:"get_intervention_status",runId,workId,instructionId:args[2]!}});
  } else if (name === "/qa-report" || name === "/qa-export") {
    if (args.length < 3 || args.length > 4) throw new Error(`${name} requires run, ticket, attempt and optional occurrence IDs`);
    const attemptId = args[2]!;
    const attempts = service.execute({ version: 2, requestId, operation: { kind: "list_qa_attempts", runId, workId } });
    const rows = completeManagerHostEvidence(service, attempts).items;
    const attempt = rows.find(row => row && typeof row === "object" && "attemptId" in row && row.attemptId === attemptId) as { reports: Array<{ occurrenceId: string }> } | undefined;
    if (!attempt) throw new Error("Attempt is not retained in this run/ticket; use /qa-attempts first");
    if (!attempt.reports.length) { write(`${JSON.stringify(rows.find(row => row && typeof row === "object" && "attemptId" in row && row.attemptId === attemptId))}\nNo retained failure report body; inspect verification or attempt status above.\n`); return true; }
    const occurrenceId = args[3] ?? (attempt.reports.length === 1 ? attempt.reports[0]!.occurrenceId : undefined);
    if (!occurrenceId) throw new Error("Report identity is ambiguous; specify a retained occurrence ID");
    page = service.execute({ version: 2, requestId, operation: { kind: "get_qa_report", runId, workId, attemptId, occurrenceId, snapshotId: attempts.snapshotId } });
    const artifact = page.items[0] as { handle?: string } | undefined;
    if (artifact?.handle) {
      if (name === "/qa-export") {
        const path = join(mkdtempSync(join(tmpdir(), "rafi-qa-evidence-")), "protected-evidence.txt");
        writeFileSync(path, service.artifacts.bytes(artifact.handle, true), { mode: 0o600 });
        write(`Protected raw evidence exported to ${path}\n${JSON.stringify({ ...service.artifacts.metadata(artifact.handle), snapshotId: page.snapshotId, asOf: page.asOf })}\n`);
      } else write(`${JSON.stringify({ ...service.artifacts.metadata(artifact.handle), snapshotId: page.snapshotId, asOf: page.asOf, availability: page.availability, omissions: page.omissions.filter(item => !item.startsWith("Complete host rendering:")) })}\n${service.artifacts.bytes(artifact.handle).toString("utf8")}\n`);
      return true;
    }
  } else return false;
  write(`${JSON.stringify(complete ? completeManagerHostEvidence(service, page) : page)}\n`);
  if (!complete && page.nextCursor) write(`Continue with /more ${page.nextCursor}\n`);
  return true;
}

/** Drain one pinned snapshot and expand every referenced artifact before host close.
 * Errors are returned as incomplete output; an expired snapshot is never refreshed.
 * This host output is deliberately independent of bounded model packets. */
export function completeManagerHostEvidence(service: ManagerEvidenceService, first: ManagerEvidencePageV2): ManagerEvidencePageV2 {
  const result = structuredClone(first);
  result.redactions = service.hostRedactions(first.snapshotId);
  result.items = [];
  const seen = new Set<string>();
  let page = first;
  while (true) {
    for (const item of page.items) {
      const row = item as { metadataArtifact?: { handle: string }; handle?: string } | null;
      if (row?.metadataArtifact) result.items.push(service.hostMetadataItem(row.metadataArtifact.handle));
      else if (row?.handle) {
        if (seen.has(row.handle)) continue;
        seen.add(row.handle);
        const { handle: _, ...metadata } = service.artifacts.metadata(row.handle)!;
        result.items.push({ ...metadata, body: service.artifacts.bytes(row.handle).toString("utf8") });
      } else result.items.push(item);
    }
    if (!page.nextCursor || page.error) break;
    const next = service.more(page.nextCursor);
    if (!next.error && next.snapshotId !== first.snapshotId) throw new Error("Evidence continuation changed snapshot identity");
    page = next;
  }
  delete result.nextCursor;
  result.complete = page.complete;
  if (page.error) { result.error = page.error; result.restartAction = page.restartAction; result.omissions.push(...page.omissions); }
  result.omissions = result.omissions.filter(item => !item.startsWith("Complete host rendering:") && !item.includes("additional redaction spans are available"));
  return result;
}

function denyManagerTools() {
  return { ...readOnlyPermissionConfig(), allowBash: [], allowTools: [], escalateBash: [""], escalateTools: ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "WebFetch", "WebSearch", "Bash"] };
}
function stringOption(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function validateExternal(value: unknown): ExternalDiagnosticMode { if (value === "auto" || value === "on" || value === "off") return value; throw new Error("--external must be auto, on, or off"); }
function looksLikeEvidenceRequest(value: string): boolean { return /^\s*(?:```(?:json)?\s*)?\{[\s\S]*"(?:operations|requestId)"/i.test(value); }
