#!/usr/bin/env node
import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig } from "rafi-spec";
import {
  compile,
  formatRuntimeUpdateFailure,
  isRootFileMode,
  rootFileModeValues,
  runtimeCommandLabel,
  writeRafiConfigYaml,
  type AgentRuntime,
  type RuntimeUpdateError,
} from "./compiler.js";
import { compileWithRootUpdateRecovery, type RootUpdateRecoveryChoice } from "./createRecovery.js";
import {
  ensureAgentRuntimesReady,
  type RuntimeReadinessChoice,
  type RuntimeReadinessError,
} from "./runtimeReadiness.js";
import {
  artifactPaths,
  buildProjectConfig,
  DEFAULT_DOCS_ROOT,
  defaultAnswers,
  LEGACY_PROJECT_CONFIG_FILE,
  normalizeProjectConfig,
  parseRuntimeSelection,
  RAFI_CONFIG_FILE,
  runtimeSelectionToTargets,
  type WalkthroughAnswers,
} from "./project.js";
import { docsRootPathExists, firstAvailableDocsRoot, validateDocsRoot } from "./docs.js";
import { buildTicketsCommand } from "ai-foreman/cli/tickets.js";
import { buildStartCommand } from "ai-foreman/cli/start.js";
import { buildStatusCommand } from "ai-foreman/cli/status.js";
import { buildDoctorCommand } from "ai-foreman/cli/doctor.js";
import { installClaudeAgentSdk } from "./sdkInstall.js";
import { buildPlanCommand } from "./plan.js";
import {
  checkpointInterview,
  completeInterview,
  createInterviewRecord,
  discardInterview,
  findInterviewRecord,
  pruneCompletedInterviews,
  readInterviewRecords,
  type InterviewRecord,
} from "ai-foreman/interviews.js";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)?.version as string;

export const program = new Command();
program
  .name("rafi")
  .description("Scaffold and compile Rafi AI framework configs for a target repo.")
  .version(PACKAGE_VERSION);

program
  .command("compile")
  .description("Re-render .claude/, .codex/, AGENTS.md, and role bundles from an existing rafi-config.yaml.")
  .argument("<project>", "path to the target repo")
  .option("--force", "overwrite existing doc files")
  .option("--root-file-mode <mode>", "override root instruction file handling for this run (append | overwrite | update)")
  .action((project: string, opts) => {
    const targetDir = resolve(project);
    const rootFileMode = parseRootFileMode(opts.rootFileMode);
    const loaded = loadRafiConfig(targetDir);
    if (!loaded) {
      console.error(`rafi: ${RAFI_CONFIG_FILE} not found at ${join(targetDir, RAFI_CONFIG_FILE)}`);
      process.exit(1);
    }
    if (loaded.migrated) {
      writeRafiConfigYaml(targetDir, loaded.config);
      console.log(`rafi: migrated ${LEGACY_PROJECT_CONFIG_FILE} to ${RAFI_CONFIG_FILE}; you can delete ${LEGACY_PROJECT_CONFIG_FILE}.`);
    }
    compile(targetDir, loaded.config, {
      force: opts.force as boolean | undefined,
      rootFileMode,
    });
    console.log(`rafi: compiled ${targetDir}`);
    console.log(`rafi: custom skills or agents can replace Rafi defaults by setting artifact_source: existing and editing their paths in ${RAFI_CONFIG_FILE}.`);
  });

