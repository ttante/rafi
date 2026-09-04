import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadTicketsConfig, resolveTicketPaths } from "./config.js";
import { DELIVERY_FILE } from "./delivery.js";

export interface AppendTicketOutputResult {
  disposition: "created" | "appended";
  path: string;
}

export function appendTicketOutput(projectDir: string, outputFile: string, payload: string): AppendTicketOutputResult {
  const target = resolve(outputFile);
  assertSafeOutputPath(projectDir, target);
  const existed = existsSync(target);
  if (existed && statSync(target).isDirectory()) {
    throw new Error(`output destination is a directory: ${target}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const separator = existed ? separatorForExistingFile(target) : "";
  appendFileSync(target, `${separator}${payload}`, {
    encoding: "utf8",
    flag: existed ? "a" : "wx",
    mode: 0o600,
  });
  return { disposition: existed ? "appended" : "created", path: target };
}

function assertSafeOutputPath(projectDir: string, target: string): void {
  const root = resolve(projectDir);
  const fixedProtectedPaths = [
    join(root, ".tickets", "config.yaml"),
    join(root, DELIVERY_FILE),
  ];
  rejectProtectedIdentity(target, fixedProtectedPaths);
  const config = loadTicketsConfig(root);
  const paths = resolveTicketPaths(config, root);
  rejectProtectedIdentity(target, [paths.tickets, paths.stateDb]);
}

function rejectProtectedIdentity(target: string, protectedPaths: string[]): void {
  const targetIdentity = resolvedIdentity(target);
  const protectedPath = protectedPaths.find((candidate) => resolvedIdentity(candidate) === targetIdentity);
  if (protectedPath) {
    throw new Error(`refusing to write ticket output to protected tracker input: ${resolve(protectedPath)}`);
  }
}

function resolvedIdentity(path: string): string {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
    return realpathSync(absolute);
  } catch {
    let ancestor = dirname(absolute);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      ancestor = parent;
    }
    const suffix = relative(ancestor, absolute);
    return resolve(realpathSync(ancestor), ...suffix.split(sep).filter(Boolean));
  }
}

function separatorForExistingFile(path: string): string {
  const size = statSync(path).size;
  if (size === 0) return "";
  const length = Math.min(2, size);
  const tail = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, tail, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  if (tail.length >= 2 && tail.at(-1) === 0x0a && tail.at(-2) === 0x0a) return "";
  return tail.at(-1) === 0x0a ? "\n" : "\n\n";
}
