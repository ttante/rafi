import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface InstallCommand {
  command: string;
  args: string[];
  display: string;
  fallbackFrom?: string;
}

type KnownPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface BuildClaudeAgentSdkInstallCommandOptions {
  resolvePackageManagerVersion?: (
    packageManager: KnownPackageManager,
    targetDir: string,
  ) => string | undefined;
}

export type ClaudeAgentSdkInstallResult = "installed" | "already-installed";

export interface InstallClaudeAgentSdkOptions {
  isInstalled?: (targetDir: string) => boolean;
  execFile?: (command: string, args: string[], options: { cwd: string; stdio: "inherit" }) => void;
}

export function buildClaudeAgentSdkInstallCommand(
  targetDir: string,
  packageManager: string,
  options: BuildClaudeAgentSdkInstallCommandOptions = {},
): InstallCommand {
  const manager = resolvePackageManager(targetDir, packageManager, options);
  const isWorkspaceRoot = hasWorkspaceConfig(targetDir);

  switch (manager.name) {
    case "pnpm":
      return command("pnpm", [
        "add",
        ...(isWorkspaceRoot ? ["-w"] : []),
        CLAUDE_AGENT_SDK_PACKAGE,
      ]);
    case "yarn":
      return command("yarn", [
        "add",
        ...(isWorkspaceRoot && isYarnClassic(manager.version) ? ["-W"] : []),
        CLAUDE_AGENT_SDK_PACKAGE,
      ]);
    case "bun":
      return command("bun", ["add", CLAUDE_AGENT_SDK_PACKAGE]);
    case "npm":
    default:
      return command("npm", ["install", CLAUDE_AGENT_SDK_PACKAGE], manager.fallbackFrom);
  }
}

/** Returns true when the target project can resolve the SDK without changing dependencies. */
export function isClaudeAgentSdkInstalled(targetDir: string): boolean {
  try {
    createRequire(join(targetDir, "package.json")).resolve(CLAUDE_AGENT_SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

export function installClaudeAgentSdk(
  targetDir: string,
  packageManager: string,
  options: InstallClaudeAgentSdkOptions = {},
): ClaudeAgentSdkInstallResult {
  const isInstalled = options.isInstalled ?? isClaudeAgentSdkInstalled;
  if (isInstalled(targetDir)) return "already-installed";

  const install = buildClaudeAgentSdkInstallCommand(targetDir, packageManager);
  const fallback = install.fallbackFrom
    ? ` (unknown package manager \`${install.fallbackFrom}\`; falling back to npm)`
    : "";
  console.log(`rafi: installing Claude Agent SDK with \`${install.display}\`${fallback}...`);
  try {
    const execFile = options.execFile ?? execFileSync;
    execFile(install.command, install.args, { cwd: targetDir, stdio: "inherit" });
    return "installed";
  } catch (err) {
    throw new Error(
      `Claude Agent SDK install failed. Run manually from ${targetDir}: ${install.display}`,
      { cause: err },
    );
  }
}

function command(command: string, args: string[], fallbackFrom?: string): InstallCommand {
  return {
    command,
    args,
    display: [command, ...args].join(" "),
    fallbackFrom,
  };
}

function resolvePackageManager(
  targetDir: string,
  packageManager: string,
  options: BuildClaudeAgentSdkInstallCommandOptions,
): { name: KnownPackageManager; version?: string; fallbackFrom?: string } {
  const selected = parsePackageManager(packageManager);
  if (!selected.name) {
    return { name: "npm", fallbackFrom: packageManager.trim() || "unknown" };
  }

  if (selected.name !== "yarn" || selected.version) {
    return { name: selected.name, version: selected.version };
  }

  const targetPackageManager = parsePackageManager(readTargetPackageManager(targetDir) ?? "");
  if (targetPackageManager.name === "yarn" && targetPackageManager.version) {
    return { name: "yarn", version: targetPackageManager.version };
  }

  const resolvePackageManagerVersion =
    options.resolvePackageManagerVersion ?? defaultResolvePackageManagerVersion;
  return {
    name: "yarn",
    version: resolvePackageManagerVersion("yarn", targetDir),
  };
}

function parsePackageManager(
  packageManager: string,
): { name?: KnownPackageManager; version?: string } {
  const value = packageManager.trim().toLowerCase();
  if (!value) return {};

  for (const name of ["npm", "pnpm", "yarn", "bun"] satisfies KnownPackageManager[]) {
    if (value === name) return { name };
    if (value.startsWith(`${name}@`)) {
      const version = value.slice(name.length + 1).trim();
      return { name, version: version || undefined };
    }
  }

  return {};
}

function defaultResolvePackageManagerVersion(
  packageManager: KnownPackageManager,
  targetDir: string,
): string | undefined {
  try {
    return execFileSync(packageManager, ["--version"], {
      cwd: targetDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function readTargetPackageManager(targetDir: string): string | undefined {
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { packageManager?: unknown };
    return typeof pkg.packageManager === "string" ? pkg.packageManager : undefined;
  } catch {
    return undefined;
  }
}

function isYarnClassic(version: string | undefined): boolean {
  const major = version?.trim().match(/^v?(\d+)/)?.[1];
  return major === "1";
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
