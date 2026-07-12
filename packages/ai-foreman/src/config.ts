import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

export interface PermissionConfig {
  /** Bash command prefixes that are auto-approved when every segment matches. */
  allowBash: string[];
  /** Bash command substrings that always escalate (checked first). */
  escalateBash: string[];
  /** Tool names auto-approved when their target stays inside the worktree. */
  allowTools: string[];
  /** Tool names that always escalate. */
  escalateTools: string[];
}

export interface NotificationsConfig {
  /** Fire a desktop notification when the builder needs user input. Default: false. */
  enabled: boolean;
}

export interface QaConfig {
  /** Run a QA review pass after each completed ticket or step. Default: true. */
  enabled: boolean;
}

export interface ForemanConfig {
  permissions: PermissionConfig;
  notifications: NotificationsConfig;
  qa: QaConfig;
}

/** Built-in defaults; foreman.yaml overrides any field present. */
export const DEFAULT_CONFIG: ForemanConfig = {
  permissions: {
    allowBash: [
      "npm test",
      "npm run",
      "npm install",
      "npm ci",
      "npx tsc",
      "node ",
      "pnpm ",
      "yarn ",
      "git status",
      "git diff",
      "git add",
      "git commit",
      "git log",
      "git branch",
      "git checkout",
      "git restore",
      "git stash",
      "ls",
      "cat ",
      "mkdir ",
      "ai-foreman tickets",
      "foreman tickets",
      "pytest",
      "python ",
      "python3 ",
      "make ",
      "cargo ",
      "go test",
      "go build",
    ],
    escalateBash: [
      "rm -rf",
      "rm -r",
      "sudo",
      "git push",
      "git reset --hard",
      "git clean",
      "curl",
      "wget",
      "ssh",
      "scp",
      "docker",
      "kubectl",
      "chmod 777",
      "> /dev",
      ":(){",
      "mkfs",
      "dd if=",
    ],
    allowTools: [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "TodoWrite",
    ],
    escalateTools: ["WebFetch", "WebSearch"],
  },
  notifications: { enabled: false },
  qa: { enabled: true },
};

/** Load foreman.yaml if present and deep-merge it over the defaults. */
export function loadConfig(path = "foreman.yaml"): ForemanConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = parse(readFileSync(path, "utf8")) ?? {};
  validateConfig(raw, path);
  return {
    permissions: { ...DEFAULT_CONFIG.permissions, ...(raw.permissions ?? {}) },
    notifications: {
      ...DEFAULT_CONFIG.notifications,
      ...(raw.notifications ?? {}),
    } as NotificationsConfig,
    qa: { ...DEFAULT_CONFIG.qa, ...(raw.qa ?? {}) } as QaConfig,
  };
}

function validateConfig(raw: unknown, path: string): asserts raw is {
  permissions?: Partial<PermissionConfig>;
  notifications?: Partial<NotificationsConfig>;
  qa?: Partial<QaConfig>;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected a YAML object`);
  }
  const cfg = raw as Record<string, unknown>;
  if (cfg.permissions !== undefined) {
    if (!cfg.permissions || typeof cfg.permissions !== "object" || Array.isArray(cfg.permissions)) {
      throw new Error(`${path}: permissions must be an object`);
    }
    const permissions = cfg.permissions as Record<string, unknown>;
    for (const key of ["allowBash", "escalateBash", "allowTools", "escalateTools"]) {
      if (permissions[key] !== undefined && !isStringArray(permissions[key])) {
        throw new Error(`${path}: permissions.${key} must be an array of strings`);
      }
    }
  }
  if (cfg.notifications !== undefined) {
    validateBooleanObject(cfg.notifications, "notifications", path);
  }
  if (cfg.qa !== undefined) {
    validateBooleanObject(cfg.qa, "qa", path);
  }
}

function validateBooleanObject(value: unknown, name: string, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: ${name} must be an object`);
  }
  const enabled = (value as Record<string, unknown>).enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(`${path}: ${name}.enabled must be a boolean`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
