import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { parse as parseHtml } from "parse5";

interface HtmlNode { nodeName?: string; value?: string; childNodes?: HtmlNode[]; }

export interface SourceFetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export const DEFAULT_SOURCE_FETCH_LIMITS: SourceFetchLimits = {
  timeoutMs: 15_000,
  maxBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
};

export interface FetchedSource {
  requestedUrl: string;
  finalUrl: string;
  contentType: "html" | "text" | "markdown" | "pdf";
  text: string;
  bytes: number;
  fingerprint: string;
  snapshotPath: string;
  metadataPath: string;
  fetchedAt: string;
}

export async function fetchAndSnapshotUrl(
  projectDir: string,
  input: string,
  limits: Partial<SourceFetchLimits> = {},
): Promise<FetchedSource> {
  const effective = { ...DEFAULT_SOURCE_FETCH_LIMITS, ...limits };
  const requested = normalizePublicHttpUrl(input);
  let current = requested;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= effective.maxRedirects; redirects++) {
    await assertPublicDestination(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effective.timeoutMs);
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/html,text/plain,text/markdown,application/pdf;q=0.9" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`URL redirect ${response.status} did not include Location`);
      if (redirects === effective.maxRedirects) throw new Error(`URL exceeded ${effective.maxRedirects} redirects`);
      current = normalizePublicHttpUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }
  if (!response) throw new Error("URL fetch did not produce a response");
  if (!response.ok) throw new Error(`URL fetch failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > effective.maxBytes) throw new Error(`URL content exceeds ${effective.maxBytes} byte limit`);
  const bytes = await readLimitedBody(response, effective.maxBytes);
  const kind = detectContentType(response.headers.get("content-type"), bytes, current);
  const text = await extractSourceText(kind, bytes);
  const fetchedAt = new Date().toISOString();
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const importsDir = join(resolve(projectDir), ".tickets", "imports");
  mkdirSync(importsDir, { recursive: true });
  const stamp = fetchedAt.replace(/[:.]/g, "-");
  const stem = `url-${stamp}-${fingerprint.slice(0, 12)}`;
  const snapshotPath = join(importsDir, `${stem}.md`);
  const metadataPath = join(importsDir, `${stem}.json`);
  writeFileSync(snapshotPath, `${text.trimEnd()}\n`, "utf8");
  writeFileSync(metadataPath, `${JSON.stringify({ requestedUrl: requested, finalUrl: current, fetchedAt, bytes: bytes.length, contentType: kind, fingerprint }, null, 2)}\n`, "utf8");
  return { requestedUrl: requested, finalUrl: current, contentType: kind, text, bytes: bytes.length, fingerprint, snapshotPath: relative(resolve(projectDir), snapshotPath), metadataPath: relative(resolve(projectDir), metadataPath), fetchedAt };
}

export function normalizePublicHttpUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`invalid URL: ${input}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL source must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("URL source must not contain credentials");
  if (!url.hostname) throw new Error("URL source must include a hostname");
  url.hash = "";
  return url.toString();
}

