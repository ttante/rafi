// The code rules of REWRITE_ARCHITECTURE.md 2.4, checked with the TypeScript compiler API (plan choices C3, C22).
// Scope: packages/engine/src and packages/rafi/src/next get every rule; packages/scenarios gets the size rules.
// A `// rules-allow: <reason>` comment exempts its line; every exemption is listed. Exit 1 on any problem.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ENGINE = "packages/engine/src/";
const NEXT = "packages/rafi/src/next/";
const SCENARIOS = "packages/scenarios/";
const SOURCE = /\.(ts|mts|cts|mjs|cjs|js)$/;
const SKIP = [/node_modules/, /\/dist\//, /fixtures\/legacy\/F-/, /\.d\.ts$/];
const BANNED_IMPORTS = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises", "node:child_process",
  "child_process", "better-sqlite3"]);
const PATH_NAME = /(dir|path|root|cwd|file|folder)$/i;
const SHELLS = new Set(["bash", "sh", "zsh"]);
const FREEZE = /^(Object\.freeze|deepFreeze)$/;
// ARCH 2.2 module budgets (reported, not enforced).
const BUDGETS = Object.freeze({ log: 900, state: 1300, workflow: 400, build: 2000, turns: 900, facts: 450,
  ask: 1300, progress: 400, plan: 750, api: 600, deps: 650, instructions: 1000, notify: 650, tools: 1100,
  stats: 700, manager: 500, config: 400, agents: 700, "agents/codex": 600, "agents/claude": 600, migrate: 900 });

function scope(file) {
  if (file.startsWith(ENGINE)) return { full: true, real: file.startsWith(`${ENGINE}deps/real/`) };
  if (file.startsWith(NEXT)) return { full: true, real: file === `${NEXT}deps.ts` };
  if (file.startsWith(SCENARIOS)) return { full: false, real: true };
  return null;
}

function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function isMutableInit(node) {
  if (!node) return false;
  if (ts.isAsExpression(node) && node.type.getText() === "const") return false;
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return true;
  if (ts.isNewExpression(node)) return ["Map", "Set", "WeakMap", "Array", "Object"].includes(node.expression.getText());
  return false;
}

function readonlyType(type) {
  if (!type) return false;
  const text = type.getText();
  return /^(Readonly|readonly )/.test(text) || /^ReadonlyArray</.test(text);
}

function moduleState(sf, add) {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const flags = statement.declarationList.flags;
    const isLet = (flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) === 0;
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (isLet) add("module-state", decl, `module-level ${(flags & ts.NodeFlags.Let) ? "let" : "var"}`);
      else if (isMutableInit(init) && !readonlyType(decl.type)) add("module-state", decl, "mutable module-level value");
    }
  }
}

function checkImport(file, spec, isTypeOnly, node, add) {
  const sc = scope(file);
  if (spec === "ai-foreman" || spec.startsWith("ai-foreman/")) add("ai-foreman-import", node, spec);
  if (!sc.real && BANNED_IMPORTS.has(spec)) add("banned-import", node, spec);
  if (file.startsWith(`${ENGINE}state/`) && !isTypeOnly && !spec.startsWith("./")) {
    add("state-imports", node, `state/ imports a value from ${spec}`);
  }
}

function bannedGlobal(node, add) {
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "process") {
    add("banned-global", node, `process.${node.name.getText()}`);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    if (callee === "Date.now" || callee === "setTimeout" || callee === "setInterval") add("banned-global", node, callee);
  }
  if (ts.isNewExpression(node) && node.expression.getText() === "Date" && !(node.arguments?.length)) {
    add("banned-global", node, "new Date()");
  }
}

function pathJoin(node, add) {
  const named = (n) => n && PATH_NAME.test(n.getText().replace(/\(\)$/, "").split(".").at(-1));
  if (ts.isTemplateExpression(node)) {
    node.templateSpans.forEach((span) => {
      if (named(span.expression) && span.literal.text.startsWith("/")) add("hand-joined-path", node, node.getText());
    });
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const slash = (n) => ts.isStringLiteral(n) && (n.text.startsWith("/") || n.text.endsWith("/"));
    if ((named(node.left) && slash(node.right)) || (slash(node.left) && named(node.right))) {
      add("hand-joined-path", node, node.getText());
    }
  }
}

