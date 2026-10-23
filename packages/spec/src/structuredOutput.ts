import { z } from "zod";
import { createHash } from "node:crypto";
import { parseStrictJson } from "./qaFailureReport.js";
import { Ajv } from "ajv";

const validatorCache = new Map<string, ReturnType<Ajv["compile"]>>();
function schemaValidator(schema: Record<string, unknown>, root = schema) {
  const complete = { ...(root.$defs ? { $defs: root.$defs } : {}), ...(root.definitions ? { definitions: root.definitions } : {}), ...schema };
  const key = structuredDigest(complete);
  let validate = validatorCache.get(key);
  if (!validate) {
    validate = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false, validateFormats: false }).compile(complete);
    if (validatorCache.size >= 512) validatorCache.delete(validatorCache.keys().next().value!);
    validatorCache.set(key, validate);
  }
  return validate;
}

/** Versions are independent of product, persistence and provider versions. */
export interface OutputContract<T = unknown> {
  protocolVersion: 1;
  operation: string;
  schemaVersion: number;
  schemaDigest: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
}

export type StructuredProvider = "claude" | "codex";

/**
 * A provider wire contract is deliberately separate from Rafi's canonical
 * contract.  Providers may have representational constraints, but only the
 * deterministic normalizer may bridge them into host-owned canonical data.
 */
export interface ProviderWireContract<Canonical = unknown, Wire = unknown> {
  canonical: OutputContract<Canonical>;
  provider: StructuredProvider;
  profile: string;
  variant: string;
  wireVersion: number;
  wireSchema: Record<string, unknown>;
  wireSchemaDigest: string;
  maximumSchemaBytes: number;
  maximumResponseBytes: number;
  maximumPageBytes?: number;
  normalizerId: string;
  normalizerVersion: number;
  /** Normalizers may add only deterministic host-owned fields. */
  normalize: (wire: Wire) => Canonical;
  descriptorDigest: string;
  guidanceId: string;
  guidance: (contract: OutputContract<Canonical>) => string;
}

const wireGuidanceBegin = "<!-- rafi:selected-provider-wire";
const wireGuidanceEnd = "<!-- /rafi:selected-provider-wire -->";

/**
 * Adds the only wire-shape instruction a provider may receive for a native
 * operation.  This is deliberately owned by the immutable descriptor, rather
 * than by individual operation prompts, so a Codex flat wire can never inherit
 * prose for Rafi's canonical envelope.
 */
export function renderProviderWireInstruction(instruction: string, selected: ProviderWireContract): string {
  const guidance = selected.guidance(selected.canonical).trim();
  if (!guidance) throw new Error(`Provider wire contract ${selected.profile} has no guidance`);
  const block = `${wireGuidanceBegin} profile=${selected.profile} variant=${selected.variant} descriptor=${selected.descriptorDigest} bytes=${selected.maximumResponseBytes} -->\n${guidance}\n${wireGuidanceEnd}`;
  if (!instruction.includes(wireGuidanceBegin)) return `${instruction.trimEnd()}\n\n${block}`;
  if (instruction.endsWith(block)) return instruction;
  throw new Error("Native instruction already contains guidance for a different or malformed provider wire contract");
}

const wireContracts = new Map<string, ProviderWireContract<any>>();
const wireKey = (contract: OutputContract, provider: StructuredProvider, variant: string) =>
  `${contract.operation}:${contract.schemaVersion}:${contract.schemaDigest}:${provider}:${variant}`;

function defaultGuidance(contract: OutputContract): string {
  return `Return exactly one native JSON result for ${contract.operation}. Follow the selected schema; do not add prose delimiters or host-owned identifiers.`;
}

