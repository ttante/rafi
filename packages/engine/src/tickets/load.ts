// Reads and validates `.tickets/tickets.yaml` and `.tickets/delivery.yaml` (C54: the read side of today's ticket
// files; the commands are M5). Validated on read (ARCH 1.2): a broken file is one line naming the ticket and field.
// P41: each load also carries the digests of the two files as read (null for a file that isn't there), so a safe
// point or a `tickets` command can tell an outside edit from one the log already recorded.
import { createHash } from "node:crypto";
import path from "node:path";
import { checkDeliveryFile, checkTicketsFile, type DeliveryUnit, type TicketV1 } from "rafi-spec/v1";
import { parse } from "yaml";
import type { Fs } from "../deps/types.js";

export const TICKETS = path.join(".tickets", "tickets.yaml");
export const DELIVERY = path.join(".tickets", "delivery.yaml");

export const fileDigest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** P41's pair: the digests of `tickets.yaml` and `delivery.yaml` as rafi read or wrote them. */
export interface Digests {
  readonly digest: string | null;
  readonly delivery_digest: string | null;
}

export const sameDigests = (a: Digests, b: Digests) => a.digest === b.digest &&
  a.delivery_digest === b.delivery_digest;

export type TicketsLoad = ({ ok: true; tickets: TicketV1[]; units: DeliveryUnit[] } & Digests)
  | { ok: false; message: string };

type Read = { ok: true; value: unknown; digest: string | null } | { ok: false; message: string };

async function yamlOf(fs: Fs, file: string): Promise<Read> {
  if (!(await fs.stat(file))) return { ok: true, value: null, digest: null };
  const text = await fs.read(file);
  try {
    return { ok: true, value: parse(text), digest: fileDigest(text) };
  } catch (error) {
    return { ok: false, message: `${path.basename(file)} isn't valid YAML: ${String((error as Error).message)
      .split("\n")[0]}` };
  }
}

/** The two files' digests as they are now, without parsing them (the safe point's cheap first look, C211). */
export async function digestsNow(fs: Fs, project: string): Promise<Digests> {
  const of = async (file: string) => ((await fs.stat(file)) ? fileDigest(await fs.read(file)) : null);
  return { digest: await of(path.join(project, TICKETS)), delivery_digest: await of(path.join(project, DELIVERY)) };
}

export async function loadTickets(fs: Fs, project: string): Promise<TicketsLoad> {
  const tickets = await yamlOf(fs, path.join(project, TICKETS));
  if (!tickets.ok) return tickets;
  const checked = checkTicketsFile(tickets.value ?? { tickets: [] });
  if (!checked.ok) return checked;
  const delivery = await yamlOf(fs, path.join(project, DELIVERY));
  if (!delivery.ok) return delivery;
  const units = checkDeliveryFile(delivery.value ?? { units: [] });
  if (!units.ok) return units;
  return { ok: true, tickets: checked.tickets, units: units.units, digest: tickets.digest,
    delivery_digest: delivery.digest };
}
