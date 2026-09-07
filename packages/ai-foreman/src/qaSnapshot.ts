import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface QaUntrackedCapture { path: string; kind: "file" | "symlink"; mode: number; digest: string; bytes: Buffer }
export interface QaSourcePathState {
  path: string;
  staged: string[];
  unstaged: string[];
  headObject?: string;
  indexObject?: string;
  worktreeObject?: string;
  untracked?: { kind: "file" | "symlink"; mode: number; digest: string };
}

/** Immutable host-observable product state from which QA is constructed. */
export interface FrozenQaSourceState {
  head: string;
  /** Repository identity/config/ref/index metadata, separate from product bytes. */
  originDigest: string;
  /** Product content identity, including staging distinctions and untracked bytes. */
  contentDigest: string;
  repository: { topLevel: string; gitDir: string; commonDir: string; indexDigest: string; configDigest: string; refsDigest: string; sparseDigest: string; submoduleDigest: string };
  status: Buffer;
  combinedDiff: Buffer;
  stagedDiff: Buffer;
  unstagedDiff: Buffer;
  changeSummary: string;
  pathInventory: QaSourcePathState[];
  untracked: QaUntrackedCapture[];
  digest: string;
  capturedAt: string;
}

export interface QaChangeManifest { diffDigest: string; untracked: Array<{ path: string; kind: "file" | "symlink"; mode: number; digest: string }> }
export interface DisposableQaSnapshot { path: string; manifest: QaChangeManifest; frozenState: FrozenQaSourceState; verify(): void; qaChanges(): string[]; remove(): void }
export interface AsyncDisposableQaSnapshot { path: string; manifest: QaChangeManifest; frozenState: FrozenQaSourceState; verify(): Promise<void>; qaChanges(): Promise<string[]>; remove(): Promise<void> }
export type QaSnapshotProgress = (state: string, detail?: string) => void;

const PRODUCT_PATHSPEC = ["--", ".", ":(exclude).foreman/**", ":(exclude).rafi/**"];
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
  return captureStableFrozenQaSource(() => captureOnce(cwd));
}

export async function captureFrozenQaSourceAsync(worktree: string, progress: QaSnapshotProgress = () => {}): Promise<FrozenQaSourceState> {
  const cwd = resolve(worktree);
  return captureStableFrozenQaSourceAsync(async (attempt, pass) => {
    if (pass === 1) progress("freezing Builder source state", `integrity pass ${attempt}/3`);
    return captureOnceAsync(cwd, progress);
  });
}

export function captureStableFrozenQaSource(read: (attempt: number, pass: 1 | 2) => FrozenQaSourceState, now = new Date()): FrozenQaSourceState {
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    const first = read(attempt, 1); const second = read(attempt, 2);
    if (first.digest === second.digest) return { ...first, capturedAt: now.toISOString() };
  }
  throw new QaSourceInstabilityError(MAX_CAPTURE_ATTEMPTS);
}

export async function captureStableFrozenQaSourceAsync(read: (attempt: number, pass: 1 | 2) => Promise<FrozenQaSourceState>, now = new Date()): Promise<FrozenQaSourceState> {
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    const first = await read(attempt, 1); const second = await read(attempt, 2);
    if (first.digest === second.digest) return { ...first, capturedAt: now.toISOString() };
  }
  throw new QaSourceInstabilityError(MAX_CAPTURE_ATTEMPTS);
}

