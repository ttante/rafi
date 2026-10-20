# Rafi audit reports

Rafi exposes a read-only audit view for retained build runs:

```sh
rafi audit /path/to/project
rafi audit /path/to/project --run RUN_ID --format json
```

When `--run` is omitted, Rafi selects the newest retained build run. Reports
are generated from the existing host-owned observability and recovery records;
the command does not create databases, migrate state, change tickets, or
export provider transcripts.

## Health statuses

- `complete`: the retained diagnostic records satisfy the checks performed by
  the audit view.
- `partial`: the build result is still reported separately, but bounded or
  historical diagnostics are missing.
- `blocked`: a non-terminal run is missing an unavailable source needed for a
  safe diagnostic or recovery decision. This does not mean the build failed.
- `corrupt`: retained span invariants are inconsistent and require
  investigation.

An audit status never replaces the build status. A completed build can have a
partial audit, and an incomplete audit must not be interpreted as a pass.

## Bounded output

Markdown is the default. Use JSON for tooling. `--max-spans` is capped at 200;
the default is 100. Provider conversations and unrestricted command output
are not included. Existing host authorization and retention rules remain the
source of truth for any separately protected evidence export.

The report shows the selected run, diagnostic schema, retention mode, timing
contributors, QA counts, findings, and explicit limitations. Older runs are
labelled as historical/partial when current fields were not captured; Rafi
does not fabricate timing, source, or evidence values.
