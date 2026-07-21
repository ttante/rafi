import { Command } from "commander";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  assertEffortLevel,
  makeLogPath,
  readOnlyPermissionConfig,
  runRoleInstruction,
  type EffortLevel,
  type RoleInstructionRunOptions,
} from "ai-foreman/agent-run.js";
import { validateDocsRoot } from "./docs.js";
import { DEFAULT_DOCS_ROOT, LEGACY_PROJECT_CONFIG_FILE, RAFI_CONFIG_FILE } from "./project.js";

export interface PlanInstructionOptions {
  brief: string;
  sources?: string[];
  docsRoot: string;
  latestPlanPath: string;
  historyDirPath: string;
}

export interface PlanArtifactPaths {
  docsRoot: string;
  historyRel: string;
  latestRel: string;
  historyAbs: string;
  latestAbs: string;
}

export function buildPlanInstruction(opts: PlanInstructionOptions): string {
  const sources = opts.sources?.length
    ? opts.sources.map((source) => `- ${source}`).join("\n")
    : "- No explicit sources were provided. Inspect the repository for relevant docs, tickets, code, configs, tests, and recent plans.";

  return `You are being run by Rafi to create a ticket-maker-ready implementation plan.

User brief:
${opts.brief.trim()}

Configured Rafi docs root:
${opts.docsRoot}

Planning source hints:
${sources}

Role and skill requirements:
- Use the planner role guidance for baseline planning.
- Use the grill-me skill explicitly while stress-testing the plan. If a question can be answered by inspecting the repository, inspect the repository instead of asking the user.
- Use prd-to-issues only as vertical-slice planning guidance. Do not create issues/*.md or any other issue files.

Permissions and file rules:
- This is a non-mutating planning run. Read, search, inspect, and ask questions as needed.
- Do not edit source files, docs, .tickets, generated artifacts, or configuration.
- Rafi CLI will write your final Markdown plan to ${opts.latestPlanPath} and keep timestamped history under ${opts.historyDirPath}.

Inspect the repository enough to make the plan concrete. Prefer facts from files over assumptions. If a decision is genuinely blocked, ask one focused question with:
STEP_STATUS: needs_input | question="..." choices="recommended option|alternative"

Output contract:
- Return one Markdown plan.
- Include these sections: Goal, Problem Statement, Repo Findings, Locked Decisions, Open Questions, Scope, Out Of Scope, Risks, Rollback Notes, Ticket-Maker Guidance.
- Ticket-Maker Guidance must include proposed ticket slices, dependencies, acceptance criteria, required tests, likely files, and branch/batch strategy for repeated component-library work.
- Make each ticket slice small enough for \`rafi start --steps ...\` or branch-per-ticket execution.
- Do not include implementation patches.

End with exactly one marker line as the final non-empty line:
STEP_STATUS: plan_complete | summary="created ticket-maker-ready Rafi plan"`;
}

export function buildPlanAgentRunOptions(opts: {
  projectDir: string;
  agent?: string;
  model?: string;
  effort?: EffortLevel;
  fast?: boolean;
  yes?: boolean;
  instruction: string;
  logPath?: string;
}): RoleInstructionRunOptions {
  return {
    projectDir: opts.projectDir,
    role: "planner",
    extraSkills: ["grill-me"],
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort,
    fast: opts.fast,
    yes: opts.yes,
    label: "rafi plan",
    logPath: opts.logPath,
    instruction: opts.instruction,
    permissionConfig: readOnlyPermissionConfig(),
    sandboxMode: "read-only",
    logEvent: "rafi-plan",
  };
}

export function resolvePlanDocsRoot(projectDir: string): string {
  return validateDocsRoot(projectDir, readConfiguredDocsRoot(projectDir) ?? DEFAULT_DOCS_ROOT);
}

