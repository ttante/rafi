// The org policy (ARCH 8.6, 13; M5 plan C184): `<machine state>/policy.yaml` locks settings by dot path. Missing
// means nothing is locked; a damaged file refuses to start (fail closed), naming the file, never guessing.
import path from "node:path";
import { checkPolicy } from "rafi-spec/v1";
import { parse } from "yaml";
import type { Fs } from "../deps/types.js";

export const POLICY_FILE = "policy.yaml";
export const POLICY_SHOWN = "~/.rafi/policy.yaml";

export type PolicyLoad = { ok: true; locked: Record<string, unknown> } | { ok: false; message: string };

export async function readPolicy(fs: Fs, stateDir: string): Promise<PolicyLoad> {
  const file = path.join(stateDir, POLICY_FILE);
  if ((await fs.stat(file))?.kind !== "file") return { ok: true, locked: {} };
  const refuse = (why: string): PolicyLoad => ({ ok: false,
    message: `Your organization's policy (${POLICY_SHOWN}) is damaged: ${why}; refusing to start.` });
  let value: unknown;
  try {
    value = parse(await fs.read(file), { maxAliasCount: 50 });
  } catch (error) {
    return refuse(`it isn't valid YAML (${String((error as Error).message).split("\n")[0]})`);
  }
  const checked = checkPolicy(value);
  return checked.ok ? checked : refuse(checked.message.replace(/\.$/, ""));
}
