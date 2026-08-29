import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { BuilderAdapter, BuilderEvent, CompactResult, ContextUsage, ProviderSessionUsage, ProviderSettingSwitch, TurnResult } from "../adapters/types.js";
import type { ProviderSessionRefV1, SessionAvailabilityV1 } from "rafi-spec";

export interface CurrentWorkflowIdentity {
  worktree: string;
  ref: string;
}

export class CurrentWorkflowChangedError extends Error {
  constructor(readonly expected: CurrentWorkflowIdentity, readonly actual: CurrentWorkflowIdentity) {
    super(`current-branch workflow paused: active worktree/ref changed (expected ${expected.worktree} @ ${expected.ref}; found ${actual.worktree} @ ${actual.ref})`);
  }
}

export function captureCurrentWorkflowIdentity(cwd: string): CurrentWorkflowIdentity {
  return { worktree: realpathSync(git(cwd, ["rev-parse", "--show-toplevel"])), ref: currentRef(cwd) };
}

export function assertCurrentWorkflowIdentity(cwd: string, expected: CurrentWorkflowIdentity): void {
  const actual = captureCurrentWorkflowIdentity(cwd);
  if (actual.worktree !== expected.worktree || actual.ref !== expected.ref) {
    throw new CurrentWorkflowChangedError(expected, actual);
  }
}

export function currentWorkflowIdentityKey(identity: CurrentWorkflowIdentity): string {
  return `current_${createHash("sha256").update(`${identity.worktree}\0${identity.ref}`).digest("hex")}`;
}

export function captureCurrentWorkflowSessionIdentity(cwd: string): string {
  return currentWorkflowIdentityKey(captureCurrentWorkflowIdentity(cwd));
}

/** Fence every provider boundary against an unexpected user/provider ref switch. */
export class CurrentWorkflowGuardAdapter implements BuilderAdapter {
  readonly agent: BuilderAdapter["agent"];
  constructor(private readonly adapter: BuilderAdapter, private readonly cwd: string, private readonly expected = captureCurrentWorkflowIdentity(cwd)) { this.agent = adapter.agent; }
  async sendTurn(text: string): Promise<TurnResult> {
    assertCurrentWorkflowIdentity(this.cwd, this.expected);
    const result = await this.adapter.sendTurn(text);
    assertCurrentWorkflowIdentity(this.cwd, this.expected);
    return result;
  }
  sessionId(): string | undefined { return this.adapter.sessionId(); }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.adapter.sessionRef?.(); }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.adapter.adoptSessionRef?.(ref); }
  validateSession(): Promise<SessionAvailabilityV1> { assertCurrentWorkflowIdentity(this.cwd, this.expected); return this.adapter.validateSession?.() ?? Promise.resolve({ version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "legacy-unscoped" }); }
  async compact(): Promise<CompactResult> { assertCurrentWorkflowIdentity(this.cwd, this.expected); const result = await (this.adapter.compact?.() ?? Promise.resolve({ ok: false, error: "native compaction unavailable" })); assertCurrentWorkflowIdentity(this.cwd, this.expected); return result; }
  contextUsage(): Promise<ContextUsage | undefined> { return this.adapter.contextUsage?.() ?? Promise.resolve(undefined); }
  sessionUsage(): Promise<ProviderSessionUsage | undefined> { return this.adapter.sessionUsage?.() ?? Promise.resolve(undefined); }
  switchSettings(settings: ProviderSettingSwitch): Promise<CompactResult> { return this.adapter.switchSettings?.(settings) ?? Promise.resolve({ ok: false, error: "settings switch unavailable" }); }
  events(): AsyncIterable<BuilderEvent> { return this.adapter.events(); }
  close(): Promise<void> { return this.adapter.close(); }
}

function currentRef(cwd: string): string {
  try { return `branch:${git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])}`; }
  catch { return `detached:${git(cwd, ["rev-parse", "HEAD"])}`; }
}
function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
