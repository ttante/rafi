import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface InstallCommand {
  command: string;
  args: string[];
  display: string;
}

export function buildClaudeAgentSdkInstallCommand(
  targetDir: string,
  packageManager: string,
): InstallCommand {
  const manager = normalizePackageManager(packageManager);
  const isWorkspaceRoot = hasWorkspaceConfig(targetDir);

  switch (manager) {
    case "pnpm":
      return command("pnpm", [
        "add",
        ...(isWorkspaceRoot ? ["-w"] : []),
        CLAUDE_AGENT_SDK_PACKAGE,
      ]);
    case "yarn":
      return command("yarn", [
        "add",
        ...(isWorkspaceRoot ? ["-W"] : []),
        CLAUDE_AGENT_SDK_PACKAGE,
      ]);
    case "bun":
      return command("bun", ["add", CLAUDE_AGENT_SDK_PACKAGE]);
    case "npm":
    default:
      return command("npm", ["install", CLAUDE_AGENT_SDK_PACKAGE]);
  }
}

export function installClaudeAgentSdk(targetDir: string, packageManager: string): void {
  const install = buildClaudeAgentSdkInstallCommand(targetDir, packageManager);
  console.log(`rafi: installing Claude Agent SDK with \`${install.display}\`...`);
  try {
    execFileSync(install.command, install.args, { cwd: targetDir, stdio: "inherit" });
  } catch (err) {
    throw new Error(
      `Claude Agent SDK install failed. Run manually from ${targetDir}: ${install.display}`,
      { cause: err },
    );
  }
}

function command(command: string, args: string[]): InstallCommand {
  return {
    command,
    args,
    display: [command, ...args].join(" "),
  };
}

function normalizePackageManager(packageManager: string): "npm" | "pnpm" | "yarn" | "bun" {
  const value = packageManager.trim().toLowerCase();
  if (value.startsWith("pnpm")) return "pnpm";
  if (value.startsWith("yarn")) return "yarn";
  if (value.startsWith("bun")) return "bun";
  if (value.startsWith("npm")) return "npm";
  return "npm";
}

function hasWorkspaceConfig(targetDir: string): boolean {
  if (existsSync(join(targetDir, "pnpm-workspace.yaml"))) return true;

  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
    return Array.isArray(pkg.workspaces) || Boolean(pkg.workspaces);
  } catch {
    return false;
  }
}
