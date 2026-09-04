/**
 * JSON Schemas (draft-07) for the neutral types in {@link ./types}. Kept in lockstep
 * with those interfaces; validated by {@link ./validate}.
 */

const KEBAB = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const qaString = { type: "string", minLength: 1, maxLength: 4096 } as const;

export const qaFailureReportV1Schema = {
  $id: "rafi/qaFailureReportV1",
  type: "object",
  additionalProperties: false,
  required: ["version", "summary", "checks_run", "findings", "observations"],
  properties: {
    version: { const: 1 },
    summary: qaString,
    checks_run: {
      type: "array", minItems: 1, maxItems: 25,
      items: {
        type: "object", additionalProperties: false,
        required: ["check", "outcome", "evidence"],
        properties: {
          check: qaString,
          command: qaString,
          outcome: { enum: ["passed", "failed", "not_run"] },
          evidence: qaString,
        },
      },
    },
    findings: {
      type: "array", minItems: 1, maxItems: 25,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "requirement", "locations", "problem", "evidence", "expected", "fix_direction", "verification"],
        properties: {
          id: qaString,
          requirement: qaString,
          locations: { type: "array", minItems: 1, maxItems: 10, items: qaString },
          problem: qaString,
          evidence: qaString,
          expected: qaString,
          fix_direction: qaString,
          verification: { type: "array", minItems: 1, maxItems: 10, items: qaString },
        },
      },
    },
    observations: { type: "array", maxItems: 25, items: qaString },
  },
} as const;

export const rulePackSchema = {
  $id: "rafi/rulePack",
  type: "object",
  additionalProperties: false,
  required: ["name", "category", "description", "condition", "template"],
  properties: {
    name: { type: "string", pattern: KEBAB },
    category: { enum: ["base", "process", "domain", "templated"] },
    description: { type: "string", minLength: 1 },
    condition: { enum: ["always", "frontend", "ai", "cloud", "backend"] },
    template: { type: "boolean" },
    supersededByForeman: { type: "boolean" },
    body: { type: "string" },
  },
} as const;

export const skillManifestSchema = {
  $id: "rafi/skillManifest",
  type: "object",
  additionalProperties: false,
  required: ["name", "description"],
  properties: {
    name: { type: "string", pattern: KEBAB },
    description: { type: "string", minLength: 1 },
    pins: { type: "array", items: { type: "string" } },
    codexPriority: { enum: ["inline", "reference"] },
    body: { type: "string" },
  },
} as const;

export const agentManifestSchema = {
  $id: "rafi/agentManifest",
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "role", "packs", "skills"],
  properties: {
    name: { type: "string", pattern: KEBAB },
    description: { type: "string", minLength: 1 },
    role: { enum: ["builder", "qa", "planner", "ticket-maker", "uninstaller", "manager"] },
    packs: { type: "array", items: { type: "string" } },
    skills: { type: "array", items: { type: "string" } },
    conditionalPacks: {
      type: "object",
      additionalProperties: false,
      properties: {
        ai: { type: "array", items: { type: "string" } },
        frontend: { type: "array", items: { type: "string" } },
        cloud: { type: "array", items: { type: "string" } },
        backend: { type: "array", items: { type: "string" } },
      },
    },
    model: { type: ["string", "null"] },
    effort: { type: ["string", "null"], enum: ["low", "medium", "high", "xhigh", null] },
  },
} as const;

const stringRecord = (keys: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: keys,
  properties: Object.fromEntries(keys.map((k) => [k, { type: "string", minLength: 1 }])),
});

const boolRecord = (keys: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: keys,
  properties: Object.fromEntries(keys.map((k) => [k, { type: "boolean" }])),
});

const runtimeArtifactPaths = {
  type: "object",
  additionalProperties: false,
  required: ["artifact_source", "claude", "codex"],
  properties: {
    artifact_source: { enum: ["rafi", "existing"] },
    claude: { type: "string", minLength: 1 },
    codex: { type: "string", minLength: 1 },
  },
} as const;

const artifactPathMap = {
  type: "object",
  additionalProperties: runtimeArtifactPaths,
} as const;