export function createProviderWireContract<Canonical, Wire = Canonical>(input: Omit<ProviderWireContract<Canonical, Wire>, "wireSchemaDigest" | "descriptorDigest">): ProviderWireContract<Canonical, Wire> {
  const wireSchema = freezeJson(structuredClone(input.wireSchema));
  const maximumSchemaBytes = input.maximumSchemaBytes;
  const maximumResponseBytes = input.maximumResponseBytes;
  if (!input.profile || !input.variant || !input.normalizerId || !input.guidanceId || typeof input.guidance !== "function" || !Number.isSafeInteger(input.wireVersion) || input.wireVersion < 1 ||
    !Number.isSafeInteger(maximumSchemaBytes) || maximumSchemaBytes < 1 || !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
    throw new Error("Invalid provider wire contract descriptor");
  }
  if (Buffer.byteLength(canonicalJson(wireSchema)) > maximumSchemaBytes) throw new Error("Provider wire schema exceeds descriptor byte limit");
  const wireSchemaDigest = structuredDigest(wireSchema);
  const descriptorDigest = structuredDigest({ operation: input.canonical.operation, schemaVersion: input.canonical.schemaVersion,
    schemaDigest: input.canonical.schemaDigest, provider: input.provider, profile: input.profile, variant: input.variant,
    wireVersion: input.wireVersion, wireSchemaDigest, maximumSchemaBytes, maximumResponseBytes,
    maximumPageBytes: input.maximumPageBytes ?? null, normalizerId: input.normalizerId,
    normalizerVersion: input.normalizerVersion, guidanceId: input.guidanceId });
  return Object.freeze({ ...input, wireSchema, wireSchemaDigest, descriptorDigest });
}

/** Register a reviewed profile. Duplicate keys with different bytes are a deployment error. */
export function registerProviderWireContract<T>(contract: ProviderWireContract<T>): ProviderWireContract<T> {
  const key = wireKey(contract.canonical, contract.provider, contract.variant);
  const existing = wireContracts.get(key);
  if (existing && existing.descriptorDigest !== contract.descriptorDigest) throw new Error(`Conflicting provider wire contract ${key}`);
  wireContracts.set(key, contract as ProviderWireContract<any>);
  return contract;
}

/**
 * Compatibility is explicit and retained only for existing descriptors that
 * have not yet received a reviewed profile. New callers can require a
 * registered descriptor via `requireRegistered`.
 */
function compatibilityWireContract<T>(contract: OutputContract<T>, provider: StructuredProvider): ProviderWireContract<T> {
  const schema = (provider === "codex" ? projectCodexSchema(contract.jsonSchema) : contract.jsonSchema) as Record<string, unknown>;
  return createProviderWireContract({ canonical: contract, provider, profile: `${provider}-json-schema-v1`, variant: "compatibility",
    wireVersion: 1, wireSchema: schema, maximumSchemaBytes: 1_000_000, maximumResponseBytes: 2_000_000,
    normalizerId: provider === "codex" ? "codex-optional-properties" : "identity", normalizerVersion: 1,
    normalize: (value: unknown) => (provider === "codex" ? decodeCodexOptionalProperties(contract.jsonSchema, value) : value) as T,
    guidanceId: "compatibility-envelope-v1", guidance: defaultGuidance });
}

export function providerWireContract<T>(contract: OutputContract<T>, provider: StructuredProvider, variant = "default", options: { requireRegistered?: boolean } = {}): ProviderWireContract<T> {
  if (structuredDigest(contract.jsonSchema) !== contract.schemaDigest) throw new Error("Output contract schema changed after selection");
  const selected = wireContracts.get(wireKey(contract, provider, variant)) as ProviderWireContract<T> | undefined;
  if (selected) return selected;
  if (options.requireRegistered) throw new Error(`No selected provider wire contract for ${contract.operation}/${provider}/${variant}`);
  return compatibilityWireContract(contract, provider);
}

export function providerWireContracts(): readonly ProviderWireContract[] {
  return [...wireContracts.values()].sort((a, b) => a.descriptorDigest.localeCompare(b.descriptorDigest));
}

/** Explicit temporary profile registration for migrated operations awaiting a purpose-built wire shape. */
export function registerCompatibilityProviderWireContracts<T>(contract: OutputContract<T>, family = "operation"): void {
  registerProviderWireContract(createProviderWireContract({
    canonical: contract, provider: "claude", profile: `claude-${family}-compat-v1`, variant: "default", wireVersion: 1,
    wireSchema: contract.jsonSchema, maximumSchemaBytes: 1_000_000, maximumResponseBytes: 2_000_000,
    normalizerId: "identity", normalizerVersion: 1, normalize: value => value,
    guidanceId: `${family}-envelope-v1`, guidance: defaultGuidance,
  }));
  registerProviderWireContract(createProviderWireContract({
    canonical: contract, provider: "codex", profile: `codex-${family}-compat-v1`, variant: "default", wireVersion: 1,
    wireSchema: projectCodexSchema(contract.jsonSchema) as Record<string, unknown>, maximumSchemaBytes: 1_000_000, maximumResponseBytes: 2_000_000,
    normalizerId: "codex-optional-properties", normalizerVersion: 1, normalize: value => decodeCodexOptionalProperties(contract.jsonSchema, value) as T,
    guidanceId: `${family}-envelope-v1`, guidance: defaultGuidance,
  }));
}

