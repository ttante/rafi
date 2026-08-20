import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { isTicketsInitialized } from "../tickets/config.js";
import { cmdValidate } from "../tickets/commands.js";
import { checkGitHubReadiness, inspectGitHubRemote } from "../branch/github.js";
import { requireClaudeSDK } from "../adapters/claude.js";
import { resolveExecutablePath, sanitizeDiagnostics } from "../runtimeReadiness.js";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
)?.version as string;

function commandVersion(command: string): { ok: boolean; detail?: string } {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: result.stderr.trim() };
  return { ok: true, detail: (result.stdout.trim() || result.stderr.trim()).slice(0, 120) };
}

export function buildDoctorCommand(): Command {
  return new Command("doctor")
    .description("Check Foreman, agent CLIs, config, and optional ticket tracker readiness.")
    .argument("[project]", "path to the project directory", ".")
    .option("--github", "run GitHub PR readiness checks")
    .option("--live-claude", "run a bounded no-tools Claude adapter request (uses account quota)")
    .action(async (project: string, opts: { github?: boolean; liveClaude?: boolean }) => {
      const cwd = resolve(project);
      let errors = 0;

      const report = (ok: boolean, label: string, detail?: string): void => {
        console.log(`${ok ? "ok" : "!!"} ${label}${detail ? ` — ${detail}` : ""}`);
        if (!ok) errors++;
      };
      const warn = (label: string, detail?: string): void => {
        console.log(`-- ${label}${detail ? ` — ${detail}` : ""}`);
      };

      report(Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 20, "node >=20", process.version);
      report(Boolean(PACKAGE_VERSION), "foreman package version", PACKAGE_VERSION);
      report(existsSync(cwd), "project directory exists", cwd);
      if (!existsSync(cwd)) process.exit(1);

      try {
        loadConfig(join(cwd, "foreman.yaml"));
        report(true, "foreman.yaml", existsSync(join(cwd, "foreman.yaml")) ? "valid" : "not present, using defaults");
      } catch (err) {
        report(false, "foreman.yaml", err instanceof Error ? err.message : String(err));
      }

      const claudeExecutable = resolveExecutablePath("claude");
      const claude = claudeExecutable ? commandVersion(claudeExecutable) : { ok: false };
      if (claude.ok) warn("claude CLI found", `${claudeExecutable} (${claude.detail})`);
      else warn("claude CLI not found", "required for Claude runs; Rafi never falls back to the SDK-bundled binary");

      try {
        await requireClaudeSDK();
        warn("Rafi Claude SDK wrapper", "available; execution uses the system Claude CLI above");
      } catch (err) {
        report(false, "Rafi Claude SDK wrapper", err instanceof Error ? err.message.split("\n")[0] : String(err));
      }
      warn("Claude setting sources", "user, project, local, and managed policy");
      const relevantEnvironment = Object.keys(process.env)
        .filter((name) => /^(ANTHROPIC|CLAUDE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)(_|$)/i.test(name))
        .sort();
      warn("Claude environment names", relevantEnvironment.length > 0 ? relevantEnvironment.join(", ") : "none set");
      const projectSdkRemoval = projectClaudeSdkRemoval(cwd);
      if (projectSdkRemoval) {
        warn("project-local Claude Agent SDK", `Rafi does not use this dependency; keep it if the application does, otherwise: ${projectSdkRemoval}`);
      }

      if (opts.liveClaude) {
        if (!claudeExecutable) {
          report(false, "live Claude adapter", "system Claude executable is missing");
        } else {
          const live = await liveClaudeSmoke(cwd, claudeExecutable);
          report(live.ok, "live Claude adapter", live.detail);
        }
      }

      const codex = commandVersion("codex");
      if (codex.ok) warn("codex CLI found", codex.detail);
      else warn("codex CLI not found", "required only for --agent codex");

      if (isTicketsInitialized(cwd)) {
        try {
          const result = cmdValidate(cwd);
          report(result.clean, ".tickets validation", result.clean ? "clean" : `${result.issues.length} issue(s)`);
        } catch (err) {
          report(false, ".tickets validation", err instanceof Error ? err.message : String(err));
        }
      } else {
        warn(".tickets", "not initialized; start will run in plain mode");
      }

      const remote = inspectGitHubRemote(cwd);
      const shouldCheckGitHub = Boolean(opts.github) || (remote.ok && remote.remote.likelyGitHub);
      if (shouldCheckGitHub) {
        const readiness = checkGitHubReadiness(cwd);
        if (readiness.ok) {
          report(true, "github PR readiness", readiness.remote.repoArg);
        } else if (opts.github) {
          report(false, "github PR readiness", `${readiness.code}: ${readiness.message}`);
          for (const command of readiness.repairCommands) warn("github repair", command);
          if (readiness.output) warn("github output", truncateOneLine(readiness.output));
        } else {
          warn("github PR readiness", `${readiness.code}: ${readiness.message}`);
          for (const command of readiness.repairCommands) warn("github repair", command);
        }
      }

      process.exit(errors === 0 ? 0 : 1);
    });
}

async function liveClaudeSmoke(cwd: string, executable: string): Promise<{ ok: boolean; detail: string }> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 45_000);
  timer.unref();
  try {
    const { query } = await requireClaudeSDK();
    const queryInstance = query({
      prompt: "Return exactly OK",
      options: {
        cwd,
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user", "project", "local"],
        tools: [],
        permissionMode: "dontAsk",
        persistSession: false,
        abortController,
      },
    });
    for await (const message of queryInstance) {
      if (message.type !== "result") continue;
      const output = "result" in message ? message.result : message.errors.join("; ");
      return message.is_error
        ? { ok: false, detail: sanitizeDiagnostics(output || "Claude returned an error") }
        : { ok: output.trim().toUpperCase() === "OK", detail: sanitizeDiagnostics(output) };
    }
    return { ok: false, detail: "Claude adapter ended without a result" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: abortController.signal.aborted ? "timed out after 45 seconds" : sanitizeDiagnostics(message) };
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}

function projectClaudeSdkRemoval(cwd: string): string | undefined {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, Record<string, string> | undefined>;
    const name = "@anthropic-ai/claude-agent-sdk";
    if (!pkg.dependencies?.[name] && !pkg.devDependencies?.[name] && !pkg.optionalDependencies?.[name]) return undefined;
    if (existsSync(join(cwd, "pnpm-lock.yaml"))) return `pnpm remove ${name}`;
    if (existsSync(join(cwd, "yarn.lock"))) return `yarn remove ${name}`;
    if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return `bun remove ${name}`;
    return `npm uninstall ${name}`;
  } catch {
    return undefined;
  }
}

function truncateOneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 180).trimEnd()}...`;
}
