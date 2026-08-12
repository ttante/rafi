# Rafi live todo fixture

This owned acceptance fixture represents a Vite/React/TypeScript frontend,
FastAPI/SQLAlchemy/Alembic API, and PostgreSQL Compose stack. It is copied to a
temporary directory by `pnpm run test:live-interview`; never run the live
script as part of CI. The full application skeleton is intentionally kept out
of package tests so the authenticated agent journey is the only consumer.

The fixture's feature contract is [FEATURES.md](FEATURES.md). It deliberately
uses the stable IDs `F-LABELS`, `F-DUE-DATES`, and `F-COMPLETION-FILTERS` so the
live runner can verify plan/ticket coverage without prescribing implementation.