export async function assertPublicDestination(input: string): Promise<void> {
  const url = new URL(normalizePublicHttpUrl(input));
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dnsLookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`URL hostname did not resolve: ${url.hostname}`);
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) throw new Error(`URL destination is not public: ${url.hostname} resolved to ${address}`);
  }
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
  if (isIP(normalized) === 6) {
    return !(
      normalized.startsWith("ff") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fec") || normalized.startsWith("fed") || normalized.startsWith("fee") || normalized.startsWith("fef") ||
      normalized.startsWith("2001:db8:") || normalized.startsWith("2001:10:") || normalized.startsWith("2001:2:") ||
      normalized.startsWith("100:") || normalized.startsWith("64:ff9b:1:")
    );
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 88 || b === 168)) ||
    (a === 100 && b! >= 64 && b! <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw new Error(`URL content exceeds ${maxBytes} byte limit`); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function detectContentType(header: string | null, bytes: Uint8Array, url: string): FetchedSource["contentType"] {
  const mime = (header ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const magic = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
  if (magic.startsWith("%PDF-")) {
    if (mime && mime !== "application/pdf" && mime !== "application/octet-stream") throw new Error(`content-type ${mime} conflicts with PDF magic bytes`);
    return "pdf";
  }
  if (["application/pdf"].includes(mime)) throw new Error("response claimed PDF but PDF magic bytes were missing");
  if (["text/html", "application/xhtml+xml"].includes(mime)) return "html";
  if (["text/markdown", "text/x-markdown"].includes(mime) || /\.md(?:own)?$/i.test(new URL(url).pathname)) return "markdown";
  if (!mime || mime.startsWith("text/") || mime === "application/octet-stream") {
    if (bytes.subarray(0, Math.min(bytes.length, 1024)).includes(0)) throw new Error("binary URL content is not supported");
    if ((!mime || mime === "application/octet-stream") && /^\s*(?:<!doctype\s+html|<html\b)/i.test(Buffer.from(bytes.subarray(0, 1024)).toString("utf8"))) return "html";
    return "text";
  }
  throw new Error(`unsupported URL content-type: ${mime}`);
}

async function extractSourceText(kind: FetchedSource["contentType"], bytes: Uint8Array): Promise<string> {
  if (kind === "pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      page.cleanup();
    }
    await document.destroy();
    return pages.join("\n\n");
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return kind === "html" ? htmlToText(decoded) : decoded;
}

export function htmlToText(html: string): string {
  const doc = parseHtml(html);
  const blocks = new Set(["address", "article", "aside", "blockquote", "br", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "p", "section", "table", "tr"]);
  const skip = new Set(["script", "style", "noscript", "svg"]);
  const out: string[] = [];
  const walk = (node: HtmlNode): void => {
    const named = node;
    const name = named.nodeName?.toLowerCase();
    if (name && skip.has(name)) return;
    if (name === "#text" && named.value) out.push(named.value);
    for (const child of named.childNodes ?? []) walk(child);
    if (name && blocks.has(name)) out.push("\n");
  };
  for (const child of (doc as unknown as { childNodes: HtmlNode[] }).childNodes) walk(child);
  return out.join(" ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Snapshot a local file outside the repository so absolute paths are never persisted. */
export function snapshotExternalLocalFile(projectDir: string, inputPath: string): string {
  const root = realpathSync(resolve(projectDir));
  const file = realpathSync(resolve(inputPath));
  const rel = relative(root, file);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  if (statSync(file).isDirectory()) {
    const hash = createHash("sha256").update(file).digest("hex").slice(0, 12);
    const targetRoot = join(root, ".tickets", "imports", `local-${hash}-${basename(file).replace(/[^A-Za-z0-9._-]/g, "-")}`);
    let count = 0;
    let bytes = 0;
    const copyDirectory = (source: string, target: string): void => {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const from = join(source, entry.name); const to = join(target, entry.name);
        if (entry.isDirectory()) copyDirectory(from, to);
        else if (entry.isFile()) {
          count++; bytes += statSync(from).size;
          if (count > 1000 || bytes > DEFAULT_SOURCE_FETCH_LIMITS.maxBytes) throw new Error("external local source directory exceeds snapshot limits");
          copyFileSync(from, to);
        }
      }
    };
    copyDirectory(file, targetRoot);
    return relative(root, targetRoot);
  }
  if (!statSync(file).isFile()) throw new Error(`local source is not a file or directory: ${inputPath}`);
  const bytes = readFileSync(file);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const dir = join(root, ".tickets", "imports");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `local-${hash}-${basename(file).replace(/[^A-Za-z0-9._-]/g, "-")}${extname(file) ? "" : ".txt"}`);
  copyFileSync(file, target);
  return relative(root, target);
}
