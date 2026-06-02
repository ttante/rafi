import { resolve, isAbsolute } from "node:path";
import type { PermissionConfig } from "../config.js";
import type { PermissionRequest } from "../adapters/types.js";

export interface Classification {
  decision: "allow" | "escalate";
  reason: string;
}

/** Tools that write to disk — allowed only inside the worktree. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Shell operators we split on to vet each segment of a chained command. */
const SHELL_SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;

/** Shell features that make a prefix allow-list too easy to bypass. */
const ESCALATE_SHELL_SYNTAX = [
  { pattern: /\s\d?>|\s>>|\s</, reason: "shell redirection is not auto-approved" },
  { pattern: /\$\(|`/, reason: "shell substitution is not auto-approved" },
];

/**
 * Rules-based permission classifier. No LLM: routine requests are auto-approved,
 * anything risky or unrecognized escalates to the human (fail safe).
 */
export class PermissionPolicy {
  constructor(
    private readonly config: PermissionConfig,
    private readonly cwd: string,
  ) {}

  classify(req: PermissionRequest): Classification {
    const { toolName, input } = req;

    if (this.config.escalateTools.includes(toolName)) {
      return { decision: "escalate", reason: `tool ${toolName} always escalates` };
    }

    if (toolName === "Bash") {
      return this.classifyBash(String(input.command ?? ""));
    }

    if (FILE_TOOLS.has(toolName)) {
      const target = this.filePath(input);
      if (target && !this.insideCwd(target)) {
        return {
          decision: "escalate",
          reason: `writes outside the worktree: ${target}`,
        };
      }
      if (this.config.allowTools.includes(toolName)) {
        return { decision: "allow", reason: `${toolName} inside the worktree` };
      }
    }

    if (this.config.allowTools.includes(toolName)) {
      return { decision: "allow", reason: `${toolName} is allow-listed` };
    }

    return { decision: "escalate", reason: `tool ${toolName} not recognized` };
  }

  private classifyBash(command: string): Classification {
    // Always-escalate list is checked first against the full command string —
    // a dangerous pattern anywhere in a chained command escalates the whole call.
    const hitEscalate = this.config.escalateBash.find((p) => command.includes(p));
    if (hitEscalate) {
      return { decision: "escalate", reason: `command matches "${hitEscalate}"` };
    }

    const syntax = ESCALATE_SHELL_SYNTAX.find((s) => s.pattern.test(command));
    if (syntax) {
      return { decision: "escalate", reason: syntax.reason };
    }

    const segments = command.split(SHELL_SPLIT).map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) {
      return { decision: "escalate", reason: "empty bash command" };
    }

    for (const segment of segments) {
      const allow = this.config.allowBash.find((p) => this.matchesAllowedPrefix(segment, p));
      if (!allow) {
        return { decision: "escalate", reason: `command segment is not allow-listed: ${segment}` };
      }
    }

    return { decision: "allow", reason: "all command segments are allow-listed" };
  }

  private matchesAllowedPrefix(command: string, prefix: string): boolean {
    if (prefix.endsWith(" ")) return command.startsWith(prefix);
    return command === prefix || command.startsWith(prefix + " ");
  }

  private filePath(input: Record<string, unknown>): string | undefined {
    const p = input.file_path ?? input.path ?? input.notebook_path;
    return typeof p === "string" ? p : undefined;
  }

  private insideCwd(target: string): boolean {
    const abs = isAbsolute(target) ? target : resolve(this.cwd, target);
    const root = resolve(this.cwd);
    return abs === root || abs.startsWith(root + "/");
  }
}
