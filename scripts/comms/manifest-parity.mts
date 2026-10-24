import { createHash } from "node:crypto";
import { canonicalJson, structuredCommunicationManifestV2 as source } from "../../packages/spec/src/index.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const packagedPath = createRequire(new URL("../../packages/ai-foreman/package.json", import.meta.url)).resolve("rafi-spec");
const { structuredCommunicationManifestV2: packaged } = await import(pathToFileURL(packagedPath).href);
const bytes = canonicalJson(source);
if (bytes !== canonicalJson(packaged)) throw new Error("Source/package structured manifest drift; build rafi-spec before validating the candidate");
console.log(JSON.stringify({ source: import.meta.resolve("../../packages/spec/src/index.js"),
  packaged: packagedPath, digest: createHash("sha256").update(bytes).digest("hex"), parity: "passed" }));
