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
  protocolVersion: 2;
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
  /**
   * Guidance is rendered and frozen with the descriptor.  Keeping a callback
   * here used to let a deployment change the prompt without changing the
   * descriptor digest.
   */
  guidance: string;
  guidanceDigest: string;
}

/** The exact immutable authority selected before a native provider dispatch. */
export interface SelectedDispatchTupleV2 {
  readonly protocolVersion: 2;
  readonly operation: string;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly provider: StructuredProvider;
  readonly profile: string;
  readonly variant: string;
  readonly descriptorDigest: string;
  readonly wireSchemaDigest: string;
  readonly guidanceDigest: string;
  readonly normalizerId: string;
  readonly normalizerVersion: number;
  readonly maximumSchemaBytes: number;
  readonly maximumResponseBytes: number;
  readonly maximumPageBytes: number | null;
  readonly instructionDigest: string;
  readonly actionId: string;
  readonly dispatchId: string;
  /** A tuple may only be sealed after the provider session is prepared. */
  readonly sessionId: string;
  readonly generation: number;
  readonly digest: string;
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
  const guidance = selected.guidance.trim();
  if (!guidance) throw new Error(`Provider wire contract ${selected.profile} has no guidance`);
  const block = `${wireGuidanceBegin} profile=${selected.profile} variant=${selected.variant} descriptor=${selected.descriptorDigest} bytes=${selected.maximumResponseBytes} -->\n${guidance}\n${wireGuidanceEnd}`;
  if (!instruction.includes(wireGuidanceBegin)) return `${instruction.trimEnd()}\n\n${block}`;
  if (instruction.endsWith(block)) return instruction;
  throw new Error("Native instruction already contains guidance for a different or malformed provider wire contract");
}

interface StaticProviderWireRegistry {
  readonly active: readonly ProviderWireContract<any>[];
  readonly historic: readonly ProviderWireContract<any>[];
}
let staticWireRegistry: StaticProviderWireRegistry | undefined;
const wireKey = (contract: OutputContract, provider: StructuredProvider, variant: string) =>
  `${contract.operation}:${contract.schemaVersion}:${contract.schemaDigest}:${provider}:${variant}`;

type ProviderWireContractInput<Canonical, Wire> = Omit<ProviderWireContract<Canonical, Wire>, "wireSchemaDigest" | "descriptorDigest" | "guidance" | "guidanceDigest"> & {
  /** A function is accepted only at construction for source compatibility. */
  guidance: string | ((contract: OutputContract<Canonical>) => string);
};

export function createProviderWireContract<Canonical, Wire = Canonical>(input: ProviderWireContractInput<Canonical, Wire>): ProviderWireContract<Canonical, Wire> {
  const wireSchema = freezeJson(structuredClone(input.wireSchema));
  const guidance = (typeof input.guidance === "function" ? input.guidance(input.canonical) : input.guidance).trim();
  const maximumSchemaBytes = input.maximumSchemaBytes;
  const maximumResponseBytes = input.maximumResponseBytes;
  if (!input.profile || !input.variant || !input.normalizerId || !input.guidanceId || !guidance || !Number.isSafeInteger(input.wireVersion) || input.wireVersion < 1 ||
    !Number.isSafeInteger(maximumSchemaBytes) || maximumSchemaBytes < 1 || !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
    throw new Error("Invalid provider wire contract descriptor");
  }
  if (Buffer.byteLength(canonicalJson(wireSchema)) > maximumSchemaBytes) throw new Error("Provider wire schema exceeds descriptor byte limit");
  const wireSchemaDigest = structuredDigest(wireSchema);
  const guidanceDigest = structuredDigest(guidance);
  const descriptorDigest = structuredDigest({ operation: input.canonical.operation, schemaVersion: input.canonical.schemaVersion,
    schemaDigest: input.canonical.schemaDigest, provider: input.provider, profile: input.profile, variant: input.variant,
    wireVersion: input.wireVersion, wireSchemaDigest, maximumSchemaBytes, maximumResponseBytes,
    maximumPageBytes: input.maximumPageBytes ?? null, normalizerId: input.normalizerId,
    normalizerVersion: input.normalizerVersion, guidanceId: input.guidanceId, guidanceDigest });
  return Object.freeze({ ...input, guidance, guidanceDigest, wireSchema, wireSchemaDigest, descriptorDigest });
}

/**
 * Called once by the spec-private declaration module.  It is intentionally
 * not a registration API: production cannot add, replace, or remove a
 * descriptor after module initialization.
 */
