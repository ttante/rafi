export { graphSemanticHost } from "./host.js";
import { capturePreimage, finalizeOwnedWrite, registerOwnedFile, readInstallManifest } from "../installOwnership.js";
import { graphStorageBytes } from "./lifecycle.js";
import { ownedGraphPython } from "./install.js";
export { ensureGraphInstallation } from "./install.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse, stringify, parseDocument } from "yaml";
import { loadSourceRegistry } from "../sources/sourceRegistry.js";
import { assertGraphConfig, DEFAULT_GRAPH_CONFIG, GRAPHIFY_VERSION, type GraphAdoptionV1, type GraphConfigV1, type GraphGenerationV1 } from "rafi-spec";
import { WorkflowDb } from "../workflowDb.js";
import { loadGraphConfig } from "./config.js";
import { captureGraphCorpus, type CapturedGraphCorpus } from "./corpus.js";
import { resolveGraphPython, runBridge } from "./bridge.js";
import { graphScope } from "./read.js";
import { bytesDigest, canonical, digest, readBounded, confined } from "./util.js";
export interface SemanticChunk {
  path: string;
  digest: string;
  text: string;
}
export interface SemanticExtraction {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  origin: {
    provider: string;
    model?: string;
    operationId: string;
  };
  inputTokens?: number;
  outputTokens?: number;
}
export type GraphSemanticHost = (chunks: SemanticChunk[], operationId: string, budget?: { deadline: number; signal?: AbortSignal }) => Promise<SemanticExtraction>;
export interface GraphMaintenanceOutcome {
  operationId: string;
  state: "published" | "failed" | "deferred";
  generationId?: string;
  reason?: string;
}
/** Called only by an accepted setup or explicit adoption, never by a read/factory. */
export function adoptGraph(configRoot: string, input: {
  config?: GraphConfigV1;
  authorization: "setup" | "explicit";
}): GraphAdoptionV1 {
  const existing = loadGraphConfig(configRoot);
  const config: GraphConfigV1 = structuredClone(input.config ?? existing.config ?? DEFAULT_GRAPH_CONFIG);
  config.enabled = true;
  if (config.sourceSelection === "active-captured") {
    config.sourceVersions = { ...(existing.config?.sourceSelection === "active-captured" ? existing.config.sourceVersions : {}), ...config.sourceVersions };
    const registry = loadSourceRegistry(configRoot).registry;
    config.sourceIds = registry.entries.filter(entry => entry.active && entry.versions.length).map(entry => entry.id).sort();
    config.sourceVersions = Object.fromEntries(config.sourceIds.flatMap(id => config.sourceVersions?.[id] ? [[id, config.sourceVersions[id]]] : []));
  }
  if (config.sourceIds.length) {
    const registry = loadSourceRegistry(configRoot).registry;
    config.sourceVersions = { ...config.sourceVersions };
    for (const id of config.sourceIds) {
      const entry = registry.entries.find(e => e.id === id && e.active);
      const version = config.sourceVersions[id] ?? entry?.versions.at(-1)?.fingerprint;
      if (!version || !entry?.versions.some(v => v.fingerprint === version))
        throw new Error(`Registered source ${id} requires an approved captured version`);
      config.sourceVersions[id] = version;
    }
  }
  assertGraphConfig(config);
  if (existing.enabled && existing.policyDigest === digest("policy", config) && existing.adoption)
    return existing.adoption;
  const adoption: GraphAdoptionV1 = { version: 1, projectRef: existing.projectRef, config, policyDigest: digest("policy", config), acceptedAt: new Date().toISOString(), authorization: input.authorization, initialOperationId: randomUUID() };
  // Update only the graph setting; preserve other project fields and user files.
  const configFile = ["rafi-config.yaml", "project.yaml"].map(name => join(configRoot, name)).find(existsSync);
  if (configFile) {
    const ownedConfig = capturePreimage(configRoot, relative(configRoot, configFile), "graph-adoption", "config");
    const raw = parseDocument(readFileSync(configFile, "utf8"));
    if (!raw || typeof raw !== "object")
      throw new Error("Invalid project configuration");
    raw.set("graph", config);
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, raw.toString());
    renameSync(temporary, configFile);
    finalizeOwnedWrite(configRoot, ownedConfig);
  }
  const db = new WorkflowDb(configRoot);
  try {
    db.graphStore().put("adoption", "project", adoption);
  }
  finally {
    db.close();
  }
  const ignore = join(configRoot, ".gitignore");
  const prior = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!prior.split(/\r?\n/).includes("/graphify-out/")) {
    const recorded = readInstallManifest(configRoot)?.files.find(entry => entry.path === ".gitignore");
    const ownedIgnore = capturePreimage(configRoot, ".gitignore", "graph-adoption", "managed-gitignore");
    const [start, end] = recorded?.marker?.split("..") ?? [];
    if (recorded?.mode === "managed-block" && start && end && prior.includes(start) && prior.includes(end)) {
      // Ownership has one entry per path: extend its existing managed block.
      writeFileSync(ignore, prior.replace(end, `/graphify-out/\n${end}`));
      finalizeOwnedWrite(configRoot, recorded);
    } else {
      writeFileSync(ignore, `${prior}${prior && !prior.endsWith("\n") ? "\n" : ""}# rafi-graph:start\n/graphify-out/\n# rafi-graph:end\n`);
      finalizeOwnedWrite(configRoot, ownedIgnore.mode === "created" || ownedIgnore.mode === "generated" ? ownedIgnore : { ...ownedIgnore, mode: "managed-block", marker: "# rafi-graph:start..# rafi-graph:end" });
    }
  }
  const ownedRoot = join(configRoot, "graphify-out", "rafi");
  if (!existsSync(ownedRoot)) {
    mkdirSync(ownedRoot, { recursive: true });
    registerOwnedFile(configRoot, "graphify-out/rafi", { mode: "generated", origin: "graph-adoption", category: "runtime-state" });
  }
  return adoption;
}
export function disableGraph(configRoot: string): void {
  const effective = loadGraphConfig(configRoot);
  if (!effective.config || !effective.adoption)
    return;
  const config = { ...effective.config, enabled: false };
  const configFile = ["rafi-config.yaml", "project.yaml"].map(name => join(configRoot, name)).find(existsSync);
  if (configFile) {
    const raw = parseDocument(readFileSync(configFile, "utf8"));
    raw.set("graph", config);
    const temp = `${configFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, raw.toString());
    renameSync(temp, configFile);
  }
  const db = new WorkflowDb(configRoot);
  try {
    db.graphStore().put("adoption", "project", { ...effective.adoption, config, policyDigest: digest("policy", config) });
  }
  finally {
    db.close();
  }
}
function validateSemantics(result: SemanticExtraction, corpus: CapturedGraphCorpus, expected: SemanticChunk[]): void {
  if (Buffer.byteLength(canonical(result)) > 120000) throw new Error("Semantic output budget exceeded");
  if (!Array.isArray(result.nodes) || !Array.isArray(result.edges) || !result.origin?.operationId || !result.origin.provider)
    throw new Error("Invalid semantic extraction protocol");
  const files = new Set(expected.map(x => x.path));
  const ids = new Set<string>();
  for (const node of result.nodes) {
    if (typeof node.id !== "string" || ids.has(node.id) || typeof node.source_file !== "string" || !files.has(node.source_file) || !corpus.bytes.has(node.source_file))
      throw new Error("Semantic node has invalid identity/provenance");
    ids.add(node.id);
  }
  for (const edge of result.edges)
    if (typeof edge.source_file !== "string" || !files.has(edge.source_file) || !ids.has(String(edge.source)) || !ids.has(String(edge.target)) || !["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(String(edge.confidence)))
      throw new Error("Semantic edge has invalid endpoint/evidence class");
  for (const file of files)
    if (!result.nodes.some(n => n.source_file === file))
      throw new Error(`Semantic extraction omitted ${file}; input remains unstamped`);
}
/** Foreground, fenced publication. Semantic failure never replaces a mixed graph. */
export async function refreshGraph(configRoot: string, workspace: string, logicalTaskId: string, options: {
  semanticHost?: GraphSemanticHost;
  sourceRef?: string;
  python?: string;
  signal?: AbortSignal;
} = {}): Promise<GraphMaintenanceOutcome> {
  const effective = loadGraphConfig(configRoot);
  if (!effective.enabled)
    throw new Error(`Graph ${effective.reason}; explicit adoption required`);
  const scope = graphScope(workspace), operationId = digest("maintenance", { scope, logicalTaskId, policy: effective.policyDigest });
  const db = new WorkflowDb(configRoot), store = db.graphStore();
  const previous = store.get<GraphMaintenanceOutcome>("job", operationId);
  if (previous?.value.state === "published") {
    db.close();
    return previous.value;
  }
  const owner = operationId;
  let fence: number;
  try {
    fence = store.lease(scope, owner, Date.now(), effective.limits.maintenanceMs);
  }
  catch (error) {
    db.close();
    return { operationId, state: "deferred", reason: String(error) };
  }
  const stage = join(configRoot, "graphify-out", "rafi", "staging", `${operationId}-${fence}`);
  const started = Date.now();
  const check = (): void => {
    if (options.signal?.aborted)
      throw new Error("Graph maintenance cancelled"); if (Date.now() - started > effective.limits.maintenanceMs)
      throw new Error("Graph maintenance deadline exceeded"); if (!store.ownsLease(scope, owner, fence, Date.now()))
      throw new Error("Graph maintenance lease lost");
  };
  try {
    const prior = store.get<{
      generationId: string;
    }>("head", scope);
    store.put("job", operationId, { version: 1, operationId, state: "capturing", scope, fence, startedAt: new Date().toISOString() });
    const corpus = captureGraphCorpus(workspace, configRoot, effective, options.sourceRef);
    check();
    const parent = prior ? store.get<GraphGenerationV1>("generation", prior.value.generationId)?.value : undefined;
    if (parent) {
      const { id, ...metadata } = parent;
      if (!/^[a-f0-9]{64}$/.test(id) || digest("generation", metadata) !== id)
        throw new Error("Parent generation metadata checksum mismatch");
    }
    let reusable: SemanticExtraction | undefined;
    if (parent?.policyDigest === effective.policyDigest) {
      try {
        const bytes = readBounded(confined(configRoot, `graphify-out/rafi/generations/${parent.id}/semantic.json`), effective.limits.maxGraphBytes);
        if (parent.files["semantic.json"] !== bytesDigest(bytes)) throw new Error("Semantic cache checksum mismatch");
        reusable = JSON.parse(bytes.toString("utf8"));
      }
      catch { /* Unknown legacy semantic provenance is never silently reused. */ }
    }
    const unchanged = new Set(corpus.inputs.filter(i => i.kind === "semantic" && parent?.inputs.some(p => p.path === i.path && p.digest === i.digest)).map(i => i.path));
    const preservedNodes = reusable?.nodes.filter(n => unchanged.has(String(n.source_file))) ?? [];
    const preservedIds = new Set(preservedNodes.map(n => String(n.id)));
    const preservedEdges = reusable?.edges.filter(e => preservedIds.has(String(e.source)) && preservedIds.has(String(e.target)) && unchanged.has(String(e.source_file))) ?? [];
    const semanticInputs = effective.config!.mode === "mixed" ? corpus.inputs.filter(i => i.kind === "semantic" && (!unchanged.has(i.path) || !preservedNodes.some(n => n.source_file === i.path))) : [];
    if (semanticInputs.length > effective.limits.semanticInputs)
      throw new Error("scope-decision-required: semantic input budget exceeded");
    if (semanticInputs.length && !options.semanticHost)
      throw new Error("semantic-runtime-unavailable: mixed extraction needs an authorized host exchange");
    store.reserveStorage(`${operationId}:${fence}`, corpus.inputs.reduce((n, i) => n + i.bytes, 0) + effective.limits.maxGraphBytes * 4, graphStorageBytes(configRoot), effective.limits.storageBytes, { scope, owner, fence });
    mkdirSync(join(stage, "input"), { recursive: true });
    confined(configRoot, `graphify-out/rafi/staging/${operationId}-${fence}`);
    for (const input of corpus.inputs) {
      const path = join(stage, "input", input.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, corpus.bytes.get(input.path)!, { mode: 0o444 });
    }
    let semantic: SemanticExtraction | undefined;
    if (semanticInputs.length) {
      const chunks = semanticInputs.map(i => ({ path: i.path, digest: i.digest, text: corpus.bytes.get(i.path)!.toString("utf8") }));
      if (chunks.reduce((n, c) => n + c.text.length, 0) > 750000)
        throw new Error("Semantic input budget exceeded; choose an explicit larger scoped policy");
      semantic = await options.semanticHost!(chunks, operationId, { deadline: started + effective.limits.maintenanceMs, signal: options.signal });
      validateSemantics(semantic, corpus, chunks);
    }
    if (preservedNodes.length) {
      semantic = { nodes: [...preservedNodes, ...(semantic?.nodes ?? [])], edges: [...preservedEdges, ...(semantic?.edges ?? [])], origin: semantic?.origin ?? reusable!.origin, inputTokens: semantic?.inputTokens, outputTokens: semantic?.outputTokens };
    }
    check();
    const python = options.python ?? (existsSync(ownedGraphPython(configRoot)) ? ownedGraphPython(configRoot) : await resolveGraphPython());
    store.put("capability", "machine", { version: 1, python, packageVersion: GRAPHIFY_VERSION, checkedAt: new Date().toISOString(), scope: "local-machine; not portable" });
    store.put("job", operationId, { version: 1, operationId, state: "extracting", scope, fence });
    const extracted = await runBridge<{
      graph: Record<string, unknown>;
      extraction: Record<string, unknown>;
      cacheFiles: Record<string, string>;
      reusedAstInputs: number;
    }>(python, { action: "extract", staging: stage, ...(parent?.policyDigest === effective.policyDigest ? { parentCache: confined(configRoot, `graphify-out/rafi/generations/${parent.id}`), cacheChecksums: parent.files } : {}), paths: corpus.inputs.filter(i => i.kind === "code").map(i => i.path), semantic: semantic ?? { nodes: [], edges: [] } }, { timeoutMs: Math.max(1, effective.limits.maintenanceMs - (Date.now() - started)), maxOutputBytes: effective.limits.maxGraphBytes, cwd: stage, signal: options.signal });
    check();
    if (Array.isArray(extracted.extraction.failed_sources) && extracted.extraction.failed_sources.length)
      throw new Error(`AST extraction failed for ${extracted.extraction.failed_sources.length} inputs; prior generation retained`);
    if (parent?.policyDigest === effective.policyDigest) {
      try {
        const parentBytes = readBounded(confined(configRoot, `graphify-out/rafi/generations/${parent.id}/graph.json`), effective.limits.maxGraphBytes);
        if (bytesDigest(parentBytes) !== parent.graphDigest) throw new Error("Parent graph checksum mismatch");
        const old = JSON.parse(parentBytes.toString("utf8")) as {
          links?: Array<Record<string, unknown>>;
          edges?: Array<Record<string, unknown>>;
          nodes: Array<{
            id: string;
            source_file?: string;
          }>;
        };
        const stable = new Set(corpus.inputs.filter(i => parent.inputs.some(p => p.path === i.path && p.digest === i.digest)).map(i => i.path));
        const nextIds = new Set((extracted.graph.nodes as Array<{
          id: string;
        }>).map(n => n.id));
        const lost = old.nodes.filter(n => n.source_file && stable.has(n.source_file) && !nextIds.has(n.id));
        if (lost.length)
          throw new Error(`unexplained-shrinkage: ${lost.length} unchanged-input nodes disappeared`);
        const stableIds = new Set(old.nodes.filter(n => n.source_file && stable.has(n.source_file)).map(n => n.id));
        const edgeKey = (edge: Record<string, unknown>): string => canonical({ source: edge.source, target: edge.target, relation: edge.relation, source_file: edge.source_file });
        const nextEdges = new Set(((extracted.graph.links ?? extracted.graph.edges ?? []) as Array<Record<string, unknown>>).map(edgeKey));
        const lostEdges = (old.links ?? old.edges ?? []).filter(edge => stableIds.has(String(edge.source)) && stableIds.has(String(edge.target))
          && typeof edge.source_file === "string" && stable.has(edge.source_file) && !nextEdges.has(edgeKey(edge)));
        if (lostEdges.length) throw new Error(`unexplained-shrinkage: ${lostEdges.length} unchanged-input relationships disappeared`);
      }
      catch (error) {
        if (String(error).includes("unexplained-shrinkage"))
          throw error;
        throw new Error(`Parent graph validation unavailable: ${String(error)}`);
      }
    }
    const graphBytes = Buffer.from(canonical(extracted.graph));
    const limitations = effective.config!.mode === "code-only" && corpus.inputs.some(i => i.kind === "semantic") ? [{ reason: "code-only", detail: "Documentation and requirement semantics were deliberately not extracted" }] : [];
    const sidecars: Record<string, string> = { "extraction.json": canonical(extracted.extraction), ...(semantic ? { "semantic.json": canonical(semantic), "semantic-origin.json": canonical(semantic.origin) } : {}) };
    const sidecarDigests: Record<string, string> = {};
    for (const [name, text] of Object.entries(sidecars)) {
      writeFileSync(join(stage, name), text);
      sidecarDigests[name] = bytesDigest(text);
    }
    sidecarDigests["graph.html"] = bytesDigest(readBounded(join(stage, "graph.html"), effective.limits.maxGraphBytes * 2));
    const metadata = { version: 1 as const, corpusDigest: corpus.corpusDigest, policyDigest: effective.policyDigest, graphDigest: bytesDigest(graphBytes), binding: corpus.binding, inputs: corpus.inputs, createdAt: new Date().toISOString(), operationId, packageVersion: GRAPHIFY_VERSION, graphSchema: 1, parent: prior?.value.generationId, limitations, files: { ...extracted.cacheFiles, ...sidecarDigests, "exclusions-digest": corpus.exclusionsDigest } };
    const generation: GraphGenerationV1 = { ...metadata, id: digest("generation", metadata) };
    writeFileSync(join(stage, "graph.json"), graphBytes);
    writeFileSync(join(stage, "manifest.json"), canonical(generation));
    const report = `# Rafi Graphify generation\n\nGeneration: ${generation.id}\nCorpus: ${corpus.corpusDigest}\nInputs: ${corpus.inputs.length}\nReused AST inputs: ${extracted.reusedAstInputs}\nGraphify: ${GRAPHIFY_VERSION}\n\nUsage: ${semantic?.inputTokens ?? "unknown"} input tokens; ${semantic?.outputTokens ?? "unknown"} output tokens.\n\nGraph evidence requires independent source verification.\n${limitations.map(l => l.detail).join("\n")}\n`;
    writeFileSync(join(stage, "GRAPH_REPORT.md"), report);
    if (!existsSync(join(stage, "graph.html")))
      throw new Error("Required graph visualization missing");
    const current = loadGraphConfig(configRoot);
    if (!current.enabled || current.policyDigest !== effective.policyDigest)
      throw new Error("Graph policy revoked during extraction");
    if (captureGraphCorpus(workspace, configRoot, current, options.sourceRef).corpusDigest !== corpus.corpusDigest)
      throw new Error("Source drift during extraction; publication deferred");
    check();
    rmSync(join(stage, "input"), { recursive: true, force: true });
    const directory = join(configRoot, "graphify-out", "rafi", "generations", generation.id);
    mkdirSync(dirname(directory), { recursive: true });
    for (const name of ["graph.json", "manifest.json", "extraction.json", "GRAPH_REPORT.md", "graph.html", ...(semantic ? ["semantic.json", "semantic-origin.json"] : []), ...Object.keys(extracted.cacheFiles)]) {
      const fd = openSync(join(stage, name), "r");
      try {
        fsyncSync(fd);
      }
      finally {
        closeSync(fd);
      }
    }
    renameSync(stage, directory);
    if (process.platform !== "win32") {
      const fd = openSync(dirname(directory), "r");
      try {
        fsyncSync(fd);
      }
      finally {
        closeSync(fd);
      }
    }
    const outcome: GraphMaintenanceOutcome = { operationId, state: "published", generationId: generation.id };
    store.publish(scope, owner, fence, Date.now(), prior?.revision ?? 0, generation, outcome);
    return outcome;
  }
  catch (error) {
    const outcome: GraphMaintenanceOutcome = { operationId, state: "failed", reason: String(error) };
    if (store.ownsLease(scope, owner, fence, Date.now()))
      store.put("job", operationId, outcome);
    return outcome;
  }
  finally {
    store.remove("storage-reservation", `${operationId}:${fence}`);
    store.release(scope, owner, fence);
    db.close();
  }
}
export { loadGraphConfig } from "./config.js";
