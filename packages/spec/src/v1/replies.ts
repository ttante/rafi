// The agent reply schemas of ARCH 6.1–6.4: builder (build and fix turns), requirements (QA's prepare turn) and
// verdict (QA's review turn). Defined once as zod; emitted as JSON Schema draft-07 for Claude and as Codex's strict
// projection (every property required, absence as null; ported from spec/src/structuredOutput.ts projectCodexSchema).
// Flat: no unions below the top level other than null; no ids rafi already has, so an extra field fails (S-MAL-4).
import { z } from "zod";

const runNumbers = z.array(z.number().int().positive());
const blockType = z.enum(["permission", "install", "service", "credential", "decision", "other"]);

export const builderReply = z.object({
  kind: z.enum(["done", "blocked", "needs-input"]),
  summary: z.string().min(1).nullable(),
  runs: runNumbers,
  block: z.object({ type: blockType, need: z.string().nullable(), reason: z.string().min(1) }).strict().nullable(),
  question: z.object({ text: z.string().min(1), choices: z.array(z.string()) }).strict().nullable(),
}).strict();

export const requirementsReply = z.object({
  requirements: z.array(z.object({
    from: z.number().int().positive(), text: z.string().min(1), check: z.string().min(1).nullable(),
    expect: z.string().nullable(),
  }).strict()).min(1),
  in_scope: z.array(z.string()), out_of_scope: z.array(z.string()), risks: z.array(z.string()),
  add_tags: z.array(z.string()),
}).strict();

export const verdictReply = z.object({
  results: z.array(z.object({
    req: z.number().int().positive(),
    status: z.enum(["satisfied", "not-satisfied", "not-applicable", "unable"]),
    runs: runNumbers,
    needs: z.enum(["browser", "device", "person", "service", "file", "other"]).nullable(),
    note: z.string().nullable(),
  }).strict()),
  summary: z.string(),
}).strict();

export type BuilderReply = z.infer<typeof builderReply>;
export type RequirementsReply = z.infer<typeof requirementsReply>;
export type VerdictReply = z.infer<typeof verdictReply>;
export type ReplyName = "builder" | "requirements" | "verdict";

const ZOD: Readonly<Record<ReplyName, z.ZodType>> = Object.freeze({
  builder: builderReply, requirements: requirementsReply, verdict: verdictReply,
});

type Json = Record<string, unknown>;

/** Codex strict mode: every property required (absence as null), no uniqueItems. */
export function projectCodex(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectCodex);
  if (!value || typeof value !== "object") return value;
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, projectCodex(v)])) as Json;
  delete out.uniqueItems;
  delete out.$schema;
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = out.properties as Json;
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = { anyOf: [props[key], { type: "null" }] };
    }
    out.required = Object.keys(props);
  }
  return out;
}

function jsonSchema(schema: z.ZodType): Json {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Json;
  return json;
}

export interface ReplySpec {
  readonly name: ReplyName;
  readonly json: Json;
  readonly codex: Json;
}

function spec(name: ReplyName): ReplySpec {
  const json = jsonSchema(ZOD[name]);
  return Object.freeze({ name, json, codex: projectCodex(json) as Json });
}

export const replySchemas: Readonly<Record<ReplyName, ReplySpec>> = Object.freeze({
  builder: spec("builder"), requirements: spec("requirements"), verdict: spec("verdict"),
});

/** The builder's kind rules, which a flat schema can't say (ARCH 6.2). */
function builderRules(value: BuilderReply): string[] {
  const errors: string[] = [];
  if (value.kind === "done") {
    if (!value.summary) errors.push("summary: a done reply needs a summary");
    if (value.block) errors.push("block: a done reply has no block");
    if (value.question) errors.push("question: a done reply has no question");
  }
  if (value.kind === "blocked" && !value.block) errors.push("block: a blocked reply needs a block");
  if (value.kind === "needs-input" && !value.question) errors.push("question: a needs-input reply needs a question");
  return errors;
}

function describe(issue: z.core.$ZodIssue): string {
  const where = issue.path.join(".") || "reply";
  if (issue.code === "unrecognized_keys") return `${issue.keys.join(", ")}: not a field of this reply`;
  return `${where}: ${issue.message}`;
}

export type ReplyCheck = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** Validates a parsed reply: the schema, then the rules it can't express. Errors are in plain words. */
export function checkReply(name: ReplyName, value: unknown): ReplyCheck {
  const parsed = ZOD[name].safeParse(value);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(describe) };
  const errors = name === "builder" ? builderRules(parsed.data as BuilderReply) : [];
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed.data };
}