const ticketSetupSource = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "paths"],
      properties: {
        type: { const: "local" },
        paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "linear" },
        api_key_env: { type: "string", minLength: 1 },
        team_key: { type: ["string", "null"] },
        filter: { type: ["string", "null"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "site", "jql"],
      properties: {
        type: { const: "jira" },
        site: { type: "string", minLength: 1 },
        email_env: { type: "string", minLength: 1 },
        token_env: { type: "string", minLength: 1 },
        jql: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "url"],
      properties: {
        type: { const: "url" },
        url: { type: "string", pattern: "^https?://" },
      },
    },
  ],
} as const;

const ticketsSetupConfig = {
  type: "object",
  additionalProperties: false,
  properties: {
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["implementation", "view"],
      properties: {
        implementation: { type: "integer", minimum: 1 },
        view: { type: "integer", minimum: 1 },
      },
    },
    sources: {
      type: "array",
      items: ticketSetupSource,
    },
    populate: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_handling: { enum: ["saved", "prompt", "manual"] },
        agent_preference: { enum: ["configured", "claude", "codex"] },
        import_cap: { type: "integer", minimum: 1 },
        comment_limit: { type: "integer", minimum: 0 },
        enrichment: { enum: ["none", "recommendations", "agent"] },
        recommend_split_for_xl: { type: "boolean" },
      },
    },
    build: {
      type: "object",
      additionalProperties: false,
      properties: {
        branch_strategy: { enum: ["current", "batch", "branch-per-ticket"] },
        completion: { enum: ["pr", "auto-merge", "direct-merge", "none"] },
        provider: { enum: ["auto", "github", "gitlab", "local"] },
        pr_ready: { type: "boolean" },
        merge_method: { enum: ["squash", "merge", "rebase"] },
        cleanup: { type: "boolean" },
        auto_merge_wait: { type: "boolean" },
        auto_merge_timeout_minutes: { type: ["integer", "null"], minimum: 1 },
        base_branch: { type: "string", minLength: 1 },
        branch_prefix: { type: "string", minLength: 1 },
        branch_policy: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "global_strategy", "by_size"],
          properties: {
            mode: { enum: ["global", "size"] },
            global_strategy: { enum: ["current", "batch", "branch-per-ticket"] },
            by_size: {
              type: "object",
              additionalProperties: false,
              required: ["XS", "S", "M", "L", "XL"],
              properties: Object.fromEntries(["XS", "S", "M", "L", "XL"].map((size) => [size, { enum: ["shared", "per-ticket"] }])),
            },
          },
        },
        review: {
          type: "object",
          additionalProperties: false,
          required: ["title_style", "description_sections"],
          properties: {
            title_style: { enum: ["ticket-title", "conventional", "none", "custom"] },
            title_template: { type: ["string", "null"] },
            description_sections: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
          },
        },
        validation_checklist: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
      },
    },
  },
} as const;

const agentDefaultsShape = {
  type: "object",
  additionalProperties: false,
  required: ["version", "roles"],
  properties: {
    version: { const: 1 },
    revision: { type: "integer", minimum: 0 },
    roles: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(["planner", "builder", "qa", "ticket-maker", "uninstaller", "manager"].map((role) => [role, {
        type: "object",
        additionalProperties: false,
        properties: {
          make: { enum: ["claude", "codex"] },
          model: { type: "string", minLength: 1 },
          reasoning: { type: "string", minLength: 1 },
          fast: { type: "boolean" },
          session_strategy: { enum: ["compact", "fresh"] },
          display_session_cost: { type: "boolean" },
          ...(role === "builder" || role === "qa" ? {
            auto_compact_threshold_percent: { type: "integer", minimum: 1, maximum: 99 },
            compact_maximum: { type: "integer", minimum: 1, maximum: 9007199254740991 },
          } : {}),
        },
      }])),
    },
  },
} as const;

