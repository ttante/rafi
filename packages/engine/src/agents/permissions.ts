// The agent permission policy (ARCH 7.6, 7.11, 11.3; S-MAL-4, PRM-G8): one function answers every runtime's tool
// request, for builder and QA alike. Agents never write rafi's state or run rafi commands; edits stay inside the
// worktree and out of rafi's files; QA writes nothing; a repair turn runs no tools; a need nobody granted is
// refused with a message telling the agent to report blocked(permission); so is a runtime's escalation out of its
// sandbox, which no grant covers (ARCH 7.11, C85).
import path from "node:path";
import type { Decision, PermissionRequest } from "./types.js";

export interface PolicyContext {
  readonly root: string;
  readonly writable: boolean;
  readonly repair: boolean;
  readonly grants: readonly string[];
}

export type PolicyAnswer = { decision: Decision; reason: string };

const FILE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "file-change"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "shell"]);
const NETWORK_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);
const RAFI_FILES = /^(\.rafi|\.tickets|\.git)(\/|$)|^rafi-config\.yaml$/;
const deny = (reason: string): PolicyAnswer => ({ decision: "deny", reason });
const allow = (reason: string): PolicyAnswer => ({ decision: "allow", reason });

function fileAnswer(file: string | null, ctx: PolicyContext): PolicyAnswer {
  if (!ctx.writable) return deny("QA's session is read-only; it doesn't change files.");
  if (!file) return deny("The edit names no file.");
  const target = path.resolve(ctx.root, file);
  const rel = path.relative(ctx.root, target).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return deny(`${target} is outside the ticket's worktree; edit only files inside the project.`);
  }
  if (RAFI_FILES.test(rel)) return deny(`${rel} is rafi's own file; agents don't change rafi's records.`);
  return allow("inside the worktree");
}

/** `rafi`, a path to it (`/usr/local/bin/rafi`, `C:\\tools\\rafi.cmd`) or a script in its package. */
const RAFI_PROGRAM = /(^|[/\\])rafi(\.(m?js|cmd|exe|ps1))?$|(^|[/\\])(rafi|@rafi-ai[/\\]cli)[/\\].*\.m?js$/i;
/** Words that run the next word as the program (`npx rafi`, `env rafi`, `bash -c 'rafi …'`, `node …/cli.js`). */
const LAUNCHERS: ReadonlySet<string> = new Set(["env", "npx", "pnpm", "yarn", "npm", "bunx", "bun", "exec", "dlx",
  "x", "command", "sudo", "nohup", "time", "node", "bash", "sh", "zsh"]);

/**
 * True when some simple command in `command` runs rafi (threat-model 10.7, threat 24): quotes are dropped, the
 * text is split at separators, substitutions and subshells, and in each part assignments, launchers and flags are
 * skipped to find the program. Obfuscation (a variable, an escape inside the name) isn't caught here; the
 * runtime's sandbox keeps rafi's folders read-only on Claude (threat 28).
 */
function runsRafi(command: string): boolean {
  return command.replace(/["']/g, "").split(/[;&|()`<>\n]|\$\(/).some((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const program = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !w.startsWith("-") &&
      !LAUNCHERS.has(w));
    return program !== undefined && RAFI_PROGRAM.test(program);
  });
}

function shellAnswer(command: string, ctx: PolicyContext): PolicyAnswer {
  if (runsRafi(command)) {
    return deny("Agents never run rafi commands; they would change rafi's records. Reply needs-input instead.");
  }
  if (/(^|[\s;&|(])(curl|wget)\s/.test(command) && !ctx.grants.includes("internet")) {
    return deny("Internet access wasn't granted for this build; report blocked(permission: internet).");
  }
  return allow("a shell command inside the session's sandbox");
}

export const ESCALATION = "This asks to run outside Codex's sandbox, which no grant covers; don't retry it. " +
  "If the ticket needs it, report blocked(permission) and say what it needs.";

/** An escalation is always denied, with the ordinary answer's reason when that is a denial too. */
export function decidePermission(request: PermissionRequest, ctx: PolicyContext): PolicyAnswer {
  if (!request.escalation) return ordinary(request, ctx);
  const own = ordinary(request, ctx);
  return own.decision === "deny" ? own : deny(ESCALATION);
}

function ordinary(request: PermissionRequest, ctx: PolicyContext): PolicyAnswer {
  if (ctx.repair) return deny("No tools during a repair: send the same reply again as JSON.");
  if (FILE_TOOLS.has(request.tool)) return fileAnswer(request.path, ctx);
  if (SHELL_TOOLS.has(request.tool)) return shellAnswer(request.command ?? "", ctx);
  if (NETWORK_TOOLS.has(request.tool) && !ctx.grants.includes("internet")) {
    return deny("Internet access wasn't granted for this build; report blocked(permission: internet).");
  }
  return allow(`${request.tool} is allowed`);
}
