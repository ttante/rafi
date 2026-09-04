export type PlanChangeClassification = "bookkeeping" | "material";

const MATERIAL_KEYS = new Set(["scope", "summary", "acceptance", "acceptance_criteria", "depends_on", "dependencies", "delivery", "delivery_strategy", "branch", "branch_mode", "completion", "completion_mode"]);
const BOOKKEEPING_KEYS = new Set(["status", "evidence", "updated_at", "updatedAt", "timestamp", "notes"]);

/** Structural classification; agent prose is intentionally ignored. */
export function classifyPlanChange(before: unknown, after: unknown): PlanChangeClassification {
  return changedPaths(before, after).some((path) => path.some((segment) => MATERIAL_KEYS.has(segment))) ? "material" : "bookkeeping";
}

export function changedPaths(before: unknown, after: unknown, prefix: string[] = []): string[][] {
  if (Object.is(before, after)) return [];
  if (!isRecord(before) || !isRecord(after)) return [prefix];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const paths = [...keys].flatMap((key) => changedPaths(before[key], after[key], [...prefix, key]));
  return paths.filter((path) => !path.length || !path.every((segment) => BOOKKEEPING_KEYS.has(segment)));
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

