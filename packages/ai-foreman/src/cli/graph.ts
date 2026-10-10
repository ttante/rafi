import { pruneGraph } from "../graph/lifecycle.js";
import { fileSemanticHost } from "../graph/semantic.js";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertGraphConfig, assertGraphReadRequest, DEFAULT_GRAPH_CONFIG, type GraphConfigV1, type GraphReadOperationV1 } from "rafi-spec";
import { loadGraphConfig } from "../graph/config.js";
import { adoptGraph, disableGraph, refreshGraph, ensureGraphInstallation } from "../graph/maintenance.js";
import { acquireGraphView, graphStatus, readGraph } from "../graph/read.js";
import { captureGraphCorpus } from "../graph/corpus.js";
export function buildGraphCommand(): Command {
  const command = new Command("graph").description("Adopt and inspect scoped local Graphify evidence. Reads never install or refresh.");
  command.command("status").argument("[project]", "project configuration root", ".").option("--json", "emit structured status").action((project: string) => {
    const result = graphStatus(resolve(project));
    console.log(JSON.stringify(result, null, 2));
  });
  command.command("adopt").argument("[project]", "project configuration root", ".").option("--yes", "accept the displayed scope and selective maintenance policy").option("--config <file>", "complete graph policy JSON").option("--code-only", "explicitly omit semantic extraction").action(async (project: string, opts: {
    yes?: boolean;
    config?: string;
    codeOnly?: boolean;
  }) => {
    const root = resolve(project);
    const config: GraphConfigV1 = opts.config ? JSON.parse(readFileSync(resolve(opts.config), "utf8")) : structuredClone(DEFAULT_GRAPH_CONFIG);
    if (opts.codeOnly)
      config.mode = "code-only";
    assertGraphConfig(config);
    console.log(`Graphify adoption policy:\n${JSON.stringify(config, null, 2)}\nReuses a compatible installation or installs pinned Graphify in a Rafi-owned isolated environment. Initial extraction and selective maintenance are authorized by acceptance.`);
    if (!opts.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("Adoption requires --yes and a complete policy in noninteractive mode");
      const { confirm, isCancel } = await import("@clack/prompts");
      const accepted = await confirm({ message: "Accept this Graphify scope and policy?", initialValue: true });
      if (isCancel(accepted) || !accepted)
        return;
    }
    const adoption = adoptGraph(root, { config, authorization: "explicit" });
    const python = await ensureGraphInstallation(root);
    const result = await refreshGraph(root, root, adoption.initialOperationId, { python });
    console.log(JSON.stringify(result, null, 2));
    if (result.state !== "published")
      throw new Error(result.reason ?? "Initial graph unavailable");
  });
  command.command("refresh").argument("[project]", "project configuration root", ".").option("--workspace <path>", "authorized source workspace").option("--task <id>", "stable task id for idempotent retry").option("--semantic-request <file>", "write captured host extraction packet (requires --task)").option("--semantic-result <file>", "consume exact host result (requires --task)").action(async (project: string, opts: {
    workspace?: string;
    task?: string;
    semanticRequest?: string;
    semanticResult?: string;
  }) => {
    if ((opts.semanticRequest || opts.semanticResult) && !opts.task)
      throw new Error("Semantic exchange requires a stable --task ID");
    if (opts.semanticRequest && opts.semanticResult)
      throw new Error("Choose request or result exchange, not both");
    const root = resolve(project), workspace = opts.workspace ? resolve(opts.workspace) : root;
    const result = await refreshGraph(root, workspace, opts.task ?? randomUUID(), { semanticHost: fileSemanticHost({ requestPath: opts.semanticRequest ? resolve(opts.semanticRequest) : undefined, resultPath: opts.semanticResult ? resolve(opts.semanticResult) : undefined }) });
    console.log(JSON.stringify(result, null, 2));
    if (result.state !== "published")
      throw new Error(result.reason ?? "Graph refresh unavailable");
  });
  command.command("prune").argument("[project]", "project configuration root", ".").action((project: string) => console.log(JSON.stringify(pruneGraph(resolve(project)), null, 2)));
  command.command("disable").argument("[project]", "project configuration root", ".").action((project: string) => { disableGraph(resolve(project)); console.log("Graph integration disabled; retained evidence preserved."); });
  command.command("enable").argument("[project]", "project configuration root", ".").action((project: string) => {
    const root = resolve(project), prior = loadGraphConfig(root);
    if (!prior.adoption)
      throw new Error("No prior adoption; use graph adopt");
    adoptGraph(root, { config: { ...prior.adoption.config, enabled: true }, authorization: "explicit" });
    console.log("Graph integration enabled under its accepted policy.");
  });
  for (const operation of ["query", "node", "neighbors", "path", "impact"] as const) {
    command.command(operation).argument("<query>", "query text or node id").argument("[target]", "target node for path").option("--project <path>", "configuration/source project root", ".").option("--json", "structured evidence").option("--direction <direction>", "incoming | outgoing | both", "both").action(async (query: string, target: string | undefined, opts: {
      project: string;
      direction: string;
    }) => {
      const root = resolve(opts.project);
      const op: GraphReadOperationV1 = { operation, ...(operation === "query" ? { query } : { seeds: [query] }), ...(target ? { target } : {}), direction: opts.direction as GraphReadOperationV1["direction"] };
      assertGraphReadRequest({ kind: "rafi_graph_request", version: 1, requestId: "cli", operations: [op] });
      const config = loadGraphConfig(root);
      const corpus = config.enabled ? captureGraphCorpus(root, root, config) : undefined;
      const view = acquireGraphView(root, root, corpus);
      const result = "graph" in view ? await readGraph(view, op) : view;
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "unavailable" || result.status === "invalid-request")
        throw new Error("Graph evidence unavailable; see the structured limitation above");
    });
  }
  return command;
}
