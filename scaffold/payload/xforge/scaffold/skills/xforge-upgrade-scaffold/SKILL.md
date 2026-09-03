---
name: xforge-upgrade-scaffold
description: Merge a staged newer XForge Scaffold into this project's own, preserving the project's adaptations and reporting what needs a human decision; use after `xforge upgrade-scaffold` has staged a version and written MERGE.md.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# Invariants

- Read `xforge/.upgrade/MERGE.md` and `xforge/.upgrade/plan.json` first. They name the whole job; nothing here requires reading the Scaffold to discover it.
- The `identical` files are already settled. Do not open them — the plan exists so the work is the few files that differ, not the seventy-eight that do not.
- `xforge/scaffold/**`, `xforge/flows/**` and `xforge/scripts/**` are the project's; `xforge/.upgrade/incoming/**` is the release's, laid out the way it merges (`incoming/scaffold/`, `incoming/flows/` and `incoming/scripts/` each into the tree of the same name). Neither side is authoritative over the other by default.
- A Flow is never a routine adopt. It states how many approvals a Stage needs and where a blocker sends the work back — the project's own governance. Report what differs and leave the decision to a person; adopting one also invalidates the approvals of any Change still running under it.
- `xforge/.upgrade/snapshot/**` is the restore point and `xforge/UPGRADING.md` is the in-flight marker, written by the CLI at stage and removed at complete or rollback. Never write to either.
- Read what this project currently selects with `xforge state --kind skills` (and `--kind rules`), not by parsing `xforge/manifest.yaml`. What is selected is a resolved fact the CLI reports; the file is one input to it.
- `manifest.scaffold.version` tracks the Scaffold's *content* and only `upgrade-scaffold --complete` advances it, so a project whose CLI is newer than its Scaffold is in a normal state, not a broken one. If `xforge upgrade-scaffold` refuses because the declared CLI does not match the running one, run `xforge update` first: it moves the CLI pin alone and leaves the Scaffold pin where the files are.
- `XFORGE_UPGRADE_VERSION_PIN_UNRELIABLE` means the pin says this Scaffold is already the incoming version while files disagree — written by an older `update` that advanced the pin without merging anything. The starting version is unrecoverable, so the reported span is meaningless; the merge itself is computed from file content and is unaffected. Say so once and continue.

# Authority

- Write `xforge/scaffold/**` and `xforge/scripts/**`, and `xforge/manifest.yaml` only to record selections a person explicitly approved. **You cannot write `xforge/flows/**` at all** — the `protected-files` PermissionPolicy denies it, so the deny is a refused tool call rather than a rule you could decide to break.
- Do not touch `xforge/changes/**`, `xforge/specs/**`, the audit chain, approvals, `xforge/constitution.md`, or `xforge/architecture.md`. The Scaffold can be regenerated; the governance record cannot, and an audit chain that could be rebuilt would not be worth keeping.
- Never delete a `project-only` file. Nothing distinguishes an asset upstream dropped from one this project wrote, so deleting on that reading destroys somebody's work on the strength of a guess.

# Execution

1. For each `added` file: copy it in verbatim. Do not add it to Manifest selection — a file arriving in a release is not a decision to run it. **A new Flow is the exception, on both counts**: `xforge/flows/**` is denied to you, and adopting a Flow is a governance decision either way. Report the new Flow, say what it is for, and leave both the copy and the selection to a person — the same answer Invariant 4 gives for a changed one, for the same reason.
2. For each `changed` file: read both versions. Adopt what the new one **rules**; keep what this project **knows**. A Gate carrying a real test command, a Script carrying code this project runs, a Skill carrying wording this project chose, a threshold somebody tuned — those are facts about this project and they survive the upgrade. In a Skill this line has a place you can point at: **`# Judgment calls` is the project's section and `# Invariants`, `# Authority` and `# Execution` are the product's.** The first holds what this project decided about how to work; the other three hold how the CLI and the Flow have to be driven, and a project that keeps its own version of those is a project whose Agents will be refused by a control plane that moved. Take the upstream text for the three, keep yours for the one, and read the rest — `# Evidence`, `# Stop and rework` — on the merits. This is a convention, not something the tool enforces: nothing compares sections, so it holds only while the merger honours it.
3. Keep English and `_cn` Skill variants equivalent. Merging one language and not the other leaves the project with two Skills that disagree, and whichever an Agent reads is then a matter of the Manifest's language setting rather than of what the project decided.
4. Run `xforge upgrade-scaffold --complete`, then `xforge doctor`. `--complete` reprojects on its own, so `xforge install` is not a step here.

# Evidence

- Report, per `changed` file, which side you took and why in one line. "Adopted upstream" and "kept ours" are both answers; an unreported merge is not.
- List every asset the plan marked shipped-but-not-selected, and say plainly that selecting it is the user's decision, not yours.
- Quote `xforge upgrade-scaffold --complete`'s adoption count verbatim. It reports how many planned files now match the release; it does not grade the merge, and restating it as a score would invent a judgement the CLI did not make.

# Stop and rework

- Stop when a `changed` file's two versions cannot both hold — when the release removes a rule the project depends on, or renames something the project references. That is a decision about the project, not about the merge.
- Stop rather than resolve a conflict by taking the newer file wholesale. Preferring upstream is the one resolution that is always available and almost never right; it is how a project silently loses the adaptation the Scaffold existed to invite.
- Stop when `xforge/.upgrade/incoming/` is missing or `xforge/.upgrade/plan.json` does not parse: run `xforge upgrade-scaffold` rather than reconstructing the plan by reading directories.

# Judgment calls

- A file that differs only in wording still deserves the question. Upstream rewrites a Skill's prose because the old wording misled an Agent, so "it means the same thing" is exactly the claim the rewrite disputes.
- Selection is a separate decision from content, and it is the one that changes behaviour. Copying `xforge-architect` in changes nothing; adding it to `scaffold.skills` changes what every Agent on the project is told to do. Bring the file, report the choice.
- A merge with no conflicts is a normal outcome, not a suspicious one. Most releases change files no project has touched, and inventing a difficulty to look thorough wastes the reader's attention on the one that matters.
