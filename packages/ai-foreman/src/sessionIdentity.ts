import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ConfigurableAgentRole,
  ProviderSessionRefV1,
  SessionAvailabilityV1,
} from "rafi-spec";

export interface ProviderSessionScope {
  provider: "claude" | "codex";
  cwd: string;
  configRoot: string;
  role?: ConfigurableAgentRole;
  stream?: string;
  workspaceIdentity?: string;
  ticketId?: string;
  deliveryUnitId?: string;
}

export interface CreateProviderSessionRefInput extends ProviderSessionScope {
  sessionId: string;
  generation?: number;
  source?: ProviderSessionRefV1["source"];
  createdAt?: string;
  validatedAt?: string;
}

/** Resolve symlinks for an existing location and otherwise return an absolute normalized path. */
export function canonicalSessionPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

/**
 * Stable for one Git worktree lifetime. The token lives in that worktree's
 * administrative Git directory (not in the checked-out tree), so normal edits
 * and commits do not change it while removal/recreation cannot inherit it.
 */
export function captureWorkspaceIdentity(cwd: string): string | undefined {
  try {
    const canonicalCwd = canonicalSessionPath(cwd);
    const gitDir = canonicalSessionPath(execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: canonicalCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim());
    const marker = join(gitDir, "rafi-workspace-id-v1");
    let token: string;
    try {
      token = readFileSync(marker, "utf8").trim();
      if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("invalid Rafi worktree identity marker");
    } catch {
      const candidate = randomUUID();
      try { writeFileSync(marker, `${candidate}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch { /* another host process may have initialized the same worktree */ }
      token = readFileSync(marker, "utf8").trim();
      if (!/^[0-9a-f-]{36}$/i.test(token)) return undefined;
    }
    return createHash("sha256").update(`${canonicalCwd}\0${gitDir}\0${token}`).digest("hex");
  } catch { return undefined; }
}

export function createProviderSessionRef(input: CreateProviderSessionRefInput): ProviderSessionRefV1 {
  if (!input.sessionId.trim()) throw new Error("provider session ID must not be empty");
  const generation = input.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("provider session generation must be a non-negative safe integer");
  const cwd = canonicalSessionPath(input.cwd);
  const workspaceIdentity = input.workspaceIdentity ?? captureWorkspaceIdentity(cwd);
  return {
    version: 1,
    provider: input.provider,
    sessionId: input.sessionId,
    role: input.role ?? (input.stream === "qa" ? "qa" : "builder"),
    stream: input.stream ?? input.role ?? "builder",
    generation,
    cwd,
    configRoot: canonicalSessionPath(input.configRoot),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    ...(input.deliveryUnitId ? { deliveryUnitId: input.deliveryUnitId } : {}),
    source: input.source ?? "observed",
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.validatedAt ? { validatedAt: input.validatedAt } : {}),
  };
}

/** Identity used by accounting, compaction, settings acknowledgements, and mutation leases. */
export function providerSessionKey(ref: ProviderSessionRefV1): string {
  const cwd = canonicalSessionPath(ref.cwd);
  const payload = [ref.provider, ref.sessionId, ref.role, cwd, ref.workspaceIdentity ?? "unscoped"].join("\0");
  return `psv1_${createHash("sha256").update(payload).digest("hex")}`;
}

export function validateProviderSessionScope(
  ref: ProviderSessionRefV1,
  requested: ProviderSessionScope,
  now = new Date(),
): SessionAvailabilityV1 {
  const checkedAt = now.toISOString();
  const unavailable = (reason: NonNullable<SessionAvailabilityV1["reason"]>, detail: string, observedCwd?: string): SessionAvailabilityV1 => ({
    version: 1, status: reason === "legacy-unscoped" ? "unknown" : "unavailable", checkedAt, reason, detail,
    ...(observedCwd ? { observedCwd } : {}), sessionRef: ref,
  });
  if (ref.provider !== requested.provider) return unavailable("provider-mismatch", `stored provider ${ref.provider} does not match requested provider ${requested.provider}`);
  if (requested.role && ref.role !== requested.role) return unavailable("role-mismatch", `stored role ${ref.role} does not match requested role ${requested.role}`);
  if (requested.stream && ref.stream !== requested.stream) return unavailable("stream-mismatch", `stored stream ${ref.stream} does not match requested stream ${requested.stream}`);
  if (!existsSync(ref.cwd) || !existsSync(requested.cwd)) return unavailable("not-found", "the recorded provider working directory no longer exists");
  const storedCwd = canonicalSessionPath(ref.cwd);
  const requestedCwd = canonicalSessionPath(requested.cwd);
  if (storedCwd !== requestedCwd) return unavailable("cwd-mismatch", `stored cwd ${storedCwd} does not match requested cwd ${requestedCwd}`, requestedCwd);
  const storedRoot = canonicalSessionPath(ref.configRoot);
  const requestedRoot = canonicalSessionPath(requested.configRoot);
  if (storedRoot !== requestedRoot) return unavailable("config-root-mismatch", `stored Rafi config root ${storedRoot} does not match requested root ${requestedRoot}`, requestedCwd);
  const actualIdentity = requested.workspaceIdentity ?? captureWorkspaceIdentity(requestedCwd);
  if (ref.workspaceIdentity && actualIdentity !== ref.workspaceIdentity) {
    return unavailable("workspace-mismatch", "the directory at the recorded path is not the original worktree", requestedCwd);
  }
  if (!ref.workspaceIdentity || !actualIdentity) {
    return unavailable("legacy-unscoped", "the stored session has no verifiable worktree identity", requestedCwd);
  }
  if (ref.ticketId && requested.ticketId && ref.ticketId !== requested.ticketId) return unavailable("workspace-mismatch", `stored ticket ${ref.ticketId} does not match requested ticket ${requested.ticketId}`, requestedCwd);
  if (ref.deliveryUnitId && requested.deliveryUnitId && ref.deliveryUnitId !== requested.deliveryUnitId) return unavailable("workspace-mismatch", `stored delivery unit ${ref.deliveryUnitId} does not match requested unit ${requested.deliveryUnitId}`, requestedCwd);
  const validated = { ...ref, cwd: storedCwd, configRoot: storedRoot, workspaceIdentity: actualIdentity, validatedAt: checkedAt };
  return { version: 1, status: "available", checkedAt, observedCwd: requestedCwd, sessionRef: validated };
}

export function latestSessionBinding(
  bindings: readonly ProviderSessionRefV1[] | undefined,
  role: ConfigurableAgentRole,
  sessionId?: string,
): ProviderSessionRefV1 | undefined {
  return [...(bindings ?? [])]
    .filter((ref) => ref.role === role && (!sessionId || ref.sessionId === sessionId))
    .sort((a, b) => a.generation - b.generation || a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

export function resolveUniqueSessionBinding(
  bindings: readonly ProviderSessionRefV1[] | undefined,
  sessionId: string,
): ProviderSessionRefV1 | undefined {
  const byKey = new Map((bindings ?? []).filter((ref) => ref.sessionId === sessionId).map((ref) => [providerSessionKey(ref), ref]));
  if (byKey.size > 1) throw new Error(`provider session ID ${sessionId} is ambiguous across recorded locations`);
  return [...byKey.values()][0];
}

export function upsertSessionBinding(
  bindings: readonly ProviderSessionRefV1[] | undefined,
  ref: ProviderSessionRefV1,
): ProviderSessionRefV1[] {
  const key = providerSessionKey(ref);
  return [...(bindings ?? []).filter((candidate) => providerSessionKey(candidate) !== key), ref]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.generation - b.generation);
}