function receiptWireContract<T>(contract: OutputContract<T>, profile: string, variant?: string): ProviderWireContract<T> | undefined {
  const matches = [...wireContracts.values()].filter(entry =>
    entry.canonical.operation === contract.operation && entry.canonical.schemaVersion === contract.schemaVersion &&
    entry.canonical.schemaDigest === contract.schemaDigest && entry.profile === profile &&
    (variant === undefined || entry.variant === variant)) as unknown as ProviderWireContract<T>[];
  return matches.length === 1 ? matches[0] : undefined;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || typeof value === "number" && !Number.isFinite(value)) throw new Error("Not a JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function structuredDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function outputContract<T>(operation: string, schema: z.ZodType<T>, schemaVersion = 1): OutputContract<T> {
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(operation) || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Invalid output contract identity");
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  return Object.freeze({ protocolVersion: 1 as const, operation, schemaVersion, schemaDigest: structuredDigest(jsonSchema), schema, jsonSchema: freezeJson(jsonSchema) });
}

/** Preserve existing JSON Schema constraints verbatim; no lossy schema conversion. */
export function jsonOutputContract<T>(operation: string, jsonSchema: Record<string, unknown>, schemaVersion = 1): OutputContract<T> {
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(operation) || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Invalid output contract identity");
  jsonSchema = freezeJson(structuredClone(jsonSchema));
  const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(jsonSchema);
  const schema = z.custom<T>(() => true).superRefine((value, context) => {
    if (validate(value)) return;
    const errors = validate.errors ?? [];
    // A discriminated union reports errors for every alternative. Do not tell
    // a completed result to add fields belonging only to blocked/questions.
    const wrongBranches = errors.filter(error => ["const", "enum"].includes(error.keyword) && error.instancePath.endsWith("/kind"))
      .map(error => error.schemaPath.match(/.*\/(?:oneOf|anyOf)\/\d+(?=\/|$)/)?.[0]).filter((path): path is string => Boolean(path));
    const relevant = errors.filter(error => !["oneOf", "anyOf"].includes(error.keyword) && !wrongBranches.some(path => error.schemaPath.startsWith(`${path}/`)));
    for (const error of (relevant.length ? relevant : errors).slice(0, 10)) {
      const detail = `${error.message ?? error.keyword}${error.keyword === "additionalProperties" ? `: ${JSON.stringify(error.params.additionalProperty)}` : ""}`;
      context.addIssue({ code: "custom", path: error.instancePath.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~")),
        message: `JSON Schema validation failed: ${detail}`.slice(0, 500) });
    }
  });
  return Object.freeze({ protocolVersion: 1 as const, operation, schemaVersion, jsonSchema, schemaDigest: structuredDigest(jsonSchema), schema });
}

/** Change oneOf only after proving disjointness. Never relax host validation. */
export function projectCodexSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectCodexSchema);
  if (!value || typeof value !== "object") return value;
  const projected = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectCodexSchema(child)])) as Record<string, any>;
  // Codex strict mode rejects uniqueItems. The canonical host validator still
  // enforces it after receipt, including nested arrays. This is not acceptance.
  delete projected.uniqueItems;
  if (projected.oneOf) {
    const branches = projected.oneOf as Array<Record<string, any>>;
    const literals = (field: any): string[] | undefined => typeof field?.const === "string" ? [field.const] :
      Array.isArray(field?.enum) && field.enum.length && field.enum.every((v: unknown) => typeof v === "string") ? field.enum : undefined;
    const discriminators = Object.keys(branches[0]?.properties ?? {}).filter(key => branches.every(branch =>
      branch.type === "object" && branch.additionalProperties === false && branch.required?.includes(key) && literals(branch.properties?.[key])));
    if (projected.anyOf || !discriminators.some(key => {
      const values = branches.flatMap(branch => literals(branch.properties[key])!);
      return new Set(values).size === values.length;
    })) throw new Error("Unsupported overlapping oneOf in Codex output contract");
    projected.anyOf = branches;
    delete projected.oneOf;
  }
  if (projected.type === "object" && projected.properties) {
    const required = new Set<string>(projected.required ?? []);
    for (const key of Object.keys(projected.properties)) {
      // Codex requires every property on the wire. Null represents absence
      // ONLY for an optional property whose canonical schema rejects null.
      if (!required.has(key)) projected.properties[key] = { anyOf: [projected.properties[key], { type: "null" }] };
    }
    projected.required = Object.keys(projected.properties);
  } else if (projected.type === "object" && projected.additionalProperties && typeof projected.additionalProperties === "object") {
    return { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "value"],
      properties: { key: { type: "string", ...(projected.propertyNames ?? {}) }, value: projected.additionalProperties } },
      ...(projected.minProperties === undefined ? {} : { minItems: projected.minProperties }),
      ...(projected.maxProperties === undefined ? {} : { maxItems: projected.maxProperties }) };
  }
  return projected;
}

