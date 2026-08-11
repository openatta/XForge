# XForge Bootstrap Guide

The canonical Protocol 2 bootstrap and installation procedure is the
root-level [XForge Agent Installation Runbook](../AGENT_INSTALL.md).

The only supported distribution is the exact npm package. It contains the CLI,
Schemas, and matching Scaffold. The runbook covers package verification,
`xforge init`, collision-safe localization, optional one-step target projection,
Managed-mode activation, Adapter dry-run review, and acceptance criteria.

Do not install from a source checkout, locally packed tarball, Git sparse
checkout, or separate HTTP Scaffold artifact.

Do not use an older Protocol 1 bootstrap procedure with the current
`@xforge/cli 0.7.6` Scaffold.
