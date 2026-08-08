# ADR 0001: v1 implementation choices

- **Status:** accepted for initial implementation
- **Date:** 2026-08-08

XForge uses Node.js 20+, TypeScript ESM, npm, Ajv JSON Schema validation, YAML,
and fast-glob. The published package is one `tsc`-compiled package with no
service or database. Vitest drives library and CLI tests.

Generated ownership is a versioned local JSON map. Gate output is capped at 64
KiB per stream and values matching common secret/token patterns are redacted.
Archive merging supports requirement-level OpenSpec-style deltas; ambiguous
replacement of an existing full specification fails with a stable conflict.

Adapters only implement reliable project-level file mappings. In protocol 1,
Hooks are reported unsupported for every target because safely merging native
settings would violate managed-only ownership. Codex/OpenCode Rules are
degraded to existing bootstrap guidance and are not generated as equivalent
native Rules.
