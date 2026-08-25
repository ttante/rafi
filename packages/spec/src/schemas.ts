/**
 * JSON Schemas (draft-07) for the neutral types in {@link ./types}. Kept in lockstep
 * with those interfaces; validated by {@link ./validate}.
 */

const KEBAB = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

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
    role: { enum: ["builder", "qa", "planner", "ticket-maker", "uninstaller"] },
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
      properties: Object.fromEntries(["planner", "builder", "qa", "ticket-maker", "uninstaller"].map((role) => [role, {
        type: "object",
        additionalProperties: false,
        properties: {
          make: { enum: ["claude", "codex"] },
          model: { type: "string", minLength: 1 },
          reasoning: { type: "string", minLength: 1 },
          fast: { type: "boolean" },
          session_strategy: { enum: ["compact", "fresh"] },
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
    agents: artifactPathMap,
    skills: artifactPathMap,
  },
} as const;