program
  .command("create")
  .description("Run the walkthrough, write rafi-config.yaml, and compile the target repo.")
  .argument("<project>", "path to the target repo")
  .option("--defaults", "skip walkthrough and use built-in defaults")
  .option("--force", "overwrite existing doc files")
  .option("--docs-root <dir>", "repo-relative directory for Rafi starter and tracker docs")
  .option("--runtime <runtime>", "agent runtime targets to configure (both | claude | codex)")
  .option("--root-file-mode <mode>", "override root instruction file handling (append | overwrite | update)")
  .action(async (project: string, opts) => {
    const targetDir = resolve(project);
    const rootFileMode = parseRootFileMode(opts.rootFileMode);
    const runtimeOption = parseRuntimeSelection(opts.runtime);
    const docsRootOption = opts.docsRoot as string | undefined;

    // Read app name from target package.json if present
    const targetPkgPath = join(targetDir, "package.json");
    const targetPkgName = existsSync(targetPkgPath)
      ? (JSON.parse(readFileSync(targetPkgPath, "utf8")) as { name?: string }).name ?? undefined
      : undefined;

    // Detect timezone from the runtime — no need to ask
    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    let answers = {
      ...defaultAnswers(),
      ...(targetPkgName ? { appName: targetPkgName } : {}),
      timezone: detectedTimezone,
    };
    const interactiveInterview = !opts.defaults && process.stdin.isTTY && process.stdout.isTTY;
    let interview: InterviewRecord | undefined = interactiveInterview
      ? createInterviewRecord({
        workflow: "create",
        invocation: { projectDir: targetDir, force: Boolean(opts.force), docsRoot: docsRootOption, runtime: runtimeOption, rootFileMode },
        checkpoint: "app-name",
        outputs: [RAFI_CONFIG_FILE],
      })
      : undefined;
    if (interview) interview = checkpointInterview(targetDir, interview, { checkpoint: "app-name" });
    const checkpointCreateAnswer = (checkpoint: string, key: string, value: unknown): void => {
      if (!interview) return;
      interview = checkpointInterview(targetDir, interview, {
        checkpoint,
        answers: { ...interview.answers, [key]: value },
      });
    };
    if (runtimeOption) {
      answers.runtimeTargets = runtimeSelectionToTargets(runtimeOption);
    }

    if (!opts.defaults) {
      // Interactive walkthrough — requires Node >=20 for @clack/prompts
      const { intro, outro, text, confirm, select, isCancel, log } = await import("@clack/prompts");
      intro("rafi create — configure your AI framework");

      log.info("Each question is pre-filled with its default — press Enter to accept.");
      log.info(`Timezone: ${detectedTimezone} (auto-detected, not asked)`);

      const appName = await text({
        message: "App name: (press Enter to accept)",
        initialValue: answers.appName,
        defaultValue: answers.appName,
      });
      if (isCancel(appName)) process.exit(0);
      checkpointCreateAnswer("frontend", "appName", String(appName));

      const frontendRaw = await text({
        message: `Frontend stack (Enter to accept, or type "No UI" for no frontend):`,
        initialValue: answers.frontend,
        defaultValue: answers.frontend,
      });
      if (isCancel(frontendRaw)) process.exit(0);
      checkpointCreateAnswer("backend", "frontend", String(frontendRaw));

      const backend = await text({
        message: "Backend stack: (Enter to accept)",
        initialValue: answers.backend,
        defaultValue: answers.backend,
      });
      if (isCancel(backend)) process.exit(0);
      checkpointCreateAnswer("database", "backend", String(backend));

      const database = await text({
        message: "Database: (Enter to accept)",
        initialValue: answers.database,
        defaultValue: answers.database,
      });
      if (isCancel(database)) process.exit(0);
      checkpointCreateAnswer("cloud", "database", String(database));

      const cloudRaw = await text({
        message: `Cloud provider (Enter to accept, or type "Local only" for no cloud):`,
        initialValue: answers.cloud,
        defaultValue: answers.cloud,
      });
      if (isCancel(cloudRaw)) process.exit(0);
      checkpointCreateAnswer("package-manager", "cloud", String(cloudRaw));

      const packageManager = await text({
        message: "Package manager: (Enter to accept)",
        initialValue: answers.packageManager,
        defaultValue: answers.packageManager,
      });
      if (isCancel(packageManager)) process.exit(0);
      checkpointCreateAnswer("uses-ai", "packageManager", String(packageManager));

      const usesAI = await confirm({
        message: "Will this app call LLMs / do AI generation? (Enter to accept)",
        initialValue: answers.usesAI,
      });
      if (isCancel(usesAI)) process.exit(0);
      checkpointCreateAnswer("runtime-targets", "usesAI", Boolean(usesAI));

      const runtimeSelection = runtimeOption ?? await select({
        message: "Agent runtime targets:",
        initialValue: "both",
        options: [
          { value: "both", label: "Both" },
          { value: "claude", label: "Claude only" },
          { value: "codex", label: "Codex only" },
        ],
      });
      if (isCancel(runtimeSelection)) process.exit(0);
      checkpointCreateAnswer("docs-root", "runtimeTargets", String(runtimeSelection));

      const docsRoot = await chooseDocsRootForCreate(targetDir, docsRootOption, {
        interactive: true,
        select,
        text,
        isCancel,
      });
      checkpointCreateAnswer("planning-sources-confirm", "docsRoot", docsRoot);

      const hasPlanningSources = await confirm({
        message: "Do you have existing ticket or planning docs you want the populate agent to use? (Enter to accept)",
        initialValue: false,
      });
      if (isCancel(hasPlanningSources)) process.exit(0);
      checkpointCreateAnswer("planning-sources", "hasPlanningSources", Boolean(hasPlanningSources));

      let planningSources: string | undefined;
      if (hasPlanningSources) {
        log.info("Any format is OK: Markdown, YAML, text notes, folders, or globs. `rafi tickets populate` will scan relevant docs too.");
        const planningSourcesRaw = await text({
          message: "Files, folders, or globs for existing tickets/plans:",
          placeholder: `e.g. ${docsRoot}/tickets.md, ${docsRoot}/plans.md, ${docsRoot}/planning/**`,
        });
        if (isCancel(planningSourcesRaw)) process.exit(0);
        planningSources = String(planningSourcesRaw) || undefined;
        checkpointCreateAnswer("compile-config", "planningSources", planningSources);
      }

      answers = {
        appName: String(appName),
        timezone: detectedTimezone,
        frontend: String(frontendRaw),
        backend: String(backend),
        database: String(database),
        cloud: String(cloudRaw),
        packageManager: String(packageManager),
        usesAI: Boolean(usesAI),
        runtimeTargets: runtimeSelectionToTargets(parseRuntimeSelection(runtimeSelection) ?? "both"),
        qa: true,
        docsRoot,
        planningSources,
      };
      if (interview) interview = checkpointInterview(targetDir, interview, {
        checkpoint: "compile-config",
        answers: { ...answers },
      });

      outro("Configuration collected — compiling...");
    } else {
      answers = {
        ...answers,
        ...(runtimeOption ? { runtimeTargets: runtimeSelectionToTargets(runtimeOption) } : {}),
        docsRoot: await chooseDocsRootForCreate(targetDir, docsRootOption, { interactive: false }),
      };
    }

    let config = await applyCollisionChoices(targetDir, buildProjectConfig(answers), rootFileMode);
    if (interview) interview = checkpointInterview(targetDir, interview, { checkpoint: "write-config" });
    writeRafiConfigYaml(targetDir, config);
    config = await compileCreateConfig(
      targetDir,
      config,
      {
        force: opts.force as boolean | undefined,
      },
      promptRootUpdateRecovery,
    );

    const finalTargets = await ensureCreateRuntimesReady(targetDir, config, Boolean(opts.defaults));
    if (!sameTargets(config.harness.targets, finalTargets)) {
      const previousTargets = config.harness.targets;
      config = {
        ...config,
        harness: {
          ...config.harness,
          targets: finalTargets,
        },
      };
      writeRafiConfigYaml(targetDir, config);
      config = await compileCreateConfig(
        targetDir,
        config,
        {
          force: opts.force as boolean | undefined,
        },
        promptRootUpdateRecovery,
      );
      if (!sameTargets(previousTargets, config.harness.targets) && sameTargets(config.harness.targets, finalTargets)) {
        console.log(`rafi: switched runtime target to ${config.harness.targets.join(" and ")} and updated ${RAFI_CONFIG_FILE}.`);
      }
    }

    const aiStatus = config.flags.usesAI ? "on" : "off";
    console.log(`rafi: compiled ${targetDir}`);
    console.log(`rafi: AI rules: ${aiStatus === "off" ? "excluded — re-run \`rafi compile\` after setting usesAI: true to add them" : "included"}`);
    console.log(`rafi: custom skills or agents can replace Rafi defaults by setting artifact_source: existing and editing their paths in ${RAFI_CONFIG_FILE}.`);

    if (config.harness.targets.includes("claude")) {
      const sdkInstall = installClaudeAgentSdk(targetDir, answers.packageManager);
      console.log(
        sdkInstall === "installed"
          ? "rafi: Claude Agent SDK installed."
          : "rafi: Claude Agent SDK already installed; skipping.",
      );
    } else {
      console.log("rafi: skipping Claude Agent SDK (Codex only).");
    }

    console.log(`rafi: verified agent runtime auth for ${config.harness.targets.join(" and ")}.`);

    await runCreateTicketHandoff(targetDir, config, answers, Boolean(opts.defaults));
    if (interview) completeInterview(targetDir, interview);
  });

