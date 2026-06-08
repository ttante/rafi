#!/usr/bin/env node
import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { assertProjectConfig } from "rafi-spec";
import { compile, writeProjectYaml } from "./compiler.js";
import { buildProjectConfig, defaultAnswers } from "./project.js";
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
  .description("Re-render .claude/, AGENTS.md, and role bundles from an existing project.yaml.")
  .argument("<project>", "path to the target repo")
  .option("--force", "overwrite existing doc files")
  .action((project: string, opts) => {
    const targetDir = resolve(project);
    const configPath = join(targetDir, "project.yaml");
    if (!existsSync(configPath)) {
      console.error(`rafi: project.yaml not found at ${configPath}`);
      process.exit(1);
    }
    const raw = parseYaml(readFileSync(configPath, "utf8"));
    assertProjectConfig(raw);
    compile(targetDir, raw, { force: opts.force as boolean | undefined });
    console.log(`rafi: compiled ${targetDir}`);
  });

program
  .command("create")
  .description("Run the walkthrough, write project.yaml, and compile the target repo.")
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
      const { intro, outro, text, confirm, isCancel } = await import("@clack/prompts");
      intro("rafi create — configure your AI framework");

      const appName = await text({ message: "App name:", defaultValue: answers.appName });
      if (isCancel(appName)) process.exit(0);

      const frontendRaw = await text({
        message: `Frontend stack (type "No UI" for no frontend):`,
        defaultValue: answers.frontend,
      });
      if (isCancel(frontendRaw)) process.exit(0);

      const backend = await text({ message: "Backend stack:", defaultValue: answers.backend });
      if (isCancel(backend)) process.exit(0);

      const database = await text({ message: "Database:", defaultValue: answers.database });
      if (isCancel(database)) process.exit(0);

      const cloudRaw = await text({
        message: `Cloud provider (type "Local only" for no cloud):`,
        defaultValue: answers.cloud,
      });
      if (isCancel(cloudRaw)) process.exit(0);

      const packageManager = await text({ message: "Package manager:", defaultValue: answers.packageManager });
      if (isCancel(packageManager)) process.exit(0);

      const usesAI = await confirm({ message: "Will this app call LLMs / do AI generation?", initialValue: answers.usesAI });
      if (isCancel(usesAI)) process.exit(0);

      const useClaude = await confirm({
        message: "Do you want to include support for Claude Code? (rafi supports Codex CLI and Claude Code)",
        initialValue: true,
      });
      if (isCancel(useClaude)) process.exit(0);

      const hasTicketsFile = await confirm({
        message: "Do you have an existing file with tickets or plans? (we'll use it to populate your ticket queue)",
        initialValue: false,
      });
      if (isCancel(hasTicketsFile)) process.exit(0);

      let ticketsFile: string | undefined;
      if (hasTicketsFile) {
        const ticketsFilePath = await text({ message: "Path to your tickets or plans file:" });
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

    const config = buildProjectConfig(answers);
    writeProjectYaml(targetDir, config);
    compile(targetDir, config, { force: opts.force as boolean | undefined });

    const aiStatus = config.flags.usesAI ? "on" : "off";
    console.log(`rafi: compiled ${targetDir}`);
    console.log(`rafi: AI rules: ${aiStatus === "off" ? "excluded — re-run \`rafi compile\` after setting usesAI: true to add them" : "included"}`);

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

program.addCommand(buildTicketsCommand());
program.addCommand(buildStartCommand());
program.addCommand(buildStatusCommand());
program.addCommand(buildDoctorCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(`rafi: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
