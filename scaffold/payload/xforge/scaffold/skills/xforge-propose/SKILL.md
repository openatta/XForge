---
name: xforge-propose
description: Create a governed Change and only the change.yaml, proposal, and delta Specs allowed by the Propose Stage; use when the user wants a sufficiently clear idea, defect, or feature formally specified but has not authorized implementation.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# Invariants

- **Enter** with `xforge state --field nextActions --field diagnostics --field constitution --field project --field flows --field changes --field specs`: the ready `create-change` Action (which carries the `change.yaml` template and where it goes), the Constitution's version and path, the Changes path, the modules, the Specs, and each Flow with the `policy` its eligibility is decided against. Read the Constitution from the path this reports; State carries its version and path, not its text. **This Stage enters through `state` rather than `stage` because there is no Change yet — from step 3 onward, `xforge stage --change <id>` is the entry and it carries the Action's inputs as text.**
- Once `change.yaml` exists, every later read is `xforge stage --change <id>`: it returns where the Change stands, the ready Action with its `writes` and `requiredSections`, and under `owes` every Artifact this Stage still owes with its `instruction` and `outline`, the text of that Action's `inputs`, the Constitution, and the diagnostics. Do not open those inputs separately — they arrived.
- **Run the command `state.nextActions[].command` gives; do not assemble one.** Step 3 is the only exception, and it exists because no Action creates a Change.
- Consume only the ready Action for `xforge-propose`, and reread its `inputs` from disk before every write.
- Decide the Flow against each Flow's `policy.eligibleWhen` as State reports it, never against a Flow's name or reputation. Escalate or ask when the classification and the eligible Flows disagree.
- Specs must use the machine-defined `ADDED|MODIFIED|REMOVED|RENAMED Requirements`, `Requirement`, `Scenario`, `WHEN`, and `THEN` headings.

# Authority

- Create one kebab-case Change ID under the State-resolved Changes directory, and write `change.yaml` plus the Proposal and delta Spec paths the Propose Action returns.
- Do not write Design, Clarifications, Check reports, persistent Tasks, product code, canonical Specs, Evidence, or Archive.
- Do not decide material compatibility, data, security, privacy, or scope questions for the user.

# Execution

0. **When the idea is still vague, narrow it before creating anything.** Read the code, Specs, and constraints needed to state one objective, its boundaries, and what would make it done. Investigation itself needs no Skill — use ordinary reading and search. What this step owes the user is a decision: one bounded objective, or an explicit report that the idea is not yet separable into one. **Do not create a Change to hold an idea you cannot yet bound** — an unbounded Change costs more to unwind than a question costs to ask.
1. Resolve one objective and check whether an active Change already covers it.
2. Set `flow` to the State-resolved manifest default unless the user explicitly requests a different Flow. Deviate on your own initiative only when the classification plainly conflicts with that default — then escalate or request a decision rather than silently overriding. Escalation and de-escalation are not symmetric, and the asymmetry is the point: a heavier Flow is always legal, so nothing refuses one, while a lighter Flow is refused the moment the classification outgrows it. **So propose a lighter Flow, never adopt one.** When the Change satisfies every `eligibleWhen` of a lighter Flow and needs no Stage the default carries, say so and put it to the user; the answer is theirs, on the same reading as any other decision that removes a check. `## Flow choice` is a section every Flow's proposal outline declares, so it is always written; what changes is what it says. On an override, an escalation, or a de-escalation the user accepted, give the reason. On a plain inherit, say that — "inherited the manifest default" is the honest content, not an omission.
3. Create the minimum `change.yaml` from the `create-change` Action: write its `template` to its `writes` path under a new kebab-case Change id, replacing every placeholder with a project fact. The template already carries this project's default Flow and its first module; `paths` and every classification key are yours to answer. Then run `xforge state --change <id>`.

   Answer every classification key from the work, never from the Flow you would rather run. `moduleContract` is true when this Change moves an interface **between modules** — a signature, an endpoint, a stored shape another module reads; it is not `publicApi`, which is true when the Change moves something outside consumers already depend on — a published entry point, a documented endpoint, a released CLI flag. An export that nothing outside this repository can reach is not a public API however visible it looks from inside; a rename behind a module boundary is neither key. **A key answered untruthfully to clear a refusal is the one failure this Stage cannot catch later.** A true `moduleContract` on a Flow with no Stage that declares an interface delta is refused as `XFORGE_FLOW_TOO_WEAK`, and that refusal is the key working rather than an error to clear: it names the Flow that can carry the Change, and `xforge explain XFORGE_FLOW_TOO_WEAK` says why answering `false` is not a weaker check but a different one.

   Continue only with ready Propose Artifacts and Actions, and clear the schema diagnostics this Change's own files caused. A diagnostic you cannot clear inside this Stage's authority — an undeclared verification Gate, a Requirement no later Artifact has anchored yet — is reported, not fixed. Reaching outside the Stage to silence one is the overstep this Skill's Authority exists to prevent.
4. Write each Artifact the ready Action names: at its `writes` path, carrying every `##` heading `requiredSections` lists, following the Artifact's `instruction` and `outline` under `owes`. Copy those headings verbatim — do not add, rename, or qualify one, because markers and the reconcile sources are keyed to the exact text. Give Requirements stable IDs and success, failure, boundary, and compatibility scenarios. Do not guess an unstated precise contract into a Spec fact; where an immutable acceptance test already fixes a field, output shape, or exit behavior, match it exactly, and stop as material ambiguity on any test/Requirement conflict.
5. Re-run `xforge stage --change <id>` after each Artifact, and stop **writing Artifacts** once the next Artifact Action belongs to another Skill. That is not the end of this Stage: step 6 is, and it runs from here.
6. Run `xforge advance --change <id>`: it runs this Stage's Gates and, if nothing refuses, takes the Transition. Read what it reports. A Gate that refuses stops the Transition and names itself — fix only Propose-stage structural issues, and never read advisory text as a passed Gate. When more than one Transition is ready it asks which, because choosing between going forward and reworking is not a default: name it with `--to`.

# Evidence

- Report Change ID, Flow (default or overridden, with the reason if overridden) and classification, actual paths, assumptions, and the next legal Action against that Action's `doneWhen` and `requiredEvidence`.
- Only current CLI output proves structure, policy, and path validation.

# Stop and rework

- Stop on unknown modules, path/identity/protocol diagnostics, material ambiguity, a Flow-policy mismatch, or an authority boundary.
- When a diagnostic is the thing blocking you and its one line is not enough, run `xforge explain <XFORGE_CODE>`. It gives that code's severity and every message it can carry — one code is raised from more than one place, and the wording you have not met is what tells you it has another cause. Do not guess a code's meaning from its name.
- Hand changed upstream facts to `xforge-revise`; do not implement opportunistically.

# Judgment calls

- The Flow default exists so the common case needs no risk-classification reasoning; overriding it is the unusual path, and doing so without noting it in the Proposal makes a deliberate call look like an oversight to the next reader.
- A Requirement that reads clearly to the author but only makes sense with unstated implementation knowledge is not testable by anyone else. Write scenarios a reviewer with no context on this Change could still verify against the running system.
