import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertReviewedRegistryBaseline } from "./registry-baseline.mts";
const reviewed = JSON.parse(readFileSync(new URL("./registry-baseline.v2.json", import.meta.url), "utf8"));
const mutations: Record<string, (value: typeof reviewed) => void> = {
  "missing operation": value => { value.operations.pop(); },
  "extra operation": value => { value.operations.push({ ...value.operations[0], operation: "unreviewed" }); },
  "renamed identity with unchanged counts": value => { value.operations[0].operation = "renamed"; },
  "ownerless operation": value => { value.operations[0].owner = []; },
  "foreign page owner": value => { value.operations.find((item: any) => item.operation === "ticket-population-page").owner = ["generic"]; },
  "changed descriptor": value => { value.operations[0].descriptors[0].descriptorDigest = "foreign"; },
  "new source site": value => { value.authoritySites.push({ ...value.authoritySites[0], file: "packages/ai-foreman/src/newDispatch.ts" }); },
  "changed guidance source": value => { const file = Object.keys(value.authoritySourceDigests)[0]!; value.authoritySourceDigests[file] = "changed"; },
  "unclassified new production file": value => { value.productionSourceDigests["packages/ai-foreman/src/unclassified.ts"] = "new"; },
  "changed unclassified production file": value => { const file = Object.keys(value.productionSourceDigests)[0]!; value.productionSourceDigests[file] = "changed"; },
  "missing control site": value => { value.generatedControlSites[Object.keys(value.generatedControlSites)[0]!] = []; },
};
test("CI accepts the reviewed registry identities, owners and sites exactly", () => {
  assert.doesNotThrow(() => assertReviewedRegistryBaseline(structuredClone(reviewed), reviewed));
});
for (const [name, mutate] of Object.entries(mutations)) test(`CI rejects ${name}`, () => {
  const candidate = structuredClone(reviewed); mutate(candidate);
  assert.throws(() => assertReviewedRegistryBaseline(candidate, reviewed), /baseline drift/);
});
