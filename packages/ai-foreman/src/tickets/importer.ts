import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { loadTickets, saveTickets, validateTicketDefs } from "./ticketLoader.js";
import type { TicketDef, TicketExternalRef, TicketPriority, TicketRisk, TicketSize } from "./ticketSchema.js";
import { StateDb, type TicketStatus } from "./stateDb.js";
import { nowTimestamp } from "./events.js";
import { loadTicketsConfig, resolveTicketPaths } from "./config.js";
import type { TicketSourceConfig } from "./setupConfig.js";
import { insertXlSplitRecommendations } from "./recommendations.js";

export function importFromMarkdown(_progressDocPath: string): never {
  throw new Error(
    "foreman tickets import is not yet implemented.\n\n" +
    "To start fresh:\n" +
    "  1. Run `foreman tickets init --app-name \"My App\" --timezone America/Chicago`\n" +
    "  2. Add your tickets to .tickets/tickets.yaml\n" +
    "  3. Run `foreman tickets render`\n\n" +
    "Manual migration steps:\n" +
    "  1. Copy ticket definitions into .tickets/tickets.yaml following the schema.\n" +
    "  2. Run `foreman tickets validate` to check the structure.\n" +
    "  3. Use `foreman tickets update <id> --status <status>` to restore active ticket states.",
  );
}

export interface ImportedTicketItem {
  provider: "linear" | "jira";
  providerId: string;
  key?: string | null;
  url?: string | null;
  title: string;
  description?: string | null;
  area?: string | null;
  priority?: string | number | null;
  size?: string | number | null;
  status?: string | null;
  statusCategory?: string | null;
  labels?: string[];
  comments?: ImportedComment[];
  createdAt?: string | null;
  updatedAt?: string | null;
  raw: unknown;
}

export interface ImportedComment {
  author?: string | null;
  body: string;
  createdAt?: string | null;
}

export interface ExternalImportOptions {
  importCap: number;
  commentLimit: number;
  recommendSplitForXl?: boolean;
}

export interface ExternalImportResult {
  provider: "linear" | "jira";
  sourceLabel: string;
  fetched: number;
  created: number;
  updated: number;
  snapshotPath: string;
}

export async function importExternalSources(
  projectDir: string,
  sources: Extract<TicketSourceConfig, { type: "linear" | "jira" }>[],
  opts: ExternalImportOptions,
): Promise<ExternalImportResult[]> {
  const results: ExternalImportResult[] = [];
  for (const source of sources) {
    const items = source.type === "linear"
      ? await fetchLinearIssues(source, opts)
      : await fetchJiraIssues(source, opts);
    const snapshotPath = writeImportSnapshot(projectDir, source.type, {
      source: redactSource(source),
      fetched_at: new Date().toISOString(),
      items: items.map((item) => item.raw),
    });
    const applied = applyImportedItems(projectDir, items);
    if (opts.recommendSplitForXl) insertXlSplitRecommendations(projectDir, applied.tickets);
    results.push({
      provider: source.type,
      sourceLabel: sourceLabel(source),
      fetched: items.length,
      created: applied.created,
      updated: applied.updated,
      snapshotPath,
    });
  }
  return results;
}

export async function validateExternalSourceAccess(source: Extract<TicketSourceConfig, { type: "linear" | "jira" }>): Promise<void> {
  if (source.type === "linear") {
    await fetchLinearIssues(source, { importCap: 1, commentLimit: 0 });
    return;
  }
  await fetchJiraIssues(source, { importCap: 1, commentLimit: 0 });
}

