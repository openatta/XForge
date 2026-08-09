# Live engine end-to-end test

This harness creates an ignored, independent project at
`tests/.tmp/live-engine-project`. It loads the repository `.env` without shell
evaluation and never copies credentials into the sample project.

The engine is allowed to edit only the isolated project. Approval signing and
delivery recording remain external deterministic harness operations.

## Runbook

Build and create the project:

```bash
npm run build
node tests/live-engine/setup.mjs
node xforge/dist/cli.js --root tests/.tmp/live-engine-project install --dry-run
node xforge/dist/cli.js --root tests/.tmp/live-engine-project install
git -C tests/.tmp/live-engine-project add .
git -C tests/.tmp/live-engine-project commit -m "Install XForge projections"
```

Run planning, inspect it, and commit the model-authored artifacts:

```bash
node tests/live-engine/run-engine.mjs \
  --root tests/.tmp/live-engine-project \
  --prompt tests/live-engine/prompts/01-plan.md \
  --output tests/.tmp/live-engine-results/01-plan.json
git -C tests/.tmp/live-engine-project add xforge/changes/task-ledger
git -C tests/.tmp/live-engine-project commit -m "Plan task ledger change"
node tests/live-engine/sign-approval.mjs \
  --root tests/.tmp/live-engine-project --change task-ledger \
  --transition apply --policy planning-solid --actor owner@example.test --role owner
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project \
  transition --change task-ledger --to apply
git -C tests/.tmp/live-engine-project add xforge/changes/task-ledger
git -C tests/.tmp/live-engine-project commit -m "Enter task ledger apply stage"
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project \
  work-package dispatch --change task-ledger --package T001
```

Run implementation. Commit only the declared `src/**` write boundary, then
record and independently verify the delivery:

```bash
node tests/live-engine/run-engine.mjs \
  --root tests/.tmp/live-engine-project \
  --prompt tests/live-engine/prompts/02-apply.md \
  --output tests/.tmp/live-engine-results/02-apply.json
git -C tests/.tmp/live-engine-project add src
git -C tests/.tmp/live-engine-project commit -m "Implement task ledger"
node tests/live-engine/record-delivery.mjs \
  --root tests/.tmp/live-engine-project --change task-ledger --package T001
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project check --change task-ledger
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project \
  transition --change task-ledger --to verify
```

Run model verification, commit semantic artifacts before creating fresh Gate
Evidence, and close the workflow:

```bash
node tests/live-engine/run-engine.mjs \
  --root tests/.tmp/live-engine-project \
  --prompt tests/live-engine/prompts/03-verify.md \
  --output tests/.tmp/live-engine-results/03-verify.json
git -C tests/.tmp/live-engine-project add \
  xforge/changes/task-ledger/assurance.md \
  xforge/changes/task-ledger/evidence/verification-receipt.yaml
git -C tests/.tmp/live-engine-project commit -m "Verify task ledger change"
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project check --change task-ledger
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project \
  transition --change task-ledger --to ready-to-archive
node tests/live-engine/sign-approval.mjs \
  --root tests/.tmp/live-engine-project --change task-ledger \
  --transition archive --policy closing-solid --actor maintainer@example.test --role maintainer
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project audit verify --change task-ledger
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project archive --change task-ledger --dry-run
node tests/live-engine/run-xforge.mjs --root tests/.tmp/live-engine-project archive --change task-ledger
npm --prefix tests/.tmp/live-engine-project test
node tests/live-engine/summarize.mjs \
  --root tests/.tmp/live-engine-project \
  --results tests/.tmp/live-engine-results \
  --output tests/.tmp/live-engine-results/summary.json \
  --change task-ledger --suffix retry
```

Omit `--suffix retry` for a first-attempt run whose engine outputs use the
base `01-plan.json`, `02-apply.json`, and `03-verify.json` names. The summary
re-runs the acceptance suite and Audit verification, then records engine cost,
tokens, receipts, delivery paths, archive state, and the final Git HEAD without
including prompts, model responses, or credentials.

Never put `sign-approval.mjs`, `run-xforge.mjs`, the approval secret, or the
repository `.env` inside the isolated project. Engine prompts prohibit parent
directory access; this is behavioral isolation, not an operating-system security
boundary.
