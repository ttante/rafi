/**
 * Compiler-API baseline for the v2 cutover. This intentionally inventories
 * calls and enforces resolution.  A syntactic match is never enough to bless
 * an authority path: if TypeScript cannot resolve an authority-shaped call,
 * the inventory fails closed.  This deliberately makes a new wrapper or a
 * dynamic property access a release-gate event instead of an invisible gap.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "../..");
export const SOURCE_ROOTS = ["packages/ai-foreman/src", "packages/rafi/src", "packages/spec/src", "scripts"];
const trackedCalls = new Map<string, string>([
  ["sendTurn", "structured-dispatch"],
  ["outputContract", "contract-construction"], ["jsonOutputContract", "contract-construction"],
  ["operationContract", "contract-construction"], ["operationJsonContract", "contract-construction"],
  ["withTicketPopulationPage", "page-owner-capability"], ["sealTicketPopulationPage", "page-sealing"],
  ["assertTicketPopulationPageBinding", "page-owner-verification"],
  ["qaHostTransformation", "qa-host-transformation"], ["verifyQaHostTransformation", "qa-transformation-replay"],
  ["spawn", "process-launch"], ["execFile", "process-launch"], ["execFileSync", "process-launch"],
  ["dispatch", "adapter-gateway"],
  ["structuredReceipt", "receipt-construction"],
  ["validateStructuredCandidate", "candidate-validation"],
  ["operationResponse", "response-consumer"],
  ["operationPayload", "payload-consumer"],
  ["providerWireContract", "descriptor-selection"],
  ["historicProviderWireContract", "historic-descriptor-selection"],
  ["persistedProviderWireContract", "historic-descriptor-selection"],
  ["retainedStructuredTurn", "stored-authority-consumer"],
  ["reserveQuery", "live-budget-reservation"],
  ["reserveStructuredLiveQuery", "live-budget-reservation"], ["updateStructuredLiveBudget", "live-budget-ledger"],
  ["inheritedStructuredLiveBudget", "live-child-supervision"], ["trackStructuredLiveChild", "live-child-cleanup"],
  ["runSupervisedStructuredLive", "live-supervision"],
  ["selectedDispatchTupleV2", "tuple-construction"],
  ["parseSelectedDispatchTupleV2", "tuple-parsing"],
  ["verifyStructuredReceiptTuple", "receipt-tuple-verification"],
  ["prepareSession", "session-preparation"],
  ["providerControlOperationV2", "provider-control"],
  ["installStaticProviderWireContracts", "registry-installation"],
  ["createProviderWireContract", "descriptor-construction"],
  ["registerStandardProviderWireContracts", "runtime-registration"],
  ["registerProviderWireContract", "runtime-registration"],
  ["journalStructuredDispatch", "durable-gateway"],
  ["withSealedDispatch", "dispatch-capability"],
  ["assertActiveProviderDispatch", "submission-consumption"],
  ["sealedDispatchRecord", "tuple-persistence"],
  ["verifyPersistedDispatch", "stored-authority-verification"],
  ["replayStructuredDispatch", "stored-authority-consumer"],
  ["commitQaTurnIntent", "qa-review-intent"],
  ["commitQaRemediationIntent", "qa-remediation-intent"],
  ["beginPageLedger", "page-intent"],
  ["appendPageLedger", "page-append"],
  ["assertStructuredCutoverComplete", "cutover-admission"],
  ["parseProtocol", "legacy-parser"],
  ["parseDelimitedJson", "legacy-parser"],
  ["extractJson", "legacy-parser"],
  ...["parseContinuityDelta", "parsePreparationArtifact", "parseGraphRequest", "parseQaResponseContract",
    "parseBuilderQaRemediationContract", "parseQaFailureReport", "parseBuilderQaRemediationReport",
    "parseGrillAuditVerdict", "extractDiscoveryEnvelope", "extractStructuredPlanProposal", "parsePlannerStepStatus",
    "parsePlannerMarkerFields", "parseContractCoverage"].map(name => [name, "legacy-parser"] as [string, string]),
]);

function files(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : files(path);
    return entry.isFile() && /\.(?:[cm]?ts|[cm]?js)$/.test(path) && !/\.test\./.test(path) ? [path] : [];
  });
}

export interface StructuredCommunicationCallsiteV2 {
  readonly kind: string;
  readonly callee: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Fully qualified declaration when TypeScript can resolve the callee. */
  readonly declaration?: string;
  /** Calls that cannot be resolved must be reviewed rather than silently omitted. */
  readonly resolution: "resolved" | "unresolved" | "dynamic";
  readonly owner?: string;
  readonly expressionDigest?: string;
  /** Authority kinds reachable through this resolved wrapper. */
  readonly reaches?: readonly string[];
  readonly operations?: readonly string[];
  readonly control?: { provider: string; command: string };
}

