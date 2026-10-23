import type { TurnPolicy, TurnResult } from "../../src/adapters/types.js";
import { structuredReceipt } from "../../src/adapters/structured.js";
import { providerOutputSchema, providerWireContract } from "rafi-spec";
import { parseQaResponseContract, parseBuilderQaRemediationContract } from "rafi-spec";
import { parseStepStatus } from "../../src/foreman.js";
import { parseContinuityDelta } from "../../src/continuity.js";

/** Fixture authoring only: older scenario descriptions become native wire replies.
 * Production code must never import this historical-text test convenience. */
export function fixtureOperationValue(operation: string, text: string): Record<string, any> {
  const continuityRecord = parseContinuityDelta(text);
  const cleanText = continuityRecord.cleanText;
  const status = parseStepStatus(cleanText);
  let result: Record<string, any>;
  if (cleanText.trim().startsWith('{"kind":"rafi_graph_request"')) result = { kind: "graph-request", request: JSON.parse(cleanText) };
  else if (operation === "session-initialization") result = { kind: "completed", summary: "Fixture session ready", payload: { ready: true } };
  else if (operation === "qa-recovery-acceptance") {
    const ack = /RAFI_QA_RECOVERY_ACK packet="([a-f0-9]{64})" reviewed_state="([a-f0-9]{64})" required_resources_read="(all)"/.exec(cleanText);
    result = { kind: "completed", summary: "Recovery acknowledgement", payload: ack ? { packet: ack[1], reviewed_state: ack[2], required_resources_read: ack[3] } : {} };
  }
  else if (status.kind === "blocked") result = { kind: "blocked", reason: status.reason ?? "Fixture blocked", nextAction: status.next ?? "Resolve the fixture blocker", ...(status.branchDependency ? { branchDependency: status.branchDependency } : {}) };
  else if (status.kind === "needs_input") result = { kind: "needs-input", question: status.question ?? "Fixture question", choices: status.choices ?? [] };
  else if (operation === "qa-verdict") {
    const qa = parseQaResponseContract(cleanText);
    const verifiedInstructionIds = [...cleanText.matchAll(/^MANAGER_INSTRUCTION_VERIFIED:\s*(\S+)$/gm)].map(match => match[1]);
    result = { kind: "completed", summary: qa.fields.summary ?? qa.fields.issues ?? "Fixture QA result", payload: qa.status === "qa_pass" ? { kind: "passed", coverage: null, verifiedInstructionIds } : { kind: "failed", report: qa.report, coverage: null, verifiedInstructionIds } };
  } else if (operation === "builder-remediation") {
    const remediation = parseBuilderQaRemediationContract(cleanText);
    result = { kind: "completed", summary: remediation.report?.summary ?? "Fixture remediation", payload: { status: remediation.status, reason: remediation.status === "blocked" ? remediation.fields.reason : null, report: remediation.report, coverage: null } };
  } else if (operation === "work-report") result = { kind: "completed", summary: status.summary ?? "Fixture work result", payload: { ...(status.kind === "done" ? {} : { status: status.kind }), disposition: "modified", evidence: ["Fixture source inspection"], coverage: null, graphMaintenance: null } };
  else throw new Error(`Fixture needs an explicit native response for ${operation}`);
  const continuity = continuityRecord.delta ?? null;
  return { version: 1, operation, result, continuity };
}

/** Encode canonical test data only for an explicitly requested compatibility fixture. */
export function codexWireFixture(schema: Record<string, any>, value: any, root = schema): any {
  if (schema.$ref) return codexWireFixture(schema.$ref.slice(2).split("/").reduce((node: any, key: string) => node[key.replaceAll("~1", "/").replaceAll("~0", "~")], root), value, root);
  const branches: Record<string, any>[] | undefined = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const branch = branches.find(branch => {
      if (branch.type === "null") return value === null;
      if (value === null) return branch.const === null || branch.enum?.includes(null);
      if (branch.type === "object") return typeof value === "object" && !Array.isArray(value) && Object.entries(branch.properties ?? {}).every(([key, item]) => {
        const field = item as any;
        return field.const === undefined && !field.enum || field.const === value[key] || field.enum?.includes(value[key]);
      });
      if (branch.type === "array") return Array.isArray(value) || Boolean(branch.items?.properties?.key && typeof value === "object");
      return !branch.type || branch.type === typeof value;
    });
    return branch ? codexWireFixture(branch, value, root) : value;
  }
  if (schema.type === "array" && schema.items?.properties?.key && value && !Array.isArray(value) && typeof value === "object") return Object.entries(value).map(([key, item]) => ({ key, value: codexWireFixture(schema.items.properties.value, item, root) }));
  if (schema.type === "object" && schema.properties && value && typeof value === "object") return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, value[key] === undefined ? null : codexWireFixture(child as any, value[key], root)]));
  if (Array.isArray(value) && schema.items) return value.map(item => codexWireFixture(schema.items, item, root));
  return value;
}

/**
 * Raw provider fixtures are never normalized, completed, or repaired. Use
 * this for captures and malformed-output tests.
 */
export function rawProviderFixtureTurn(policy: TurnPolicy | undefined, sessionId: string, wire: unknown, provider: "claude" | "codex" = "claude"): TurnResult {
  if (!policy?.output || !policy.dispatchId) throw new Error("Fixture requires a selected native contract and dispatch identity");
  return { text: "Presentation only", isError: false, numTurns: 1, costUsd: 0, turnId: policy.dispatchId,
    structured: structuredReceipt(policy.output, provider, wire, { dispatchId: policy.dispatchId, sessionId, nativeTurnId: `native-${policy.dispatchId}` }, "decoded-json") };
}

/** Build an intentionally conforming canonical-envelope fixture. Never use for a raw provider capture. */
export function canonicalFixtureTurn(policy: TurnPolicy | undefined, sessionId: string, payload: unknown, provider: "claude" | "codex" = "claude", alternative?: unknown, continuity: unknown = null): TurnResult {
  if (!policy?.output || !policy.dispatchId) throw new Error("Fixture requires a selected native contract and dispatch identity");
  const value = { version: 1, operation: policy.output.operation, result: alternative ?? { kind: "completed", summary: "Fixture result", payload }, continuity };
  const selected = policy.wireContract ?? providerWireContract(policy.output, provider);
  if (provider === "codex" && !selected.profile.includes("compat")) throw new Error(`Canonical fixture cannot invent the ${selected.profile} provider wire; use rawProviderFixtureTurn`);
  const wire = provider === "codex" ? codexWireFixture(providerOutputSchema(policy.output, provider).schema, value) : value;
  return rawProviderFixtureTurn(policy, sessionId, wire, provider);
}

/** @deprecated Use canonicalFixtureTurn or rawProviderFixtureTurn explicitly. */
export const nativeFixtureTurn = canonicalFixtureTurn;

export function nativeFixtureFromText(policy: TurnPolicy | undefined, sessionId: string, text: string, provider: "claude" | "codex" = "claude"): TurnResult {
  if (!policy?.output) throw new Error("Fixture received an uncontracted provider turn");
  try {
    const value = fixtureOperationValue(policy.output.operation, text);
    return { ...canonicalFixtureTurn(policy, sessionId, undefined, provider, value.result, value.continuity), text, rawResponse: text };
  } catch (error) {
    return { text, rawResponse: text, isError: false, numTurns: 1, costUsd: 0, turnId: policy.dispatchId,
      structured: { state: "rejected", reason: "invalid-contract", detail: String(error), dispatchId: policy.dispatchId! } };
  }
}
