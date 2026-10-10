import { createHash } from "node:crypto";
import { lstatSync, realpathSync, constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a<b?-1:a>b?1:0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(domain: string, value: unknown): string { return createHash("sha256").update(`rafi-graph:${domain}:v1\0`).update(canonical(value)).digest("hex"); }
export function bytesDigest(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
export function confined(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || path.includes("\0") || /^[A-Za-z]:/.test(path))
    throw new Error("Graph path escapes authorized scope");
  const base = realpathSync(root), target = resolve(base, path);
  const rel = relative(base, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new Error("Graph path escapes authorized scope");
  const actual = realpathSync(target);
  const realRel = relative(base, actual);
  if (realRel.startsWith(`..${sep}`) || realRel === ".." || isAbsolute(realRel))
    throw new Error("Graph symlink escapes authorized scope");
  if (lstatSync(target).isSymbolicLink())
    throw new Error("Graph inputs cannot be symlinks");
  return target;
}
export function readBounded(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum)
      throw new Error("Graph resource is not a bounded regular file");
    const parts: Buffer[] = [];
    let size = 0;
    for (; ;) {
      const buffer = Buffer.alloc(Math.min(65536, maximum - size + 1));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count)
        break;
      size += count;
      if (size > maximum)
        throw new Error("Graph resource grew beyond byte limit");
      parts.push(buffer.subarray(0, count));
    }
    return Buffer.concat(parts, size);
  }
  finally {
    closeSync(fd);
  }
}