export function resolvePlanArtifactPaths(
  projectDir: string,
  docsRoot: string,
  now = new Date(),
): PlanArtifactPaths {
  const safeDocsRoot = validateDocsRoot(projectDir, docsRoot);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const historyRel = `${safeDocsRoot}/rafi-plans/${stamp}.md`;
  const latestRel = `${safeDocsRoot}/rafi-plan.md`;
  const historyAbs = resolve(projectDir, historyRel);
  const latestAbs = resolve(projectDir, latestRel);
  assertOutputPathInsideRepo(projectDir, historyAbs, historyRel);
  assertOutputPathInsideRepo(projectDir, latestAbs, latestRel);
  return { docsRoot: safeDocsRoot, historyRel, latestRel, historyAbs, latestAbs };
}

export function writePlanArtifacts(
  projectDir: string,
  docsRoot: string,
  planMarkdown: string,
  now = new Date(),
): PlanArtifactPaths {
  const paths = resolvePlanArtifactPaths(projectDir, docsRoot, now);
  const content = normalizePlanMarkdown(planMarkdown);
  mkdirSync(dirname(paths.historyAbs), { recursive: true });
  assertOutputPathInsideRepo(projectDir, paths.historyAbs, paths.historyRel);
  assertOutputPathInsideRepo(projectDir, paths.latestAbs, paths.latestRel);
  writeFileSync(paths.historyAbs, content, "utf8");
  writeFileSync(paths.latestAbs, content, "utf8");
  return paths;
}

