---
name: xforge-apply
description: Implement the next tasks for a Change whose Flow apply prerequisites are satisfied.
license: MIT
compatibility: Requires a matching XForge protocol 1 CLI.
metadata:
  author: xforge (adapted from OpenSpec)
  version: "1.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# Purpose

Implement a selected Change incrementally while keeping its task record honest.

# Preconditions

Resolve an unambiguous Change ID and obtain user authorization to implement it.
The `apply.ready` value from state must be true. A Prime approval must be an
external granted decision, never an Agent-authored assertion.

# State Query

Run `xforge state --change <id>` at the start and after material artifact edits.
Read every returned context file, the Constitution, relevant Specs/Rules, scope,
apply prerequisites, tasks tracking path, and optional work-package state. Do
not infer paths or readiness.

# Allowed Writes

Main Agent may write the task tracker, `work-packages.yaml`, and delivery records
under the active Change. A Worker may write only its assigned `write_paths` in
its assigned worktree; it returns its delivery contract to Main Agent and does
not hand-write Evidence. Planning artifacts may be corrected when implementation
uncovers a false assumption, but announce the divergence and re-run state.
Main Specs and archive paths are not writable by this Skill.

# Procedure

- For a `solid` or `prime` Change with at least two dependency-independent,
  non-overlapping write scopes, Main Agent may derive `work-packages.yaml` from
  Specs, Design, and Tasks. Each package has exactly `id`, `goal`, `depends_on`,
  `inputs`, `write_paths`, `skills`, `verify`, and `done_when`.
- Re-query state to validate the DAG, required inputs, Skills, Change scope,
  protected paths, and ready packages before creating any worktree.
- Main Agent pins the returned Git base, creates one branch/worktree per ready
  Worker, and dispatches exactly one package to each Worker. Do not parallelize
  packages whose paths or external resources can conflict.
- After a Worker returns, Main Agent validates its commit and writes the fixed
  delivery record to
  `<change>/evidence/agents/<package-id>/<execution-id>.yaml`; the filename,
  package ID, and execution ID must agree. Re-query state before releasing
  dependent packages.
- Use one Integrator only when multiple commits or shared files require it.
  High-risk or cross-system integration is handed to an independent Reviewer.
- Without a work-package plan, work through dependency-ready unchecked tasks in
  order as a single Main Agent execution.
- Make the smallest scoped change that satisfies the Artifact requirements.
- Add deterministic tests for scenarios and failure paths, not just happy paths.
- Run the proportionate test/lint/build commands after each coherent unit.
- Mark a checkbox complete only after implementation and its verification pass.
- If reality invalidates the plan, pause implementation, update the governing
  Artifact with the user's authorization, and re-query state.

# Verification

Run relevant project tests and `xforge check --change <id>`. The check validates
successful delivery commits and re-runs every work-package `verify` command into
bounded XForge Evidence before mandatory Flow Gates. Report task/package counts,
changed paths, test results, and unresolved risks. Test prose, a delivery record,
or a checked box alone is not Gate evidence.

# Stop Conditions

Stop on failed prerequisites, invalid DAG, conflicting or escaped write paths,
missing inputs/Skills, dependency commit drift, destructive migration not
approved in Prime artifacts, failing checks, secrets, or material ambiguity.
Do not archive; hand off to `xforge-verify` when all tasks and work packages are
truthfully done.
