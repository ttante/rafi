import { resolve, isAbsolute, relative, sep } from "node:path";
import type { PermissionConfig } from "../config.js";
import type { PermissionRequest } from "../adapters/types.js";
import { classifySupportedShellForm, isWithinProject, canonicalToolPath } from "./shellForms.js";

export interface Classification {
  decision: "allow" | "escalate";
  reason: string;
}

/** Tools that write to disk — allowed only inside the worktree. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Shell operators we split on to vet each segment of a chained command. */
const SHELL_SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;

/** Shell features that make a prefix allow-list too easy to bypass. */
const SHELL_REDIRECTION = {
  standard: /\s\d?>|\s>>|\s</,
  strict: /(?:^|[^\\])(?:\d+)?(?:>>?|<<?)/,
  reason: "shell redirection is not auto-approved",
};
const SHELL_SUBSTITUTION = { pattern: /\$\(|`/, reason: "shell substitution is not auto-approved" };

/**
 * Rules-based permission classifier. No LLM: routine requests are auto-approved,
 * anything risky or unrecognized escalates to the human (fail safe).
 */
export class PermissionPolicy {
  constructor(
    private readonly config: PermissionConfig,
    private readonly cwd: string,
    private readonly options: { currentBranchWorkflow?: boolean } = {},
  ) {}

  classify(req: PermissionRequest): Classification {
    const { toolName, input } = req;

    if (this.config.escalateTools.includes(toolName)) {
      return { decision: "escalate", reason: `tool ${toolName} always escalates` };
    }

    if (toolName === "Bash") {
      return this.classifyBash(String(input.command ?? ""), req.executionCwd ?? this.cwd);
    }

    if (FILE_TOOLS.has(toolName)) {
      const rawTarget = this.filePath(input);
      const target = rawTarget ? resolve(req.executionCwd ?? this.cwd, rawTarget) : undefined;
      if (req.executionCwd && !isWithinProject(this.cwd, req.executionCwd)) return { decision: "escalate", reason: "tool cwd is outside the worktree" };
      if (this.options.currentBranchWorkflow && target && this.isGitMetadata(target)) {
        return { decision: "escalate", reason: "current-branch workflow forbids direct writes to Git metadata" };
      }
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

  private classifyBash(command: string, executionCwd: string): Classification {
    if (this.options.currentBranchWorkflow && isCurrentWorkflowGitMutation(command)) {
      return { decision: "escalate", reason: "current-branch workflow leaves all Git lifecycle and review operations to the user" };
    }
    // Always-escalate list is checked first against the full command string —
    // a dangerous pattern anywhere in a chained command escalates the whole call.
    const hitEscalate = this.config.escalateBash.find((p) => command.includes(p));
    if (hitEscalate) {
      return { decision: "escalate", reason: `command matches "${hitEscalate}"` };
    }
    const restrictedNodeTests = this.config.allowBash.includes("node --test") && !this.config.allowBash.includes("node ") && !this.config.allowBash.includes("node");
    if (restrictedNodeTests && /(?:^|\s|[&|;])node\s/.test(command)
      || /^\s*(?:cd(?:\s|$)|[A-Za-z_]\w*=|uv\s+run\b)|(?:&&|\|)\s*(?:cd(?:\s|$)|[A-Za-z_]\w*=|uv\s+run\b)|2>&1|[/\\](?:python3?|pytest)(?:["']|\s|$)/.test(command)) {
      const reason = classifySupportedShellForm(command, this.cwd, executionCwd, this.config.allowBash);
      return reason ? { decision: "escalate", reason } : { decision: "allow", reason: "validated project-local command segments" };
    }

    const syntax = [
      {
        pattern: this.config.strictShellRedirection ? SHELL_REDIRECTION.strict : SHELL_REDIRECTION.standard,
        reason: SHELL_REDIRECTION.reason,
      },
      SHELL_SUBSTITUTION,
    ].find((s) => s.pattern.test(command));
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
    return isWithinProject(this.cwd, isAbsolute(target) ? target : resolve(this.cwd, target));
  }

  private isGitMetadata(target: string): boolean {
    const abs = canonicalToolPath(isAbsolute(target) ? target : resolve(this.cwd, target));
    const path = relative(canonicalToolPath(this.cwd), abs).split(sep).join("/");
    return path === ".git" || path.startsWith(".git/");
  }
}

function isCurrentWorkflowGitMutation(command: string): boolean {
  const segments = command.split(SHELL_SPLIT).map((part) => part.trim()).filter(Boolean);
  for (const segment of segments) {
    if (/^(?:gh|glab)(?:\s|$)/.test(segment)) return true;
    const invocation = /(?:^|\s)git\s+([\s\S]+)$/i.exec(segment);
    if (!invocation) continue;
    let remainder = invocation[1]!.trim();
    const globalOption = /^(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)\s+(?:"[^"]+"|'[^']+'|\S+)|--(?:git-dir|work-tree|namespace|exec-path)=\S+|--(?:no-pager|paginate|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs|bare))(?:\s+|$)/i;
    while (globalOption.test(remainder)) remainder = remainder.replace(globalOption, "").trimStart();
    const match = /^([a-z][a-z-]*)([\s\S]*)$/i.exec(remainder);
    if (!match) continue;
    const subcommand = match[1]!.toLowerCase();
    const args = match[2]!.trim();
    if (["add", "am", "apply", "checkout", "cherry-pick", "clean", "commit", "fetch", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm", "stash", "switch", "tag", "worktree"].includes(subcommand)) return true;
    if (subcommand === "branch" && args && !/^(?:--show-current|-a|--all|-r|--remotes|-v|-vv|--verbose)(?:\s|$)/.test(args)) return true;
    if (subcommand === "branch") continue;
    if (subcommand === "remote" && /^(?:$|-v|--verbose|get-url(?:\s|$)|show(?:\s|$))/.test(args)) continue;
    if (["annotate", "blame", "cat-file", "describe", "diff", "diff-tree", "for-each-ref", "grep", "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev", "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "symbolic-ref", "version", "whatchanged"].includes(subcommand)) continue;
    // Configured aliases and unfamiliar porcelain can mutate refs or the
    // index; current mode permits only an explicit read-only subset.
    return true;
  }
  return false;
}