const sourceRegistry = {
  type: "object",
  additionalProperties: false,
  required: ["version", "snapshot_storage", "entries"],
  properties: {
    version: { const: 1 },
    snapshot_storage: { enum: ["local", "tracked"] },
    pending: { type: "array", items: { type: "object", additionalProperties: false, required: ["description", "created_at"], properties: { description: { type: "string", minLength: 1 }, created_at: { type: "string", minLength: 1 } } } },
    entries: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["id", "type", "label", "active", "locator", "versions"],
      properties: {
        id: { type: "string", pattern: "^src_[A-Za-z0-9_-]+$" },
        type: { enum: ["local", "url", "github", "gitlab", "linear", "jira"] },
        label: { type: "string", minLength: 1 }, active: { type: "boolean" },
        locator: { type: "object", additionalProperties: true },
        versions: { type: "array", items: { type: "object", additionalProperties: false, required: ["fingerprint", "captured_at", "storage", "snapshot_path", "manifest_path"], properties: {
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" }, captured_at: { type: "string", minLength: 1 }, storage: { enum: ["local", "tracked"] },
          snapshot_path: { type: "string", minLength: 1 }, manifest_path: { type: "string", minLength: 1 }, content_type: { type: "string" }, bytes: { type: "integer", minimum: 0 }, item_count: { type: "integer", minimum: 0 },
        } } },
      },
    } },
  },
} as const;

const autonomyConfig = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "continue_independent_tickets", "supervisor"],
  properties: {
    profile: { enum: ["supervised", "balanced", "unattended"] },
    continue_independent_tickets: { type: "boolean" },
    rules: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(["qa.nonconvergence", "runtime.transient", "plan.material_change"].map((rule) => [rule, {
        type: "object", additionalProperties: false, required: ["action"], properties: {
          action: { enum: ["retry_builder", "retry", "human_required"] },
          max_attempts: { type: "integer", minimum: 0, maximum: 100 },
        },
      }])),
    },
    supervisor: {
      type: "object", additionalProperties: false,
      required: ["enabled", "max_worker_restarts_per_checkpoint", "max_worker_restarts_per_run"],
      properties: {
        enabled: { type: "boolean" },
        max_worker_restarts_per_checkpoint: { type: "integer", minimum: 0, maximum: 100 },
        max_worker_restarts_per_run: { type: "integer", minimum: 0, maximum: 1000 },
      },
    },
  },
} as const;

export const agentDefaultsSchema = {
  $id: "rafi/agentDefaultsV1",
  ...agentDefaultsShape,
} as const;

export const projectConfigSchema = {
  $id: "rafi/projectConfig",
  type: "object",
  additionalProperties: false,
  required: ["appName", "timezone", "stack", "flags", "harness", "agent_files", "agents", "skills"],
  properties: {
    appName: { type: "string", minLength: 1 },
    timezone: { type: "string", minLength: 1 },
    stack: stringRecord(["frontend", "backend", "database", "cloud", "packageManager"]),
    flags: boolRecord(["hasFrontend", "usesAI", "runsInCloud"]),
    harness: {
      type: "object",
      additionalProperties: false,
      required: ["targets", "qa"],
      properties: {
        targets: {
          type: "array",
          minItems: 1,
          items: { enum: ["claude", "codex"] },
        },
        qa: { type: "boolean" },
      },
    },
    agent_files: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "codex", "claude"],
      properties: {
        mode: { enum: ["append", "update", "overwrite"] },
        codex: { type: "string", minLength: 1 },
        claude: { type: "string", minLength: 1 },
      },
    },
    docs: {
      type: "object",
      additionalProperties: false,
      required: ["root"],
      properties: {
        root: { type: "string", minLength: 1 },
      },
    },
    planning: {
      type: "object",
      additionalProperties: false,
      properties: {
        sources: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    sources: sourceRegistry,
    tickets: ticketsSetupConfig,
    agent_defaults: agentDefaultsShape,
    autonomy: autonomyConfig,
    agents: artifactPathMap,
    skills: artifactPathMap,
  },
} as const;

