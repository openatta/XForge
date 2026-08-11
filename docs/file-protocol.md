# XForge File Protocol 2

> **Implementation status:** implemented by `@xforge/cli 0.7.3` (`xforge.dev/v1alpha2`). Protocol 1 projects remain readable in Portable mode, but Protocol 2 managed writes require an exact CLI/Lock identity.

Protocol 2 separates guidance, enforcement and evidence. Markdown remains the human/Agent planning surface; YAML/JSON resources and CLI receipts are the machine authority.

## 1. Project roots

```text
xforge/
├── manifest.yaml
├── lock.yaml
├── constitution.md
├── flows/*.yaml
├── scaffold/
│   ├── skills/*/SKILL.md
│   ├── agents/*.{yaml,md}
│   ├── rules/*.yaml
│   ├── policies/*.yaml
│   ├── hooks/*.yaml
│   └── gates/*.yaml
├── .audit/events.jsonl          # local, gitignored hash chain
├── changes/<change>/
│   ├── change.yaml
│   ├── approvals/<policy>/*.json
│   ├── work-packages.yaml
│   └── evidence/
│       ├── gates and verification evidence
│       ├── agents/<package>/
│       │   ├── dispatch/*.json
│       │   └── <execution>.yaml
│       ├── audit/index.json
│       └── receipts/transitions/*.json
└── specs/
```

`manifest.yaml` explicitly selects every Skill, Agent, Rule, PermissionPolicy, Hook, Gate and target. Presence under `scaffold/` does not enable a resource.

## 2. Version and compatibility

- CLI envelope: `protocolVersion: "2"`.
- current resources: `apiVersion: xforge.dev/v1alpha2`.
- CLI declaration and Lock: version `0.7.3`, protocol `"2"`, exact runtime integrity.
- CLI 和 Scaffold source 都固定为 `@xforge/cli` npm 精确版本。Protocol 2 不接受
  Git checkout、HTTP Scaffold 或 source-built installation identity。
- Protocol 1 Flow/Rule/Agent resources can be read during migration. A Protocol 1 project whose declared CLI identity does not match runs in Portable mode; managed install/check/transition/approval/archive writes are rejected.
- Existing Protocol 1 Gate Evidence is not promoted to current evidence. Re-running the Gate creates Protocol 2 revision-bound evidence.

## 3. Rule and PermissionPolicy

`Rule` is guidance plus coverage links:

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Rule
metadata: { name: public-api-safety, version: 1 }
spec:
  severity: must
  instruction: Public API changes require compatibility evidence.
  scope:
    paths: [src/api/**]
    stages: [design, check, verify]
  enforcement:
    gateRefs: [unit-tests]
    policyRefs: []
    approvalRefs: [implementation-major]
```

Coverage is reported independently as `instructed`, `guarded`, `verified`, `approved`, or `uncovered`. A `must` Rule without Gate or Approval coverage is explicitly `uncovered`.

`PermissionPolicy` controls runtime capabilities and is not a Guidance Rule:

```yaml
apiVersion: xforge.dev/v1alpha2
kind: PermissionPolicy
metadata: { name: protected-files, version: 1 }
spec:
  capability: fs.write
  effect: deny
  match:
    paths: [xforge/manifest.yaml, xforge/specs/**]
  exceptActors: [integrator]
  reason: Shared governance files have one authorized writer.
```

Effects are `deny`, `ask`, and `allow`; deny wins in the XForge dispatcher. Enterprise/managed platform policy remains an upstream layer and cannot be weakened by a project projection.

## 4. Hook

Hook resources declare the plane, normalized event, action, timeout and failure policy:

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Hook
metadata: { name: runtime-audit, version: 1 }
spec:
  enabled: false
  plane: runtime
  event: agent.tool.after
  action: { builtin: audit }
  timeoutSeconds: 10
  failurePolicy: spool
  matcher: "*"
```

Runtime Hooks observe or guard platform events. Workflow Hooks are CLI-owned lifecycle actions. A Hook cannot create Gate success, Approval or a Stage transition. Project Hook selection, generated installation, platform trust and runtime activation are separate states.

## 5. Flow and transition state

A governed Stage Flow defines:

- `governance.approvalPolicies`;
- workflow audit policy;
- structured Stage exits: conditions, Gates, Approvals and required audit events;
- terminal archive Approval/Audit policy.

The current Stage is reconstructed from the validated transition-receipt chain, never inferred only from artifact presence. A Transition receipt binds:

```text
change / flow / from / to / sequence
contentRevision / stateRevisionBefore / policySnapshotDigest / gitHead
previousReceiptDigest / approvals[] / gates[] / auditHead / digest
```

Changes to governing artifacts, Flow, Rules, Policies, Hooks, Gates or Git HEAD make linked evidence stale.

## 6. Approval receipt

Approval is a first-class receipt bound to Change, Flow, Stage, transition, policy and revision. Local approval requires an interactive terminal plus `--attestation human`; it is repository-level self-attestation and is not enterprise-grade identity proof. External receipts use configured HMAC providers and are revalidated on every state load. Major policies accept external receipts only and require two approvers with role separation.

Agents, Reviewers and Skills cannot issue a valid human Approval. A Review `PASS` is assurance, not Approval or Gate Evidence.

## 7. Gate Evidence

Only the XForge Gate runner writes Machine Gate Evidence. Evidence contains current content/state/policy revisions, Git base/head, runner identity and integrity, exact argv/cwd, bounded redacted outputs, outcome and digest. Hand-written or digest-invalid evidence is rejected.

Transition to `ready-to-archive` records the exact Gate digests. Archive validates those bindings and then reruns mandatory Gates against the ready-state revision before the atomic transaction.

## 8. Work packages

`work-packages.yaml` keeps the eight static fields: `id`, `goal`, `depends_on`, `inputs`, `write_paths`, `skills`, `verify`, `done_when`.

Runtime dispatch is separate:

```bash
xforge work-package dispatch --change <id> --package <package-id>
```

The dispatch receipt fixes `executionId`, `stateRevision`, `policySnapshotDigest`, Git base/head and `auditCorrelationId`. A Protocol 2 successful delivery must return the matching `state_revision`, `policy_snapshot_digest` and `audit_correlation_id`, plus an exact `done_when_evidence` entry for every static `done_when` criterion. CLI validation also checks commit ancestry, actual diff, write boundary and verification commands. Integration and review are separately acknowledged with repository evidence; a successful check does not fabricate either lifecycle event.

## 9. Audit

Audit uses three layers:

1. `xforge/.audit/events.jsonl`: local gitignored JSONL with `previousHash`/`hash` chain;
2. `<change>/evidence/audit/index.json`: commit-safe event index and digests;
3. optional remote append-only HTTP sink with Bearer/HMAC credentials supplied only by environment variables.

The default redaction is metadata/digest oriented: prompts, hidden reasoning, secrets, full environment and unbounded tool payloads are not stored. Delivery failure writes a spool receipt; retry is explicit. `audit verify --change` enforces the selected Flow's event, runtime-coverage and remote-delivery policy, so it can be used as a CI protected check. Local retention is reported; destructive expiry and immutability are enforced by the remote sink to avoid silently rewriting the local chain.

## 10. JSON envelope

Normal commands emit exactly one object:

```json
{
  "protocolVersion": "2",
  "ok": true,
  "command": "state",
  "root": "/project",
  "data": {},
  "diagnostics": [],
  "changes": [],
  "nextActions": []
}
```

`nextActions` are typed and may include a stable command argv, status and blockers. The internal Hook dispatcher is the exception: it writes the target platform's required Hook response JSON to stdout.
