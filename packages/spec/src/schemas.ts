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
    role: { enum: ["builder", "qa", "planner", "ticket-maker"] },
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

export const projectConfigSchema = {
  $id: "rafi/projectConfig",
  type: "object",
  additionalProperties: false,
  required: ["appName", "timezone", "stack", "flags", "harness"],
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
  },
} as const;
