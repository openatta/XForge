---
name: xforge-explore
description: Investigate code, specifications, constraints, defects, or solution options without writing, and narrow an ambiguous idea into a proposal-ready scope; use when the user asks for analysis, diagnosis, comparison, or Flow selection but has not authorized project changes.
allowed-tools: Read, Grep, Glob, Bash(npx:*)
---

# Invariants

- Run `npx --no-install xforge state` first, and `npx --no-install xforge state --change <id>` for an existing Change. Never guess the Flow, paths, constraints, or state.
- Treat code, Constitution, Rules, Specs, and CLI diagnostics as facts; distinguish observations, hypotheses, and recommendations.
- Remain read-only and never present exploration output as an Artifact, Gate Evidence, or completion claim.

# Authority

- You may read and search the project, run side-effect-free diagnostics, compare options, and recommend Change scope and Flow.
- Do not create or modify Changes, code, Specs, Scaffold, Evidence, generated directories, or external systems.
- If the user asks to record or implement the result, stop Explore and hand off to `xforge-propose` or the Skill for the applicable ready Action.

# Execution

1. Query State and resolve relevant modules, active Changes, Constitution, Rules, PermissionPolicy, Hook/Audit coverage, Specs, and Adapter local/cloud/managed/blocking degradation.
2. Investigate code and runtime facts before mapping integration points, constraints, unknowns, and impact.
3. Compare viable approaches with compatibility, risk, rollback cost, and verification. Ask only questions the project cannot answer that would materially change the result.
4. When sufficiently clear, return a bounded Change description, classification, path scope, and Quick/Solid/Major recommendation.
5. Confirm that this Skill made no workspace changes.

# Evidence

- Cite concrete files, command results, or existing Specs. Natural-language inference is not machine evidence.
- Report the read-only scope, key facts, remaining unknowns, and recommended next step.

# Stop and rework

- Stop and request authority before any write, permission expansion, sensitive external-state access, or material decision on the user's behalf.
- In Portable mode, state that the CLI did not enforce governance constraints.

# Judgment calls

- Users describe an already-decided implementation, not the underlying problem. "Add a caching layer" may really be "the search endpoint times out under load" — recommending scope or a Flow on the stated solution instead of the underlying problem locks the eventual Change into an approach nobody has actually evaluated.
- "Sufficiently clear" is a judgment call, not a checklist. A scope that reads clean in isolation can still hide an unstated assumption (who owns the migrated data, what happens to existing callers) that only surfaces once Design starts — when in doubt, surface the assumption now instead of letting Propose inherit it silently.
