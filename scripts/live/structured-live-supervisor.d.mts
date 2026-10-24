import type { ChildProcess } from "node:child_process";
import type { ProviderQueryBudget } from "../../packages/ai-foreman/src/adapters/types.js";
export class StructuredLiveRunSupervisor implements ProviderQueryBudget {
  constructor(name: string, env?: NodeJS.ProcessEnv);
  readonly config: { providers: Array<"claude" | "codex">; deadline: number; requireAuthoritativeCost: boolean; liveValidation: { credentialScope: string; retainedLogDirectory: string } };
  readonly evidenceRoot: string;
  readonly budgetPath: string;
  readonly reportPath: string;
  readonly signal: AbortSignal;
  check(): void;
  reserveQuery(provider: "claude" | "codex", requestedUsd?: number): ReturnType<ProviderQueryBudget["reserveQuery"]>;
  track(close: () => void | Promise<void>): () => boolean;
  abort(error?: Error): void;
  save(status: string, error?: string): void;
  execute<T>(work: (supervisor: StructuredLiveRunSupervisor) => Promise<T>): Promise<T>;
}
export function runSupervisedStructuredLive<T>(name: string, work: (supervisor: StructuredLiveRunSupervisor) => Promise<T>, env?: NodeJS.ProcessEnv): Promise<T>;
export function trackStructuredLiveChild<T extends ChildProcess>(child: T): T;
