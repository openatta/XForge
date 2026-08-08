---
version: 1.1.0
ratified: 2026-08-08
lastAmended: 2026-08-08
---

# Project Constitution

## Mission and boundaries

Deliver the project's declared behavior without silently expanding scope,
authority, data collection, or dependencies.

## Architecture principles

Prefer small, testable modules and explicit contracts. Preserve existing
project layout and compatibility unless an approved Change says otherwise.

## Security, privacy, and compliance

Use least privilege, keep secrets out of repository assets and output, validate
all trust-boundary input, and record security/privacy impact explicitly.

## Quality and observability

Externally observable requirements need automated verification. Failures must
be diagnosable without exposing sensitive data. No Change is complete without
current evidence from its mandatory gates.

## Parallel Development

Parallelize only dependency-ready work packages whose write paths do not
overlap and whose shared resources can be isolated. Every write-capable Worker
uses an assigned worktree and fixed base commit, and each path has a single
writer at a time. Shared contracts, migrations, generated files, and lock files
have one Integrator writer. Accept delivery only from verified Git diffs,
declared verification commands, and current Gate Evidence; Agent prose is not
proof. No Agent may approve its own exception.

## Compatibility and versioning

Public interfaces, stored data, and protocols change deliberately with a
documented migration and rollback strategy.

## Governance

This Constitution outranks ordinary Rules. Amend it through an independently
reviewed Change and update its semantic version: MAJOR for breaking principles,
MINOR for new or materially broader principles, PATCH for clarification.
Humans or authorized external systems grant approvals; an AI Agent cannot
self-approve an exception.