const buildRunBaseProperties = {
  runId: { type: "string", minLength: 1 },
  status: { enum: ["running", "interrupted", "recoverable", "blocked", "completed", "failed", "superseded"] },
  tickets: { type: "array", items: { type: "string", minLength: 1 } },
  branchMode: { enum: ["current", "per-ticket", "shared", "mixed"] },
  checkpoint: { type: "string", minLength: 1 },
  receipts: { type: "object", additionalProperties: { type: "object" } },
  createdAt: { type: "string", minLength: 1 },
  updatedAt: { type: "string", minLength: 1 },
} as const;

const buildRepositoryV1 = {
  type: "object", additionalProperties: true, required: ["root", "worktree"],
  properties: { root: { type: "string", minLength: 1 }, worktree: { type: "string", minLength: 1 } },
} as const;

const buildGitSnapshotV2 = {
  type: "object", additionalProperties: false,
  required: ["worktree", "statusPaths", "initialStatusPaths", "runOwnedPaths", "createdBranch", "createdWorktree"],
  properties: {
    baselineHead: { type: "string" }, baseRef: { type: "string" }, branch: { type: "string" }, startHead: { type: "string" },
    worktree: { type: "string", minLength: 1 }, worktreeIdentity: { type: "string" }, upstream: { type: "string" },
    statusPaths: { type: "array", items: { type: "string" } }, initialStatusPaths: { type: "array", items: { type: "string" } }, runOwnedPaths: { type: "array", items: { type: "string" } },
    createdBranch: { type: "boolean" }, createdWorktree: { type: "boolean" },
  },
} as const;

const providerSessionRefV1 = {
  type: "object", additionalProperties: false,
  required: ["version", "provider", "sessionId", "role", "stream", "generation", "cwd", "configRoot", "source", "createdAt"],
  properties: {
    version: { const: 1 }, provider: { enum: ["claude", "codex"] }, sessionId: { type: "string", minLength: 1 },
    role: { enum: ["builder", "qa", "planner", "ticket-maker", "uninstaller", "manager"] }, stream: { type: "string", minLength: 1 },
    generation: { type: "integer", minimum: 0 }, cwd: { type: "string", minLength: 1 }, configRoot: { type: "string", minLength: 1 },
    workspaceIdentity: { type: "string", minLength: 1 }, ticketId: { type: "string", minLength: 1 }, deliveryUnitId: { type: "string", minLength: 1 },
    source: { enum: ["observed", "legacy-inferred"] }, createdAt: { type: "string", minLength: 1 }, validatedAt: { type: "string", minLength: 1 },
  },
} as const;

export const buildRunRecordSchema = {
  $id: "rafi/buildRunRecord",
  oneOf: [
    {
      type: "object", additionalProperties: true,
      required: ["version", "runId", "status", "tickets", "branchMode", "checkpoint", "repository", "receipts", "createdAt", "updatedAt"],
      properties: { version: { const: 1 }, ...buildRunBaseProperties, repository: buildRepositoryV1 },
    },
    {
      type: "object", additionalProperties: true,
      required: ["version", "runId", "status", "tickets", "branchMode", "checkpoint", "repository", "progress", "receipts", "createdAt", "updatedAt"],
      properties: {
        version: { const: 2 }, ...buildRunBaseProperties,
        repository: { type: "object", additionalProperties: true, required: ["root", "worktree", "git", "baselineComplete"], properties: { root: { type: "string", minLength: 1 }, worktree: { type: "string", minLength: 1 }, git: buildGitSnapshotV2, baselineComplete: { type: "boolean" } } },
        sessionBindings: { type: "array", items: providerSessionRefV1 },
        progress: { type: "object", additionalProperties: false, required: ["completedTickets", "completedOperations", "remainingTickets"], properties: {
          completedTickets: { type: "array", items: { type: "string" } }, completedOperations: { type: "array", items: { type: "string" } }, remainingTickets: { type: "array", items: { type: "string" } },
          currentStep: { type: "string" }, lastSuccessfulAction: { type: "string" }, nextAction: { type: "string" }, validation: { type: "object" },
        } },
      },
    },
    {
      type: "object", additionalProperties: true,
      required: ["version", "runId", "status", "tickets", "branchMode", "checkpoint", "repository", "progress", "receipts", "createdAt", "updatedAt", "frozenPolicy", "phase", "qaEnabled", "recoveryAttempts", "supervisor", "pendingDecisions", "deferredTickets"],
      properties: {
        version: { const: 3 }, ...buildRunBaseProperties,
        repository: { type: "object", additionalProperties: true, required: ["root", "worktree", "git", "baselineComplete"], properties: { root: { type: "string", minLength: 1 }, worktree: { type: "string", minLength: 1 }, git: buildGitSnapshotV2, baselineComplete: { type: "boolean" } } },
        sessionBindings: { type: "array", items: providerSessionRefV1 },
        progress: { type: "object", additionalProperties: false, required: ["completedTickets", "completedOperations", "remainingTickets"], properties: {
          completedTickets: { type: "array", items: { type: "string" } }, completedOperations: { type: "array", items: { type: "string" } }, remainingTickets: { type: "array", items: { type: "string" } },
          currentStep: { type: "string" }, lastSuccessfulAction: { type: "string" }, nextAction: { type: "string" }, validation: { type: "object" },
        } },
        frozenPolicy: { type: "object" }, phase: { type: "string", minLength: 1 }, qaEnabled: { type: "boolean" },
        recoveryAttempts: { type: "array", items: { type: "object" } },
        supervisor: { type: "object" }, pendingDecisions: { type: "array", items: { type: "object" } },
        deferredTickets: { type: "array", items: { type: "string" } },
      },
    },
  ],
} as const;