program
  .command("resume")
  .description("Resume or discard a saved interactive create, plan, or ticket-setup interview.")
  .argument("[project]", "path to the target repo", ".")
  .option("--id <id>", "saved interview id (or unique prefix) to resume")
  .option("--discard <id>", "discard a saved interview id (or unique prefix)")
  .action(async (project: string, opts) => {
    const projectDir = resolve(project);
    pruneCompletedInterviews(projectDir);
    if (opts.discard) {
      if (!discardInterview(projectDir, String(opts.discard))) throw new Error(`interview not found: ${opts.discard}`);
      console.log(`rafi resume: discarded ${opts.discard}`);
      return;
    }
    const available = readInterviewRecords(projectDir).records.filter((record) => record.status !== "completed");
    if (available.length === 0) {
      console.log("rafi resume: no unfinished interviews found");
      return;
    }
    let record = opts.id ? findInterviewRecord(projectDir, String(opts.id)) : undefined;
    if (!record && !opts.id) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("provide --id <id> when stdin/stdout is not a TTY");
      }
      const { select, isCancel } = await import("@clack/prompts");
      const chosen = await select({
        message: "Which interview should Rafi resume?",
        options: available.map((item) => ({
          value: item.id,
          label: `${item.workflow} — ${item.checkpoint} — ${item.failure?.summary ?? "interrupted"}`,
          hint: item.updatedAt,
        })),
      });
      if (isCancel(chosen)) return;
      record = findInterviewRecord(projectDir, String(chosen));
    }
    if (!record) throw new Error(`interview not found: ${opts.id}`);
    if (record.status === "incompatible") {
      throw new Error(`interview ${record.id} uses an incompatible state version; use --discard ${record.id} to remove it`);
    }
    console.log(`rafi resume: ${record.workflow} at ${record.checkpoint}`);
    if (record.runtime.sessionId) {
      console.log(`rafi resume: saved ${record.runtime.runtime ?? "agent"} session ${record.runtime.sessionId} will be requested by the workflow.`);
    } else if (record.checkpoint === "agent-run") {
      console.log("rafi resume: the prior agent session is unavailable; the workflow will start a fresh session with the saved brief and answers.");
    }
    await resumeInterview(projectDir, record);
  });

