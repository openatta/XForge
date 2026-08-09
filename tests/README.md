# Product validation suite

This directory is intentionally outside the CLI implementation package. It
black-box validates XForge as a product: distribution equivalence, repository
boundaries, Scaffold attribution/integrity, full CLI lifecycle behavior, real Adapter
discovery paths, Portable/Managed truthfulness, work-package collaboration
evidence, and hostile path handling.

The implementation suite uses two project classes: the complete localized
`scaffold/payload` fixture for multi-Target lifecycle and governance coverage,
and `xforge/test/fixtures/minimal-project` for the smallest readable/runnable
project. `projection-lifecycle.test.ts` creates isolated copies and mutates
canonical sources, Manifest selections, Target sets, Lock identity, ownership
versions, and generated files so sync/update/uninstall are exercised through
real project transitions rather than mocked planner results.

Run through `npm run test:product` or the complete `npm run verify` at the
repository root.

`npm run verify` also collects V8 coverage from the compiled CLI subprocesses
used by the implementation suite and enforces global thresholds. The separate
live-engine directory remains excluded; its runner has its own suite-level
budget, retry, timeout, and isolation policy.
