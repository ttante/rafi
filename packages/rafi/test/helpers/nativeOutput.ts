import type { OutputContract } from "rafi-spec";
import { nativePolicy } from "ai-foreman/agent-run.js";
import type { TurnPolicy, TurnResult } from "../../../ai-foreman/dist/adapters/types.js";
import { structuredReceipt } from "../../../ai-foreman/dist/adapters/structured.js";
import { providerOutputSchema, providerWireContract } from "rafi-spec";
/** Fixture authoring adapter; production never accepts historical text envelopes. */
export function nativeEnvelope(contract: OutputContract, text: string, start: string, end: string, session = "fixture-session") {
  const a = text.indexOf(start), b = text.indexOf(end);
  let payload: unknown;
  try { payload = JSON.parse(text.slice(a + start.length, b)); } catch { payload = null; }
  return { ...nativeFixtureTurn(nativePolicy(contract), session, payload, "codex"), text, rawResponse: text };
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

/** Raw provider fixture: it never adds omitted fields or rewrites a wire value. */
export function rawProviderFixtureTurn(policy: TurnPolicy | undefined, sessionId: string, wire: unknown, provider: "claude" | "codex" = "claude"): TurnResult {
  if (!policy?.output || !policy.dispatchId) throw new Error("Fixture requires a selected native contract and dispatch identity");
  return { text: "Presentation only", isError: false, numTurns: 1, costUsd: 0, turnId: policy.dispatchId,
    structured: structuredReceipt(policy.output, provider, wire, { dispatchId: policy.dispatchId, sessionId, nativeTurnId: `native-${policy.dispatchId}` }, "decoded-json") };
}

/** Intentionally conforming canonical-envelope fixture; never a substitute for raw provider output. */
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
