// Reading `.rafi/progress.yaml` (ARCH 3.7; S-CRASH-2): a torn, conflicted or schema-invalid file is "damaged" and
// is rewritten from the database at the next safe point, with one line saying so. The database always wins: the
// file is never read into state here (importing a clone's file is M5).
import { progressFile } from "rafi-spec/v1";
import { parse } from "yaml";

export type ProgressRead = { kind: "missing" } | { kind: "valid" } | { kind: "damaged"; why: string };

export function readProgress(text: string | null): ProgressRead {
  if (text === null) return { kind: "missing" };
  if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) return { kind: "damaged", why: "it has merge conflict markers" };
  let value: unknown;
  try { value = parse(text); } catch { return { kind: "damaged", why: "it isn't valid YAML" }; }
  const checked = progressFile.safeParse(value);
  return checked.success ? { kind: "valid" } : { kind: "damaged", why: "it doesn't match the progress format" };
}
