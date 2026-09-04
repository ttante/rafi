import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface QaUntrackedCapture { path: string; kind: "file" | "symlink"; mode: number; digest: string; bytes: Buffer }

/** Immutable host-observable product state from which QA is constructed. */
export interface FrozenQaSourceState {
  head: string;
  status: Buffer;
  combinedDiff: Buffer;
  stagedDiff: Buffer;
  unstagedDiff: Buffer;
  changeSummary: string;
  untracked: QaUntrackedCapture[];
  digest: string;
  capturedAt: string;
}

export interface QaChangeManifest { diffDigest: string; untracked: Array<{ path: string; kind: "file" | "symlink"; mode: number; digest: string }> }
export interface DisposableQaSnapshot { path: string; manifest: QaChangeManifest; frozenState: FrozenQaSourceState; verify(): void; qaChanges(): string[]; remove(): void }
export interface AsyncDisposableQaSnapshot { path: string; manifest: QaChangeManifest; frozenState: FrozenQaSourceState; verify(): Promise<void>; qaChanges(): Promise<string[]>; remove(): Promise<void> }
export type QaSnapshotProgress = (state: string, detail?: string) => void;

const PRODUCT_PATHSPEC = ["--", ".", ":(exclude).foreman/**", ":(exclude).rafi/cache/**"];
const MAX_CAPTURE_ATTEMPTS = 3; // initial attempt plus two bounded retries

export class QaSourceInstabilityError extends Error {
  constructor(readonly attempts: number) {
    super(`Builder source changed during frozen QA capture after ${attempts} attempts`);
    this.name = "QaSourceInstabilityError";
  }
}

/** Capture twice and accept only a byte-identical source state. */
export function captureFrozenQaSource(worktree: string): FrozenQaSourceState {
  const cwd = resolve(worktree);
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    const first = captureOnce(cwd);
    const second = captureOnce(cwd);
    if (first.digest === second.digest) return { ...first, capturedAt: new Date().toISOString() };
  }
  throw new QaSourceInstabilityError(MAX_CAPTURE_ATTEMPTS);
}

export async function captureFrozenQaSourceAsync(worktree: string, progress: QaSnapshotProgress = () => {}): Promise<FrozenQaSourceState> {
  const cwd = resolve(worktree);
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    progress("freezing Builder source state", `integrity pass ${attempt}/3`);
    const first = await captureOnceAsync(cwd, progress);
    const second = await captureOnceAsync(cwd, progress);
    if (first.digest === second.digest) return { ...first, capturedAt: new Date().toISOString() };
  }
  throw new QaSourceInstabilityError(MAX_CAPTURE_ATTEMPTS);
}

export function createDisposableQaSnapshot(builderWorktree: string): DisposableQaSnapshot {
  const source = resolve(builderWorktree);
  const root = gitText(source, ["rev-parse", "--show-toplevel"]);
  const frozenState = captureFrozenQaSource(source);
  const tempRoot = mkdtempSync(join(tmpdir(), "rafi-qa-"));
  const review = join(tempRoot, "review");
  addWorktreeSync(root, review, frozenState.head);
  try {
    applyFrozenSync(review, frozenState);
    const manifest = manifestFromFrozen(frozenState);
    const snapshot: DisposableQaSnapshot = {
      path: review, manifest, frozenState,
      verify: () => assertSnapshotMatches(review, manifest),
      qaChanges: () => manifestDifference(manifest, changeManifest(review)),
      remove: () => removeWorktreeSync(root, review, tempRoot),
    };
    snapshot.verify();
    return snapshot;
  } catch (error) {
    removeWorktreeSync(root, review, tempRoot);
    throw error;
  }
}

