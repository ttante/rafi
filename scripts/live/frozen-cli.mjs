import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";

/** Freeze workspace packages; immutable external dependencies remain linked locally. */
export function freezeBuiltCli(repository, destination) {
  const packages = ["spec", "special-agents", "ai-foreman", "rafi"];
  const targets = new Map(packages.map(name => {
    const metadata = JSON.parse(readFileSync(join(repository, "packages", name, "package.json"), "utf8"));
    return [metadata.name, join(destination, "packages", name)];
  }));
  const files = [];
  for (const name of packages) {
    const source = join(repository, "packages", name), target = join(destination, "packages", name);
    cpSync(source, target, { recursive: true, filter: path => !relative(source, path).split(/[\\/]/).some(part => ["node_modules", "src", "test", "tests", ".git", ".rafi", ".foreman"].includes(part)) });
    const linkDependencies = (directory, output, prefix = "") => {
      if (!existsSync(directory)) return;
      mkdirSync(output, { recursive: true });
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (entry.name.startsWith("@")) { linkDependencies(join(directory, entry.name), join(output, entry.name), `${entry.name}/`); continue; }
        symlinkSync(targets.get(prefix + entry.name) ?? realpathSync(join(directory, entry.name)), join(output, entry.name), process.platform === "win32" ? "junction" : "dir");
      }
    };
    linkDependencies(join(source, "node_modules"), join(target, "node_modules"));
    if (name === "spec") linkDependencies(join(repository, "node_modules"), join(destination, "node_modules"));
    const verify = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) verify(path);
        else if (entry.isFile()) {
          const bytes = readFileSync(path), original = readFileSync(join(source, relative(target, path)));
          if (!bytes.equals(original)) throw new Error("Build changed while freezing live CLI; rebuild and restart the test");
          files.push([relative(destination, path), createHash("sha256").update(bytes).digest("hex")]);
        }
      }
    };
    verify(target);
  }
  // Recheck the entire source set after copying all packages. A rebuild of an
  // earlier package must not escape the per-package check while later packages
  // are still being copied.
  for (const [path, digest] of files) {
    const current = createHash("sha256").update(readFileSync(join(repository, path))).digest("hex");
    if (current !== digest) throw new Error("Build changed while freezing live CLI; rebuild and restart the test");
  }
  const digest = createHash("sha256").update(JSON.stringify(files.sort())).digest("hex");
  writeFileSync(join(destination, "build-manifest.json"), JSON.stringify({ digest, files }, null, 2));
  return { cli: join(destination, "packages", "rafi", "dist", "index.js"), digest, files: files.length };
}

/** Continue the same candidate after a completed delivery unit, without rebuilding it. */
export function verifyFrozenCli(destination) {
  const manifest = JSON.parse(readFileSync(join(destination, "build-manifest.json"), "utf8"));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Frozen CLI manifest is empty");
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid frozen CLI manifest entry");
    const [path, digest] = entry;
    if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..") || seen.has(path) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid frozen CLI manifest identity");
    seen.add(path);
    const file = join(destination, path);
    if (!lstatSync(file).isFile() || createHash("sha256").update(readFileSync(file)).digest("hex") !== digest) throw new Error("Frozen CLI candidate was modified; continuation refused");
  }
  if (createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex") !== manifest.digest || !seen.has("packages/rafi/dist/index.js")) throw new Error("Frozen CLI manifest digest or entrypoint is invalid");
  return { cli: join(destination, "packages/rafi/dist/index.js"), digest: manifest.digest, files: manifest.files.length };
}
