---
name: xforge-continue
description: Resume a Change from current machine state and execute the next legal Action consistent with user authority; use when the user says continue, resume, do the next step, or a new session must recover from an interruption.
allowed-tools: Read Grep Glob Bash
---

# Invariants

- Run `npx --no-install xforge state`, resolve one Change, then run State for that Change. Never hard-code Quick/Solid/Major order.
- Select only a CLI typed `nextActions` entry with `status=ready` whose actor, authority, and user authorization match, and execute its command. Never infer the next step from Markdown or Flow familiarity.
- Refresh State after every Action and never advance from stale session/model memory.

# Authority

- Authority comes from the selected ready Action and its Skill; Continue never expands it.
- Do not claim external, CLI, or user-decision Actions. Archive always needs explicit authority.
- Approval Actions may only request (submit) a human/external provider decision via the terminal or an mcp provider poll; an Agent never self-approves.

# Execution

1. Resolve whether the user authorized one Action or continuous progress and remove multi-Change ambiguity first.
2. Read ready Actions, blocking diagnostics, inputs, writes, doneWhen, requiredEvidence, and reworkTo.
3. Choose an authorized Action, load and fully follow its Skill, then query State again.
4. For continuous progress, repeat without skipping Clarify/Check, failed Gates, or revision checks.
5. Stop at ready-to-archive by default unless the user explicitly authorizes archive.

# Evidence

- Report each consumed Action, State revision, actual changes, satisfied Evidence, and final next Action.

# Stop and rework

- Stop on material ambiguity, scope or permission expansion, failed Gate, stale revision, external side effect, or no ready Action.
- Follow State `reworkTo`; never choose a later Stage to bypass a problem.
- When an Approval Action fails or blocks because the configured provider is missing, unreachable, or not permitted by policy (for example `XFORGE_APPROVAL_PROVIDER_FORBIDDEN`) — as opposed to a `status: pending` Action genuinely awaiting a human decision — this is a configuration gap, not ordinary pending review. Stop, do not retry, and tell the user the approval provider needs to be configured: point at manifest.yaml `approvals.providers` and the Flow's `approvalPolicies`.
