# Live guided ticket-plan fixture

These files seed the opt-in authenticated `rafi tickets plan` acceptance
journey. The runner copies the todo application separately, initializes RAFI
through public CLI commands, installs `tickets.yaml`, and keeps
`REQUIREMENTS.md` outside the copied project so RAFI must snapshot it as an
external local source.

The stable requirement and ticket IDs are an assertion contract. Generated
ticket prose is checked semantically rather than snapshotted verbatim.
