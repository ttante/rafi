// The three tables and four indexes of ARCH 3.2, verbatim.
export const name = "initial";

export const sql = `
CREATE TABLE events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT NOT NULL UNIQUE,
  run_id    TEXT,
  ticket_id TEXT,
  type      TEXT NOT NULL,
  v         INTEGER NOT NULL,
  class     TEXT NOT NULL CHECK (class IN ('state', 'detail')),
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  source    TEXT,
  origin    TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'imported')),
  idem_key  TEXT,
  data      TEXT NOT NULL
);
CREATE INDEX events_run    ON events (run_id, seq);
CREATE INDEX events_ticket ON events (ticket_id, seq);
CREATE INDEX events_type   ON events (type, seq);
CREATE INDEX events_idem   ON events (idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE blobs (
  digest    TEXT PRIMARY KEY,
  bytes     INTEGER NOT NULL,
  sensitive INTEGER NOT NULL,
  data      BLOB NOT NULL
);
CREATE TABLE lease (
  run_id       TEXT PRIMARY KEY,
  instance     TEXT NOT NULL,
  host         TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
`;
