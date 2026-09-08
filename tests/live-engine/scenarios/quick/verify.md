You are the verification participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit implementation or
tests, transition Stage, archive, or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the complete active `greeter` Change, and
the installed `xforge-verify` Skill. Confirm State shows Stage Verify. Do not
run `xforge approve`, `transition`, or `archive` in this
phase, because closing Approval and Stage movement are kept outside the model
environment; `xforge state` and `xforge check` are yours to run and the Skill
requires them. Run `npm test` as an independent verification. If it fails,
document the failure and stop without changing implementation or tests.

If it passes, create a complete `assurance.md` that maps every Requirement ID
to real test evidence and discusses completeness, correctness, coherence,
risk and findings. Write it before the receipt: it is an Artifact, so it moves
the content revision the receipt has to name. Then run `xforge check` to produce current-revision Machine Gate Evidence, and file the receipt with
`xforge verification finalize --change <id> --status passed --by <person>`.
Do not hand-assemble `evidence/verification-receipt.yaml`: the CLI already
holds the contentRevision, the gitHead and the cited Gate set, and both the
`xforge-verify` Skill and the CLI's own nextActions say not to transcribe
them. `--status` and `--by` are the two it will not compute. Sign it
`--by "project owner"`: `TEST_REQUEST.md` stands in for the owner in this
project, the same way it stands in for the person Propose signed the Gate
commands with. Expect
`XFORGE_VERIFICATION_DECLARER_UNATTESTED` on this call — a role is not a Git
author, the CLI records the name as written and says so, and that warning is
the record being honest about itself. Outside a fixture, a name nobody gave
you is a name you do not write.
Its `gates` list carries exactly the Gates this Stage declares and nothing else;
Quick has no work packages, so `workPackageDeliveries` does not appear at all.
The receipt is review/verification metadata, not Machine Gate Evidence, and
never restates a Gate's findings as its own. Stop without transitioning;
the external harness will commit these artifacts, obtain closing Approval, and
archive.
Any contradiction between the delta Spec, immutable tests, and implementation
is a blocker even when `npm test` passes: record a failed verdict, do not
claim archive readiness, and request rework instead of downgrading it to a
warning.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted.
The outline is the contract.

The `unit-tests` Gate runs whatever this project declared and refuses when it has
declared nothing — but by the time this Stage runs, **Propose has already answered
it.** A required declared Gate with no command blocks the Change's first
Transition, so a Change that reached Verify carries the answer already, recorded
under `manifest.verification` and signed with the name `TEST_REQUEST.md` gives.

**Do not declare it again here.** `manifest.verification.<gate>` is a list, so a
second declaration appends a second command rather than replacing the first, and
both then run — with two different `--by` answers on the record for one question.
Read what is recorded and use it.

Meeting a genuinely undeclared Gate here is the unusual case the `xforge-verify`
Skill describes — a declaration retired mid-flight, or a Gate the project selected
after this Change began. If that happens, the rules are the ones Propose follows:
the command comes from what the project states about itself, never from the
suggestion the CLI offers because it appeared, and never by editing the Manifest
by hand.

**Do not edit `xforge/manifest.yaml` yourself.** The Manifest is what the
governance dispatcher reads, so a malformed one denies every tool call — and a
live run reached exactly that deadlock by indenting a hand-written block one
level short, after which it could not open the file it had just broken. The
command writes the block correctly, fills `declaredAt`, and refuses rather than
producing a Manifest that would not load.

Do **not** run `xforge install` afterwards either: the declaration is a Manifest
field, not a locked resource, and `install` rewrites the projected tool
directories, whose changed files belong to no work package and would invalidate
every delivery in this Change once committed. Just re-run the Gate.

