# Plan update approval: future improvement

Status: **to investigate.** Nothing has been changed yet. Raised 2026-10-28 during the moneyTree T001 resume.

## Today's behavior

Every `rafi resume` asks:

> How should Rafi handle implementation-plan updates during this resumed process?
> - Ask me to review each plan update (Recommended)
> - Auto-approve plan updates for this resumed process

- **Where:** `resolvePlanUpdateApproval` and `promptPlanUpdateApproval` in `packages/rafi/src/buildResume.ts`.
- **How it's applied:** `autoApprovePlanUpdates` in `packages/ai-foreman/src/cli/start.ts`.
- **What it covers:** whether rafi may continue if the approved ticket plan (`.tickets/tickets.yaml`) changes. That happens when the user edits or re-plans tickets, or when "Discuss with Planner" rewrites a ticket.
- **Problems:**
  - The answer lasts only for that one resume and isn't saved, so the user is asked every time.
  - The situation it guards against is rare, so the question is usually noise.
  - `--yes` skips the question but also auto-approves unrelated things, such as Builder and QA network access.

## Proposed direction

### 1. Requirements that can't change

The user can mark specific requirements as **locked**, either in the plan or per ticket. A locked requirement can never be changed, dropped or weakened by an automatic plan update. Rafi must stop and ask before touching it.

### 2. Default: change the plan, then tell the user

For anything not locked, rafi makes the plan update **without asking**. It then tells the user what changed and why:
- in the terminal at the moment it happens;
- in the build summary;
- in a durable plan-change log.

Asking first stays available as an opt-in setting for users who want it.

### 3. A backup plan you can switch to

When rafi changes the plan, it keeps the **previous version as a backup**. Later, the user can tell rafi to switch back to it: for one ticket, from a chosen change onward, or entirely. Rafi then rebuilds affected work against the restored version.

### 4. Saved choice, not a question every time

- The setting (auto with notice, or ask) is saved per project, or per build, and isn't asked again on resume.
- It's separate from `--yes`, so approving plan updates doesn't also approve network access.

## Questions to investigate

- **Where locked requirements live:** a field on each ticket's acceptance items, a project-level list, or both? And how does the planner keep the marks when it rewrites tickets?
- **What counts as a plan update:** edited acceptance, new or removed tickets, reordering, scope changes. Should small rewording be ignored?
- **How "tell the user" works** when the build runs unattended or in the background: a notification, the summary, or a manager command such as `rafi manager --ask "/plan-changes"`.
- **Switching back to the backup plan:**
  - What happens to work already done under the changed plan? Keep it, re-run QA against the old requirements, or revert it?
  - How long are backups kept, and how many?
- **How this fits with QA:** QA must always review against the plan currently in force. Saved approvals and QA certificates must go stale exactly when the requirements they covered change.
- **Risk:** this touches plan approval binding (`planApprovalBinding`), resume and saved decisions, the same area as the bugs in `QA_MANUAL_CHECKS_AND_RECOVERY_FINDINGS.md`. It needs a careful design and a full "resume from every state" test table before building.
