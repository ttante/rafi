import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const filePreservationSchema = z.object({
  path: z.string().min(1).max(1024),
  status: z.enum(["compared", "unavailable"]),
  baselineBytes: z.number().int().nonnegative().optional(),
  finalBytes: z.number().int().nonnegative().optional(),
  baselineHash: z.string().max(80).optional(),
  finalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  baselineIsExactPrefix: z.boolean().optional(),
  baselineEndsWithNewline: z.boolean().optional(),
  reason: z.string().max(256),
});

export type RetainedSourceIdentity = {
  digest?: string;
  head?: string;
  fileByteLengths?: Record<string, number>;
  pathInventory?: Array<{ path: string; worktreeObject?: string; untracked?: { kind: "file" | "symlink"; mode: number; digest: string } }>;
  untracked?: Array<{ path: string; kind: string; digest: string; byteLength?: number; bytes?: Buffer }>;
};

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A bounded fact, never an acceptance decision. No baseline bytes reach agents. */
export function inspectFilePreservation(worktree: string, before: RetainedSourceIdentity, paths: string[]): z.infer<typeof filePreservationSchema>[] {
  const root = realpathSync(worktree);
  return paths.slice(0, 20).map(path => {
    const unavailable = (reason: string) => ({ path, status: "unavailable" as const, reason });
    try {
      const absolute = resolve(root, path);
      const outside = relative(root, realpathSync(absolute));
      if (!outside || outside.startsWith("..") || isAbsolute(outside)) return unavailable("Path is outside the source boundary.");
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return unavailable("Comparison supports regular files up to 2 MiB.");
      const current = readFileSync(absolute);
      if (current.length > MAX_FILE_BYTES) return unavailable("Final file exceeds the comparison limit.");
      const inventory = before.pathInventory?.find(item => item.path === path);
      let size: number | undefined;
      let hash: string | undefined;
      let algorithm: "sha256" | "git-sha1" | "git-sha256" = "sha256";
      if (inventory?.untracked?.kind === "file") {
        const retained = before.untracked?.find(item => item.path === path && item.kind === "file" && item.digest === inventory.untracked!.digest);
        size = retained?.byteLength ?? retained?.bytes?.length;
        hash = inventory.untracked.digest;
      } else if (inventory) {
        hash = inventory.worktreeObject?.match(/^file:\d+:([a-f0-9]{64})$/)?.[1];
        size = before.fileByteLengths?.[path];
      } else if (before.head && /^[a-f0-9]{40,64}$/.test(before.head)) {
        // Clean baseline files are content-addressed by the retained HEAD.
        // Read only Git metadata; do not checkout, alter the index, or write blobs.
        const tree = execFileSync("git", ["ls-tree", "-z", before.head, "--", path], { cwd: root, maxBuffer: 4096, timeout: 5000 }).toString();
        const match = tree.match(/^100[0-7]{3} blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/);
        if (!match || match[2] !== path) return unavailable("No retained regular-file baseline for this path.");
        hash = match[1]!;
        algorithm = hash.length === 40 ? "git-sha1" : "git-sha256";
        size = Number(execFileSync("git", ["cat-file", "-s", hash], { cwd: root, maxBuffer: 128, timeout: 5000 }).toString().trim());
      }
      if (!hash || size === undefined || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return unavailable("Retained baseline hash or bounded byte length is unavailable.");
      const prefix = current.subarray(0, size);
      const prefixHash = algorithm === "sha256" ? sha256(prefix) : createHash(algorithm === "git-sha1" ? "sha1" : "sha256").update(`blob ${size}\0`).update(prefix).digest("hex");
      const preserved = current.length >= size && prefixHash === hash;
      return { path, status: "compared" as const, baselineBytes: size, finalBytes: current.length, baselineHash: `${algorithm}:${hash}`, finalHash: sha256(current), baselineIsExactPrefix: preserved,
        ...(preserved ? { baselineEndsWithNewline: size > 0 && current[size - 1] === 10 } : {}),
        reason: preserved ? "Every baseline byte is preserved in its original position; any extra bytes follow the baseline." : "The final file is not an exact byte-prefix extension of the baseline; this does not assess other forms of valid edits." };
    } catch { return unavailable("Source or retained Git identity is unavailable for this comparison."); }
  });
}