/** Decode the documented Codex optional-property projection, retaining raw evidence. */
export function decodeCodexOptionalProperties(schema: Record<string, any>, value: unknown, root = schema): unknown {
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/")) throw new Error("Unsupported external schema reference");
    const target = schema.$ref.slice(2).split("/").reduce((node: any, key: string) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
    if (!target) throw new Error("Missing schema reference");
    return decodeCodexOptionalProperties(target, value, root);
  }
  const branches: Array<Record<string, any>> | undefined = schema.oneOf ?? schema.anyOf;
  if (branches) {
    const matching = branches.filter(branch => schemaValidator(projectCodexSchema(branch) as Record<string, unknown>, projectCodexSchema(root) as Record<string, unknown>)(value));
    if (matching.length === 1) return decodeCodexOptionalProperties(matching[0]!, value, root);
    // Do not guess a branch if normalization could change its meaning.
    if (matching.length > 1 && matching.some(branch => branch.type === "object" || branch.$ref)) throw new Error("Ambiguous optional-property projection");
    return value;
  }
  if (Array.isArray(value) && schema.type === "object" && !schema.properties && typeof schema.additionalProperties === "object") {
    const entries: Array<[string, unknown]> = [];
    const keys = new Set<string>();
    for (const row of value) {
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "key,value" || typeof row.key !== "string" || keys.has(row.key)) throw new Error("Invalid or duplicate projected map entry");
      keys.add(row.key); entries.push([row.key, decodeCodexOptionalProperties(schema.additionalProperties, row.value, root)]);
    }
    return Object.fromEntries(entries);
  }
  if (Array.isArray(value) && schema.items) return value.map(item => decodeCodexOptionalProperties(schema.items, item, root));
  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const acceptsNull = (entry: Record<string, any>): boolean => Boolean(schemaValidator(entry, root)(null));
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const field = schema.properties[key];
      if (!field) return [[key, child]]; // Unknown fields must reach strict validation.
      if (child === null && !schema.required?.includes(key) && !acceptsNull(field)) return [];
      return [[key, decodeCodexOptionalProperties(field, child, root)]];
    }));
  }
  return value;
}

export function providerOutputSchema(contract: OutputContract, provider: "claude" | "codex"): { schema: Record<string, unknown>; digest: string; profile: string } {
  const selected = providerWireContract(contract, provider);
  return { schema: selected.wireSchema, digest: selected.wireSchemaDigest, profile: selected.profile };
}

/** Bound before parsing, including SDK-decoded objects. Duplicate keys require raw bytes. */
export function boundedJson(value: unknown, representation: "json-text" | "decoded-json", maxBytes = 2_000_000): unknown {
  if (representation !== "json-text" && representation !== "decoded-json") throw new Error("Unknown structured result representation");
  if (representation === "json-text") {
    if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) throw new Error("Structured result exceeds byte limit or is not JSON text");
    // Check nesting before the strict recursive JSON scanner.
    let depth = 0, quoted = false, escaped = false;
    for (const char of value) {
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") { if (++depth > 64) throw new Error("Structured result exceeds nesting limit"); }
      else if (char === "}" || char === "]") depth--;
    }
    value = parseStrictJson(value);
  }
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 64 || ++nodes > 100_000) throw new Error("Structured result exceeds complexity limit");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)) return;
    if (typeof entry !== "object" || seen.has(entry)) throw new Error("Structured result is not finite JSON");
    seen.add(entry);
    if (!Array.isArray(entry) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) throw new Error("Structured result is not a plain JSON object");
    for (const child of Object.values(entry)) visit(child, depth + 1);
    seen.delete(entry);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error("Structured result exceeds byte limit");
  return value;
}

