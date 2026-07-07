#!/usr/bin/env node
import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig } from "rafi-spec";
import { compile, writeRafiConfigYaml } from "./compiler.js";
import {
  artifactPaths,
  buildProjectConfig,
  defaultAnswers,
  LEGACY_PROJECT_CONFIG_FILE,
  normalizeProjectConfig,
  RAFI_CONFIG_FILE,
} from "./project.js";
import { buildTicketsCommand } from "ai-foreman/cli/tickets.js";
import { buildStartCommand } from "ai-foreman/cli/start.js";
import { buildStatusCommand } from "ai-foreman/cli/status.js";
import { buildDoctorCommand } from "ai-foreman/cli/doctor.js";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)?.version as string;

const program = new Command();
program
  .name("rafi")
  .description("Scaffold and compile Rafi AI framework configs for a target repo.")
  .version(PACKAGE_VERSION);

program
  .command("compile")
  .description("Re-render .claude/, .codex/, AGENTS.md, and role bundles from an existing rafi-config.yaml.")
  .argument("<project>", "path to the target repo")
  .option("--force", "overwrite existing doc files")
  .action((project: string, opts) => {
    const targetDir = resolve(project);
    const loaded = loadRafiConfig(targetDir);
    if (!loaded) {
      console.error(`rafi: ${RAFI_CONFIG_FILE} not found at ${join(targetDir, RAFI_CONFIG_FILE)}`);
      process.exit(1);
    }
    if (loaded.migrated) {
      writeRafiConfigYaml(targetDir, loaded.config);
      console.log(`rafi: migrated ${LEGACY_PROJECT_CONFIG_FILE} to ${RAFI_CONFIG_FILE}; you can delete ${LEGACY_PROJECT_CONFIG_FILE}.`);
    }
    compile(targetDir, loaded.config, { force: opts.force as boolean | undefined });
    console.log(`rafi: compiled ${targetDir}`);
    console.log(`rafi: custom skills or agents can replace Rafi defaults by setting artifact_source: existing and editing their paths in ${RAFI_CONFIG_FILE}.`);
  });

