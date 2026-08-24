You are the verification participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit implementation or
tests, transition Stage, archive, or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the complete active `greeter` Change, and
the installed `xforge-verify` Skill. Confirm State shows Stage Verify. Do not
run `xforge approve`, `transition`, or `archive` in this
phase, because closing Approval and Stage movement are kept outside the model
environment; `xforge state` and `xforge check` are yours to run and the Skill
requires them. Run `python3 -m unittest discover -s test` as an independent verification. If it fails,
document the failure and stop without changing implementation or tests.

If it passes, create a complete `assurance.md` that maps every Requirement ID
to real test evidence and discusses completeness, correctness, coherence,
risk and findings. Write it before the receipt: it is an Artifact, so it moves
the content revision the receipt has to name. Then run `xforge check` to produce current-revision Machine Gate Evidence, and create
`evidence/verification-receipt.yaml` recording passed status, current
Flow/Stage, `contentRevision` from `xforge state`, Git HEAD, and test command.
Its `gates` list carries exactly the Gates this Stage declares and nothing else;
Quick has no work packages, so `workPackageDeliveries` does not appear at all.
The receipt is review/verification metadata, not Machine Gate Evidence, and
never restates a Gate's findings as its own. Stop without transitioning;
the external harness will commit these artifacts, obtain closing Approval, and
archive.
Any contradiction between the delta Spec, immutable tests, and implementation
is a blocker even when `python3 -m unittest discover -s test` passes: record a failed verdict, do not
claim archive readiness, and request rework instead of downgrading it to a
warning.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted. The
outline is the contract; if something you want to report has no section, put
it inside the closest one rather than inventing a heading.

This project is not a Node project and has no `package.json`, so the `unit-tests`
Gate has no command declared and refuses rather than passing. That refusal is
correct and must not be worked around: do not edit the Gate, and do not adopt the
suggestion the CLI offers — `pyproject.toml` makes it propose `pytest`, which
this project neither uses nor has installed.

`TEST_REQUEST.md` states the command this project actually runs, under "本项目如何
运行测试". Declare it with the CLI, never by hand:

```
xforge verification declare --gate-name unit-tests \
  --command '["python3","-m","unittest","discover","-s","test"]' --by "project owner"
```

**Do not edit `xforge/manifest.yaml` yourself** — a malformed Manifest denies
every tool call, including the ones that would repair it. Do not run
`xforge install` afterwards either: the declaration is not a locked resource, and
`install` rewrites the projected tool directories, which would invalidate this
Change's deliveries once committed. Just re-run the Gate.