export async function fetchLinearIssues(
  source: Extract<TicketSourceConfig, { type: "linear" }>,
  opts: ExternalImportOptions,
): Promise<ImportedTicketItem[]> {
  const apiKey = process.env[source.api_key_env];
  if (!apiKey) throw new Error(`Linear API key env var is not set: ${source.api_key_env}`);
  const items: ImportedTicketItem[] = [];
  let after: string | null = null;

  while (items.length < opts.importCap) {
    const first = Math.min(100, opts.importCap - items.length);
    const body = {
      query: LINEAR_ISSUES_QUERY,
      variables: {
        first,
        after,
        commentLimit: opts.commentLimit,
        filter: linearFilter(source),
      },
    };
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": apiKey,
      },
      body: JSON.stringify(body),
    });
    const json = await readJsonResponse(response, "Linear GraphQL");
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${json.errors.map((err: { message?: string }) => err.message ?? "unknown").join("; ")}`);
    }
    const issues = json.data?.issues;
    const nodes = Array.isArray(issues?.nodes) ? issues.nodes : [];
    for (const node of nodes) {
      items.push(linearIssueToImportedItem(node, opts.commentLimit));
      if (items.length >= opts.importCap) break;
    }
    if (!issues?.pageInfo?.hasNextPage || !issues.pageInfo.endCursor || nodes.length === 0) break;
    after = issues.pageInfo.endCursor;
  }
  return items;
}

export async function fetchJiraIssues(
  source: Extract<TicketSourceConfig, { type: "jira" }>,
  opts: ExternalImportOptions,
): Promise<ImportedTicketItem[]> {
  const email = process.env[source.email_env];
  const token = process.env[source.token_env];
  if (!email) throw new Error(`Jira email env var is not set: ${source.email_env}`);
  if (!token) throw new Error(`Jira API token env var is not set: ${source.token_env}`);

  const items: ImportedTicketItem[] = [];
  let nextPageToken: string | undefined;
  while (items.length < opts.importCap) {
    const maxResults = Math.min(100, opts.importCap - items.length);
    const body: Record<string, unknown> = {
      jql: source.jql,
      maxResults,
      fieldsByKeys: true,
      fields: [
        "summary",
        "description",
        "priority",
        "issuetype",
        "status",
        "labels",
        "comment",
        "assignee",
        "created",
        "updated",
        "project",
      ],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const response = await fetch(`${source.site.replace(/\/+$/, "")}/rest/api/3/search/jql`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
    });
    const json = await readJsonResponse(response, "Jira JQL search");
    const issues = Array.isArray(json.issues) ? json.issues : [];
    for (const issue of issues) {
      items.push(jiraIssueToImportedItem(source.site, issue, opts.commentLimit));
      if (items.length >= opts.importCap) break;
    }
    nextPageToken = typeof json.nextPageToken === "string" ? json.nextPageToken : undefined;
    if (!nextPageToken || issues.length === 0 || json.isLast === true) break;
  }
  return items;
}

export function applyImportedItems(
  projectDir: string,
  items: ImportedTicketItem[],
): { created: number; updated: number; tickets: TicketDef[] } {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  const existing = loadTickets(paths.tickets);
  const tickets = [...existing];
  const now = nowTimestamp(config.timezone);
  const db = new StateDb(paths.stateDb);
  let created = 0;
  let updated = 0;

  try {
    let nextNumber = nextTicketNumber(tickets);
    let nextOrder = nextTicketOrder(tickets);
    for (const item of items) {
      const matchIndex = tickets.findIndex((ticket) => hasExternalRef(ticket, item));
      if (matchIndex >= 0) {
        const current = tickets[matchIndex]!;
        tickets[matchIndex] = importedItemToTicket(item, current.id, current.order, current);
        updated++;
      } else {
        const id = `T${String(nextNumber++).padStart(3, "0")}`;
        const order = nextOrder;
        nextOrder += 1000;
        tickets.push(importedItemToTicket(item, id, order));
        created++;
      }
      const ticket = matchIndex >= 0 ? tickets[matchIndex]! : tickets[tickets.length - 1]!;
      const status = importedStatus(item);
      if (status) {
        const patch: Parameters<StateDb["upsertState"]>[1] = {
          status,
          completed_at: status === "done" || status === "canceled" ? now : null,
        };
        if (status === "done") {
          patch.evidence = `Imported ${item.provider} status: ${item.status ?? item.statusCategory ?? "done"}`;
          patch.validation_result = "not_applicable";
          patch.validation_notes = "External tracker marked this item complete before import.";
        }
        db.upsertState(ticket.id, patch, now);
      }
    }

    const errors = validateTicketDefs(tickets).filter((issue) => issue.message);
    if (errors.length > 0) {
      throw new Error(`import produced invalid tickets:\n${errors.map((err) => `- ${err.path}: ${err.message}`).join("\n")}`);
    }

    saveTickets(paths.tickets, tickets);
    return { created, updated, tickets };
  } finally {
    db.close();
  }
}

const LINEAR_ISSUES_QUERY = `
query RafiImportIssues($first: Int!, $after: String, $commentLimit: Int!, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes {
      id
      identifier
      title
      description
      priority
      estimate
      url
      createdAt
      updatedAt
      state { name type }
      team { key name }
      project { name }
      labels { nodes { name } }
      comments(first: $commentLimit) {
        nodes {
          id
          body
          createdAt
          user { name }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function readJsonResponse(response: Response, label: string): Promise<any> {
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = json?.errorMessages?.join("; ") ?? json?.message ?? json?.errors?.[0]?.message ?? text.slice(0, 300);
    throw new Error(`${label} request failed (${response.status}): ${message}`);
  }
  return json;
}

function linearFilter(source: Extract<TicketSourceConfig, { type: "linear" }>): Record<string, unknown> | undefined {
  const parts: Record<string, unknown>[] = [];
  if (source.team_key) parts.push({ team: { key: { eq: source.team_key } } });
  if (source.filter) {
    try {
      const parsed = JSON.parse(source.filter) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) parts.push(parsed as Record<string, unknown>);
    } catch {
      parts.push({ title: { containsIgnoreCase: source.filter } });
    }
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { and: parts };
}

function linearIssueToImportedItem(issue: any, commentLimit: number): ImportedTicketItem {
  const labels = Array.isArray(issue.labels?.nodes)
    ? issue.labels.nodes.map((label: { name?: unknown }) => String(label.name ?? "")).filter(Boolean)
    : [];
  const comments = Array.isArray(issue.comments?.nodes)
    ? issue.comments.nodes.slice(0, commentLimit).map((comment: any) => ({
      author: typeof comment.user?.name === "string" ? comment.user.name : null,
      body: String(comment.body ?? ""),
      createdAt: typeof comment.createdAt === "string" ? comment.createdAt : null,
    })).filter((comment: ImportedComment) => comment.body.trim())
    : [];
  return {
    provider: "linear",
    providerId: String(issue.id),
    key: typeof issue.identifier === "string" ? issue.identifier : null,
    url: typeof issue.url === "string" ? issue.url : null,
    title: String(issue.title ?? issue.identifier ?? issue.id),
    description: typeof issue.description === "string" ? issue.description : null,
    area: issue.project?.name ?? issue.team?.name ?? issue.team?.key ?? null,
    priority: typeof issue.priority === "number" ? issue.priority : null,
    size: typeof issue.estimate === "number" ? issue.estimate : null,
    status: issue.state?.name ?? null,
    statusCategory: issue.state?.type ?? null,
    labels,
    comments,
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    raw: issue,
  };
}

function jiraIssueToImportedItem(site: string, issue: any, commentLimit: number): ImportedTicketItem {
  const fields = issue.fields ?? {};
  const comments = Array.isArray(fields.comment?.comments)
    ? fields.comment.comments.slice(0, commentLimit).map((comment: any) => ({
      author: comment.author?.displayName ?? null,
      body: adfToText(comment.body),
      createdAt: typeof comment.created === "string" ? comment.created : null,
    })).filter((comment: ImportedComment) => comment.body.trim())
    : [];
  return {
    provider: "jira",
    providerId: String(issue.id ?? issue.key),
    key: typeof issue.key === "string" ? issue.key : null,
    url: issue.key ? `${site.replace(/\/+$/, "")}/browse/${issue.key}` : null,
    title: String(fields.summary ?? issue.key ?? issue.id),
    description: adfToText(fields.description),
    area: fields.project?.name ?? fields.issuetype?.name ?? null,
    priority: fields.priority?.name ?? null,
    size: null,
    status: fields.status?.name ?? null,
    statusCategory: fields.status?.statusCategory?.name ?? null,
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    comments,
    createdAt: fields.created ?? null,
    updatedAt: fields.updated ?? null,
    raw: issue,
  };
}

function importedItemToTicket(item: ImportedTicketItem, id: string, order: number, existing?: TicketDef): TicketDef {
  const priority = mapPriority(item);
  const size = mapSize(item);
  const risk = mapRisk(priority, item);
  const notes = buildImportedNotes(item);
  return {
    id,
    order,
    title: item.key ? `${item.key}: ${item.title}` : item.title,
    area: item.area || existing?.area || "Imported",
    priority,
    size,
    risk,
    depends_on: existing?.depends_on ?? [],
    summary: item.description?.trim() || item.title,
    acceptance: existing?.acceptance?.length ? existing.acceptance : [
      `Imported ${item.provider} item remains represented in Rafi.`,
      item.url ? `Provider reference is preserved: ${item.url}` : "Provider reference is preserved.",
    ],
    required_tests: existing?.required_tests?.length ? existing.required_tests : [
      "Review provider details before implementation.",
    ],
    likely_files: existing?.likely_files ?? [],
    rollback: existing?.rollback ?? (risk === "Low" ? null : "Revert the imported implementation changes for this provider item."),
    notes,
    external_refs: mergeExternalRefs(existing?.external_refs, {
      provider: item.provider,
      id: item.providerId,
      key: item.key ?? null,
      url: item.url ?? null,
    }),
  };
}

function buildImportedNotes(item: ImportedTicketItem): string | null {
  const lines = [
    `Imported from ${item.provider}${item.key ? ` ${item.key}` : ""}.`,
    item.url ? `URL: ${item.url}` : null,
    item.status ? `Status: ${item.status}${item.statusCategory ? ` (${item.statusCategory})` : ""}` : null,
    item.labels?.length ? `Labels: ${item.labels.join(", ")}` : null,
    item.comments?.length ? "Comments:" : null,
    ...(item.comments ?? []).map((comment) => {
      const author = comment.author ? `${comment.author}: ` : "";
      return `- ${author}${comment.body.replace(/\s+/g, " ").trim()}`;
    }),
  ].filter(Boolean) as string[];
  return lines.length > 0 ? lines.join("\n") : null;
}

function mergeExternalRefs(existing: TicketExternalRef[] | undefined, next: TicketExternalRef): TicketExternalRef[] {
  const refs = [...(existing ?? [])];
  const index = refs.findIndex((ref) =>
    ref.provider === next.provider && (ref.id === next.id || (next.key && ref.key === next.key)));
  if (index >= 0) refs[index] = { ...refs[index], ...next };
  else refs.push(next);
  return refs;
}

function mapPriority(item: ImportedTicketItem): TicketPriority {
  if (item.provider === "linear" && typeof item.priority === "number") {
    if (item.priority <= 1 && item.priority > 0) return "P0";
    if (item.priority === 2) return "P1";
    if (item.priority === 3) return "P2";
    return "P3";
  }
  const raw = String(item.priority ?? "").toLowerCase();
  if (/highest|blocker|urgent/.test(raw)) return "P0";
  if (/high|critical/.test(raw)) return "P1";
  if (/medium|normal/.test(raw)) return "P2";
  if (/low|lowest|minor/.test(raw)) return "P3";
  return "P2";
}

function mapSize(item: ImportedTicketItem): TicketSize {
  if (typeof item.size === "number") {
    if (item.size >= 8) return "XL";
    if (item.size >= 5) return "L";
    if (item.size >= 3) return "M";
    if (item.size >= 1) return "S";
  }
  const raw = String(item.size ?? "").toUpperCase();
  if (["XS", "S", "M", "L", "XL"].includes(raw)) return raw as TicketSize;
  return "M";
}

function mapRisk(priority: TicketPriority, item: ImportedTicketItem): TicketRisk {
  const labels = (item.labels ?? []).join(" ").toLowerCase();
  if (priority === "P0" || /\b(security|data|migration|billing|auth)\b/.test(labels)) return "High";
  if (priority === "P1") return "Medium";
  return "Low";
}

function importedStatus(item: ImportedTicketItem): TicketStatus | undefined {
  const text = `${item.status ?? ""} ${item.statusCategory ?? ""}`.toLowerCase();
  if (/\b(done|completed|complete|closed|resolved)\b/.test(text)) return "done";
  if (/\b(canceled|cancelled|duplicate|wontfix|won't fix)\b/.test(text)) return "canceled";
  if (/\b(started|in progress|indeterminate)\b/.test(text)) return "in_progress";
  if (/\b(blocked)\b/.test(text)) return "blocked";
  return "planned";
}

function hasExternalRef(ticket: TicketDef, item: ImportedTicketItem): boolean {
  return (ticket.external_refs ?? []).some((ref) =>
    ref.provider === item.provider && (ref.id === item.providerId || Boolean(item.key && ref.key === item.key)));
}

function nextTicketNumber(tickets: TicketDef[]): number {
  let max = 0;
  for (const ticket of tickets) {
    const match = /^T(\d+)$/i.exec(ticket.id);
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max + 1;
}

function nextTicketOrder(tickets: TicketDef[]): number {
  const max = tickets.reduce((highest, ticket) => Math.max(highest, ticket.order), 0);
  return Math.max(1000, Math.ceil(max / 1000) * 1000 + 1000);
}

function writeImportSnapshot(projectDir: string, provider: string, payload: unknown): string {
  const dir = join(projectDir, ".tickets", "imports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${provider}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relative(projectDir, path).replace(/\\/g, "/");
}

function redactSource(source: TicketSourceConfig): Record<string, unknown> {
  if (source.type === "linear") {
    return { type: source.type, api_key_env: source.api_key_env, team_key: source.team_key, filter: source.filter };
  }
  if (source.type === "jira") {
    return { type: source.type, site: source.site, email_env: source.email_env, token_env: source.token_env, jql: source.jql };
  }
  return source;
}

function sourceLabel(source: TicketSourceConfig): string {
  if (source.type === "linear") return source.team_key ? `Linear team ${source.team_key}` : "Linear";
  if (source.type === "jira") return `Jira ${source.site}`;
  return "local";
}

function adfToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfToText).filter(Boolean).join("\n").trim();
  if (typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  if (typeof node.text === "string") return node.text;
  const content = adfToText(node.content);
  if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem") return content;
  if (node.type === "bulletList" || node.type === "orderedList" || node.type === "doc") return content;
  return content;
}
