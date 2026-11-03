// Capabilities per runtime and model (ARCH 11.6, C52). The provider's model list where it reports a feature
// (effort, fast); otherwise this table. A model the provider doesn't list is flagged before the build and gets
// conservative capabilities: no structured replies, so the text-JSON fallback is used.
import type { Capabilities } from "./types.js";

/**
 * Loopback without internet, checked in M2 (plan 1.3): Codex's seatbelt sandbox allows the network all or nothing
 * (`codex sandbox`, 0.164.0). Claude's allows it: `allowLocalBinding` with no allowed domains let a test listen on
 * and connect to 127.0.0.1 while a public connect got EPERM (live check 10.8, Claude Code 2.1.317, macOS).
 */
const TABLE: Readonly<Record<"codex" | "claude", Capabilities>> = Object.freeze({
  codex: Object.freeze({ structuredReplies: true, exitCodes: true, resume: true, images: true,
    enforceableGrants: true, compaction: true, localServersWithoutInternet: false }),
  claude: Object.freeze({ structuredReplies: true, exitCodes: false, resume: true, images: true,
    enforceableGrants: true, compaction: true, localServersWithoutInternet: true }),
});

export function codexCapabilities(structured = true): Capabilities {
  return { ...TABLE.codex, structuredReplies: structured };
}

export function claudeCapabilities(structured = true): Capabilities {
  return { ...TABLE.claude, structuredReplies: structured };
}

export interface ModelCheck {
  readonly listed: boolean;
  readonly capabilities: Capabilities;
  /** One line for the flag before the build, when the model can't meet what the role needs. */
  readonly flag: string | null;
}

/** C52: a configured model the provider doesn't list is flagged and falls back to text replies. */
export function checkModel(runtime: "codex" | "claude", model: string | null, listed: readonly string[] | null,
  role: string): ModelCheck {
  const base = runtime === "codex" ? codexCapabilities() : claudeCapabilities();
  if (!model || listed === null || listed.includes(model)) return { listed: true, capabilities: base, flag: null };
  return { listed: false, capabilities: { ...base, structuredReplies: false },
    flag: `The ${role} model ${model} isn't in ${runtime === "codex" ? "Codex" : "Claude"}'s model list, so rafi ` +
      "can't confirm it supports structured replies; it will ask for JSON in plain text instead." };
}
