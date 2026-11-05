// `rafi tickets init` (FLAG-TK-3, FILE-24, FILE-25, FILE-27, FMT-K1): `.tickets/config.yaml` with today's defaults
// (500, 20000, UTC), the ticket schema, the tracker rules with a version line, and the progress doc. Files already
// there are kept; `--queue-limit` is gone (it isn't an option any more).
import path from "node:path";
import { stringify } from "yaml";
import type { Engine } from "../api/engine.js";
import { ENGINE_VERSION_LINE } from "../version.js";
import { TRACKER_CONFIG, writeProgressDoc } from "./render.js";

export interface InitOptions {
  readonly appName?: string;
  readonly timezone?: string;
  readonly implementationLimit?: number;
  readonly viewLimit?: number;
  readonly docsRoot: string;
}

const RULES = (doc: string) => `<!-- ${ENGINE_VERSION_LINE}; regenerated on upgrade and by rafi compile -->
# Tracker Rules

Rafi builds one ticket at a time and gives each agent only its own ticket. People read \`${doc}\`; agents don't.
Change tickets with \`rafi tickets\` (update, complete, block, unblock, cancel, reorder) or by editing
\`.tickets/tickets.yaml\`; rafi records each change and rewrites the progress doc.
`;

const SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "https://json-schema.org/draft/2020-12/schema", title: "rafi 1.0 tickets",
  type: "object", required: ["tickets"], properties: { tickets: { type: "array", items: { type: "object",
    required: ["id", "title", "risk", "acceptance"] } } } };

export async function initTracker(engine: Engine, o: InitOptions): Promise<string[]> {
  const { fs } = engine.deps;
  const at = (file: string) => path.join(engine.projectDir, file);
  const made: string[] = [];
  const put = async (file: string, text: string) => {
    if (await fs.stat(at(file))) return;
    await fs.mkdir(path.dirname(at(file)));
    await fs.writeAtomic(at(file), text);
    made.push(file);
  };
  const doc = path.posix.join(o.docsRoot, "ticket-progress.md");
  await put(TRACKER_CONFIG, stringify({ app_name: o.appName ?? path.basename(engine.projectDir),
    implementation_limit: o.implementationLimit ?? 500, view_limit: o.viewLimit ?? 20000, timezone: o.timezone ?? "UTC",
    paths: { tickets: ".tickets/tickets.yaml", tracker_rules: ".tickets/tracker-rules.md", progress_doc: doc,
      archive_doc: path.posix.join(o.docsRoot, "ticket-archive.md") } }));
  await put(path.join(".tickets", "schema", "tickets.schema.json"), `${JSON.stringify(SCHEMA, null, 2)}\n`);
  await put(path.join(".tickets", "tracker-rules.md"), RULES(doc));
  const file = await writeProgressDoc(engine, engine.fold(), { docsRoot: o.docsRoot, force: true });
  if (file) made.push(path.relative(engine.projectDir, file));
  return made;
}