const installEntryV1 = {
  type: "object", additionalProperties: false, required: ["path", "sha256", "mode", "origin"],
  properties: {
    path: { type: "string", minLength: 1 }, sha256: { type: ["string", "null"] },
    mode: { enum: ["created", "managed-block", "modified", "generated", "runtime-produced"] }, origin: { type: "string", minLength: 1 },
    marker: { type: "string" }, backup: { type: "string" },
  },
} as const;
const installDependency = { type: "object", additionalProperties: false, required: ["manager", "package", "installed", "manifests"], properties: {
  manager: { enum: ["npm", "pnpm", "yarn", "bun"] }, package: { type: "string", minLength: 1 }, previous: { type: ["string", "null"] }, installed: { type: "string", minLength: 1 }, manifests: { type: "array", items: { type: "string", minLength: 1 } },
} } as const;

export const installManifestSchema = {
  $id: "rafi/installManifest",
  oneOf: [
    { type: "object", additionalProperties: false, required: ["version", "createdAt", "updatedAt", "files", "dependencies"], properties: {
      version: { const: 1 }, createdAt: { type: "string" }, updatedAt: { type: "string" }, files: { type: "array", items: installEntryV1 }, dependencies: { type: "array", items: installDependency },
    } },
    { type: "object", additionalProperties: false, required: ["version", "createdAt", "updatedAt", "repository", "files", "dependencies"], properties: {
      version: { const: 2 }, createdAt: { type: "string" }, updatedAt: { type: "string" },
      repository: { type: "object", additionalProperties: false, required: ["rootIdentity", "dirtyChoice", "baselineComplete"], properties: {
        rootIdentity: { type: "string", minLength: 1 }, preInstallHead: { type: "string" }, initialBranch: { type: "string" }, initialDirtyDigest: { type: "string" }, dirtyChoice: { enum: ["clean", "snapshot-and-continue", "stop-and-clean", "legacy-unknown"] }, baselineComplete: { type: "boolean" },
      } },
      files: { type: "array", items: { ...installEntryV1, required: [...installEntryV1.required, "category"], properties: { ...installEntryV1.properties,
        category: { enum: ["tickets", "plans", "skills", "agents", "rules", "config", "documentation-created", "documentation-modified", "managed-gitignore", "runtime-state", "generated-other"] },
        preimageSha256: { type: ["string", "null"] }, installedSha256: { type: ["string", "null"] }, lastRafiWriteAt: { type: "string" },
      } } },
      dependencies: { type: "array", items: installDependency },
    } },
  ],
} as const;
