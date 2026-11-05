// `tools:` entries in sessions (ARCH 10.3; M5 plan C222). The entries are validated when the config loads
// (`rafi-spec/v1` config keys: kind, start, roles, tags, permissions, versions); here a ticket's agent gets a tool
// when its role is among the tool's roles and one of the ticket's tags is among the tool's tags. An MCP tool goes
// into the session's MCP servers (Claude's `mcpServers`, Codex's thread `mcp_servers`); every tool gets a line in
// the standing instructions. Tools come only from `rafi-config.yaml`, which agents can't write (P48); a ticket
// field naming a tool is ignored. A tool's `permissions` grant nothing in M5 (grants are M7).

export interface ToolEntry {
  readonly kind: "mcp" | "command";
  readonly start: { readonly command: string; readonly args?: readonly string[] };
  readonly description: string;
  readonly roles?: readonly string[];
  readonly tags?: readonly string[];
  readonly setup_notes?: string;
}

export interface TicketTool {
  readonly name: string;
  /** "playwright, for drive a browser to check web UI. Setup notes: docs/tools/playwright.md" (NEW-TOOL-7). */
  readonly line: string;
  readonly mcp: { command: string; args: string[] } | null;
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The tools a role's agent gets for a ticket with these tags, in name order. */
export function toolsFor(tools: unknown, role: string, tags: ReadonlySet<string>): TicketTool[] {
  const entries = Object.entries((tools ?? {}) as Record<string, ToolEntry>).sort(([a], [b]) => a.localeCompare(b));
  return entries.filter(([, t]) => (t.roles ?? []).includes(role) && (t.tags ?? []).some((tag) => tags.has(tag)))
    .map(([name, t]) => ({ name,
      line: `${name}, for ${lower(t.description)}${t.setup_notes ? `. Setup notes: ${t.setup_notes}` : ""}`,
      mcp: t.kind === "mcp" ? { command: t.start.command, args: [...(t.start.args ?? [])] } : null }));
}
