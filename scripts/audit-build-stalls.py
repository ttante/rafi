#!/usr/bin/env python3
"""Read-only build-stall evidence; never opens a provider or resumes a run.

Usage: python3 scripts/audit-build-stalls.py PROJECT [PROJECT ...]
       --codex-sessions /path/to/codex/sessions

Only reads transcripts whose session IDs occur in the supplied projects. Output
contains timings, identities and sizes, not transcript bodies or tool contents.
Database reads use one transaction per database; separate databases and provider
logs are not an atomic project snapshot. An inactive WAL database with no WAL
file can be read with immutable=1 when ordinary read-only access cannot open it.
"""
import argparse
import collections
import datetime
import json
import pathlib
import sqlite3


def seconds(start, end):
    if not start or not end:
        return None
    return round((datetime.datetime.fromisoformat(end.replace("Z", "+00:00")) -
                  datetime.datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds(), 3)


def database(path):
    mode = "read-only"
    try:
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        connection.execute("SELECT name FROM sqlite_master LIMIT 1").fetchall()
    except sqlite3.OperationalError:
        if "connection" in locals():
            connection.close()
        if pathlib.Path(str(path) + "-wal").exists():
            raise
        mode = "immutable-no-wal"
        connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("BEGIN")
    return connection, mode


def query(db, sql):
    return [dict(row) for row in db.execute(sql)]


def audit(project):
    project = pathlib.Path(project).resolve()
    output = {"project": str(project), "databaseReadModes": {}}
    for name in ["observability", "recovery"]:
        path = project / ".rafi" / (name + ".sqlite3")
        before = path.stat()
        db, mode = database(path)
        output["databaseReadModes"][name] = mode
        try:
            if name == "observability":
                output["spans"] = query(db, "SELECT run_id,role,kind,name,started_at,ended_at,duration_ms,outcome FROM run_spans WHERE kind IN ('preflight','provider_turn','compaction','user_wait') ORDER BY started_at")
                output["executions"] = query(db, "SELECT run_id,started_at,ended_at,outcome FROM run_executions ORDER BY started_at")
            else:
                output["runs"] = query(db, "SELECT run_id,kind,status,checkpoint,created_at,updated_at FROM workflow_runs ORDER BY created_at")
                output["supervisors"] = query(db, "SELECT run_id,status,generation,heartbeat_at,updated_at FROM supervisor_leases ORDER BY updated_at")
                output["decisions"] = query(db, "SELECT run_id,status,created_at,updated_at FROM human_decisions ORDER BY created_at")
                output["compactions"] = query(db, "SELECT run_id,role,provider_session_id,status,error,created_at,updated_at,before_sample_json,after_sample_json FROM compaction_attempts ORDER BY created_at")
                output["handoffs"] = query(db, "SELECT run_id,role,generation,state,failure,predecessor_session_id,successor_session_id,predecessor_session_ref_json,successor_session_ref_json,created_at,accepted_at FROM handoffs ORDER BY created_at")
                output["resumeSessions"] = query(db, "SELECT r.run_id,r.status AS run_status,s.status AS session_status,s.session_json,s.updated_at FROM branch_resume_sessions s JOIN workflow_runs r ON r.run_id=s.run_id")
                output["dispatches"] = query(db, "SELECT run_id,idempotency_key,status,created_at,updated_at FROM operation_journal WHERE kind='provider-dispatch' ORDER BY created_at")
                output["decisions"] = query(db, "SELECT run_id,decision_id,status,created_at,updated_at FROM human_decisions ORDER BY created_at")
                output["supervisors"] = query(db, "SELECT run_id,status,generation,heartbeat_at FROM supervisor_leases ORDER BY updated_at")
                output["reviews"] = query(db, "SELECT run_id,ticket_id,review_number,status,source_digest,created_at,updated_at FROM qa_review_attempts ORDER BY created_at")
                output["remediations"] = query(db, "SELECT run_id,ticket_id,generation,status,created_at,updated_at FROM qa_remediation_attempts ORDER BY created_at")
            db.rollback()
        finally:
            db.close()
        after = path.stat()
        if mode == "immutable-no-wal" and (before.st_mtime_ns != after.st_mtime_ns or before.st_size != after.st_size or pathlib.Path(str(path) + "-wal").exists()):
            raise RuntimeError(f"Database changed during immutable read: {path}; rerun against a stable copy")
    logs = []
    for path in sorted((project / ".foreman").glob("*.jsonl")):
        counts = collections.Counter()
        relevant = []
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            event = row.get("event", "unknown")
            counts[event] += 1
            if event in ["preflight", "step", "batch-start", "batch-end", "handoff-transfer", "recovery-handoff-accepted", "branch-issue", "blocked-recovery"]:
                relevant.append({key: row[key] for key in ["ts", "event", "statusKind", "generation", "predecessorSessionId", "successorSessionId", "code"] if key in row})
        logs.append({"file": str(path), "counts": dict(counts), "events": relevant})
    output["logs"] = logs
    output["deliverySessions"] = [{"file": str(path), **json.loads(path.read_text())} for path in sorted((project / ".foreman/delivery-sessions").glob("*.json"))]
    return output


def transcripts(root, wanted):
    output = {}
    for path in pathlib.Path(root).rglob("*.jsonl"):
        session = next((key for key in wanted if path.name.endswith(key + ".jsonl")), None)
        if not session:
            continue
        record = {"file": str(path), "compactions": [], "taskStarts": [], "taskCompletions": [], "userMessageBytes": [], "tokenUsage": []}
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            payload = row.get("payload", {})
            timestamp = row.get("timestamp")
            if row.get("type") == "session_meta":
                record["cliVersion"] = payload.get("cli_version")
            elif row.get("type") == "compacted":
                record["compactions"].append(timestamp)
            elif row.get("type") == "event_msg" and payload.get("type") == "task_started":
                record["taskStarts"].append(timestamp)
            elif row.get("type") == "event_msg" and payload.get("type") == "task_complete":
                record["taskCompletions"].append(timestamp)
            elif row.get("type") == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") or {}
                total = (info.get("total_token_usage") or {}).get("total_tokens")
                latest = (info.get("last_token_usage") or {}).get("total_tokens")
                window = info.get("model_context_window")
                if total is not None or latest is not None:
                    record["tokenUsage"].append({"at": timestamp, "cumulativeTokens": total,
                                               "latestTokens": latest, "contextWindow": window})
            elif row.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") == "user":
                body = "\n".join(part.get("text", "") for part in payload.get("content", []) if isinstance(part, dict))
                record["userMessageBytes"].append({"at": timestamp, "bytes": len(body.encode())})
        output[session] = record
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("projects", nargs="+")
    parser.add_argument("--codex-sessions")
    args = parser.parse_args()
    projects = [audit(project) for project in args.projects]
    wanted = set()
    for project in projects:
        for row in project["compactions"]:
            wanted.add(row["provider_session_id"])
        for row in project["handoffs"]:
            wanted.update([row["predecessor_session_id"], row["successor_session_id"]])
    wanted.discard(None)
    provider = transcripts(args.codex_sessions, wanted) if args.codex_sessions else {}
    for project in projects:
        for row in project["compactions"]:
            row["hostDurationSeconds"] = seconds(row["created_at"], row["updated_at"])
            candidates = [(seconds(row["created_at"], at), at) for at in provider.get(row["provider_session_id"], {}).get("compactions", [])]
            candidates = [(duration, at) for duration, at in candidates if duration is not None and 0 <= duration < 600]
            if candidates:
                duration, at = min(candidates)
                row["providerCompletionCandidate"] = {"at": at, "secondsAfterHostStart": duration, "secondsAfterHostOutcome": seconds(row["updated_at"], at)}
            samples = provider.get(row["provider_session_id"], {}).get("tokenUsage", [])
            preceding = [sample for sample in samples if sample["at"] <= row["created_at"]]
            if preceding:
                row["latestProviderUsageBeforeAttempt"] = preceding[-1]
    print(json.dumps({"observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "projects": projects, "providerTranscripts": provider}, indent=2))


if __name__ == "__main__":
    main()