export function installStaticProviderWireContracts(registry: StaticProviderWireRegistry): void {
  if (staticWireRegistry) throw new Error("Static provider wire registry was already installed");
  const digests = new Set<string>();
  for (const contract of registry.historic) {
    // Historic replay intentionally permits a retired and active descriptor
    // for the same canonical/provider/variant identity.  The descriptor
    // digest, not a mutable profile or the active-selection key, identifies
    // the exact shipped wire contract on replay.
    if (digests.has(contract.descriptorDigest)) throw new Error(`Duplicate static provider wire descriptor digest ${contract.descriptorDigest}`);
    digests.add(contract.descriptorDigest);
  }
  const historic = Object.freeze([...registry.historic]);
  const active = Object.freeze([...registry.active]);
  for (const contract of active) {
    if (!historic.some(entry => entry.descriptorDigest === contract.descriptorDigest)) throw new Error("Active provider wire descriptor is absent from historic registry");
  }
  staticWireRegistry = Object.freeze({ active, historic });
}

function installedWireRegistry(): StaticProviderWireRegistry {
  if (!staticWireRegistry) throw new Error("Static provider wire registry is unavailable");
  return staticWireRegistry;
}

/** Descriptor selection is deliberately fail-closed. */
export function providerWireContract<T>(contract: OutputContract<T>, provider: StructuredProvider, variant = "default", _options: { requireRegistered?: boolean } = {}): ProviderWireContract<T> {
  if (structuredDigest(contract.jsonSchema) !== contract.schemaDigest) throw new Error("Output contract schema changed after selection");
  const selected = installedWireRegistry().active.find(entry => wireKey(entry.canonical, entry.provider, entry.variant) === wireKey(contract, provider, variant)) as ProviderWireContract<T> | undefined;
  if (selected) return selected;
  throw new Error(`No selected provider wire contract for ${contract.operation}/${provider}/${variant}`);
}

/** Resolve a persisted descriptor identity for replay.  New dispatch must use
 * providerWireContract; this path deliberately cannot select a replacement. */
export function historicProviderWireContract<T>(contract: OutputContract<T>, tuple: Pick<SelectedDispatchTupleV2, "provider" | "variant" | "descriptorDigest">): ProviderWireContract<T> {
  const descriptor = installedWireRegistry().historic.find(entry => entry.canonical.operation === contract.operation &&
    entry.canonical.schemaVersion === contract.schemaVersion && entry.canonical.schemaDigest === contract.schemaDigest &&
    entry.provider === tuple.provider && entry.variant === tuple.variant && entry.descriptorDigest === tuple.descriptorDigest) as ProviderWireContract<T> | undefined;
  if (!descriptor) throw new Error("Persisted structured descriptor is not available for historic replay");
  return descriptor;
}

/** Exact persisted identity lookup, including retired schemas and providers. Never selects new work. */
export function persistedProviderWireContract(value: SelectedDispatchTupleV2): ProviderWireContract {
  const tuple = parseSelectedDispatchTupleV2(value);
  const { digest, ...fields } = tuple;
  if (structuredDigest(fields) !== digest) throw new Error("Persisted structured tuple digest mismatch");
  const descriptor = installedWireRegistry().historic.find(entry => entry.canonical.operation === tuple.operation &&
    entry.canonical.schemaVersion === tuple.schemaVersion && entry.canonical.schemaDigest === tuple.schemaDigest &&
    entry.provider === tuple.provider && entry.variant === tuple.variant && entry.descriptorDigest === tuple.descriptorDigest);
  if (!descriptor) throw new Error("Persisted structured descriptor is not available for historic replay");
  return descriptor;
}

export function providerWireContracts(): readonly ProviderWireContract[] {
  return [...installedWireRegistry().active].sort((a, b) => a.descriptorDigest.localeCompare(b.descriptorDigest));
}

export function selectedDispatchTupleV2(input: Omit<SelectedDispatchTupleV2, "protocolVersion" | "digest">): SelectedDispatchTupleV2 {
  if (!input.operation || !input.schemaDigest || !input.descriptorDigest || !input.guidanceDigest || !input.instructionDigest || !input.actionId || !input.dispatchId ||
    !input.sessionId || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1 ||
    !Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error("Invalid selected dispatch tuple v2");
  }
  const immutable = { protocolVersion: 2 as const, ...input };
  return parseSelectedDispatchTupleV2({ ...immutable, digest: structuredDigest(immutable) });
}

