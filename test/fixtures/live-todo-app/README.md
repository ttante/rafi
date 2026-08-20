# Rafi live todo fixture

This owned acceptance fixture represents a Vite/React/TypeScript frontend,
FastAPI/SQLAlchemy/Alembic API, and PostgreSQL Compose stack. It is copied to a
temporary directory by the opt-in `test:live-create` and
`test:live-ticket-plan` journeys; never run the authenticated live scripts as
part of normal CI. The full application skeleton is intentionally kept out of
package tests so the authenticated journeys are its only consumers.

The fixture's feature contract is [FEATURES.md](FEATURES.md). It deliberately
uses the stable IDs `F-LABELS`, `F-DUE-DATES`, and `F-COMPLETION-FILTERS` so the
create journey can verify plan/ticket coverage without prescribing
implementation. The ticket-plan journey replaces this README and excludes that
feature contract in its temporary copy, then supplies the independently owned
fixtures under `test/fixtures/live-ticket-plan/`.
