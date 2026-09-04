import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { DEFAULT_OBSERVABILITY_CONFIG, type ObservabilityConfig } from "./observability.js";

export interface PermissionConfig {
  /** Bash command prefixes that are auto-approved when every segment matches. */
  allowBash: string[];
  /** Bash command substrings that always escalate (checked first). */
  escalateBash: string[];
  /** Escalate shell redirection even when it is attached to an allowed command. */
  strictShellRedirection?: boolean;
  /** Tool names auto-approved when their target stays inside the worktree. */
  allowTools: string[];
  /** Tool names that always escalate. */
  escalateTools: string[];
}

export interface NotificationsConfig {
  /** Fire a desktop notification when the builder needs user input. Default: false. */
  enabled: boolean;
  /** Ring the terminal bell when user attention is required or a run finishes. Default: true. */
  terminal_bell: boolean;
}

export interface QaConfig {
  /** Run a QA review pass after each completed ticket or step. Default: true. */
  enabled: boolean;
}

export interface ForemanConfig {
  permissions: PermissionConfig;
  notifications: NotificationsConfig;
  qa: QaConfig;
  observability: ObservabilityConfig;
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
  notifications: { enabled: false, terminal_bell: true },
  qa: { enabled: true },
  observability: DEFAULT_OBSERVABILITY_CONFIG,
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
    observability: { ...DEFAULT_CONFIG.observability, ...(raw.observability ?? {}) } as ObservabilityConfig,
  };
}

function validateConfig(raw: unknown, path: string): asserts raw is {
  permissions?: Partial<PermissionConfig>;
  notifications?: Partial<NotificationsConfig>;
  qa?: Partial<QaConfig>;
  observability?: Partial<ObservabilityConfig>;
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
    if (permissions.strictShellRedirection !== undefined && typeof permissions.strictShellRedirection !== "boolean") {
      throw new Error(`${path}: permissions.strictShellRedirection must be a boolean`);
    }
  }
  if (cfg.notifications !== undefined) {
    validateBooleanObject(cfg.notifications, "notifications", path);
    const terminalBell = (cfg.notifications as Record<string, unknown>).terminal_bell;
    if (terminalBell !== undefined && typeof terminalBell !== "boolean") {
      throw new Error(`${path}: notifications.terminal_bell must be a boolean`);
    }
  }
  if (cfg.qa !== undefined) {
    validateBooleanObject(cfg.qa, "qa", path);
  }
  if (cfg.observability !== undefined) validateObservability(cfg.observability, path);
}

function validateObservability(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: observability must be an object`);
  const input = value as Record<string, unknown>;
  const keys = ["enabled", "sample_interval_seconds", "detail_retention_days", "log_retention_days", "detail_soft_limit_mb", "detail_hard_limit_mb", "log_limit_mb"] as const;
  for (const key of Object.keys(input)) if (!(keys as readonly string[]).includes(key)) throw new Error(`${path}: unknown observability setting ${key}`);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error(`${path}: observability.enabled must be a boolean`);
  for (const key of keys.filter((key) => key !== "enabled")) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || Number(input[key]) <= 0)) throw new Error(`${path}: observability.${key} must be a positive integer`);
  }
  const merged = { ...DEFAULT_OBSERVABILITY_CONFIG, ...input } as ObservabilityConfig;
  if (merged.detail_soft_limit_mb >= merged.detail_hard_limit_mb) throw new Error(`${path}: observability.detail_soft_limit_mb must be less than detail_hard_limit_mb`);
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
