// Reads and validates `.tickets/tickets.yaml` and `.tickets/delivery.yaml` (C54: the read side of today's ticket
// files; the commands are M5). Validated on read (ARCH 1.2): a broken file is one line naming the ticket and field.
import path from "node:path";
import { checkDeliveryFile, checkTicketsFile, type DeliveryUnit, type TicketV1 } from "rafi-spec/v1";
import { parse } from "yaml";
import type { Fs } from "../deps/types.js";

export const TICKETS = path.join(".tickets", "tickets.yaml");
export const DELIVERY = path.join(".tickets", "delivery.yaml");

export type TicketsLoad = { ok: true; tickets: TicketV1[]; units: DeliveryUnit[] } | { ok: false; message: string };

async function yamlOf(fs: Fs, file: string): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  if (!(await fs.stat(file))) return { ok: true, value: null };
  try {
    return { ok: true, value: parse(await fs.read(file)) };
  } catch (error) {
    return { ok: false, message: `${path.basename(file)} isn't valid YAML: ${String((error as Error).message)
      .split("\n")[0]}` };
  }
}

export async function loadTickets(fs: Fs, project: string): Promise<TicketsLoad> {
  const tickets = await yamlOf(fs, path.join(project, TICKETS));
  if (!tickets.ok) return tickets;
  const checked = checkTicketsFile(tickets.value ?? { tickets: [] });
  if (!checked.ok) return checked;
  const delivery = await yamlOf(fs, path.join(project, DELIVERY));
  if (!delivery.ok) return delivery;
  const units = checkDeliveryFile(delivery.value ?? { delivery_units: [] });
  if (!units.ok) return units;
  return { ok: true, tickets: checked.tickets, units: units.units };
}