function receiptWireContract<T>(contract: OutputContract<T>, profile: string, variant?: string): ProviderWireContract<T> | undefined {
  const matches = installedWireRegistry().historic.filter(entry =>
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
  return Object.freeze({ protocolVersion: 2 as const, operation, schemaVersion, schemaDigest: structuredDigest(jsonSchema), schema, jsonSchema: freezeJson(jsonSchema) });
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
  return Object.freeze({ protocolVersion: 2 as const, operation, schemaVersion, jsonSchema, schemaDigest: structuredDigest(jsonSchema), schema });
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
  protocolVersion: 2;
  operation: string;
  schemaVersion: number;
  schemaDigest: string;
  wireSchemaDigest: string;
  profile: string;
  wireContractDigest: string;
  wireVariant: string;
  /** Digest of the immutable tuple that authorized this exact provider turn. */
  selectedDispatchDigest: string;
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
export function parseSelectedDispatchTupleV2(value: unknown): SelectedDispatchTupleV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Selected dispatch tuple is not an object");
  const tuple = value as Partial<SelectedDispatchTupleV2>;
  const fields: Array<keyof SelectedDispatchTupleV2> = ["operation", "schemaVersion", "schemaDigest", "provider", "profile", "variant", "descriptorDigest", "wireSchemaDigest", "guidanceDigest", "normalizerId", "normalizerVersion", "maximumSchemaBytes", "maximumResponseBytes", "maximumPageBytes", "instructionDigest", "actionId", "dispatchId", "sessionId", "generation", "digest"];
  if (tuple.protocolVersion !== 2 || Object.keys(tuple).length !== fields.length + 1 || fields.some(field => !(field in tuple))) throw new Error("Selected dispatch tuple is incomplete or has unknown fields");
  if (tuple.provider !== "claude" && tuple.provider !== "codex" || typeof tuple.operation !== "string" || typeof tuple.profile !== "string" || typeof tuple.variant !== "string" || typeof tuple.sessionId !== "string" || !tuple.sessionId ||
    !tuple.operation || !tuple.profile || !tuple.variant || typeof tuple.normalizerId !== "string" || !tuple.normalizerId ||
    [tuple.schemaVersion, tuple.normalizerVersion, tuple.maximumSchemaBytes, tuple.maximumResponseBytes].some(entry => !Number.isSafeInteger(entry) || (entry ?? 0) < 1) ||
    !Number.isSafeInteger(tuple.generation) || (tuple.generation ?? -1) < 0 ||
    (tuple.maximumPageBytes !== null && (!Number.isSafeInteger(tuple.maximumPageBytes) || (tuple.maximumPageBytes ?? 0) < 1)) ||
    [tuple.schemaDigest, tuple.descriptorDigest, tuple.wireSchemaDigest, tuple.guidanceDigest, tuple.instructionDigest, tuple.actionId, tuple.dispatchId, tuple.digest].some(entry => typeof entry !== "string" || !entry)) throw new Error("Selected dispatch tuple has invalid fields");
  return Object.freeze({ ...tuple } as SelectedDispatchTupleV2);
}

export function verifyStructuredReceiptTuple<T>(contract: OutputContract<T>, candidate: StructuredCandidate, descriptor: ProviderWireContract<T>, value: SelectedDispatchTupleV2): void {
  const tuple = parseSelectedDispatchTupleV2(value);
  const { digest, ...canonicalTuple } = tuple;
  if (digest !== structuredDigest(canonicalTuple)) throw new Error("Selected dispatch tuple digest mismatch");
  if (tuple.operation !== contract.operation || tuple.schemaVersion !== contract.schemaVersion || tuple.schemaDigest !== contract.schemaDigest ||
    tuple.provider !== descriptor.provider || tuple.profile !== descriptor.profile || tuple.variant !== descriptor.variant ||
    tuple.descriptorDigest !== descriptor.descriptorDigest || tuple.wireSchemaDigest !== descriptor.wireSchemaDigest ||
    tuple.guidanceDigest !== descriptor.guidanceDigest || tuple.normalizerId !== descriptor.normalizerId ||
    tuple.normalizerVersion !== descriptor.normalizerVersion || tuple.maximumSchemaBytes !== descriptor.maximumSchemaBytes ||
    tuple.maximumResponseBytes !== descriptor.maximumResponseBytes || tuple.maximumPageBytes !== (descriptor.maximumPageBytes ?? null) ||
    tuple.dispatchId !== candidate.dispatchId || tuple.sessionId !== candidate.sessionId ||
    candidate.selectedDispatchDigest !== tuple.digest) throw new Error("Structured result does not match selected dispatch tuple v2");
}

export function validateStructuredCandidate<T>(contract: OutputContract<T>, candidate: StructuredResponse | undefined, selected: ProviderWireContract<T>, tuple: SelectedDispatchTupleV2): T {
  if (!candidate || candidate.state !== "candidate") throw new Error(`No completed structured result: ${candidate?.detail ?? "missing receipt"}`);
  if (candidate.protocolVersion !== 2 || candidate.terminal !== "completed" || !candidate.dispatchId || !candidate.sessionId || !candidate.nativeTurnId ||
    candidate.operation !== contract.operation || candidate.schemaVersion !== contract.schemaVersion || candidate.schemaDigest !== contract.schemaDigest) throw new Error("Structured result contract or receipt mismatch");
  const descriptor = selected;
  if (candidate.profile !== descriptor.profile || candidate.wireSchemaDigest !== descriptor.wireSchemaDigest ||
    candidate.wireContractDigest !== descriptor.descriptorDigest ||
    candidate.wireVariant !== descriptor.variant) throw new Error("Structured result wire profile mismatch");
  verifyStructuredReceiptTuple(contract, candidate, descriptor, tuple);
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