export function createDisposableQaSnapshot(builderWorktree: string): DisposableQaSnapshot {
  const source = resolve(builderWorktree);
  const root = gitText(source, ["rev-parse", "--show-toplevel"]);
  const frozenState = captureFrozenQaSource(source);
  const tempRoot = mkdtempSync(join(tmpdir(), "rafi-qa-"));
  const review = join(tempRoot, "review");
  cloneRepositorySync(root, review, frozenState.head);
  try {
    applyFrozenSync(review, frozenState);
    projectDependencyTrees(root, review);
    mkdirSync(join(tempRoot, "scratch"), { mode: 0o700 });
    const manifest = manifestFromFrozen(frozenState);
    const snapshot: DisposableQaSnapshot = {
      path: review, manifest, frozenState,
      verify: () => assertSnapshotMatches(review, manifest),
      qaChanges: () => manifestDifference(manifest, changeManifest(review)),
      remove: () => rmSync(tempRoot, { recursive: true, force: true }),
    };
    snapshot.verify();
    return snapshot;
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
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
    progress("preparing disposable QA snapshot", "creating independent review repository");
    await cloneRepositoryAsync(root, review, frozenState.head);
    await applyFrozenAsync(review, frozenState, progress);
    projectDependencyTrees(root, review);
    await mkdir(join(tempRoot, "scratch"), { mode: 0o700 });
    const manifest = manifestFromFrozen(frozenState);
    const snapshot: AsyncDisposableQaSnapshot = {
      path: review, manifest, frozenState,
      verify: async () => assertSnapshotMatchesAsync(review, manifest, progress),
      qaChanges: async () => manifestDifference(manifest, await changeManifestAsync(review, progress)),
      remove: async () => {
        progress("cleaning up disposable QA snapshot", "removing independent review repository");
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
    progress("preparing disposable QA snapshot", "verifying frozen review copy");
    await snapshot.verify();
    return snapshot;
  } catch (error) {
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

/** Git tree for exactly what `git add -A && git commit` would publish. */
export function captureProspectiveGitTree(worktree: string): string {
  const cwd = resolve(worktree);
  const temporary = mkdtempSync(join(tmpdir(), "rafi-qa-finalize-"));
  const index = join(temporary, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync("git", ["read-tree", "HEAD"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["add", "-A", "--", "."], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    return execFileSync("git", ["write-tree"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Compare prospective publication trees while permitting only named host-owned paths. */
export function prospectiveGitTreeMatches(worktree: string, expectedTree: string, allowedPaths: string[] = []): boolean {
  const currentTree = captureProspectiveGitTree(worktree);
  if (currentTree === expectedTree) return true;
  const pathspec = ["--", ".", ...allowedPaths.map((path) => `:(exclude)${path.replaceAll("\\", "/")}`)];
  const result = spawnSync("git", ["diff", "--quiet", expectedTree, currentTree, ...pathspec], { cwd: resolve(worktree), stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git diff could not compare QA finalization trees (exit ${result.status ?? "unknown"})`);
}

function captureOnce(cwd: string): FrozenQaSourceState {
  const head = gitText(cwd, ["rev-parse", "HEAD"]);
  const repository = captureRepositoryMetadataSync(cwd);
  const status = gitBuffer(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...PRODUCT_PATHSPEC]);
  const combinedDiff = gitBuffer(cwd, ["diff", "--binary", "HEAD", ...PRODUCT_PATHSPEC]);
  const stagedDiff = gitBuffer(cwd, ["diff", "--cached", "--binary", ...PRODUCT_PATHSPEC]);
  const unstagedDiff = gitBuffer(cwd, ["diff", "--binary", ...PRODUCT_PATHSPEC]);
  const stagedNames = gitBuffer(cwd, ["diff", "--cached", "--name-status", "-z", ...PRODUCT_PATHSPEC]);
  const unstagedNames = gitBuffer(cwd, ["diff", "--name-status", "-z", ...PRODUCT_PATHSPEC]);
  const untrackedNames = gitBuffer(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = untrackedPathsFrom(untrackedNames).map((path) => captureUntrackedSync(cwd, path));
  const pathInventory = enrichTrackedPathInventorySync(cwd, buildPathInventory(stagedNames, unstagedNames, untracked));
  const content = { head, status, combinedDiff, stagedDiff, unstagedDiff, changeSummary: renderSummary(stagedNames, unstagedNames, untrackedNames), pathInventory, untracked };
  const contentDigest = calculateFrozenQaContentDigest(content);
  const base = { ...content, repository, originDigest: repositoryDigest(repository), contentDigest };
  return { ...base, digest: calculateFrozenQaStateDigest(base), capturedAt: "" };
}

async function captureOnceAsync(cwd: string, progress: QaSnapshotProgress): Promise<FrozenQaSourceState> {
  // These reads are deliberately serialized. Concurrent git reads can each
  // observe a different index/worktree generation and manufacture a state
  // that never existed. The enclosing double-capture supplies the stability
  // fence across the complete sequence.
  const headBytes = await runGit(cwd, ["rev-parse", "HEAD"]);
  const repository = await captureRepositoryMetadataAsync(cwd);
  const status = await runGit(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...PRODUCT_PATHSPEC]);
  const combinedDiff = await runGit(cwd, ["diff", "--binary", "HEAD", ...PRODUCT_PATHSPEC]);
  const stagedDiff = await runGit(cwd, ["diff", "--cached", "--binary", ...PRODUCT_PATHSPEC]);
  const unstagedDiff = await runGit(cwd, ["diff", "--binary", ...PRODUCT_PATHSPEC]);
  const stagedNames = await runGit(cwd, ["diff", "--cached", "--name-status", "-z", ...PRODUCT_PATHSPEC]);
  const unstagedNames = await runGit(cwd, ["diff", "--name-status", "-z", ...PRODUCT_PATHSPEC]);
  const untrackedNames = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = untrackedPathsFrom(untrackedNames);
  const untracked: QaUntrackedCapture[] = [];
  for (let index = 0; index < paths.length; index++) {
    progress("freezing Builder source state", `reading untracked file ${index + 1}/${paths.length}`);
    untracked.push(await captureUntrackedAsync(cwd, paths[index]!));
  }
  const pathInventory = await enrichTrackedPathInventoryAsync(cwd, buildPathInventory(stagedNames, unstagedNames, untracked));
  const content = { head: headBytes.toString().trim(), status, combinedDiff, stagedDiff, unstagedDiff, changeSummary: renderSummary(stagedNames, unstagedNames, untrackedNames), pathInventory, untracked };
  const contentDigest = calculateFrozenQaContentDigest(content);
  const base = { ...content, repository, originDigest: repositoryDigest(repository), contentDigest };
  return { ...base, digest: calculateFrozenQaStateDigest(base), capturedAt: "" };
}

export function calculateFrozenQaStateDigest(state: Omit<FrozenQaSourceState, "digest" | "capturedAt">): string {
  const h = createHash("sha256");
  h.update("rafi.qa.source-state.v2\0").update(state.originDigest).update("\0").update(state.contentDigest).update("\0");
  const pathBytes = Buffer.from(JSON.stringify(state.pathInventory.map((item) => ({
    path: item.path, staged: item.staged, unstaged: item.unstaged,
    ...(item.headObject ? { headObject: item.headObject } : {}),
    ...(item.indexObject ? { indexObject: item.indexObject } : {}),
    ...(item.worktreeObject ? { worktreeObject: item.worktreeObject } : {}),
    ...(item.untracked ? { untracked: { kind: item.untracked.kind, mode: item.untracked.mode, digest: item.untracked.digest } } : {}),
  }))));
  for (const [label, value] of [["head", Buffer.from(state.head)], ["status", state.status], ["combined", state.combinedDiff], ["staged", state.stagedDiff], ["unstaged", state.unstagedDiff], ["summary", Buffer.from(state.changeSummary)], ["paths", pathBytes]] as Array<[string, Buffer]>) {
    h.update(label).update("\0").update(value).update("\0");
  }
  for (const item of state.untracked) h.update(item.path).update("\0").update(item.kind).update("\0").update(String(item.mode)).update("\0").update(item.bytes).update("\0");
  return h.digest("hex");
}

function calculateFrozenQaContentDigest(state: Pick<FrozenQaSourceState, "head" | "status" | "combinedDiff" | "stagedDiff" | "unstagedDiff" | "changeSummary" | "pathInventory" | "untracked">): string {
  const h = createHash("sha256").update("rafi.qa.content.v2\0");
  h.update(state.head).update("\0").update(state.status).update("\0").update(state.combinedDiff).update("\0").update(state.stagedDiff).update("\0").update(state.unstagedDiff).update("\0");
  h.update(JSON.stringify(state.pathInventory)).update("\0");
  for (const item of state.untracked) h.update(item.path).update("\0").update(item.kind).update("\0").update(String(item.mode)).update("\0").update(item.bytes).update("\0");
  return h.digest("hex");
}

function repositoryDigest(repository: FrozenQaSourceState["repository"]): string {
  return createHash("sha256").update("rafi.qa.origin.v2\0").update(JSON.stringify(repository)).digest("hex");
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
function isQaProductPath(path: string): boolean { return path !== ".foreman" && !path.startsWith(".foreman/") && path !== ".rafi" && !path.startsWith(".rafi/"); }

function renderSummary(staged: Buffer, unstaged: Buffer, untracked: Buffer): string {
  const normalize = (value: Buffer) => value.toString().split("\0").filter(Boolean).filter(isQaProductPath).sort().join("\n") || "(none)";
  return `tracked/staged:\n${normalize(staged)}\ntracked/unstaged:\n${normalize(unstaged)}\nuntracked:\n${normalize(untracked)}`;
}

function buildPathInventory(staged: Buffer, unstaged: Buffer, untracked: QaUntrackedCapture[]): QaSourcePathState[] {
  const rows = new Map<string, QaSourcePathState>();
  const row = (path: string): QaSourcePathState => {
    let value = rows.get(path);
    if (!value) { value = { path, staged: [], unstaged: [] }; rows.set(path, value); }
    return value;
  };
  const addTracked = (raw: Buffer, kind: "staged" | "unstaged"): void => {
    const tokens = raw.toString().split("\0").filter(Boolean);
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++]!;
      const first = tokens[index++];
      if (!first) break;
      if (/^[RC]/.test(status)) {
        const second = tokens[index++];
        if (!second) break;
        row(first)[kind].push(`${status}:from`);
        row(second)[kind].push(`${status}:to`);
      } else row(first)[kind].push(status);
    }
  };
  addTracked(staged, "staged"); addTracked(unstaged, "unstaged");
  for (const item of untracked) row(item.path).untracked = { kind: item.kind, mode: item.mode, digest: item.digest };
  return [...rows.values()].map((item) => ({ ...item, staged: item.staged.sort(), unstaged: item.unstaged.sort() })).sort((a, b) => a.path.localeCompare(b.path));
}

function enrichTrackedPathInventorySync(cwd: string, inventory: QaSourcePathState[]): QaSourcePathState[] {
  return inventory.map((item) => item.untracked ? item : {
    ...item,
    ...optionalIdentity("headObject", gitTreeIdentitySync(cwd, item.path)),
    ...optionalIdentity("indexObject", gitIndexIdentitySync(cwd, item.path)),
    ...optionalIdentity("worktreeObject", worktreeIdentitySync(cwd, item.path)),
  });
}

async function enrichTrackedPathInventoryAsync(cwd: string, inventory: QaSourcePathState[]): Promise<QaSourcePathState[]> {
  const result: QaSourcePathState[] = [];
  for (const item of inventory) {
    if (item.untracked) { result.push(item); continue; }
    result.push({
      ...item,
      ...optionalIdentity("headObject", await gitTreeIdentityAsync(cwd, item.path)),
      ...optionalIdentity("indexObject", await gitIndexIdentityAsync(cwd, item.path)),
      ...optionalIdentity("worktreeObject", await worktreeIdentityAsync(cwd, item.path)),
    });
  }
  return result;
}

function optionalIdentity<K extends "headObject" | "indexObject" | "worktreeObject">(key: K, value: string | undefined): Partial<Pick<QaSourcePathState, K>> {
  return value === undefined ? {} : { [key]: value } as Pick<QaSourcePathState, K>;
}

function gitTreeIdentitySync(cwd: string, path: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "ls-tree", "-z", "HEAD", "--", path], { encoding: "buffer" });
  return result.status === 0 ? parseGitObjectIdentity(Buffer.from(result.stdout)) : undefined;
}
function gitIndexIdentitySync(cwd: string, path: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "ls-files", "--stage", "-z", "--", path], { encoding: "buffer" });
  return result.status === 0 ? parseGitObjectIdentity(Buffer.from(result.stdout), true) : undefined;
}
async function gitTreeIdentityAsync(cwd: string, path: string): Promise<string | undefined> {
  try { return parseGitObjectIdentity(await runGit(cwd, ["ls-tree", "-z", "HEAD", "--", path])); } catch { return undefined; }
}
async function gitIndexIdentityAsync(cwd: string, path: string): Promise<string | undefined> {
  try { return parseGitObjectIdentity(await runGit(cwd, ["ls-files", "--stage", "-z", "--", path]), true); } catch { return undefined; }
}
function parseGitObjectIdentity(value: Buffer, index = false): string | undefined {
  const header = value.toString().split("\t", 1)[0]?.trim();
  if (!header) return undefined;
  const parts = header.split(/\s+/);
  const mode = parts[0]; const object = parts[index ? 1 : 2]; const stage = index ? parts[2] : undefined;
  return mode && object && (!index || stage === "0") ? `${mode}:${object}` : undefined;
}
function worktreeIdentitySync(cwd: string, path: string): string | undefined {
  const absolute = join(cwd, path);
  try {
    const stat = lstatSync(absolute); const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) return `symlink:${mode}:${hash(Buffer.from(readlinkSync(absolute)))}`;
    if (stat.isFile()) return `file:${mode}:${hash(readFileSync(absolute))}`;
    return `other:${mode}`;
  } catch { return undefined; }
}
async function worktreeIdentityAsync(cwd: string, path: string): Promise<string | undefined> {
  const absolute = join(cwd, path);
  try {
    const stat = await lstat(absolute); const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) return `symlink:${mode}:${hash(Buffer.from(await readlink(absolute)))}`;
    if (stat.isFile()) return `file:${mode}:${hash(await readFile(absolute))}`;
    return `other:${mode}`;
  } catch { return undefined; }
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

function cloneRepositorySync(root: string, review: string, head: string): void {
  const cloned = spawnSync("git", ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--quiet", root, review], { encoding: "utf8" });
  if (cloned.status !== 0) { rmSync(dirname(review), { recursive: true, force: true }); throw new Error(`cannot create independent QA repository: ${cloned.stderr.trim()}`); }
  const checked = spawnSync("git", ["-C", review, "checkout", "--detach", "--quiet", head], { encoding: "utf8" });
  if (checked.status !== 0) { rmSync(dirname(review), { recursive: true, force: true }); throw new Error(`cannot check out frozen QA source: ${checked.stderr.trim()}`); }
}

async function cloneRepositoryAsync(root: string, review: string, head: string): Promise<void> {
  await runGit(dirname(review), ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--quiet", root, review]);
  await runGit(review, ["checkout", "--detach", "--quiet", head]);
}

/**
 * Dependency installs are execution environment, not reviewed product state.
 * Project the existing trees without copying or permitting writes so validation
 * commands in the independent clone can resolve the same installed toolchain.
 */
function projectDependencyTrees(sourceRoot: string, reviewRoot: string): void {
  const parents = ["", ...readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules")
    .flatMap((entry) => {
      const first = entry.name;
      const nested = readdirSync(join(sourceRoot, first), { withFileTypes: true })
        .filter((child) => child.isDirectory() && child.name !== "node_modules")
        .map((child) => join(first, child.name));
      return [first, ...nested];
    })];
  for (const parent of parents) {
    const source = join(sourceRoot, parent, "node_modules");
    const target = join(reviewRoot, parent, "node_modules");
    if (!existsSync(source) || existsSync(target) || !lstatSync(source).isDirectory()) continue;
    const relativeTarget = parent ? `${parent.replaceAll("\\", "/")}/node_modules` : "node_modules";
    if (spawnSync("git", ["-C", reviewRoot, "check-ignore", "-q", "--", relativeTarget]).status !== 0) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target, "dir");
  }
}

function captureRepositoryMetadataSync(cwd: string): FrozenQaSourceState["repository"] {
  const topLevel = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return {
    topLevel, gitDir, commonDir,
    indexDigest: hash(gitBuffer(cwd, ["ls-files", "--stage", "-z"])),
    configDigest: hash(gitBuffer(cwd, ["config", "--local", "--null", "--list"])),
    refsDigest: hash(gitBuffer(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"])),
    sparseDigest: hashOptionalFile(join(gitDir, "info", "sparse-checkout")),
    submoduleDigest: hash(gitBuffer(cwd, ["submodule", "status", "--recursive"])),
  };
}

async function captureRepositoryMetadataAsync(cwd: string): Promise<FrozenQaSourceState["repository"]> {
  const topLevel = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).toString().trim();
  const gitDir = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"])).toString().trim();
  const commonDir = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim();
  const index = await runGit(cwd, ["ls-files", "--stage", "-z"]);
  const config = await runGit(cwd, ["config", "--local", "--null", "--list"]);
  const refs = await runGit(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]);
  const submodules = await runGit(cwd, ["submodule", "status", "--recursive"]);
  let sparse = Buffer.alloc(0);
  try { sparse = await readFile(join(gitDir, "info", "sparse-checkout")); } catch { /* absent is canonical empty */ }
  return { topLevel, gitDir, commonDir, indexDigest: hash(index), configDigest: hash(config), refsDigest: hash(refs), sparseDigest: hash(sparse), submoduleDigest: hash(submodules) };
}

function hashOptionalFile(path: string): string { try { return hash(readFileSync(path)); } catch { return hash(Buffer.alloc(0)); } }
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
