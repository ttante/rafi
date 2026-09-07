import { Command } from "commander";
import { resolve } from "node:path";
import { exportStateBundle, hasTransferableState, importStateBundle, inspectStateBundle } from "../stateTransfer.js";

export function buildStateCommand(opts: { resolveProject?: (project?: string) => string } = {}): Command {
  const command = new Command("state")
    .description("Export, inspect, and import portable Rafi local state bundles.");

  command
    .command("export")
    .description("Write a portable Rafi state bundle for sequential machine handoff.")
    .argument("[project]", "project directory", ".")
    .requiredOption("-o, --output <file>", "output bundle file")
    .action(async (project: string, options: { output: string }) => {
      const root = opts.resolveProject ? opts.resolveProject(project) : resolve(project);
      const manifest = await exportStateBundle(root, options.output);
      console.log(`rafi state export: wrote ${options.output}`);
      console.log(`  bundle: ${manifest.bundleId}`);
      console.log(`  files: ${manifest.files.length}`);
      if (manifest.source.git.branch || manifest.source.git.head) {
        console.log(`  git: ${manifest.source.git.branch ?? "(detached)"} ${manifest.source.git.head ?? ""}`.trimEnd());
      }
    });

  command
    .command("inspect")
    .description("Inspect and verify a Rafi state bundle.")
    .argument("<bundle>", "state bundle file")
    .option("--json", "print the manifest as JSON")
    .action((bundle: string, options: { json?: boolean }) => {
      const result = inspectStateBundle(bundle);
      if (options.json) {
        console.log(JSON.stringify(result.manifest, null, 2));
        return;
      }
      console.log(`rafi state inspect: ${result.valid ? "valid" : "invalid"}`);
      console.log(`  bundle: ${result.manifest.bundleId}`);
      console.log(`  created: ${result.manifest.createdAt}`);
      console.log(`  source: ${result.manifest.source.root}`);
      console.log(`  files: ${result.manifest.files.length}`);
      console.log("  provider sessions: not portable; use `rafi build:resume --fresh-with-handoff` when exact session recovery is unavailable");
    });

  command
    .command("import")
    .description("Restore a portable Rafi state bundle into an existing matching source checkout.")
    .argument("<projectOrBundle>", "project directory or bundle file")
    .argument("[bundle]", "state bundle file")
    .option("-y, --yes", "confirm replacement of local Rafi state")
    .action(async (projectOrBundle: string, bundle: string | undefined, options: { yes?: boolean }) => {
      const project = bundle ? projectOrBundle : ".";
      const bundleFile = bundle ?? projectOrBundle;
      const root = opts.resolveProject ? opts.resolveProject(project) : resolve(project);
      let confirmed = Boolean(options.yes);
      if (!confirmed && hasTransferableState(root)) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("refusing non-interactive import that replaces existing local Rafi state without --yes");
        const { confirm, isCancel } = await import("@clack/prompts");
        const answer = await confirm({ message: `Replace existing local Rafi state in ${root}?`, initialValue: false });
        if (isCancel(answer) || !answer) {
          console.log("rafi state import: cancelled; no state changed");
          return;
        }
        confirmed = true;
      }
      const result = await importStateBundle(root, bundleFile, { yes: confirmed });
      console.log(`rafi state import: restored bundle ${result.manifest.bundleId}`);
      if (result.backupDir) console.log(`  previous state backup: ${result.backupDir}`);
      console.log("  provider sessions are historical only; resume with `rafi build:resume --fresh-with-handoff` if exact session recovery fails");
    });

  return command;
}
