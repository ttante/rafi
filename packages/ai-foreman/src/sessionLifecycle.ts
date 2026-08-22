import type { ConfigurableAgentRole, ResolvedAgentSettings, WorkflowIssue } from "rafi-spec";
import type { BuilderAdapter, ContextUsage } from "./adapters/types.js";
import { sanitizeDiagnostics } from "./runtimeReadiness.js";

export interface SessionTransition {
  kind: "initial" | "compacted" | "fresh" | "missing" | "compaction-retry" | "compaction-fallback" | "settings-attempt" | "settings-continued" | "settings-fallback";
  role: ConfigurableAgentRole;
  workSession: number;
  sessionId?: string;
  message: string;
}

export interface SessionBoundary {
  adapter: BuilderAdapter;
  transition: SessionTransition;
  issue?: WorkflowIssue;
}

export interface RoleSessionControllerOptions {
  role: ConfigurableAgentRole;
  settings: ResolvedAgentSettings;
  create: (settings: ResolvedAgentSettings, resumeSessionId?: string) => Promise<BuilderAdapter>;
  report?: (transition: SessionTransition) => void;
  now?: () => Date;
  initialSessionId?: string;
}

/** One lifecycle implementation shared by interviews, builds, QA, and recovery. */
export class RoleSessionController {
  private adapter?: BuilderAdapter;
  private workSessions = 0;

  constructor(private readonly options: RoleSessionControllerOptions) {}

  async next(_durableHandoff: string, nextSettings?: ResolvedAgentSettings): Promise<SessionBoundary> {
    this.workSessions += 1;
    if (!this.adapter) {
      if (nextSettings) this.options.settings = nextSettings;
      this.adapter = await this.options.create(this.options.settings, this.options.initialSessionId);
      return this.boundary("initial", "started a workflow-scoped provider conversation");
    }
    if (nextSettings) {
      const current = this.options.settings;
      if (nextSettings.make !== current.make) {
        await this.adapter.close(); this.options.settings = nextSettings; this.adapter = await this.options.create(nextSettings);
        return this.boundary("settings-fallback", `provider changed from ${current.make} to ${nextSettings.make}; started fresh from the durable handoff`);
      }
      const changed = nextSettings.model !== current.model || nextSettings.reasoning !== current.reasoning || nextSettings.fast !== current.fast;
      this.options.settings = nextSettings;
      if (changed) {
        this.emit("settings-attempt", `attempting same-conversation settings switch to ${nextSettings.model}, reasoning=${nextSettings.reasoning}, fast=${nextSettings.fast}`);
        const switched = this.adapter.switchSettings
          ? await this.adapter.switchSettings({ model: nextSettings.model === "default" ? undefined : nextSettings.model, effort: effort(nextSettings.reasoning), fast: nextSettings.fast })
          : { ok: false, error: "provider adapter does not support an in-conversation settings switch" };
        if (!switched.ok) {
          await this.adapter.close(); this.adapter = await this.options.create(nextSettings);
          const detail = sanitize(switched.error ?? "settings switch failed");
          const issue = this.issue("session_model_switch_failure", detail, "This work session continued fresh with the current project settings.");
          return this.boundary("settings-fallback", `settings switch failed (${detail}); started fresh and continuity was lost`, issue);
        }
        this.emit("settings-continued", "provider accepted the same-conversation settings switch");
      }
    }
    if (this.options.settings.session_strategy === "fresh") {
      await this.adapter.close();
      this.adapter = await this.options.create(this.options.settings);
      const result = this.boundary("fresh", "started a fresh conversation with a durable handoff");
      return result;
    }
    if (!this.adapter.sessionId()) {
      await this.adapter.close();
      this.adapter = await this.options.create(this.options.settings);
      const issue = this.issue("session_missing", "exact provider session is unavailable", "Continue fresh from the durable handoff.");
      const result = this.boundary("missing", "continuity unavailable; started fresh from the durable handoff", issue);
      return result;
    }
    let firstError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const compacted = this.adapter.compact
          ? await this.adapter.compact()
          : { ok: false, error: "provider adapter does not expose native compaction" };
        if (compacted.ok) return this.boundary("compacted", attempt === 1 ? "compacted and continued the exact conversation" : "compaction retry succeeded; continued the exact conversation");
        firstError = sanitize(compacted.error ?? "provider reported compaction failure");
      } catch (error) {
        firstError = sanitize(error);
      }
      if (attempt === 1) this.emit("compaction-retry", `compaction failed (${firstError}); retrying once`);
    }
    await this.adapter.close();
    this.adapter = await this.options.create(this.options.settings);
    const issue = this.issue("session_compaction_failure", firstError, "Inspect provider health; this work session continued fresh.");
    const result = this.boundary("compaction-fallback", `compaction failed twice (${firstError}); started fresh and continuity was lost`, issue);
    return result;
  }

  current(): BuilderAdapter | undefined { return this.adapter; }
  count(): number { return this.workSessions; }
  async usage(): Promise<ContextUsage | undefined> { return this.adapter?.contextUsage?.(); }
  async close(): Promise<void> { await this.adapter?.close(); this.adapter = undefined; }

  private boundary(kind: SessionTransition["kind"], message: string, issue?: WorkflowIssue): SessionBoundary {
    const transition = this.emit(kind, message);
    return { adapter: this.adapter!, transition, issue };
  }

  private emit(kind: SessionTransition["kind"], message: string): SessionTransition {
    const transition = { kind, role: this.options.role, workSession: this.workSessions, sessionId: this.adapter?.sessionId(), message };
    this.options.report?.(transition);
    return transition;
  }

  private issue(code: "session_missing" | "session_compaction_failure" | "session_model_switch_failure", detail: string, action: string): WorkflowIssue {
    return {
      code, role: this.options.role, phase: "session-boundary", provider: this.options.settings.make,
      model: this.options.settings.model, detail, human_required: false, recoverable: true,
      suggested_action: action, occurred_at: (this.options.now?.() ?? new Date()).toISOString(),
    };
  }
}

function effort(value: string): "low" | "medium" | "high" | "xhigh" | undefined {
  return ["low", "medium", "high", "xhigh"].includes(value) ? value as "low" | "medium" | "high" | "xhigh" : undefined;
}

function sanitize(error: unknown): string {
  return sanitizeDiagnostics(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
