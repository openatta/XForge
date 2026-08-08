# v1 acceptance coverage

| Product baseline area | Deterministic coverage |
|---|---|
| Fixed Bootstrap, Git sparse checkout, HTTP artifact, identical payload manifest | `product-validation.test.ts` |
| Portable/Managed identity, npm exact version, Git full commit/repository, CLI integrity | `cli-protocol.test.ts` |
| Default/relocated Specs and Changes paths | `archive.test.ts`, `security-boundaries.test.ts` |
| Traversal, overlap, generated roots, symlink escape, malicious resource IDs | `path-safety.test.ts`, `security-boundaries.test.ts` |
| Constitution validity/conflict and Flow risk escalation | `governance.test.ts` |
| Eight-field work packages, DAG readiness, shared/path boundaries, Git delivery and verify Evidence | `work-packages.test.ts` |
| quick/solid/major Stage graphs, Flow policy, and Verify receipt boundary | `flows.test.ts`, `flows.json` golden |
| Four-command JSON/Text envelope | `cli-protocol.test.ts` |
| Five Adapter paths and capability truthfulness | `adapters.test.ts`, `adapters.json` golden, `product-validation.test.ts` |
| Default worker/integrator/reviewer assets and Parallel Development bootstrap | `product-validation.test.ts`, `install.test.ts` |
| Dry-run, idempotency, unmanaged conflict, modified-file protection, managed-only prune | `install.test.ts` |
| Gate execution, timeout, output cap, redaction, failed/current Evidence, no forged overwrite | `check-gates.test.ts` |
| Archive dry-run, receipt/Gate block, Spec merge, archive move | `archive.test.ts`, `spec-merger.test.ts` |
| TypeScript default and Python optional project Script execution | `script-runner.test.ts` |
| Minimum readable/runnable example project | `minimal-example.test.ts`, `xforge/test/fixtures/minimal-project` |
| Scaffold attribution/integrity and generated-file secret prevention | `product-validation.test.ts`, `security-boundaries.test.ts` |

The full local release gate is `npm run verify` from the repository root. It
builds the CLI, verifies `scaffold/files.sha256`, runs implementation tests, and
runs this independent black-box product suite.
