import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertNode24Policy(root = fileURLToPath(new URL("../../", import.meta.url))) {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Structured communication gates require Node 24");
  const packages = ["package.json", ...readdirSync(resolve(root, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/package.json`)];
  for (const path of packages) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8"));
    if (manifest.engines?.node !== "24.x") throw new Error(`Node 24 engine drift: ${path}`);
  }
  if (readFileSync(resolve(root, ".nvmrc"), "utf8").trim() !== "24") throw new Error("Node 24 version-manager drift");
  const workflow = readFileSync(resolve(root, ".github/workflows/build-recovery.yml"), "utf8");
  if (!/^\s+node: \[24\]\s*$/m.test(workflow) || !workflow.includes("node-version: ${{ matrix.node }}")) throw new Error("Node 24 CI drift");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNode24Policy(); console.log("Node 24 workspace, version manager and CI policy match");
}
