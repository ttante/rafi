import { canonicalJson, structuredDigest } from "rafi-spec";

export type QaHostTransformationRule = "assessment-host-bindings-v1" | "depth-host-bindings-v1" | "draft-host-bindings-v1";
export interface QaHostTransformationV1 {
  version: 1;
  ruleVersion: QaHostTransformationRule;
  operation: string;
  tupleDigest: string;
  inputDigest: string;
  outputDigest: string;
  authorityClass: "host-binding-and-observation";
  justification: string;
  effects: Array<{ path: string; beforeDigest: string; afterDigest: string }>;
}
const hashValue = (value: unknown, present: boolean) => structuredDigest({ present, ...(present ? { value } : {}) });

/** Records only approved host effects; provider/user requirements remain immutable. */
export function qaHostTransformation(input: { rule: QaHostTransformationRule; operation: string; tupleDigest: string;
  before: unknown; after: unknown; workspacePaths?: Record<string, string> }): QaHostTransformationV1 {
  if (!["assessment-host-bindings-v1", "depth-host-bindings-v1", "draft-host-bindings-v1"].includes(input.rule)) throw new Error("Unknown QA host transformation rule");
  if (!/^[a-f0-9]{64}$/.test(input.tupleDigest) || !input.operation) throw new Error("QA transformation requires native tuple provenance");
  const effects: QaHostTransformationV1["effects"] = [];
  const original = input.before as any, transformed = input.after as any;
  const ids = new Map<string, string>();
  if (input.rule === "draft-host-bindings-v1") {
    if (transformed.checks.length < original.checks.length) throw new Error("QA transformation cannot remove provider checks");
    original.checks.forEach((check: any, index: number) => ids.set(check.id, transformed.checks[index].id));
  }
  const labelIds = [...ids.keys()].filter(id => id.startsWith("check-")).sort((a, b) => b.length - a.length);
  const labelPattern = labelIds.length ? new RegExp(`(^|[^A-Za-z0-9_-])(${labelIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_-])`, "g") : undefined;
  const relabel = (value: unknown) => typeof value === "string" && labelPattern
    ? value.replace(labelPattern, (_match, prefix: string, id: string) => `${prefix}${ids.get(id)}`) : value;
  const walk = (before: any, after: any, path: string, beforePresent = true, afterPresent = true): void => {
    if (beforePresent === afterPresent && canonicalJson(before ?? null) === canonicalJson(after ?? null)) return;
    if (input.rule === "draft-host-bindings-v1" && path === "baseline" && Array.isArray(before) && Array.isArray(after)) {
      for (const prior of before) if (!after.some(row => row.id === prior.id)) throw new Error("QA transformation cannot remove provider observations");
      for (const [index, row] of after.entries()) {
        const prior = before.find(item => item.id === row.id);
        walk(prior, row, `baseline.${index}`, prior !== undefined, true);
      }
      return;
    }
    if (before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after)) {
      for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort())
        walk(before[key], after[key], path ? `${path}.${key}` : key, Object.hasOwn(before, key), Object.hasOwn(after, key));
      return;
    }
    const assessment = /^(draftPayloadDigest|inventoryDigest|policyVersion|authorSessionId|sessionId|operationId)$/.test(path);
    const depth = /^(plannerOperationId|plannerIdentity|minimumReasons(?:\.\d+)?)$/.test(path);
    let draft = false;
    if (input.rule === "draft-host-bindings-v1") {
      const check = /^checks\.(\d+)\.(.+)$/.exec(path);
      const originalCheck = check && original.checks[Number(check[1])];
      const idReference = /^(checks\.\d+\.(id|dependsOnChecks\.\d+)|coverage\.\d+\.checkIds\.\d+|unresolved\.\d+\.checkIds\.\d+)$/.test(path);
      draft = idReference && ids.get(before) === after;
      if (check?.[2] === "obligation" && originalCheck && after === "mandatory") {
        draft = original.requirements.some((requirement: any) => requirement.obligation === "mandatory" &&
          original.coverage.some((row: any) => row.requirementId === requirement.id && row.checkIds.includes(originalCheck.id)));
      }
      if (check && /^requirementRefs\.\d+$/.test(check[2]!) && !beforePresent && originalCheck) {
        draft = original.coverage.some((row: any) => row.requirementId === after && row.checkIds.includes(originalCheck.id));
      }
      if (/^checks\.\d+\.hostKind$/.test(path) && !beforePresent) draft = after === "source-scope" || after === "graph-maintenance";
      if (/^checks\.\d+$/.test(path) && !beforePresent) draft = after && (after.hostKind === "source-scope" || after.hostKind === "graph-maintenance") &&
        after.origin === "invariant" && after.obligation === "mandatory" && after.requirementRefs.every((id: string) => original.requirements.some((requirement: any) => requirement.id === id));
      if (/^baseline\.\d+$/.test(path) && !beforePresent) draft = after && /^[a-f0-9]{64}$/.test(after.evidenceDigest) && typeof after.observedAt === "string";
      if (/^baseline\.\d+\.(sourceDigest|observedAt|phase|evidenceDigest)$/.test(path)) draft = true;
      if (/^baseline\.\d+\.checkId$/.test(path)) {
        const row = transformed.baseline[Number(path.split(".")[1])];
        const checks = transformed.checks.filter((item: any) => item.prerequisiteRefs.includes(row.id));
        draft = ids.get(before) === after || checks.length === 1 && checks[0].id === after;
      }
      if (/^preparationEvidence\.\d+\.(operationId|sessionId|graphReceiptRefs(?:\.\d+)?|evidenceDigest)$/.test(path) ||
        /^preparationEvidence\.\d+\.references\.\d+\.digest$/.test(path)) draft = true;
      if (/^(checks\.\d+\.verification\.\d+\.cwd|preparationEvidence\.\d+\.references\.\d+\.path)$/.test(path))
        draft = typeof before === "string" && input.workspacePaths?.[before] === after;
      // The only permitted prose edit substitutes exact provider check identifiers.
      if (/^(checks\.\d+\.(expectedBehavior|expectedEvidence\.\d+|expectedBaseline|applicability\.(predicate|requiredEvidence\.\d+)|verification\.\d+\.(expectedOutcome|steps\.\d+))|baseline\.\d+\.(procedure|relevance|expectedTransition|predicateEvidence\.\d+)|preparationEvidence\.\d+\.analysis|unresolved\.\d+\.(reason|nextAction))$/.test(path) &&
        typeof before === "string" && before !== after && relabel(before) === after) draft = true;
    }
    if (!(input.rule === "assessment-host-bindings-v1" ? assessment : input.rule === "depth-host-bindings-v1" ? depth : draft))
      throw new Error(`QA host transformation cannot change provider requirements or semantic fields: ${path}`);
    effects.push({ path, beforeDigest: hashValue(before, beforePresent), afterDigest: hashValue(after, afterPresent) });
    if (effects.length > 10000) throw new Error("QA host transformation exceeds effect budget");
  };
  walk(input.before, input.after, "");
  if (input.rule === "depth-host-bindings-v1") {
    const before = input.before as { minimumReasons: string[]; riskFactors: Array<{ category: string }> };
    const after = input.after as typeof before;
    const expected = [...before.minimumReasons, ...before.riskFactors.map(risk => risk.category).filter(category => !before.minimumReasons.includes(category))];
    if (canonicalJson(expected) !== canonicalJson(after.minimumReasons)) throw new Error("Depth labels must be exactly derivable from provider risk factors");
  }
  return { version: 1, ruleVersion: input.rule, operation: input.operation, tupleDigest: input.tupleDigest,
    inputDigest: structuredDigest(input.before), outputDigest: structuredDigest(input.after), effects,
    authorityClass: "host-binding-and-observation", justification: "Bind native dispatch identities and retained host observations; preserve provider/user requirements" };
}

export function verifyQaHostTransformation(record: QaHostTransformationV1, before: unknown, after: unknown, workspacePaths?: Record<string, string>): void {
  const expected = qaHostTransformation({ rule: record.ruleVersion, operation: record.operation, tupleDigest: record.tupleDigest, before, after, workspacePaths });
  if (canonicalJson(expected) !== canonicalJson(record)) throw new Error("QA host transformation replay mismatch");
}
