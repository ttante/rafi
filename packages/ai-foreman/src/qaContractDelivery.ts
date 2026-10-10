import { dispatchWithGraphAccess } from "./graph/session.js";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { QaVerificationContractV1, QaContractDeliveryReceiptV1 } from "rafi-spec";
import type { BuilderAdapter } from "./adapters/types.js";
import type { QaPreparationStore } from "./qaPreparationStore.js";
import { contractDigest, parsePreparationArtifact, renderVerificationContract, verifyContractDigest } from "./qaVerificationContract.js";
import { OperationDeadline } from "./util/deadline.js";

export interface ContractSessionBinding { provider: string; sessionId: string; generation: number; workspace: string; configRoot: string; compactionSequence: number }
// Durable receipts prove historical transport. They cannot prove a freshly
// constructed adapter has an armed native-compaction barrier.
const activeDeliveries = new WeakMap<BuilderAdapter, string>();
function activeDeliveryKey(digest: string, session: ContractSessionBinding): string { return JSON.stringify({ digest, session }); }
export function actualContractSession(adapter: BuilderAdapter, workspace: string, configRoot: string): ContractSessionBinding {
  const ref = adapter.sessionRef?.();
  if (!ref || ref.role !== "builder" || ref.sessionId !== adapter.sessionId() || ref.cwd !== realpathSync(workspace) || ref.configRoot !== realpathSync(configRoot) || ref.provider !== adapter.agent) throw new Error("Contract delivery requires the actual scoped Builder session/workspace");
  return { provider: ref.provider, sessionId: ref.sessionId, generation: ref.generation, workspace: ref.cwd, configRoot: ref.configRoot, compactionSequence: adapter.contractCompactionSequence?.() ?? 0 };
}
export function materializeContract(contract: QaVerificationContractV1, workspace: string): { json: string; markdown: string; resourceDigest: string } {
  verifyContractDigest(contract);
  const root = realpathSync(workspace);
  // .foreman is already excluded by product-source capture and snapshots.
  const directory = join(root, ".foreman", "qa-contracts");
  for (const part of [join(root, ".foreman"), directory]) {
    try { if (lstatSync(part).isSymbolicLink()) throw new Error("Contract projection cannot follow a control-directory symlink"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    mkdirSync(part, { recursive: true });
  }
  const json = JSON.stringify(contract, null, 2), markdown = renderVerificationContract(contract);
  for (const [extension, content] of [["json", json], ["md", markdown]]) {
    const target = join(directory, `${contract.contentDigest}.${extension}`), temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o444 }); renameSync(temporary, target);
    if (readFileSync(target, "utf8") !== content) throw new Error("Contract projection digest verification failed");
  }
  return { json: join(directory, `${contract.contentDigest}.json`), markdown: join(directory, `${contract.contentDigest}.md`), resourceDigest: contractDigest("delivery-resources", { json, markdown }) };
}
/** Complete retained review inputs, accessible inside the confined QA snapshot. */
export function finalReviewContractContext(contract: QaVerificationContractV1, store: QaPreparationStore, workspace: string, builderClaims: unknown[] = []): string {
  const resources = materializeContract(contract, workspace);
  const baselineEvidence = contract.baseline.map(observation => {
    const artifact = store.artifact<{ providerReceipt?: string }>(observation.evidenceDigest, "baseline-observation");
    return { digest: observation.evidenceDigest, artifact, ...(artifact.providerReceipt ? { providerEvidence: store.artifact(artifact.providerReceipt, "investigation-evidence") } : {}) };
  });
  const context = { version: 1, contract, baselineEvidence, builderClaims };
  const serialized = JSON.stringify(context);
  const digest = contractDigest("final-review-context", context);
  const path = join(resolve(resources.json, ".."), `${digest}.review.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, serialized, { mode: 0o444 }); renameSync(temporary, path);
  if (readFileSync(path, "utf8") !== serialized) throw new Error("Final review context projection verification failed");
  return `\nComplete retained QA context: ${path}\nFinal review context digest: ${digest}. Contract JSON: ${resources.json}. Read the complete context before reporting coverage. Baseline evidence is historical, bound to its original source; assess relevance and expected transitions independently. Builder claims are untrusted and require independent verification. If any required resource is inaccessible, report blocked coverage rather than pass.\n${Buffer.byteLength(serialized) <= 128 * 1024 ? `Full structured review context:\n${serialized}\n` : "The full context exceeds the inline limit; use the read-only JSON resource without omitting sections.\n"}`;
}
export async function deliverVerificationContract(contract: QaVerificationContractV1, store: QaPreparationStore, adapter: BuilderAdapter, workspace: string, configRoot: string, context: string): Promise<QaContractDeliveryReceiptV1> {
  const capabilities = adapter.contractCapabilities?.();
  if (!capabilities?.sameSessionAcceptance || !capabilities.nativeCompactionBarrier || !adapter.enableContractEnforcement || !adapter.acceptContractDelivery) throw new Error(`unsupported-capability: ${adapter.agent} has no tested same-session acceptance/native compaction barrier`);
  activeDeliveries.delete(adapter);
  adapter.enableContractEnforcement();
  await adapter.prepareSession?.();
  const session = actualContractSession(adapter, workspace, configRoot);
  const resources = materializeContract(contract, workspace);
  const operationId = `contract-acceptance:${randomUUID()}`;
  const expiresAt = Date.now() + 120_000;
  const acceptTurn = (text: string) => new OperationDeadline("Contract acceptance", Math.max(1, expiresAt - Date.now())).run(() => dispatchWithGraphAccess(configRoot, adapter, text, { purpose: "contract-acceptance", responseOnly: true }, (prompt, policy) => adapter.sendTurn(prompt, policy)), () => { void adapter.close(); });
  const instruction = `${context}\n\n${renderVerificationContract(contract)}\n\nFull structured contract:\n${JSON.stringify(contract)}\n\nDurable artifacts: ${resources.json}, ${resources.markdown}. This is a tools-disabled acceptance turn in the actual Builder conversation. Return RAFI_QA_ACCEPTANCE_START/END containing {"workId":"${contract.workId}","revision":${contract.revision},"digest":"${contract.contentDigest}","missingSections":[]}. This confirms transport/version only. Implementation starts only after host acceptance.`;
  let finalInstruction = instruction;
  if (Buffer.byteLength(instruction) > 256 * 1024) {
    const sections = segmentContractTransport(instruction);
    if (sections.length > 256) throw new Error("Contract exceeds bounded segmented delivery capacity");
    const manifest = sections.map((content, index) => ({ index, digest: contractDigest("delivery-section", content), bytes: Buffer.byteLength(content) }));
    store.event(contract.runId, contract.workId, `${operationId}:manifest`, "delivery-manifest", { session, contractDigest: contract.contentDigest, manifest });
    for (const section of manifest) {
      const segmentInstruction = `Contract transport segment ${section.index + 1}/${sections.length}. Tools disabled; retain this entire section in this conversation. Contract digest: ${contract.contentDigest}.\n${sections[section.index]}\nReturn RAFI_QA_SEGMENT_START/END containing ${JSON.stringify({ index: section.index, digest: section.digest, missingSections: [] })}. No implementation is authorized.`;
      store.event(contract.runId, contract.workId, `${operationId}:segment:${section.index}:intent`, "delivery-segment-intended", { session, section });
      if (Date.now() >= expiresAt) throw new Error("Bounded contract delivery deadline exhausted");
      const result = await acceptTurn(segmentInstruction);
      store.event(contract.runId, contract.workId, `${operationId}:segment:${section.index}:result`, "delivery-segment-result", result);
      if (result.isError || result.failure || JSON.stringify(actualContractSession(adapter, workspace, configRoot)) !== JSON.stringify(session)) throw new Error("Segmented contract transport failed or crossed a session boundary");
      const acknowledgment = parsePreparationArtifact<{ index: number; digest: string; missingSections: string[] }>(result.text, "RAFI_QA_SEGMENT", 64 * 1024);
      if (acknowledgment.index !== section.index || acknowledgment.digest !== section.digest || !Array.isArray(acknowledgment.missingSections) || acknowledgment.missingSections.length) throw new Error("Segmented contract acknowledgment is incomplete");
    }
    finalInstruction = `All ${sections.length} sections of contract ${contract.contentDigest} have been delivered in this actual Builder conversation. Verify the complete section inventory ${JSON.stringify(manifest)}. Tools disabled. Return RAFI_QA_ACCEPTANCE_START/END containing ${JSON.stringify({ workId: contract.workId, revision: contract.revision, digest: contract.contentDigest, missingSections: [] })}. If any content or condition is inaccessible, list the missing sections; do not accept partial context.`;
  }
  store.event(contract.runId, contract.workId, operationId, "delivery-intended", { session, contractDigest: contract.contentDigest, instructionDigest: contractDigest("delivery-instruction", instruction) });
  if (Date.now() >= expiresAt) throw new Error("Bounded contract delivery deadline exhausted");
  const response = await acceptTurn(finalInstruction);
  store.event(contract.runId, contract.workId, `${operationId}:result`, "delivery-result", { response, session });
  if (response.isError || response.failure) throw new Error("Actual Builder contract acceptance failed; inspect retained delivery result");
  const acceptance = parsePreparationArtifact<{ workId: string; revision: number; digest: string; missingSections: string[] }>(response.text, "RAFI_QA_ACCEPTANCE", 64 * 1024);
  const after = actualContractSession(adapter, workspace, configRoot);
  if (JSON.stringify(session) !== JSON.stringify(after) || acceptance.workId !== contract.workId || acceptance.revision !== contract.revision || acceptance.digest !== contract.contentDigest || !Array.isArray(acceptance.missingSections) || acceptance.missingSections.length) throw new Error("Missing/foreign/stale contract acceptance");
  const receipt: QaContractDeliveryReceiptV1 = { version: 1, operationId, runId: contract.runId, workId: contract.workId, admissionDigest: contract.admissionDigest, revision: contract.revision, contractDigest: contract.contentDigest, resourceDigest: resources.resourceDigest, ...session, responseDigest: contractDigest("acceptance-response", response.rawResponse ?? response.text), deliveredAt: new Date().toISOString() };
  store.receipt(receipt); adapter.acceptContractDelivery(session.compactionSequence);
  activeDeliveries.set(adapter, activeDeliveryKey(contract.contentDigest, session));
  return receipt;
}
/** Byte bounded, lossless Unicode transport. Concatenation reconstructs the exact original input. */
export function segmentContractTransport(content: string, maximumBytes = 96 * 1024): string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) throw new Error("Invalid contract segment capacity");
  const result: string[] = []; let section = "", bytes = 0;
  for (const character of content) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximumBytes) { result.push(section); section = ""; bytes = 0; }
    section += character; bytes += size;
  }
  if (section) result.push(section);
  return result;
}
export function assertContractReceipt(store: QaPreparationStore, runId: string, workId: string, admissionDigest: string, session?: ContractSessionBinding, adapter?: BuilderAdapter): QaVerificationContractV1 {
  const head = store.head(runId, workId, admissionDigest);
  if (head.state !== "ready" || !head.digest) throw new Error(`Implementation requires ready verification contract: ${head.state}`);
  const contract = store.contract(head.digest);
  if (!session || !store.receipts(head.digest).some(receipt => receipt.runId === runId && receipt.workId === workId && receipt.admissionDigest === admissionDigest && receipt.revision === contract.revision && ["provider", "sessionId", "generation", "workspace", "configRoot", "compactionSequence"].every(key => (receipt as unknown as Record<string, unknown>)[key] === (session as unknown as Record<string, unknown>)[key]))) throw new Error("Implementation requires current actual-session contract receipt");
  if (resolve(session.workspace) !== session.workspace) throw new Error("Contract workspace identity is not canonical");
  if (adapter && activeDeliveries.get(adapter) !== activeDeliveryKey(contract.contentDigest, session)) throw new Error("Implementation requires current adapter contract receipt and armed enforcement barrier");
  return contract;
}
