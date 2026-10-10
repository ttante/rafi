# Rafi implementation handoff

Packaged 2026-10-10. Copy this entire `rafi-plan-docs/` folder to the **root of the actual Rafi development repository**. Start the coding agent in that repository.

## Start here

Give the agent this instruction:

```text
Implement the Rafi harness improvement plan in rafi-plan-docs/.
Read rafi-plan-docs/AGENT-INSTRUCTIONS.md and the repository's applicable
agent rules first. Begin with IMP-01 and IMP-02, reconcile current code and
existing repairs, establish the test baseline and separate Rafi backlog,
then implement dependency-ready steps with test-first regression coverage.
Continue through all six phases, using measured evidence to adopt, reject
or defer optional experiments. Preserve all scope, ownership, budget,
uncertainty, independent-QA and finalization protections. Consult me at
concrete consequential decision gates; continue unaffected work meanwhile.
Keep durable progress and evidence so another session can resume.
Do not commit, push, publish or deploy unless I explicitly authorize it.
```

This prompt requests implementation in the receiving repository. The planning documents alone do not authorize a release, paid service, new external data sharing, destructive operation, or an unresolved consequential contract change.

## Contents and reading order

1. [Agent instructions](AGENT-INSTRUCTIONS.md): execution workflow, authorization boundaries, regression protections, progress and reporting.
2. [Requirements](rafi-harness-requirements.md): all 84 requirements and preserved research; acceptance authority.
3. [Regression review](rafi-harness-regression-review.md): CR01–CR24, existing behavior to preserve and required safeguards.
4. [Design brief](rafi-harness-implementation-design.md): verification/certificate/ownership boundaries and decisions D01–D12.
5. [Implementation plan](rafi-harness-implementation-plan.md): 47 steps across all six phases, dependencies, coverage matrices, protected suites, VT01–VT12 and verification gates G0–G6.
6. [Validation script](validate-plan-docs.py): dependency, traceability, links and document-integrity checks using Python's standard library.

Run from Rafi's repository root:

```sh
python3 rafi-plan-docs/validate-plan-docs.py --repo-root .
```

This checks the planning package. It does not run application tests or certify runtime reliability.

## Provenance and portability

The four planning documents were copied from MoneyFarm's `docs/`, with source/test links changed from its `rafi-ref` clone to the receiving Rafi repository. Historical dates and evidence limits remain intact. They reference CLI 0.9.20/runtime 1.7.20 at commit `4aa437b3cf19d83d7bb5dc8482bb4b04709c887a`. The receiving repository is authoritative for implementation; the agent must revalidate current paths, versions, behavior and tests.

Original investigation copies remain in MoneyFarm for reference. Use this transferred package as the implementation input, then maintain implementation progress in the Rafi repository. Do not reconcile competing backlogs between the two projects.

MoneyFarm's `docs/rafi-plan.md`, `docs/rafi-plan.json` and versioned `docs/rafi-plans/` describe the MoneyFarm application, not Rafi's harness improvement work; they are excluded from this product handoff. Historical Rafi repair documents referenced by the package are expected in the receiving repository's `docs/`; consult later superseding sections before interpreting earlier defect claims.
