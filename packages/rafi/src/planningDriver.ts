import type { SourceRegistryConfig, SourceSnapshotStorage } from "rafi-spec";
import {
  discardStagedSourceCaptures,
  extractSourceRequests,
  registerSourceRequests,
  saveSourceRegistry,
  sourceContext,
  sourceRequestFromAnswer,
} from "ai-foreman/sources/source-registry.js";

export interface PlanningInputResult {
  registry: SourceRegistryConfig;
  snapshots: string[];
  answer?: string;
  continuation?: string;
  cancelled: boolean;
}

export interface PlanningInputPrompts {
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<unknown>;
  text(options: { message: string; placeholder?: string }): Promise<unknown>;
  isCancel(value: unknown): boolean;
  log?: { info(message: string): void };
}

/** Shared ordinary-question and source-request turn handling for both planning commands. */
export async function handlePlanningInput(options: {
  projectDir: string;
  output: string;
  question?: string;
  choices?: string[];
  registry: SourceRegistryConfig;
  storage?: SourceSnapshotStorage;
  interactive: boolean;
  context?: (registry: SourceRegistryConfig) => unknown;
  prompts?: PlanningInputPrompts;
}): Promise<PlanningInputResult> {
  const requests = extractSourceRequests(options.output);
  const received = requests.length
    ? await registerSourceRequests(options.projectDir, options.registry, requests, { storage: options.storage })
    : { registry: options.registry, snapshots: [] };
  if (!options.interactive) throw new Error(`planner needs input: ${options.question ?? "additional guidance required"}`);
  const prompts = options.prompts ?? await import("@clack/prompts");
  let answer: string;
  if (options.choices?.length) {
    const customValue = "custom-response";
    const selected = await prompts.select({
      message: options.question ?? "Planner needs input:",
      options: [
        ...options.choices.map((label, index) => ({ value: `planner-choice-${index}`, label })),
        { value: customValue, label: "Custom response" },
      ],
    });
    if (prompts.isCancel(selected)) return { registry: received.registry, snapshots: received.snapshots, cancelled: true };
    if (selected === customValue) {
      const value = await prompts.text({ message: options.question ?? "Planner needs input:" });
      if (prompts.isCancel(value)) return { registry: received.registry, snapshots: received.snapshots, cancelled: true };
      answer = String(value);
    } else {
      const index = typeof selected === "string" ? /^planner-choice-(\d+)$/.exec(selected)?.[1] : undefined;
      const choice = index === undefined ? undefined : options.choices[Number(index)];
      if (choice === undefined) throw new Error("planner choice selection was invalid");
      answer = choice;
    }
  } else {
    const value = await prompts.text({ message: options.question ?? "Planner needs input:" });
    if (prompts.isCancel(value)) return { registry: received.registry, snapshots: received.snapshots, cancelled: true };
    answer = String(value);
  }
  let registry = received.registry; const snapshots = [...received.snapshots];
  if (requests.length) {
    const answerSources = await registerSourceRequests(options.projectDir, registry, [sourceRequestFromAnswer(answer, options.projectDir)], { storage: options.storage });
    registry = answerSources.registry; snapshots.push(...answerSources.snapshots);
  }
  const context = options.context ? options.context(registry) : sourceContext(registry);
  return {
    registry, snapshots, answer, cancelled: false,
    continuation: `User answer (preserve exactly):\n${answer}\n\nValidated shared source registry context:\n${JSON.stringify(context, null, 2)}\nContinue this same planning session without editing files.`,
  };
}

export function parseSourceStorage(value: unknown): SourceSnapshotStorage | undefined {
  if (value === undefined) return undefined;
  if (value === "local" || value === "tracked") return value;
  throw new Error("--source-storage must be local or tracked");
}

export async function promptSourceStorage(): Promise<SourceSnapshotStorage> {
  const { select, isCancel } = await import("@clack/prompts");
  const value = await select({ message: "Where should source snapshots be stored for this project?", options: [
    { value: "local", label: "Private/local (Recommended)" }, { value: "tracked", label: "Team-visible/tracked" },
  ] });
  if (isCancel(value)) throw new Error("source storage selection cancelled");
  return value as SourceSnapshotStorage;
}

export async function chooseStagedSourceDisposition(projectDir: string, original: SourceRegistryConfig, staged: SourceRegistryConfig): Promise<boolean> {
  if (JSON.stringify(original) === JSON.stringify(staged) || !process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { confirm, isCancel } = await import("@clack/prompts");
  const keep = await confirm({ message: "Keep newly supplied sources for future planning?", initialValue: true });
  if (!isCancel(keep) && keep) { saveSourceRegistry(projectDir, staged); return true; }
  discardStagedSourceCaptures(projectDir, original, staged); return false;
}
