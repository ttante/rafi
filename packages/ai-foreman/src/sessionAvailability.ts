import type { ProviderSessionRefV1, SessionAvailabilityV1 } from "rafi-spec";
import { ClaudeAdapter, probeClaudeSession } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import type { BuilderAdapterOptions } from "./adapters/types.js";
import { SessionUnavailableError } from "./adapters/sessionFailure.js";

export interface ResolveSessionAvailabilityOptions {
  cwd?: string;
  configRoot?: string;
  workspaceIdentity?: string;
  runtimeExecutable?: string;
  now?: Date;
}

/** Provider-backed exact-session probe. Codex attaches with thread/resume and never starts a turn. */
export async function resolveProviderSessionAvailability(
  ref: ProviderSessionRefV1,
  options: ResolveSessionAvailabilityOptions = {},
): Promise<SessionAvailabilityV1> {
  const cwd = options.cwd ?? ref.cwd;
  const configRoot = options.configRoot ?? ref.configRoot;
  if (ref.provider === "claude") {
    return probeClaudeSession(ref, { cwd, configRoot, workspaceIdentity: options.workspaceIdentity, now: options.now });
  }
  if (ref.source === "legacy-inferred") {
    return { version: 1, status: "unknown", checkedAt: (options.now ?? new Date()).toISOString(), reason: "legacy-unscoped", detail: "legacy Codex thread IDs cannot be proven exact without an observed scoped binding", sessionRef: ref };
  }
  const adapterOptions: BuilderAdapterOptions = {
    cwd,
    configRoot,
    runtimeExecutable: options.runtimeExecutable,
    runtimePhase: "recovery",
    resumeSessionRef: ref,
    sessionRole: ref.role,
    sessionStream: ref.stream,
    sessionGeneration: ref.generation,
    workspaceIdentity: options.workspaceIdentity,
    ticketId: ref.ticketId,
    deliveryUnitId: ref.deliveryUnitId,
    sandboxMode: "read-only",
    permission: async () => ({ behavior: "deny", message: "session availability probes never run tools" }),
  };
  const adapter = new CodexAdapter(adapterOptions);
  try { return await adapter.validateSession(); }
  catch (error) {
    return { version: 1, status: "unknown", checkedAt: (options.now ?? new Date()).toISOString(), reason: "probe-failed", detail: error instanceof Error ? error.message : String(error), sessionRef: ref };
  } finally { await adapter.close().catch(() => {}); }
}

/** Create a validated exact adapter for callers that need one after a successful probe. */
export async function createValidatedProviderAdapter(
  ref: ProviderSessionRefV1,
  options: Omit<BuilderAdapterOptions, "resumeSessionId" | "resumeSessionRef">,
): Promise<ClaudeAdapter | CodexAdapter> {
  const scoped = { ...options, resumeSessionRef: ref, sessionRole: ref.role, sessionStream: ref.stream, sessionGeneration: ref.generation };
  if (ref.provider === "claude") return ClaudeAdapter.create(scoped);
  const adapter = new CodexAdapter(scoped);
  const availability = await adapter.validateSession();
  if (availability.status !== "available") {
    await adapter.close().catch(() => {});
    throw new SessionUnavailableError({
      runtime: "codex", phase: "preflight", dispatchState: "not-sent",
      executable: options.runtimeExecutable ?? "codex", cwd: options.cwd,
      diagnostics: availability.detail ?? `Codex session ${ref.sessionId} is ${availability.status}`,
      availability,
    });
  }
  return adapter;
}