/** The complete scanned production corpus, including files with no recognized authority call. */
export function structuredCommunicationSources(paths = SOURCE_ROOTS.map(path => resolve(ROOT, path))): string[] {
  const roots = [...paths];
  // Opt-in live tests are production entry points when advertised by package scripts.
  if (paths.some(path => resolve(path) === resolve(ROOT, "scripts"))) {
    for (const entry of readdirSync(resolve(ROOT, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = resolve(ROOT, "packages", entry.name);
      const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
      for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
        if (!/live|canary/i.test(name) || typeof command !== "string") continue;
        for (const match of command.matchAll(/\b(?:test|scripts)\/[\w/.-]+\.(?:[cm]?ts|[cm]?js)\b/g)) roots.push(resolve(packageRoot, match[0]));
      }
    }
  }
  return [...new Set(roots.flatMap(files))].sort();
}

export function collectStructuredCommunicationCallsites(paths = SOURCE_ROOTS.map(path => resolve(ROOT, path))): StructuredCommunicationCallsiteV2[] {
  const configPath = resolve(ROOT, "tsconfig.base.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, undefined, configPath);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  const roots = structuredCommunicationSources(paths);
  // Resolve workspace imports to their source declarations, never possibly stale dist.
  const program = ts.createProgram({ rootNames: roots, options: { ...parsed.options, noEmit: true,
    allowJs: true, baseUrl: ROOT, paths: { "rafi-spec": ["packages/spec/src/index.ts"],
      "ai-foreman": ["packages/ai-foreman/src/index.ts"], "special-agents": ["packages/special-agents/src/index.ts"] } } });
  const checker = program.getTypeChecker();
  const output: StructuredCommunicationCallsiteV2[] = [];
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const targetSymbol = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Symbol | undefined => {
    if (ts.isPropertyAccessExpression(expression) && (expression.name.text === "call" || expression.name.text === "apply"))
      return targetSymbol(expression.expression, seen);
    const at = ts.isPropertyAccessExpression(expression) ? expression.name
      : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression : expression;
    const symbol = symbolAt(at);
    if (!symbol || seen.has(symbol)) return symbol;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer) &&
        ts.isPropertyAccessExpression(declaration.initializer.expression) && declaration.initializer.expression.name.text === "bind") {
        return targetSymbol(declaration.initializer.expression.expression, seen) ?? symbol;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer &&
        (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer) || ts.isElementAccessExpression(declaration.initializer))) {
        return targetSymbol(declaration.initializer, seen) ?? symbol;
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const container = declaration.parent.parent;
        if (ts.isVariableDeclaration(container) && container.initializer) {
          const property = checker.getTypeAtLocation(container.initializer).getProperty((declaration.propertyName ?? declaration.name).getText());
          if (property) return property;
        }
      }
    }
    return symbol;
  };
  const enclosingOwner = (node: ts.Node): ts.Node | undefined => {
    for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current) && !ts.isCallSignatureDeclaration(current)) return current;
    return undefined;
  };
  const ownerName = (node: ts.Node | undefined): string => {
    if (!node) return "<module>";
    const named = node as ts.NamedDeclaration;
    if (named.name) return named.name.getText();
    return ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : "<callback>";
  };
  const isTuple = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    const type = checker.getTypeAtLocation(node);
    return Boolean(type.getProperty("descriptorDigest") && type.getProperty("instructionDigest") && type.getProperty("dispatchId"));
  };
  const calls: { node: ts.CallExpression; source: ts.SourceFile; symbol?: ts.Symbol; declaration?: ts.Declaration; kind?: string; owner?: ts.Node; dynamic: boolean }[] = [];
  const effects = new Map<ts.Node, Set<string>>();
  const operationNames = (node: ts.Node): string[] => {
    const found = new Set<string>();
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) {
        const type = checker.getTypeAtLocation(child);
        if (type.getProperty("schemaDigest") && type.getProperty("operation") && type.getProperty("jsonSchema")) {
          const symbol = symbolAt(child);
          for (const declaration of symbol?.declarations ?? []) {
            if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)) {
              const operation = declaration.initializer.arguments[0];
              if (operation && ts.isStringLiteralLike(operation)) found.add(operation.text);
            }
          }
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return [...found].sort();
  };
  for (const path of roots) {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`Inventory source was not loaded: ${path}`);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const type = checker.getContextualType(node) ?? checker.getTypeAtLocation(node);
        const text = checker.typeToString(type);
        const kind = /StructuredCandidate|StructuredResponse/.test(text) ? "receipt-object-construction"
          : type.getProperty("descriptorDigest") && type.getProperty("instructionDigest") && type.getProperty("dispatchId") ? "tuple-object-construction" : undefined;
        if (kind) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          output.push({ kind, callee: text, file: relative(ROOT, path), line: position.line + 1,
            column: position.character + 1, owner: ownerName(enclosingOwner(node)),
            expressionDigest: createHash("sha256").update(node.getText(source)).digest("hex"), resolution: "resolved" });
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const operations = operationNames(node.initializer);
        if (operations.length) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          output.push({ kind: "contract-selection", callee: node.name.getText(source), file: relative(ROOT, path),
            line: position.line + 1, column: position.character + 1, owner: ownerName(enclosingOwner(node)),
            expressionDigest: createHash("sha256").update(node.initializer.getText(source)).digest("hex"), resolution: "resolved", operations });
        }
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const symbol = targetSymbol(expression);
        const declaration = checker.getResolvedSignature(node)?.declaration ?? symbol?.declarations?.[0];
        const name = symbol?.getName() ?? (ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text :
          ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined);
        const signatureName = declaration && "name" in declaration && declaration.name && ts.isIdentifier(declaration.name as ts.Node)
          ? (declaration.name as ts.Identifier).text : undefined;
        // Readonly TypeScript fields do not prevent reflective writes at runtime.
        const indirect = ts.isPropertyAccessExpression(expression) && ["call", "apply", "bind"].includes(expression.name.text);
        const mutationSymbol = indirect ? targetSymbol(expression.expression) : symbol;
        const builtin = mutationSymbol && checker.getFullyQualifiedName(mutationSymbol);
        let target = node.arguments[indirect ? 1 : 0];
        if (indirect && expression.name.text === "apply" && target && ts.isArrayLiteralExpression(target)) target = target.elements[0] as ts.Expression;
        const mutatesTuple = builtin && /(?:ObjectConstructor\.(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\.(?:set|deleteProperty|defineProperty|setPrototypeOf))$/.test(builtin) && isTuple(target);
        const kind = mutatesTuple ? "tuple-mutation" : name && trackedCalls.get(name) || signatureName && trackedCalls.get(signatureName);
        const dynamic = ts.isElementAccessExpression(expression) && !ts.isStringLiteralLike(expression.argumentExpression);
        const owner = enclosingOwner(node);
        calls.push({ node, source, symbol, declaration, kind: kind || undefined, owner, dynamic });
        if (owner && kind) {
          const values = effects.get(owner) ?? new Set<string>(); values.add(kind); effects.set(owner, values);
        }
      }
      if (ts.isDeleteExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) && isTuple(node.expression.expression)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        output.push({ kind: "tuple-mutation", callee: node.expression.getText(source), file: relative(ROOT, path),
          line: position.line + 1, column: position.character + 1, owner: ownerName(enclosingOwner(node)), resolution: "resolved" });
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ||
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        const left = ts.isBinaryExpression(node) ? node.left : (node as ts.PrefixUnaryExpression).operand;
        if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          const type = checker.getTypeAtLocation(left.expression);
          if (type.getProperty("descriptorDigest") && type.getProperty("instructionDigest") && type.getProperty("dispatchId")) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            output.push({ kind: "tuple-mutation", callee: left.getText(source), file: relative(ROOT, path), line: position.line + 1,
              column: position.character + 1, owner: ownerName(enclosingOwner(node)), resolution: "resolved" });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // Fixed-point propagation follows resolved wrapper declarations, not wrapper spelling.
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const inherited = call.declaration && effects.get(call.declaration);
      if (!call.owner || !inherited) continue;
      const values = effects.get(call.owner) ?? new Set<string>();
      for (const value of inherited) if (!values.has(value)) { values.add(value); changed = true; }
      effects.set(call.owner, values);
    }
  }
  for (const { node, source, symbol, declaration, kind, owner, dynamic } of calls) {
    const reaches = declaration && effects.get(declaration);
    if (!kind && !dynamic && !reaches?.size) continue;
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    output.push({ kind: dynamic ? "dynamic-authority-call" : kind ?? "authority-wrapper", callee: symbol?.getName() ?? node.expression.getText(source),
      file: relative(ROOT, source.fileName), line: position.line + 1, column: position.character + 1,
      owner: ownerName(owner), expressionDigest: createHash("sha256").update(node.getText(source)).digest("hex"),
      resolution: dynamic ? "dynamic" : declaration ? "resolved" : "unresolved",
      ...(declaration ? { declaration: relative(ROOT, declaration.getSourceFile().fileName) } : {}),
      ...(reaches?.size ? { reaches: [...reaches].sort() } : {}), operations: operationNames(node),
      ...(kind === "provider-control" && node.arguments[0] && node.arguments[1] && ts.isStringLiteralLike(node.arguments[0]) && ts.isStringLiteralLike(node.arguments[1])
        ? { control: { provider: node.arguments[0].text, command: node.arguments[1].text } } : {}) });
  }
  return output.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column);
}

/** Fail closed for unresolved names and dynamic dispatch.  Callers may only
 * exempt a site by adding a typed, reviewed manifest entry, never by ignoring
 * it in a hand-maintained allowlist. */
export function assertStructuredCommunicationInventory(callsites = collectStructuredCommunicationCallsites()): void {
  const historicalParserBoundaries = new Set(["packages/spec/src/legacyQaDisplay.ts"]);
  const unsafe = callsites.filter(site => site.resolution !== "resolved" || site.kind === "tuple-mutation" || site.kind === "runtime-registration" ||
    site.kind === "legacy-parser" && !historicalParserBoundaries.has(site.file));
  if (unsafe.length) {
    throw new Error(`Unresolved structured authority callsites: ${unsafe.map(site => `${site.file}:${site.line}:${site.column} (${site.kind})`).join(", ")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const callsites = collectStructuredCommunicationCallsites();
  assertStructuredCommunicationInventory(callsites);
  console.log(JSON.stringify({ version: 2, generatedFrom: SOURCE_ROOTS, callsites }, null, 2));
}
