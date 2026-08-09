# v1 acceptance coverage

| Product baseline area | Deterministic coverage |
|---|---|
| Exact npm install, bundled Scaffold integrity, `init` dry-run/atomic bootstrap, combined target projection | `product-validation.test.ts`, `init.test.ts` |
| Portable/Managed identity, npm exact version, CLI integrity, legacy Git identity rejection | `cli-protocol.test.ts` |
| Default/relocated Specs and Changes paths | `archive.test.ts`, `security-boundaries.test.ts` |
| Traversal, overlap, generated roots, symlink escape, malicious resource IDs | `path-safety.test.ts`, `security-boundaries.test.ts` |
| Constitution validity/conflict and Flow risk escalation | `governance.test.ts` |
| Eight-field work packages, DAG readiness, revision-bound dispatch, shared/path boundaries, Git delivery and verify Evidence | `work-packages.test.ts`, `control-plane.test.ts` |
| quick/solid/major Stage graphs, Flow policy, and Verify receipt boundary | `flows.test.ts`, `flows.json` golden |
| Typed Transition receipts, stale revision rejection, rework, planning/closing Approval and separation of duties | `control-plane.test.ts`, `archive.test.ts` |
| External Approval signature/provider/role validation and non-interactive fail-closed behavior | `control-plane.test.ts` |
| Audit status/verify/export/retry, local hash-chain tamper detection, 503 spool→retry, Major remote-debt block | `audit.test.ts` |
| Runtime Hook dispatch, protected-file deny, secret redaction, local/cloud coverage and adapter mapping | `runtime-governance.test.ts`, `adapters.test.ts` |
| Full command lifecycle, `init`, and JSON/Text envelope | `cli-protocol.test.ts`, `init.test.ts`, `projection-lifecycle.test.ts` |
| Five Adapter paths and capability truthfulness | `adapters.test.ts`, `adapters.json` golden, `product-validation.test.ts` |
| Default worker/integrator/reviewer assets and Parallel Development bootstrap | `product-validation.test.ts`, `install.test.ts` |
| Init/install dry-run, idempotency, unmanaged conflict, modified-file protection, managed-only prune | `init.test.ts`, `install.test.ts` |
| Gate execution, timeout, output cap, redaction, failed/current Evidence, no forged overwrite | `check-gates.test.ts` |
| Archive dry-run, receipt/Gate block, Spec merge, archive move | `archive.test.ts`, `spec-merger.test.ts` |
| TypeScript default and Python optional project Script execution | `script-runner.test.ts` |
| Minimum readable/runnable example project | `minimal-example.test.ts`, `xforge/test/fixtures/minimal-project` |
| Scaffold attribution/integrity and generated-file secret prevention | `product-validation.test.ts`, `security-boundaries.test.ts` |

The full local release gate is `npm run verify` from the repository root. It
builds the CLI, verifies `scaffold/files.sha256`, runs implementation tests, and
runs this independent black-box product suite.