export function stripFinalStepStatusMarker(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  if (/^STEP_STATUS:/i.test(lines[lines.length - 1] ?? "")) {
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

export function nextPopulateCommand(projectDir: string, latestRel: string): string {
  const projectArg = resolve(projectDir) === process.cwd()
    ? ""
    : ` --project ${shellQuote(projectDir)}`;
  return `rafi tickets populate${projectArg} --sources ${shellQuote(latestRel)}`;
}

export function buildPlanCommand(): Command {
  return new Command("plan")
    .description("Create a ticket-maker-ready implementation plan from a brief and repo inspection.")
    .argument("[project]", "path to the target repo", ".")
    .option("--brief <text>", "planning brief")
    .option("--brief-file <path>", "file containing the planning brief")
    .option("--sources <paths...>", "source hint files, folders, or globs to check first")
    .option("-a, --agent <agent>", "planning agent (claude | codex)")
    .option("-m, --model <model>", "override the planning agent's model")
    .option("--effort <level>", "reasoning effort level (low|medium|high|xhigh)")
    .option("--fast", "fast mode - lower latency")
    .option("-y, --yes", "skip confirmation prompt before running the planning agent")
    .action(async (project: string, opts) => {
      try {
        const projectDir = resolve(project);
        if (!existsSync(projectDir)) fail(`project directory not found: ${projectDir}`);
        assertEffortLevel(opts.effort as string | undefined);

        const docsRoot = resolvePlanDocsRoot(projectDir);
        const previewPaths = resolvePlanArtifactPaths(projectDir, docsRoot);
        const brief = await resolveBrief(opts);
        const instruction = buildPlanInstruction({
          brief,
          sources: opts.sources as string[] | undefined,
          docsRoot,
          latestPlanPath: previewPaths.latestRel,
          historyDirPath: `${docsRoot}/rafi-plans`,
        });

        if (!opts.yes) {
          const { select, isCancel } = await import("@clack/prompts");
          const action = await select({
            message: "Run a read-only planning agent and write Rafi plan docs?",
            options: [
              { value: "proceed", label: "Proceed - read-only agent run, then write plan docs" },
              { value: "cancel", label: "Cancel" },
            ],
          });
          if (isCancel(action) || action === "cancel") {
            console.log("rafi plan: cancelled");
            process.exit(0);
          }
        }

        const logPath = makeLogPath(projectDir, "rafi-plan");
        console.log("rafi plan: running read-only planner");
        console.log(`rafi plan: project ${projectDir}`);
        console.log("rafi plan: role planner + skill grill-me");
        console.log(`rafi plan: log ${logPath}\n`);

        const run = await runRoleInstruction(buildPlanAgentRunOptions({
          projectDir,
          agent: opts.agent as string | undefined,
          model: opts.model as string | undefined,
          effort: opts.effort as EffortLevel | undefined,
          fast: opts.fast as boolean | undefined,
          yes: Boolean(opts.yes),
          instruction,
          logPath,
        }));

        const turn = run.turn;
        if (turn.result.isError) {
          fail(`planner turn errored: ${turn.result.text.slice(0, 200)}`);
        }
        if (turn.status.kind === "blocked") {
          console.error(`rafi plan: blocked - ${turn.status.reason ?? "planner reported blocked"}`);
          process.exit(2);
        }
        if (turn.status.kind !== "plan_complete" && turn.status.kind !== "done") {
          console.error(`rafi plan: needs human - ${turn.status.error ?? "planner did not emit plan_complete"}`);
          process.exit(2);
        }

        const planMarkdown = stripFinalStepStatusMarker(turn.result.text);
        if (!planMarkdown.trim()) fail("planner returned an empty plan");
        const written = writePlanArtifacts(projectDir, docsRoot, planMarkdown);

        console.log(`\nrafi plan: wrote ${written.historyRel}`);
        console.log(`rafi plan: refreshed ${written.latestRel}`);
        console.log("rafi plan: next:");
        console.log(`  ${nextPopulateCommand(projectDir, written.latestRel)}`);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}

function normalizePlanMarkdown(planMarkdown: string): string {
  return `${stripFinalStepStatusMarker(planMarkdown).trimEnd()}\n`;
}

async function resolveBrief(opts: { brief?: string; briefFile?: string }): Promise<string> {
  if (opts.brief && opts.briefFile) {
    throw new Error("choose either --brief or --brief-file, not both");
  }
  if (opts.brief !== undefined) {
    const brief = opts.brief.trim();
    if (!brief) throw new Error("--brief must not be empty");
    return brief;
  }
  if (opts.briefFile !== undefined) {
    const path = resolve(opts.briefFile);
    if (!existsSync(path)) throw new Error(`brief file not found: ${path}`);
    const brief = readFileSync(path, "utf8").trim();
    if (!brief) throw new Error(`brief file is empty: ${path}`);
    return brief;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("provide --brief <text> or --brief-file <path>");
  }
  const { text, isCancel } = await import("@clack/prompts");
  const answer = await text({
    message: "Planning brief:",
    validate: (value) => (String(value ?? "").trim() ? undefined : "Please enter a brief"),
  });
  if (isCancel(answer)) process.exit(0);
  return String(answer).trim();
}

function readConfiguredDocsRoot(projectDir: string): string | undefined {
  for (const file of [RAFI_CONFIG_FILE, LEGACY_PROJECT_CONFIG_FILE]) {
    const path = join(projectDir, file);
    if (!existsSync(path)) continue;
    const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${file}: expected a YAML object`);
    }
    const docs = raw.docs as Record<string, unknown> | undefined;
    if (typeof docs?.root === "string") return docs.root;
  }
  return undefined;
}

function assertOutputPathInsideRepo(projectDir: string, outputPath: string, label: string): void {
  const repoRoot = resolve(projectDir);
  const outputAbs = resolve(outputPath);
  const rel = relative(repoRoot, outputAbs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`plan output must stay inside the repository: ${label}`);
  }

  const repoReal = realOrResolved(repoRoot);
  const existing = nearestExistingPath(outputAbs);
  if (!existing) return;
  const real = realpathSync(existing);
  const realRel = relative(repoReal, real);
  if (!realRel && existing !== repoRoot) return;
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`plan output must stay inside the repository: ${label}`);
  }
  const stat = statSync(existing);
  if (existing !== outputAbs && !stat.isDirectory()) {
    throw new Error(`plan output parent is not a directory: ${label}`);
  }
}

function nearestExistingPath(path: string): string | undefined {
  let current = pathExistsOrSymlink(path) ? path : dirname(path);
  while (!pathExistsOrSymlink(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

function pathExistsOrSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function fail(message: string): never {
  console.error(`rafi plan: ${message}`);
  process.exit(1);
}