export async function createDisposableQaSnapshotAsync(builderWorktree: string, progress: QaSnapshotProgress = () => {}): Promise<AsyncDisposableQaSnapshot> {
  const source = resolve(builderWorktree);
  progress("preparing disposable QA snapshot", "locating Builder worktree");
  const root = (await runGit(source, ["rev-parse", "--show-toplevel"])).toString().trim();
  const frozenState = await captureFrozenQaSourceAsync(source, progress);
  const tempRoot = await mkdtemp(join(tmpdir(), "rafi-qa-"));
  const review = join(tempRoot, "review");
  try {
    progress("preparing disposable QA snapshot", "creating detached review worktree");
    await runGit(root, ["worktree", "add", "--detach", review, frozenState.head]);
    await applyFrozenAsync(review, frozenState, progress);
    const manifest = manifestFromFrozen(frozenState);
    const snapshot: AsyncDisposableQaSnapshot = {
      path: review, manifest, frozenState,
      verify: async () => assertSnapshotMatchesAsync(review, manifest, progress),
      qaChanges: async () => manifestDifference(manifest, await changeManifestAsync(review, progress)),
      remove: async () => {
        progress("cleaning up disposable QA snapshot", "removing detached review worktree");
        await runGit(root, ["worktree", "remove", "--force", review]).catch(() => {});
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
    progress("preparing disposable QA snapshot", "verifying frozen review copy");
    await snapshot.verify();
    return snapshot;
  } catch (error) {
    await runGit(root, ["worktree", "remove", "--force", review]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function frozenQaStateManifest(state: FrozenQaSourceState): QaChangeManifest { return manifestFromFrozen(state); }

export function changeManifest(worktree: string): QaChangeManifest {
  const diff = gitBuffer(resolve(worktree), ["diff", "--binary", "HEAD", ...PRODUCT_PATHSPEC]);
  return { diffDigest: hash(diff), untracked: untrackedPaths(worktree).map((path) => describeUntrackedSync(worktree, path)) };
}

export async function changeManifestAsync(worktree: string, progress: QaSnapshotProgress = () => {}, state = "checking QA file changes"): Promise<QaChangeManifest> {
  const diff = await runGit(worktree, ["diff", "--binary", "HEAD", ...PRODUCT_PATHSPEC]);
  const paths = await untrackedPathsAsync(worktree);
  const untracked: QaChangeManifest["untracked"] = [];
  for (let index = 0; index < paths.length; index++) {
    progress(state, `hashing untracked files ${index + 1}/${paths.length}`);
    const absolute = join(worktree, paths[index]!);
    const stat = await lstat(absolute);
    const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
    const bytes = kind === "symlink" ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    untracked.push({ path: paths[index]!, kind, mode: stat.mode & 0o7777, digest: hash(bytes) });
  }
  return { diffDigest: hash(diff), untracked };
}

export async function deterministicChangeSummaryAsync(worktree: string): Promise<string> {
  const [staged, unstaged, untracked] = await Promise.all([
    runGit(worktree, ["diff", "--cached", "--name-status", "-z", ...PRODUCT_PATHSPEC]),
    runGit(worktree, ["diff", "--name-status", "-z", ...PRODUCT_PATHSPEC]),
    runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return renderSummary(staged, unstaged, untracked);
}

function captureOnce(cwd: string): FrozenQaSourceState {
  const head = gitText(cwd, ["rev-parse", "HEAD"]);
  const status = gitBuffer(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...PRODUCT_PATHSPEC]);
  const combinedDiff = gitBuffer(cwd, ["diff", "--binary", "HEAD", ...PRODUCT_PATHSPEC]);
  const stagedDiff = gitBuffer(cwd, ["diff", "--cached", "--binary", ...PRODUCT_PATHSPEC]);
  const unstagedDiff = gitBuffer(cwd, ["diff", "--binary", ...PRODUCT_PATHSPEC]);
  const stagedNames = gitBuffer(cwd, ["diff", "--cached", "--name-status", "-z", ...PRODUCT_PATHSPEC]);
  const unstagedNames = gitBuffer(cwd, ["diff", "--name-status", "-z", ...PRODUCT_PATHSPEC]);
  const untrackedNames = gitBuffer(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = untrackedPathsFrom(untrackedNames).map((path) => captureUntrackedSync(cwd, path));
  const base = { head, status, combinedDiff, stagedDiff, unstagedDiff, changeSummary: renderSummary(stagedNames, unstagedNames, untrackedNames), untracked };
  return { ...base, digest: calculateFrozenQaStateDigest(base), capturedAt: "" };
}

async function captureOnceAsync(cwd: string, progress: QaSnapshotProgress): Promise<FrozenQaSourceState> {
  const [headBytes, status, combinedDiff, stagedDiff, unstagedDiff, stagedNames, unstagedNames, untrackedNames] = await Promise.all([
    runGit(cwd, ["rev-parse", "HEAD"]), runGit(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...PRODUCT_PATHSPEC]),
    runGit(cwd, ["diff", "--binary", "HEAD", ...PRODUCT_PATHSPEC]), runGit(cwd, ["diff", "--cached", "--binary", ...PRODUCT_PATHSPEC]),
    runGit(cwd, ["diff", "--binary", ...PRODUCT_PATHSPEC]), runGit(cwd, ["diff", "--cached", "--name-status", "-z", ...PRODUCT_PATHSPEC]),
    runGit(cwd, ["diff", "--name-status", "-z", ...PRODUCT_PATHSPEC]), runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const paths = untrackedPathsFrom(untrackedNames);
  const untracked: QaUntrackedCapture[] = [];
  for (let index = 0; index < paths.length; index++) {
    progress("freezing Builder source state", `reading untracked file ${index + 1}/${paths.length}`);
    untracked.push(await captureUntrackedAsync(cwd, paths[index]!));
  }
  const base = { head: headBytes.toString().trim(), status, combinedDiff, stagedDiff, unstagedDiff, changeSummary: renderSummary(stagedNames, unstagedNames, untrackedNames), untracked };
  return { ...base, digest: calculateFrozenQaStateDigest(base), capturedAt: "" };
}

export function calculateFrozenQaStateDigest(state: Omit<FrozenQaSourceState, "digest" | "capturedAt">): string {
  const h = createHash("sha256");
  for (const [label, value] of [["head", Buffer.from(state.head)], ["status", state.status], ["combined", state.combinedDiff], ["staged", state.stagedDiff], ["unstaged", state.unstagedDiff], ["summary", Buffer.from(state.changeSummary)]] as Array<[string, Buffer]>) {
    h.update(label).update("\0").update(value).update("\0");
  }
  for (const item of state.untracked) h.update(item.path).update("\0").update(item.kind).update("\0").update(String(item.mode)).update("\0").update(item.bytes).update("\0");
  return h.digest("hex");
}

function manifestFromFrozen(state: FrozenQaSourceState): QaChangeManifest {
  return { diffDigest: hash(state.combinedDiff), untracked: state.untracked.map(({ path, kind, mode, digest }) => ({ path, kind, mode, digest })) };
}

function applyFrozenSync(review: string, state: FrozenQaSourceState): void {
  applyPatchSync(review, state.stagedDiff, true);
  applyPatchSync(review, state.unstagedDiff, false);
  for (const item of state.untracked) writeCapturedUntrackedSync(review, item);
}

async function applyFrozenAsync(review: string, state: FrozenQaSourceState, progress: QaSnapshotProgress): Promise<void> {
  progress("preparing disposable QA snapshot", "applying captured staged changes");
  await applyPatchAsync(review, state.stagedDiff, true);
  progress("preparing disposable QA snapshot", "applying captured unstaged changes");
  await applyPatchAsync(review, state.unstagedDiff, false);
  for (let index = 0; index < state.untracked.length; index++) {
    progress("preparing disposable QA snapshot", `materializing captured untracked files ${index + 1}/${state.untracked.length}`);
    await writeCapturedUntrackedAsync(review, state.untracked[index]!);
  }
}

function applyPatchSync(review: string, patch: Buffer, index: boolean): void {
  if (!patch.length) return;
  const applied = spawnSync("git", ["-C", review, "apply", ...(index ? ["--index"] : []), "--binary", "--whitespace=nowarn", "-"], { input: patch, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  if (applied.status !== 0) throw new Error(`cannot apply frozen Builder diff to QA worktree: ${Buffer.from(applied.stderr).toString().trim()}`);
}

async function applyPatchAsync(review: string, patch: Buffer, index: boolean): Promise<void> {
  if (patch.length) await runGit(review, ["apply", ...(index ? ["--index"] : []), "--binary", "--whitespace=nowarn", "-"], patch);
}

function captureUntrackedSync(cwd: string, path: string): QaUntrackedCapture {
  const absolute = join(cwd, path); const stat = lstatSync(absolute);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported untracked path type during QA capture: ${path}`);
  const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
  const bytes = kind === "symlink" ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
  return { path, kind, mode: stat.mode & 0o7777, digest: hash(bytes), bytes };
}

async function captureUntrackedAsync(cwd: string, path: string): Promise<QaUntrackedCapture> {
  const absolute = join(cwd, path); const stat = await lstat(absolute);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported untracked path type during QA capture: ${path}`);
  const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
  const bytes = kind === "symlink" ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
  return { path, kind, mode: stat.mode & 0o7777, digest: hash(bytes), bytes };
}

function writeCapturedUntrackedSync(review: string, item: QaUntrackedCapture): void {
  const target = join(review, item.path); mkdirSync(dirname(target), { recursive: true });
  if (item.kind === "symlink") symlinkSync(item.bytes.toString(), target); else writeFileSync(target, item.bytes, { mode: item.mode });
}

async function writeCapturedUntrackedAsync(review: string, item: QaUntrackedCapture): Promise<void> {
  const target = join(review, item.path); await mkdir(dirname(target), { recursive: true });
  if (item.kind === "symlink") await symlink(item.bytes.toString(), target); else await writeFile(target, item.bytes, { mode: item.mode });
}

function describeUntrackedSync(worktree: string, path: string): QaChangeManifest["untracked"][number] {
  const item = captureUntrackedSync(worktree, path); return { path: item.path, kind: item.kind, mode: item.mode, digest: item.digest };
}

function untrackedPaths(worktree: string): string[] { return untrackedPathsFrom(gitBuffer(resolve(worktree), ["ls-files", "--others", "--exclude-standard", "-z"])); }
async function untrackedPathsAsync(worktree: string): Promise<string[]> { return untrackedPathsFrom(await runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])); }
function untrackedPathsFrom(raw: Buffer): string[] { return raw.toString().split("\0").filter((path) => path && isQaProductPath(path)).sort(); }
function isQaProductPath(path: string): boolean { return path !== ".foreman" && !path.startsWith(".foreman/") && path !== ".rafi/cache" && !path.startsWith(".rafi/cache/"); }

function renderSummary(staged: Buffer, unstaged: Buffer, untracked: Buffer): string {
  const normalize = (value: Buffer) => value.toString().split("\0").filter(Boolean).filter(isQaProductPath).sort().join("\n") || "(none)";
  return `tracked/staged:\n${normalize(staged)}\ntracked/unstaged:\n${normalize(unstaged)}\nuntracked:\n${normalize(untracked)}`;
}

function assertSnapshotMatches(review: string, expected: QaChangeManifest): void {
  const actual = changeManifest(review);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`disposable QA snapshot does not match frozen source manifest: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertSnapshotMatchesAsync(review: string, expected: QaChangeManifest, progress: QaSnapshotProgress): Promise<void> {
  const actual = await changeManifestAsync(review, progress, "verifying frozen QA snapshot");
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`disposable QA snapshot does not match frozen source manifest: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function manifestDifference(before: QaChangeManifest, after: QaChangeManifest): string[] {
  const changes: string[] = [];
  if (before.diffDigest !== after.diffDigest) changes.push("tracked diff changed");
  const left = new Map(before.untracked.map((item) => [item.path, item])); const right = new Map(after.untracked.map((item) => [item.path, item]));
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) if (JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path))) changes.push(path);
  return changes;
}

function addWorktreeSync(root: string, review: string, head: string): void {
  const added = spawnSync("git", ["-C", root, "worktree", "add", "--detach", review, head], { encoding: "utf8" });
  if (added.status !== 0) { rmSync(dirname(review), { recursive: true, force: true }); throw new Error(`cannot create disposable QA worktree: ${added.stderr.trim()}`); }
}
function removeWorktreeSync(root: string, review: string, tempRoot: string): void { spawnSync("git", ["-C", root, "worktree", "remove", "--force", review], { encoding: "utf8" }); rmSync(tempRoot, { recursive: true, force: true }); }
function gitText(cwd: string, args: string[]): string { return gitBuffer(cwd, args).toString().trim(); }
function gitBuffer(cwd: string, args: string[]): Buffer { return execFileSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }); }
function runGit(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] }); const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk)); child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(Buffer.concat(stdout)) : reject(new Error(Buffer.concat(stderr).toString().trim() || `git exited with status ${code ?? "unknown"}`)));
    child.stdin.end(input);
  });
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
