// Reads rafi-config.yaml through deps.fs and checks M1's 1.0 subset (plan choice C17).
import path from "node:path";
import { checkConfigV1, checkReservedTicketFields, type ConfigV1 } from "rafi-spec/v1";
import { parse } from "yaml";
import type { Fs } from "../deps/types.js";

export const CONFIG_FILE = "rafi-config.yaml";
export const TICKETS_FILE = path.join(".tickets", "tickets.yaml");

export type ConfigLoad = { ok: true; config: ConfigV1 } | { ok: false; message: string };

function parseYaml(text: string, name: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: parse(text) };
  } catch (error) {
    const first = String((error as Error).message).split("\n")[0];
    return { ok: false, message: `${name} isn't valid YAML: ${first}` };
  }
}

/** Loads and checks the project's config, and the reserved ticket `workflow` field. */
export async function loadConfig(fs: Fs, projectDir: string): Promise<ConfigLoad> {
  const parsed = parseYaml(await fs.read(path.join(projectDir, CONFIG_FILE)), CONFIG_FILE);
  if (!parsed.ok) return parsed;
  const checked = checkConfigV1(parsed.value);
  if (!checked.ok) return checked;
  const ticketsPath = path.join(projectDir, TICKETS_FILE);
  if (await fs.stat(ticketsPath)) {
    const tickets = parseYaml(await fs.read(ticketsPath), TICKETS_FILE);
    if (!tickets.ok) return tickets;
    const list = (tickets.value as { tickets?: unknown[] } | null)?.tickets ?? [];
    const reserved = checkReservedTicketFields(Array.isArray(list) ? list : []);
    if (!reserved.ok) return { ok: false, message: `${reserved.message} (ticket ${reserved.ticket})` };
  }
  return { ok: true, config: checked.config };
}
