// Query options for the Agent SDK (ARCH 11.5, 7.11). The executable is the readiness-checked `claude`. The builder
// loads user, project and local settings and may write its worktree; QA loads user settings only and is denied the
// worktree; its temp files go to Claude Code's own sandbox temp folder (P20, C87). The network follows the grants.
import path from "node:path";
import type { Env } from "../../deps/types.js";
import type { TurnRequest } from "../types.js";

export interface ClaudeOptions {
  readonly cwd: string;
  /** Absolute path to `claude` (NEW-ADP-4); undefined lets the SDK use its own. */
  readonly executable?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly fast?: boolean;
  readonly resume?: string;
  /** false for QA: read-only, user settings only. */
  readonly writable?: boolean;
  /** rafi's in-process tools for this session, from deps.agents.claudeTools (C38). */
  readonly tools?: unknown;
  /** The ticket's MCP tools (C222), as stdio servers beside rafi's own. */
  readonly external?: Readonly<Record<string, { command: string; args: string[] }>>;
  readonly env?: Env;
  /** false: no outputFormat; the reply format is in the instructions (C52's text fallback). */
  readonly structured?: boolean;
}

/**
 * Claude's sandbox from the grants. Bash isn't auto-allowed (Claude Code's default would skip canUseTool and the
 * PreToolUse hook's policy would be the only gate) and never leaves the sandbox (`dangerouslyDisableSandbox`);
 * the builder can't write git's folder or rafi's records (threat-model 10.7, threat 28).
 */
function sandbox(o: ClaudeOptions, grants: readonly string[]) {
  const network: Record<string, unknown> = grants.includes("internet") ? { allowedDomains: ["*"] }
    : { allowedDomains: [], deniedDomains: ["*"] };
  if (grants.includes("local-servers")) network.allowLocalBinding = true;
  // QA: Claude Code gives sandboxed Bash its own TMPDIR (/tmp/claude-<uid>), which beats one rafi passes, and a
  // folder inside the worktree can't be written under denyWrite (M2 plan 10.8 f), so rafi adds none.
  const filesystem = o.writable === false ? { allowWrite: [], denyWrite: [o.cwd] }
    : { allowWrite: [o.cwd],
      denyWrite: [".git", ".rafi", ".tickets", "rafi-config.yaml"].map((d) => path.join(o.cwd, d)) };
  return { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
    network, filesystem };
}

export function queryOptions(o: ClaudeOptions, first: TurnRequest, extra: Record<string, unknown>) {
  const readOnly = o.writable === false;
  return {
    cwd: o.cwd,
    ...(o.executable ? { pathToClaudeCodeExecutable: o.executable } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    ...(o.fast ? { settings: { fastMode: true } } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    // The SDK reads only `systemPrompt`; it drops an `appendSystemPrompt` option (live check, M2 plan 10.8).
    ...(first.instructions ? { systemPrompt: { type: "preset", preset: "claude_code", append: first.instructions } }
      : {}),
    ...(o.structured === false ? {} : { outputFormat: { type: "json_schema", schema: first.schema.json } }),
    settingSources: readOnly ? ["user"] : ["user", "project", "local"],
    sandbox: sandbox(o, first.grants),
    ...(o.env ? { env: o.env } : {}),
    ...(o.tools || o.external ? { mcpServers: { ...Object.fromEntries(Object.entries(o.external ?? {})
      .map(([name, t]) => [name, { type: "stdio", command: t.command, args: t.args }])),
    ...(o.tools ? { rafi: o.tools } : {}) } } : {}),
    ...extra,
  };
}