function loadRafiConfig(targetDir: string): { config: ProjectConfig; migrated: boolean } | undefined {
  const configPath = join(targetDir, RAFI_CONFIG_FILE);
  if (existsSync(configPath)) {
    return {
      config: normalizeProjectConfig(parseYaml(readFileSync(configPath, "utf8"))),
      migrated: false,
    };
  }
  const legacyPath = join(targetDir, LEGACY_PROJECT_CONFIG_FILE);
  if (!existsSync(legacyPath)) return undefined;
  return {
    config: normalizeProjectConfig(parseYaml(readFileSync(legacyPath, "utf8"))),
    migrated: true,
  };
}

async function applyCollisionChoices(
  targetDir: string,
  config: ProjectConfig,
  rootFileMode?: ProjectConfig["agent_files"]["mode"],
): Promise<ProjectConfig> {
  const next: ProjectConfig = {
    ...config,
    agent_files: { ...config.agent_files },
    docs: config.docs ? { ...config.docs } : undefined,
    agents: cloneArtifactMap(config.agents),
    skills: cloneArtifactMap(config.skills),
  };
  if (rootFileMode) {
    next.agent_files.mode = rootFileMode;
  }

  const rootCollisions = selectedRootInstructionPaths(next).filter((path) => existsSync(join(targetDir, path)));
  if (rootCollisions.length > 0 && !rootFileMode) {
    const { select, isCancel } = await import("@clack/prompts");
    const mode = await select({
      message: `${rootCollisions.length} root agent file collision(s) found. How should Rafi handle them?`,
      options: [
        { value: "append", label: "Append — preserve existing text and add Rafi guidance or a sidecar reference" },
        { value: "update", label: "Update — ask an authenticated installed agent runtime to rewrite the file" },
        { value: "overwrite", label: "Overwrite — replace with Rafi's generated file" },
      ],
    });
    if (isCancel(mode)) process.exit(0);
    next.agent_files.mode = mode as ProjectConfig["agent_files"]["mode"];
  }

  const collisions = artifactCollisions(targetDir, next);
  if (collisions.length === 0) return next;

  const { confirm, isCancel } = await import("@clack/prompts");
  const overwrite = await confirm({
    message: `${collisions.length} skill/subagent name collision(s) found. Should Rafi overwrite existing files with the same name?`,
    initialValue: false,
  });
  if (isCancel(overwrite)) process.exit(0);
  if (overwrite) return next;

  for (const item of collisions) {
    setArtifactPaths(next, item.kind, item.name, `${item.name}-rafi`);
  }

  const useExisting = await confirm({
    message: "Do you want Rafi to use any pre-existing skills or agents instead of the ones it provides?",
    initialValue: false,
  });
  if (isCancel(useExisting)) process.exit(0);
  if (!useExisting) return next;

  for (let i = 0; i < collisions.length; i++) {
    const item = collisions[i];
    const useThis = await confirm({
      message: `Use ${item.kind} ${item.name} instead of ${item.name}-rafi? (${i + 1} of ${collisions.length})`,
      initialValue: true,
    });
    if (isCancel(useThis)) process.exit(0);
    if (useThis) setArtifactPaths(next, item.kind, item.name, item.name, "existing");
  }

  return next;
}