function shellString(node, add) {
  if (ts.isPropertyAssignment(node) && node.name.getText() === "shell" && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
    add("shell-string", node, "shell: true");
  }
  if (ts.isCallExpression(node) && /(spawn|spawnSync|exec|execFile|execFileSync|execSync)$/.test(node.expression.getText())) {
    const first = node.arguments[0];
    if (first && ts.isStringLiteral(first) && SHELLS.has(first.text)) add("shell-string", node, `${first.text} as a command`);
  }
}

function functionLines(sf, node, add) {
  const fn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node);
  if (!fn || !node.body) return;
  const count = lineOf(sf, node.end) - lineOf(sf, node.getStart(sf)) + 1;
  if (count > 100) add("function-lines", node, `${count} lines`);
}

function checkFile(entry) {
  const sc = scope(entry.path);
  if (!sc) return { problems: [], exemptions: [] };
  const sf = ts.createSourceFile(entry.path, entry.text, ts.ScriptTarget.Latest, true);
  const textLines = entry.text.split("\n");
  const problems = [];
  const exemptions = [];
  const allow = (line) => /\/\/ rules-allow: (.+)$/.exec(textLines[line - 1] ?? "")?.[1];
  const add = (rule, node, detail) => {
    const line = typeof node === "number" ? node : lineOf(sf, node.getStart(sf));
    const reason = allow(line);
    if (reason) exemptions.push({ file: entry.path, line, rule, reason });
    else problems.push({ file: entry.path, line, rule, detail });
  };
  if (textLines.length > 500) add("file-lines", 1, `${textLines.length} lines`);
  textLines.forEach((text, i) => { if (text.length > 120) add("line-length", i + 1, `${text.length} characters`); });
  const visitSize = (node) => { functionLines(sf, node, add); ts.forEachChild(node, visitSize); };
  visitSize(sf);
  if (!sc.full) return { problems, exemptions };
  if (entry.path.startsWith(`${ENGINE}log/migrations/`) && /CREATE\s+TRIGGER/i.test(entry.text)) {
    add("migration-trigger", 1, "CREATE TRIGGER in a migration");
  }
  moduleState(sf, add);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      checkImport(entry.path, node.moduleSpecifier.text, Boolean(node.importClause?.isTypeOnly ?? node.isTypeOnly), node, add);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      checkImport(entry.path, node.arguments[0].getText().slice(1, -1), false, node, add);
    }
    if (!sc.real) bannedGlobal(node, add);
    pathJoin(node, add);
    shellString(node, add);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { problems, exemptions };
}

export function checkFiles(entries) {
  const out = { problems: [], exemptions: [] };
  for (const entry of entries) {
    const result = checkFile(entry);
    out.problems.push(...result.problems);
    out.exemptions.push(...result.exemptions);
  }
  return out;
}

function walk(root, rel, found) {
  for (const name of readdirSync(path.join(root, rel))) {
    const child = path.posix.join(rel, name);
    if (SKIP.some((re) => re.test(`/${child}`))) continue;
    if (statSync(path.join(root, child)).isDirectory()) walk(root, child, found);
    else if (SOURCE.test(name)) found.push(child);
  }
}

function budgets(root, files) {
  const totals = {};
  for (const file of files.filter((f) => f.startsWith(ENGINE))) {
    const parts = file.slice(ENGINE.length).split("/");
    const module = parts.length > 2 && parts[0] === "agents" ? `agents/${parts[1]}` : parts.length > 1 ? parts[0] : "(root)";
    totals[module] = (totals[module] ?? 0) + readFileSync(path.join(root, file), "utf8").split("\n").length;
  }
  return Object.entries(totals).map(([m, n]) => `${m} ${n}${BUDGETS[m] ? `/${BUDGETS[m]}` : ""}${n > (BUDGETS[m] ?? Infinity) ? " OVER" : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  for (const dir of [ENGINE, NEXT, SCENARIOS]) walk(root, dir.slice(0, -1), files);
  const result = checkFiles(files.map((file) => ({ path: file, text: readFileSync(path.join(root, file), "utf8") })));
  for (const p of result.problems) console.log(`${p.file}:${p.line}: ${p.rule}: ${p.detail}`);
  for (const e of result.exemptions) console.log(`exempt ${e.file}:${e.line}: ${e.rule}: ${e.reason}`);
  console.log(`module lines (budget): ${budgets(root, files).join(", ")}`);
  console.log(`check-rules: ${files.length} files, ${result.problems.length} problems, ${result.exemptions.length} exemptions`);
  process.exitCode = result.problems.length ? 1 : 0;
}
