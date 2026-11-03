// Large payloads by SHA-256 digest, bounded at 16 MB with a cut marker (plan choice C16), redacted on write.
import { createHash } from "node:crypto";
import type { Log } from "./db.js";
import type { Redactor } from "./redact.js";

export const BLOB_LIMIT = 16 * 1024 * 1024;
export const CUT_MARKER = "\n[rafi: cut at 16 MB]\n";

export interface PutResult {
  readonly digest: string;
  readonly bytes: number;
  readonly cut: boolean;
}

export async function putBlob(
  log: Log, redact: Redactor, content: string, o: { sensitive: boolean },
): Promise<PutResult> {
  let text = redact.text(content);
  let bytes = Buffer.from(text, "utf8");
  const cut = bytes.length > BLOB_LIMIT;
  if (cut) {
    bytes = Buffer.concat([bytes.subarray(0, BLOB_LIMIT - Buffer.byteLength(CUT_MARKER)), Buffer.from(CUT_MARKER)]);
    text = bytes.toString("utf8");
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await log.write((db) => {
    db.prepare("INSERT OR IGNORE INTO blobs (digest, bytes, sensitive, data) VALUES (?, ?, ?, ?)")
      .run(digest, bytes.length, o.sensitive ? 1 : 0, bytes);
  });
  return { digest, bytes: bytes.length, cut };
}

export function getBlob(log: Log, digest: string): { data: string; sensitive: boolean } | null {
  const row = log.db.prepare("SELECT data, sensitive FROM blobs WHERE digest = ?").get(digest) as
    { data: Uint8Array; sensitive: number } | undefined;
  if (!row) return null;
  return { data: Buffer.from(row.data).toString("utf8"), sensitive: row.sensitive === 1 };
}