async function promptRootUpdateRecovery(err: RuntimeUpdateError): Promise<RootUpdateRecoveryChoice> {
  const { select, isCancel, log } = await import("@clack/prompts");
  log.error(formatRuntimeUpdateFailure(err));
  log.info(
    "Cancel stops here and keeps generated files in place. Rafi will not uninstall packages, delete generated files, or corrupt setup.",
  );
  const choice = await select({
    message: `${runtimeCommandLabel(err.runtime)} failed while updating ${err.targetFile}. What should Rafi do?`,
    options: [
      { value: "retry", label: "Fix manually and retry update" },
      { value: "switch", label: `Use ${runtimeDisplayName(otherRuntime(err.runtime))} for now` },
      { value: "append", label: "Append instead — preserve existing guidance and add Rafi guidance or a sidecar reference" },
      { value: "overwrite", label: "Overwrite instead — replace the root instruction files" },
      { value: "cancel", label: "Cancel - stop here; keep generated files" },
    ],
  });
  if (isCancel(choice) || choice === "cancel") process.exit(0);
  return choice as RootUpdateRecoveryChoice;
}

async function compileCreateConfig(
  targetDir: string,
  config: ProjectConfig,
  opts: Parameters<typeof compileWithRootUpdateRecovery>[2],
  choose: Parameters<typeof compileWithRootUpdateRecovery>[3],
): Promise<ProjectConfig> {
  const result = await compileWithRootUpdateRecovery(targetDir, config, opts, choose);
  if (!sameTargets(config.harness.targets, result.harness.targets)) {
    writeRafiConfigYaml(targetDir, result);
    console.log(`rafi: switched runtime target to ${result.harness.targets.join(" and ")} and updated ${RAFI_CONFIG_FILE}.`);
    return result;
  }
  return config;
}