export type StructuredCandidate = {
  state: "candidate";
  protocolVersion: 1;
  operation: string;
  schemaVersion: number;
  schemaDigest: string;
  wireSchemaDigest: string;
  profile: string;
  wireContractDigest?: string;
  wireVariant?: string;
  dispatchId: string;
  sessionId: string;
  nativeTurnId: string;
  nativeItemId?: string;
  terminal: "completed";
  representation: "json-text" | "decoded-json";
  value: unknown;
  normalization?: { version: 1; rawDecodedDigest: string; canonicalDigest: string };
};
export type StructuredResponse = StructuredCandidate | {
  state: "rejected";
  reason: "invalid-contract" | "missing-result" | "ambiguous-result" | "execution-not-completed" | "tool-policy-violation" | "unsupported-contract";
  detail: string;
  dispatchId: string;
  observedValue?: { representation: "json-text" | "decoded-json"; value: unknown; digest: string };
};

/** Validate a decoded provider submission before an SDK accepts it as native output. */
export function validateProviderWireValue<Canonical, Wire>(descriptor: ProviderWireContract<Canonical, Wire>, value: unknown): void {
  const raw = boundedJson(value, "decoded-json", descriptor.maximumResponseBytes);
  const validator = schemaValidator(descriptor.wireSchema);
  if (!validator(raw)) throw new Error(`Structured result violates wire schema: ${JSON.stringify(validator.errors?.slice(0, 10)).slice(0, 2400)}`);
}

/** Transport validation only. Product authority/evidence checks belong to the operation owner. */
export function validateStructuredCandidate<T>(contract: OutputContract<T>, candidate: StructuredResponse | undefined, selected?: ProviderWireContract<T>): T {
  if (!candidate || candidate.state !== "candidate") throw new Error(`No completed structured result: ${candidate?.detail ?? "missing receipt"}`);
  if (candidate.protocolVersion !== 1 || candidate.terminal !== "completed" || !candidate.dispatchId || !candidate.sessionId || !candidate.nativeTurnId ||
    candidate.operation !== contract.operation || candidate.schemaVersion !== contract.schemaVersion || candidate.schemaDigest !== contract.schemaDigest) throw new Error("Structured result contract or receipt mismatch");
  const provider = candidate.profile === "codex-json-schema-v1" ? "codex" : candidate.profile === "claude-json-schema-v1" ? "claude" : undefined;
  const descriptor = selected ?? receiptWireContract(contract, candidate.profile, candidate.wireVariant) ??
    (provider ? providerWireContract(contract, provider, candidate.wireVariant ?? "default") : undefined);
  if (!descriptor) throw new Error("Structured result wire profile mismatch");
  if (candidate.profile !== descriptor.profile || candidate.wireSchemaDigest !== descriptor.wireSchemaDigest ||
    candidate.wireContractDigest !== undefined && candidate.wireContractDigest !== descriptor.descriptorDigest ||
    candidate.wireVariant !== undefined && candidate.wireVariant !== descriptor.variant) throw new Error("Structured result wire profile mismatch");
  const raw = boundedJson(candidate.value, candidate.representation, descriptor.maximumResponseBytes);
  validateProviderWireValue(descriptor, raw);
  const decoded = descriptor.normalize(raw);
  const parsed = contract.schema.parse(decoded);
  // Zod deliberately omits prototype-sensitive record keys. Do not silently
  // accept a payload whose declared data was lost during schema normalization.
  const ensureNoKeyLoss = (before: unknown, after: unknown): void => {
    if (!before || typeof before !== "object" || !after || typeof after !== "object") return;
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) throw new Error("Schema normalization discarded a JSON field");
      ensureNoKeyLoss((before as any)[key], (after as any)[key]);
    }
  };
  ensureNoKeyLoss(decoded, parsed);
  if (candidate.normalization && (candidate.normalization.version !== 1 || candidate.normalization.rawDecodedDigest !== structuredDigest(raw) || candidate.normalization.canonicalDigest !== structuredDigest(parsed))) throw new Error("Structured normalization receipt mismatch");
  return parsed;
}