program
  .command("create")
  .description("Run the walkthrough, write rafi-config.yaml, and compile the target repo.")
  .argument("<project>", "path to the target repo")
  .option("--defaults", "skip walkthrough and use built-in defaults")
  .option("--force", "overwrite existing doc files")
  .action(async (project: string, opts) => {
    const targetDir = resolve(project);

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

    if (!opts.defaults) {
      // Interactive walkthrough — requires Node >=20 for @clack/prompts
      const { intro, outro, text, confirm, isCancel, log } = await import("@clack/prompts");
      intro("rafi create — configure your AI framework");

      log.info("Each question is pre-filled with its default — press Enter to accept.");
      log.info(`Timezone: ${detectedTimezone} (auto-detected, not asked)`);

      const appName = await text({
        message: "App name: (press Enter to accept)",
        initialValue: answers.appName,
        defaultValue: answers.appName,
      });
      if (isCancel(appName)) process.exit(0);

      const frontendRaw = await text({
        message: `Frontend stack (Enter to accept, or type "No UI" for no frontend):`,
        initialValue: answers.frontend,
        defaultValue: answers.frontend,
      });
      if (isCancel(frontendRaw)) process.exit(0);

      const backend = await text({
        message: "Backend stack: (Enter to accept)",
        initialValue: answers.backend,
        defaultValue: answers.backend,
      });
      if (isCancel(backend)) process.exit(0);

      const database = await text({
        message: "Database: (Enter to accept)",
        initialValue: answers.database,
        defaultValue: answers.database,
      });
      if (isCancel(database)) process.exit(0);

      const cloudRaw = await text({
        message: `Cloud provider (Enter to accept, or type "Local only" for no cloud):`,
        initialValue: answers.cloud,
        defaultValue: answers.cloud,
      });
      if (isCancel(cloudRaw)) process.exit(0);

      const packageManager = await text({
        message: "Package manager: (Enter to accept)",
        initialValue: answers.packageManager,
        defaultValue: answers.packageManager,
      });
      if (isCancel(packageManager)) process.exit(0);

      const usesAI = await confirm({
        message: "Will this app call LLMs / do AI generation? (Enter to accept)",
        initialValue: answers.usesAI,
      });
      if (isCancel(usesAI)) process.exit(0);

      const useClaude = await confirm({
        message: "Do you want to include support for Claude Code? (Enter to accept — rafi supports Codex CLI and Claude Code)",
        initialValue: true,
      });
      if (isCancel(useClaude)) process.exit(0);

      const hasTicketsFile = await confirm({
        message: "Do you have an existing file with tickets or plans? (Enter to accept)",
        initialValue: false,
      });
      if (isCancel(hasTicketsFile)) process.exit(0);

      let ticketsFile: string | undefined;
      if (hasTicketsFile) {
        const ticketsFilePath = await text({
          message: "Path to your tickets or plans file:",
          placeholder: "e.g. docs/tickets.md or tickets.yaml",
        });
        if (isCancel(ticketsFilePath)) process.exit(0);
        ticketsFile = String(ticketsFilePath) || undefined;
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
        useClaude: Boolean(useClaude),
        qa: true,
        ticketsFile,
      };

      outro("Configuration collected — compiling...");
    }

    const config = await applyCollisionChoices(targetDir, buildProjectConfig(answers));
    writeRafiConfigYaml(targetDir, config);
    compile(targetDir, config, {
      force: opts.force as boolean | undefined,
    });

    const aiStatus = config.flags.usesAI ? "on" : "off";
    console.log(`rafi: compiled ${targetDir}`);
    console.log(`rafi: AI rules: ${aiStatus === "off" ? "excluded — re-run \`rafi compile\` after setting usesAI: true to add them" : "included"}`);
    console.log(`rafi: custom skills or agents can replace Rafi defaults by setting artifact_source: existing and editing their paths in ${RAFI_CONFIG_FILE}.`);

    if (answers.useClaude) {
      console.log("rafi: installing Claude Agent SDK...");
      execSync("npm install @anthropic-ai/claude-agent-sdk", { cwd: targetDir, stdio: "inherit" });
      console.log("rafi: Claude Agent SDK installed.");
    } else {
      console.log("rafi: skipping Claude Agent SDK (Codex only).");
    }

    if (answers.ticketsFile) {
      console.log(`\nrafi: to import your existing tickets or plans, run:`);
      console.log(`  rafi tickets init --app-name "${answers.appName}"`);
      console.log(`  rafi tickets populate --tickets "${answers.ticketsFile}"`);
    } else {
      console.log(`\nrafi: to set up your ticket queue, run:`);
      console.log(`  rafi tickets init --app-name "${answers.appName}"`);
    }
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
): Promise<ProjectConfig> {
  const next: ProjectConfig = {
    ...config,
    agent_files: { ...config.agent_files },
    agents: cloneArtifactMap(config.agents),
    skills: cloneArtifactMap(config.skills),
  };

  const rootCollisions = [next.agent_files.codex, next.agent_files.claude].filter((path) =>
    existsSync(join(targetDir, path)),
  );
  if (rootCollisions.length > 0) {
    const { select, isCancel } = await import("@clack/prompts");
    const mode = await select({
      message: `${rootCollisions.length} root agent file collision(s) found. How should Rafi handle them?`,
      options: [
        { value: "append", label: "Append — add a dated Rafi section at the end" },
        { value: "update", label: "Update — ask the installed agent runtime to rewrite the file" },
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

function artifactCollisions(
  targetDir: string,
  config: ProjectConfig,
): Array<{ kind: "agent" | "skill"; name: string }> {
  const collisions: Array<{ kind: "agent" | "skill"; name: string }> = [];
  for (const name of Object.keys(config.agents)) {
    const paths = artifactPaths("agent", name);
    if (existsSync(join(targetDir, paths.claude)) || existsSync(join(targetDir, paths.codex))) {
      collisions.push({ kind: "agent", name });
    }
  }
  for (const name of Object.keys(config.skills)) {
    const paths = artifactPaths("skill", name);
    if (existsSync(join(targetDir, paths.claude)) || existsSync(join(targetDir, paths.codex))) {
      collisions.push({ kind: "skill", name });
    }
  }
  return collisions;
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

program.addCommand(buildTicketsCommand());
program.addCommand(buildStartCommand());
program.addCommand(buildStatusCommand());
program.addCommand(buildDoctorCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(`rafi: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