async function ensureCreateRuntimesReady(
  targetDir: string,
  config: ProjectConfig,
  defaultsMode: boolean,
): Promise<AgentRuntime[]> {
  const nonInteractive = defaultsMode || !process.stdin.isTTY || !process.stdout.isTTY;
  if (nonInteractive) {
    return ensureAgentRuntimesReady(targetDir, config.harness.targets, async (err) => {
      throw err;
    });
  }
  return ensureAgentRuntimesReady(targetDir, config.harness.targets, promptRuntimeReadinessRecovery);
}

async function promptRuntimeReadinessRecovery(
  err: RuntimeReadinessError,
  otherRuntime: AgentRuntime,
): Promise<RuntimeReadinessChoice> {
  const { select, isCancel, log } = await import("@clack/prompts");
  log.error(err.message);
  log.info(
    "Cancel stops here and keeps generated files in place. Rafi will not uninstall packages, delete generated files, or corrupt setup. " +
    `After fixing authentication, run \`rafi compile .\`, \`rafi start . --steps ...\`, or rerun \`rafi create .\` if you want the walkthrough again.`,
  );
  const choice = await select({
    message: `${runtimeCommandLabel(err.runtime)} is not ready. What should Rafi do?`,
    options: [
      { value: "retry", label: "Fix manually and retry check" },
      { value: "switch", label: `Use ${runtimeDisplayName(otherRuntime)} for now` },
      { value: "cancel", label: "Cancel - stop here; keep generated files" },
    ],
  });
  if (isCancel(choice) || choice === "cancel") process.exit(0);
  return choice as RuntimeReadinessChoice;
}

function parseRootFileMode(value: unknown): ProjectConfig["agent_files"]["mode"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && isRootFileMode(value)) return value;
  throw new Error(`--root-file-mode must be one of: ${rootFileModeValues().join(", ")}`);
}

type DocsRootPromptTools = {
  interactive: true;
  select: (opts: {
    message: string;
    options: Array<{ value: string; label: string }>;
  }) => Promise<unknown>;
  text: (opts: {
    message: string;
    initialValue?: string;
    defaultValue?: string;
    validate?: (value: string | undefined) => string | Error | undefined;
  }) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
} | {
  interactive: false;
};

async function chooseDocsRootForCreate(
  targetDir: string,
  docsRootOption: string | undefined,
  tools: DocsRootPromptTools,
): Promise<string> {
  if (docsRootOption) return validateDocsRoot(targetDir, docsRootOption);

  if (!docsRootPathExists(targetDir, DEFAULT_DOCS_ROOT)) {
    return DEFAULT_DOCS_ROOT;
  }

  const recommended = firstAvailableDocsRoot(targetDir);
  if (!tools.interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return recommended;
  }

  const choice = await tools.select({
    message: "A `docs/` path already exists. Where should Rafi put its starter docs?",
    options: [
      { value: "separate", label: `Use separate ${recommended}/ (Recommended) - keeps existing app docs untouched` },
      { value: "existing", label: "Use existing docs/ - add only missing Rafi docs unless --force is set" },
      { value: "custom", label: "Choose custom folder" },
    ],
  });
  if (tools.isCancel(choice)) process.exit(0);
  if (choice === "separate") return recommended;
  if (choice === "existing") return validateDocsRoot(targetDir, DEFAULT_DOCS_ROOT);

  const custom = await tools.text({
    message: "Custom Rafi docs folder:",
    initialValue: recommended,
    defaultValue: recommended,
    validate: (value) => {
      try {
        validateDocsRoot(targetDir, value ?? "");
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  if (tools.isCancel(custom)) process.exit(0);
  return validateDocsRoot(targetDir, String(custom));
}

function ticketsInitCommand(appName: string, docsRoot: string): string {
  const docsArg = docsRoot === DEFAULT_DOCS_ROOT ? "" : ` --docs-root ${shellQuote(docsRoot)}`;
  return `rafi tickets init --app-name ${shellQuote(appName)}${docsArg}`;
}

async function runCreateTicketHandoff(
  targetDir: string,
  config: ProjectConfig,
  answers: WalkthroughAnswers,
  defaultsMode: boolean,
): Promise<void> {
  const docsRoot = config.docs?.root ?? DEFAULT_DOCS_ROOT;
  const setupCommand = setupInitCommand(targetDir, answers, docsRoot);
  const planCommand = `rafi plan ${shellQuote(targetDir)}`;
  const populateCommand = `rafi tickets populate --project ${shellQuote(targetDir)}`;
  const interactive = !defaultsMode && process.stdin.isTTY && process.stdout.isTTY;

  if (!interactive) {
    console.log("\nrafi: next steps:");
    console.log(`  ${planCommand}`);
    console.log(`  ${setupCommand}`);
    console.log(`  ${populateCommand}`);
    return;
  }

  const { confirm, isCancel } = await import("@clack/prompts");
  const runPlan = await confirm({
    message: "Run `rafi plan .` now?",
    initialValue: false,
  });
  if (isCancel(runPlan)) process.exit(0);
  if (runPlan) runSelfCommand(["plan", targetDir]);

  const runSetup = await confirm({
    message: "Run `rafi tickets setup:init` now?",
    initialValue: true,
  });
  if (isCancel(runSetup)) process.exit(0);
  if (runSetup) {
    runSelfCommand(["tickets", "setup:init", "--project", targetDir]);
  } else {
    console.log("\nrafi: ticket setup commands:");
    console.log(`  ${setupCommand}`);
    console.log(`  ${populateCommand}`);
  }
}

function setupInitCommand(targetDir: string, answers: WalkthroughAnswers, docsRoot: string): string {
  const args = [
    "rafi tickets setup:init",
    "--project",
    shellQuote(targetDir),
    "--app-name",
    shellQuote(answers.appName),
  ];
  if (docsRoot !== DEFAULT_DOCS_ROOT) args.push("--docs-root", shellQuote(docsRoot));
  if (answers.planningSources) {
    args.push("--local-source", ...parsePlanningSources(answers.planningSources).map(shellQuote));
  }
  return args.join(" ");
}

function runSelfCommand(args: string[]): void {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    stdio: "inherit",
  });
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

async function resumeInterview(projectDir: string, record: InterviewRecord): Promise<void> {
  const entry = fileURLToPath(import.meta.url);
  const invocation = record.invocation;
  let args: string[];
  if (record.workflow === "plan") {
    const brief = record.answers.brief;
    if (typeof brief !== "string" || !brief.trim()) {
      throw new Error("the saved plan interview has no brief yet; rerun `rafi plan` to answer the brief question");
    }
    args = ["plan", projectDir, "--brief", brief, "--yes"];
    for (const [key, option] of [["agent", "--agent"], ["model", "--model"], ["effort", "--effort"]] as const) {
      if (typeof invocation[key] === "string") args.push(option, invocation[key] as string);
    }
    if (invocation.fast) args.push("--fast");
    if (record.runtime.sessionId) args.push("--resume-session", record.runtime.sessionId);
  } else if (record.workflow === "create") {
    // Create's saved values are retained for audit and recovery. Its historical
    // prompt implementation does not yet accept answer injection, so re-enter
    // the walkthrough rather than replacing configuration with defaults.
    args = ["create", projectDir];
    if (invocation.force) args.push("--force");
    if (typeof invocation.docsRoot === "string") args.push("--docs-root", invocation.docsRoot);
    if (typeof invocation.runtime === "string") args.push("--runtime", invocation.runtime);
    if (typeof invocation.rootFileMode === "string") args.push("--root-file-mode", invocation.rootFileMode);
  } else {
    args = ["tickets", record.workflow === "tickets-setup-init" ? "setup:init" : "setup:update", "--project", projectDir];
  }
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`resumed ${record.workflow} exited with status ${result.status ?? "unknown"}`);
  completeInterview(projectDir, record);
}

function artifactCollisions(
  targetDir: string,
  config: ProjectConfig,
): Array<{ kind: "agent" | "skill"; name: string }> {
  const collisions: Array<{ kind: "agent" | "skill"; name: string }> = [];
  for (const name of Object.keys(config.agents)) {
    const paths = artifactPaths("agent", name);
    if (selectedArtifactPaths(config, paths).some((path) => existsSync(join(targetDir, path)))) {
      collisions.push({ kind: "agent", name });
    }
  }
  for (const name of Object.keys(config.skills)) {
    const paths = artifactPaths("skill", name);
    if (selectedArtifactPaths(config, paths).some((path) => existsSync(join(targetDir, path)))) {
      collisions.push({ kind: "skill", name });
    }
  }
  return collisions;
}

function selectedArtifactPaths(
  config: ProjectConfig,
  paths: ProjectConfig["agents"][string],
): string[] {
  return config.harness.targets.map((target) => paths[target]);
}

function selectedRootInstructionPaths(config: ProjectConfig): string[] {
  return config.harness.targets.map((target) => config.agent_files[target]);
}

function setArtifactPaths(
  config: ProjectConfig,
  kind: "agent" | "skill",
  genericName: string,
  installedName: string,
  artifactSource: ProjectConfig["agents"][string]["artifact_source"] = "rafi",
): void {
  if (kind === "agent") {
    config.agents[genericName] = artifactPaths("agent", installedName, artifactSource);
  } else {
    config.skills[genericName] = artifactPaths("skill", installedName, artifactSource);
  }
}

function cloneArtifactMap(map: ProjectConfig["agents"]): ProjectConfig["agents"] {
  return Object.fromEntries(Object.entries(map).map(([name, paths]) => [name, { ...paths }]));
}

function parsePlanningSources(raw: string | string[]): string[] {
  return (Array.isArray(raw) ? raw.join(" ") : raw)
    .split(/\s*(?:,|\+)\s*|\s+/)
    .map((source) => source.trim())
    .filter(Boolean);
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function runtimeDisplayName(runtime: AgentRuntime): string {
  return runtime === "claude" ? "Claude" : "Codex";
}

function otherRuntime(runtime: AgentRuntime): AgentRuntime {
  return runtime === "claude" ? "codex" : "claude";
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

program.addCommand(buildPlanCommand());
program.addCommand(buildTicketsCommand());
program.addCommand(buildStartCommand());
program.addCommand(buildStatusCommand());
program.addCommand(buildDoctorCommand());

export async function runRafiCli(argv = process.argv): Promise<void> {
  await program.parseAsync(argv);
}

if (isDirectCliEntrypoint()) {
  runRafiCli().catch((err) => {
    console.error(`rafi: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

function isDirectCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return resolve(entry) === modulePath;
  }
}
