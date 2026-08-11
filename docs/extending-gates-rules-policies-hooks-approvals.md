[简体中文](extending-gates-rules-policies-hooks-approvals.zh-CN.md) | English

# Extending Gates, Rules, PermissionPolicies, Hooks, and Approvals

This guide is for adding a project-owned Gate, Rule, PermissionPolicy, Hook,
or Approval policy to an XForge-managed project — the mechanics and worked
YAML for each. For what each one *is*, how they relate, and whether they
depend on your project's programming language, see
[Skills, Flows, Rules, Gates, Hooks, PermissionPolicies, and Approvals](governance-concepts.md)
first; for the Gate/Rule interplay with Flows specifically, see
[Extending Skills and Flows](extending-skills-and-flows.md).

## Gates — deterministic proof, and yes, project-language-specific

A Gate is a YAML resource (`kind: Gate`) declaring either a fixed `command`
(any executable, any language) or the one special case, `builtin: structure`
(the CLI's own in-process schema/reference/eligibility validator — see
below). Whichever it is, running it always produces the same signed Evidence
envelope, written to `<change>/evidence/<spec.evidence>`.

### How a Gate gets wired in and invoked

1. Author `xforge/scaffold/gates/<id>.yaml` and register `<id>` in
   `manifest.yaml`'s `scaffold.gates`.
2. Reference `<id>` in a Flow's stage `gates: [...]` list (or
   `terminal.archive.mandatoryGates`) so `checkStructure()` knows it's
   required — an unregistered or unreferenced Gate is dead weight, never run.
3. It runs when a Skill (or you, by hand) calls
   `npx --no-install xforge check --change <id> --gate <gate-id>`, or
   implicitly as part of `xforge archive` for every `mandatoryGates` entry.
4. `runGate()` spawns `spec.command` as a real child process (`spawn`, no
   shell by default), captures exit code / stdout / stderr (redacted,
   byte-capped), and atomically writes the Evidence JSON — `gate`, `change`,
   `flow`, `stage`, `stateRevision`, `contentRevision`, `gitHead`,
   `runner.integrity`, `command`, `exitCode`, `status`, `digest`. A later
   Transition or Archive re-reads this file; it does not re-run your command,
   it trusts the digest-bound record instead.

### `structure` is the one Gate that isn't a subprocess

`builtin: structure` doesn't run a command at all. By the time `xforge check`
gets to running it, the CLI's own `checkStructure()` (in-process TypeScript:
schema validity, Flow/Skill/Gate cross-references, Flow eligibility for the
Change's classification, Lock freshness, work-package DAG safety) has
already run and already returned clean — the Gate call just wraps that
already-known "passed" result into the same signed Evidence envelope every
other Gate produces, so downstream code (Transitions, Rule `coverage`,
Archive) can treat all Gates uniformly without special-casing this one.

### Worked example: a Python project's lint Gate

```yaml
# xforge/scaffold/gates/lint.yaml
apiVersion: xforge.dev/v1alpha1
kind: Gate
metadata:
  name: lint
  version: 1
spec:
  stage: before-archive
  required: true
  command: [ruff, check, ., --quiet]
  workingDirectory: .
  timeoutSeconds: 120
  evidence: lint.json
```

```yaml
# manifest.yaml
scaffold:
  gates: [structure, unit-tests, lint]
```

```yaml
# xforge/flows/solid.yaml (excerpt)
stages:
  - id: verify
    gates: [structure, unit-tests, lint]
```

Nothing here is Node/npm-specific — swap `[ruff, check, ., --quiet]` for
`[pytest]`, `[go, vet, ./...]`, `[cargo, clippy, --, -D, warnings]`, or
`[mvn, -q, verify]` and the mechanism is identical. `unit-tests.yaml` itself
is only `npm test --if-present` because the *bundled default Scaffold*
assumes an npm project; nothing in the Gate schema requires npm.

## Rules — declared instruction, verified (not trusted) coverage

A Rule (`kind: Rule`) states `severity: must|should`, an `instruction`
string, a `scope` (modules/paths/stages), and an `enforcement` block
claiming which Gates/PermissionPolicies/Approvals back it up
(`gateRefs`/`policyRefs`/`approvalRefs`). Critically, **the system does not
take that claim on faith** — every `xforge state` computation cross-checks it
and reports a `coverage` array:

- `instructed` — baseline; the Rule applies and was surfaced.
- `guarded` — a `policyRefs` entry matches a real, loaded PermissionPolicy.
- `verified` — a `gateRefs` entry matches a Gate actually required by the
  next candidate Transition.
- `approved` — an `approvalRefs` entry matches a real, current-revision
  `approve` receipt.
- `uncovered` — `severity: must` with empty `gateRefs` **and** empty
  `approvalRefs`: a mandatory Rule with nothing mechanically backing it.

### Worked example

```yaml
# xforge/scaffold/rules/no-console-log.yaml
apiVersion: xforge.dev/v1alpha2
kind: Rule
metadata:
  name: no-console-log
  version: 1
spec:
  severity: must
  instruction: >
    Do not leave console.log debugging statements in committed src/** code.
  scope:
    paths: [src/**]
  enforcement:
    gateRefs: [lint]
    policyRefs: []
    approvalRefs: []
```

Wire `ruff`/eslint/whatever `lint` Gate you already added (above) to actually
catch `console.log`/`print` debugging statements, register the Rule in
`manifest.yaml`'s `scaffold.rules`, and this Rule will show `coverage:
['instructed', 'verified']` in `xforge state` — because `lint` really is one
of the Gates the next Transition requires. Ship the same Rule with an empty
`enforcement.gateRefs` instead, and `xforge state` will honestly report
`'uncovered'` — a Rule that only exists as an instruction an Agent might or
might not follow, not something the system verified.

Rules reach the Agent as instruction text inside `xforge state`'s
`governance.rules` output; Skills are expected to read applicable Rules and
follow them (`xforge-design`'s Invariants: "Constitution, Rules, current
architecture, and Specs constrain the design"). The `coverage` field is what
keeps that honest — an Agent (or a human reviewing the state output) can see
at a glance whether a "must" Rule is actually backed by something
mechanical, or just asked nicely.

## PermissionPolicies — live allow/ask/deny

A PermissionPolicy (`kind: PermissionPolicy`) declares one `capability`
(`fs.read`, `fs.write`, `shell`, `network`, `mcp`, `subagent`,
`external.write`), one `effect` (`deny`/`ask`/`allow`), and a `match` block
(`paths`/`commands`/`hosts`/`tools`/`mcpServers`, each glob-style, plus
optional `stages` scoping and `exceptActors`).

### How it's actually evaluated — not a static config file, a live dispatch

Every projected coding tool has its own native "before I do this, ask
first" hook mechanism (Claude Code's `PreToolUse`, Cursor's permission hook,
etc.). `xforge init`/`install` writes each platform's native hook config to
call `npx --no-install xforge hook ...` for the relevant event. That CLI
invocation runs `executeHookDispatch()`, which, per call:

1. Normalizes the platform's tool name into an XForge capability (`bash`/
   `shell`/`exec_command` → `shell`; `write`/`edit`/`delete` → `fs.write`;
   `read`/`view` → `fs.read`; `task`/`subagent`/`spawn` → `subagent`;
   `web`/`fetch` or a `url` field → `network`; an `mcp*` tool name → `mcp`).
2. Extracts the concrete resource being acted on (the file path, the shell
   command string, the URL, the sub-agent id) from the tool's own input
   payload.
3. Finds every PermissionPolicy whose `capability` matches and whose `match`
   patterns wildcard-match that resource (respecting `exceptActors` and
   `match.stages`).
4. Combines all matching policies with `deny` beating `ask` beating `allow`
   (`effectivePolicyEffect`) — one matching `deny` wins regardless of how
   many `allow`s also matched.
5. Translates that decision into whatever shape the calling platform expects
   (Cursor wants `{permission, user_message, ...}`; GitHub Copilot wants
   `{permissionDecision, ...}`; Codex has no native "ask", so `ask` is
   downgraded to `deny` for it specifically) and records an audit event
   either way.
6. If the dispatcher itself errors before producing a decision, a
   before/permission-type event **fails closed** (denies) rather than
   silently allowing — this is the same fail-closed default the rest of
   XForge uses.

### Worked example

```yaml
# xforge/scaffold/policies/no-force-push.yaml
apiVersion: xforge.dev/v1alpha2
kind: PermissionPolicy
metadata:
  name: no-force-push
  version: 1
spec:
  capability: shell
  effect: deny
  match:
    commands: ["*git*--force*", "*git*push*-f*"]
  reason: >
    Force-pushing rewrites shared history; use a normal push and resolve
    conflicts, or ask a human to force-push deliberately.
```

Register it in `manifest.yaml`'s `scaffold.policies`, run `xforge sync`, and
the next time a projected Agent tries to run a matching shell command on any
platform whose hook is wired up, the platform's own permission prompt (or a
silent deny, depending on how that platform surfaces `hookSpecificOutput`)
fires — before the command executes, not after.

## Hooks — wiring platform events to XForge logic

A Hook (`kind: Hook`) has an `event` (from a fixed enum —
`agent.tool.before`, `agent.permission.request`, `stage.entered`,
`gate.after`, `approval.decided`, `archive.after`, ...), a `plane`
(`runtime` for live Agent-session events, `workflow` for governance-lifecycle
events), a `failurePolicy` (`deny`/`ask`/`stop`/`spool`/`warn` — what
happens if the Hook call itself fails), and an `action`.

### What actually runs today

`action.builtin: policy` and `action.builtin: audit` are the two working
paths. In practice, `xforge hook`'s dispatcher always resolves matching
PermissionPolicies and always records an audit event on a relevant call — a
Hook resource's real job is *declaring that a given platform event should
invoke `xforge hook` at all*, and at what `failurePolicy`, not selecting
different runtime behavior per Hook. `runtime-audit.yaml` (shipped disabled
by default) is the concrete example:

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Hook
metadata: { name: runtime-audit, version: 1 }
spec:
  enabled: false
  plane: runtime
  event: agent.tool.after
  action: { builtin: audit }
  failurePolicy: spool
  timeoutSeconds: 10
  matcher: "*"
```

Enabling it (`enabled: true`, register in `manifest.yaml`'s `scaffold.hooks`,
`xforge sync`) makes every projected platform call `xforge hook` after every
tool call, recording an audit trail of Agent activity — not just
Change/Flow/Gate governance events.

### Custom Hook logic — a scriptRef Hook

`action.scriptRef` points at a project-owned `kind: Script` resource
(`runtime: node` — JS or TS, transpiled in-process, no build step — or
`runtime: python`, via `python3`/`XFORGE_PYTHON`). On every `xforge hook
dispatch` call, the dispatcher looks up every **enabled** Hook resource whose
`event` matches the one that fired, runs each referenced Script via
`runProjectScript()`, and folds its result into the same decision the
built-in PermissionPolicy check produces — `deny` beats `ask` beats `allow`
beats "no opinion," exactly like combining multiple matching Policies.

**Contract between the dispatcher and your script:** the payload for the
firing event is piped to the script's stdin as one JSON document (tool name,
tool input, actor, change/flow/stage if resolvable). To participate in the
decision, the script prints one JSON line to stdout —
`{"decision": "allow"|"ask"|"deny"|null, "reason": "..."}` — read as the last
JSON-parseable line of stdout. A script that never prints a decision line
(fine for non-blocking events like `agent.tool.after`, where there is
nothing left to allow/deny) simply contributes no opinion.

**Failure handling is governed by the Hook's own `failurePolicy`**, not a
fixed rule: a script that exits non-zero, times out, or prints no
parseable decision line is treated as `deny` for `failurePolicy: deny` or
`stop`, `ask` for `failurePolicy: ask`, and as "no opinion" (never blocking)
for `spool`/`warn` — the audit event's `outcome` is set to `spooled` for the
`spool` case so a failing best-effort script hook is traceable without
blocking any Agent action.

```yaml
# xforge/scaffold/hooks/deny-generated-secrets.yaml
apiVersion: xforge.dev/v1alpha2
kind: Hook
metadata: { name: deny-generated-secrets, version: 1 }
spec:
  enabled: true
  plane: runtime
  event: agent.tool.before
  action: { scriptRef: secret-pattern-scan }
  failurePolicy: deny
  timeoutSeconds: 5
  matcher: "Write|Edit"
```

```yaml
# xforge/scripts/secret-pattern-scan/script.yaml
apiVersion: xforge.dev/v1alpha1
kind: Script
metadata: { name: secret-pattern-scan, version: 1 }
spec:
  runtime: node
  entry: main.mjs
  arguments: []
  workingDirectory: .
  timeoutSeconds: 5
  input: JSON payload on stdin
  output: one JSON decision line on stdout
  sideEffects: none
```

```js
// xforge/scripts/secret-pattern-scan/main.mjs
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  const content = payload.tool_input?.content ?? '';
  const looksLikeAKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content);
  process.stdout.write(`${JSON.stringify({
    decision: looksLikeAKey ? 'deny' : null,
    reason: looksLikeAKey ? 'Content matches a private key pattern.' : undefined,
  })}\n`);
});
```

Register `secret-pattern-scan` in `manifest.yaml`'s top-level `scripts` list
(not under `scaffold`) and `deny-generated-secrets` in `scaffold.hooks`, run
`xforge sync`, and every projected platform's `Write`/`Edit` tool calls now
run this script before they execute — a real, custom, deny-capable check
that isn't expressible as a Gate (Gates run at `check`/`archive`
checkpoints, not before every individual tool call) and isn't just a
PermissionPolicy pattern match (it inspects tool *content*, not just a path
or command string).

## Approvals — human or external-system authorization, bound to a revision

Unlike the other four, an Approval isn't a standalone project-owned YAML
file. A policy is declared inline in a Flow's `governance.approvalPolicies`
(`id`, `minApprovers`, `roles`, `separationOfDuties`, `providers`) and
referenced from a stage's `exit.approvals` or from
`terminal.archive.approvals`. What gets produced at runtime is an
`ApprovalReceipt` — signed JSON bound to the Change's exact
`stateRevision`/`contentRevision`/`policySnapshotDigest`/`gitHead`; any later
edit invalidates it.

### How it's actually invoked

`xforge approve --change <id> --for <stage|archive> --policy <id> ...` has
two paths:

1. **Local interactive** — requires a real TTY and `--attestation human`,
   and only works if the policy's `providers` includes `local`. Deliberately
   not automatable: Agents cannot self-approve. If your Agent harness itself
   mediates the confirmation (e.g. it already asked the human in-session
   before shelling out) and the `xforge approve` subprocess therefore has no
   TTY, set `approvals.local.requireTty: false` in `manifest.yaml` — every
   other requirement (`--attestation human`, `--actor`, `--role`, `--reason`,
   `--decision`, and the policy allowing the `local` provider) still applies.
   The default is `true` (require a real TTY), unchanged from before.
2. **External signed receipt** — `xforge approve --receipt <path>`, verified
   by HMAC-SHA256 against a shared secret named in `manifest.yaml`'s
   `approvals.providers[].secretEnv`. No TTY required — this is the
   extension point.

Receipts are re-verified on *every* `xforge state` computation, not cached
from approve-time — edit the Change after approval and the receipt goes
stale (`XFORGE_APPROVAL_STALE`, or a signature/digest check fails).

### Worked example: defining a policy

```yaml
# xforge/flows/major.yaml (excerpt)
governance:
  approvalPolicies:
    - id: implementation-major
      minApprovers: 2
      roles: [owner, maintainer, security]
      separationOfDuties: true
      providers: [enterprise-hmac]
```

```yaml
# manifest.yaml
approvals:
  providers:
    - id: enterprise-hmac
      type: hmac-sha256
      secretEnv: XFORGE_APPROVAL_SECRET
      roles: [owner, maintainer, security]
```

`minApprovers`/`roles`/`separationOfDuties` are enforced by counting
**distinct approver ids** with **distinct roles** among valid `approve`
receipts for the current revision — one person cannot satisfy a 2-approver
requirement by approving twice, and with `separationOfDuties: true`, two
approvers sharing one role don't satisfy it either.

### Reference: generating a signed `ApprovalReceipt` from an external system

This is the exact, byte-level contract an external platform (or a glue
script sitting in front of one) needs to implement to produce a receipt
`xforge approve --receipt <path>` will accept. It does not require running
any XForge code — everything here is reproducible from documented inputs.

**1. Get the binding inputs.** Run (or have your glue script run)
`xforge state --change <id>`. The fields you need are in
`data.change.governance`:

- `revision` → `{ contentRevision, stateRevision, policySnapshotDigest,
  gitBase, gitHead }` — the exact revision the receipt must be bound to.
- `pendingApprovals[]` → each entry's `policyId` and `transition` tell you
  which policy id and which `--for` value (`<stage>` or `archive`) the
  receipt is for.
- `currentStage` → the receipt's `stage` field.
- top-level `data.change.flow` → the receipt's `flow` field (the Flow's
  `metadata.name`).

**2. Build the unsigned payload** (every `ApprovalReceipt` field except
`signature` and `digest`):

| Field | Value |
|---|---|
| `apiVersion` | the literal string `xforge.dev/v1alpha2` |
| `kind` | the literal string `ApprovalReceipt` |
| `receiptId` | a fresh UUID (schema requires `format: uuid`) |
| `change` | the Change id |
| `flow` | Flow name from step 1 |
| `stage` | `currentStage` from step 1 |
| `transition` | `<stage>` or `archive` — whichever you're approving |
| `policyId` | the approval policy id from `pendingApprovals[]` |
| `stateRevision`, `contentRevision`, `policySnapshotDigest`, `gitBase`, `gitHead` | copied verbatim from `revision` in step 1 |
| `governingDigest` | see step 3 |
| `decision` | `"approve"` or `"reject"` |
| `approver` | `{ id, provider, role, type: "external-system" }` — `provider` must be an id listed in `manifest.yaml`'s `approvals.providers` (and in this policy's `providers` list); `role` must be one of the provider's and the policy's `roles` |
| `decidedAt` | ISO 8601 date-time |
| `reason` | non-empty human-readable string |
| `expiresAt` | optional ISO 8601 date-time — `xforge state` stops counting the receipt once this passes |
| `externalRef` | optional — your platform's own ticket/request id, carried through unchanged, not otherwise interpreted by XForge |

**3. Compute `governingDigest`:**

```
governingDigest = sha256(stableStringify({
  change:   <change id>,
  flow:     <flow name>,
  policy:   <policyId>,
  revision: { contentRevision, stateRevision, policySnapshotDigest, gitBase, gitHead },
}))
```

**4. Sign it.** `stableStringify(value)` is: recursively sort every object's
keys (plain `key.localeCompare()`; for the ASCII field names used
throughout this schema that's equivalent to ordinary lexicographic sort —
safe to reimplement in any language without pulling in ICU), then
`JSON.stringify` the result **with 2-space indentation** (not compact JSON —
this is a common source of signature mismatches when porting to another
language; match the indentation, not just the key order). Compute:

```
payload   = the unsigned object from step 2 (governingDigest included, no signature/digest field)
signature.value     = hex(HMAC-SHA256(secretEnv value, stableStringify(payload)))
signature.algorithm = "hmac-sha256"
```

The secret is whatever's in the environment variable named by this
provider's `secretEnv` in `manifest.yaml` — coordinate that value with
whoever operates the external platform; XForge never transmits or stores it.

**5. Compute the final `digest`** over payload + signature (still excluding
`digest` itself):

```
signed  = { ...payload, signature }
digest  = sha256(stableStringify(signed))
receipt = { ...signed, digest }
```

Write `receipt` to a file and hand it to
`xforge approve --change <id> --for <transition> --policy <policyId> --receipt <path>`.
Schema validation runs first (reject anything that doesn't match
`approval-receipt.schema.json`, e.g. a non-UUID `receiptId`), then
`verifyApprovalReceipt()` re-derives `digest` and `signature.value` exactly
as above and compares.

**Reference implementation** (Node's `crypto`/`JSON.stringify` is the source
of truth; here's the same algorithm in Python, useful if your platform isn't
Node):

```python
import hashlib, hmac, json

def stable_stringify(value):
    def normalize(item):
        if isinstance(item, list):
            return [normalize(v) for v in item]
        if isinstance(item, dict):
            return {k: normalize(item[k]) for k in sorted(item.keys())}
        return item
    return json.dumps(normalize(value), indent=2, ensure_ascii=False)

def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def hmac_sha256_hex(secret: str, text: str) -> str:
    return hmac.new(secret.encode('utf-8'), text.encode('utf-8'), hashlib.sha256).hexdigest()
```

`sorted(item.keys())` is a plain codepoint sort — for this schema's field
names it produces the same order as JS's `localeCompare`. Don't assume that
equivalence holds for arbitrary user-supplied strings elsewhere; it's only
being claimed for the fixed field names in this schema.

### Extending it: routing approval through an external platform (e.g. via MCP)

The external-receipt path is intentionally decision-agnostic —
`xforge approve --receipt` only checks that the receipt is validly signed,
bound to the current revision, and uses an authorized role/provider. It
doesn't care what produced it. A common extension: have the Agent submit the
approval request to an internal platform through an MCP tool, wait for a
human decision, then have that platform (or a small glue script) emit a
signed receipt:

1. The Agent calls an MCP tool exposed by your approval platform, submitting
   the Change id, Flow, stage, and governing revision.
2. A human approves on the platform — Slack, an internal portal, ServiceNow,
   whatever you already use for change approval.
3. The platform (or a script polling its API) constructs and signs the
   receipt exactly as described above in
   "Reference: generating a signed `ApprovalReceipt`".
4. Anything — the Agent itself, a CI job, a webhook handler — calls
   `xforge approve --receipt <path>` to import the result.

No XForge code changes are needed for this: MCP here is just the transport
your platform happens to use to talk to the Agent; the trust boundary
XForge actually checks is the HMAC signature.

If your platform can expose an MCP server that XForge itself talks to
directly — rather than routing through the Agent and a hand-signed file —
use the native `mcp` provider `type` instead of this glue-script pattern;
see [Extending Approvals with an MCP provider](extending-approvals-with-mcp.md)
for the submit/poll tool contract and the (deliberately signature-free)
trust model that goes with it.

## Checklist

New Gate:
- [ ] `xforge/scaffold/gates/<id>.yaml` created; registered in
      `manifest.yaml`'s `scaffold.gates`
- [ ] Referenced in the Flow stage(s) or `terminal.archive.mandatoryGates`
      that should require it — an unreferenced Gate never runs
- [ ] `command` is your project's own toolchain invocation with a clean
      exit-code contract; not embedding governance decisions in prose output

New Rule:
- [ ] `enforcement.gateRefs`/`policyRefs`/`approvalRefs` point at Gates/
      Policies/Approvals that actually exist and actually apply where the
      Rule claims — verify `xforge state`'s `coverage` output says what you
      expect, not `uncovered`
- [ ] `scope` (modules/paths/stages) is as narrow as the instruction
      actually needs

New PermissionPolicy:
- [ ] `capability` + `match` patterns tested against real tool-call payloads
      you expect to see (a path, a shell command string, a host)
- [ ] `effect: deny` used deliberately — remember it beats every matching
      `allow` regardless of policy count
- [ ] Registered in `manifest.yaml`'s `scaffold.policies`, `xforge sync` run

New Hook:
- [ ] For `action.scriptRef`: the Script prints one `{"decision", "reason"}`
      JSON line to stdout when it has an opinion; prints nothing (or a line
      without `decision`) when it doesn't
- [ ] `failurePolicy` chosen deliberately (`deny`/`stop` for governance-
      critical events, `spool`/`warn` for best-effort/advisory checks whose
      failure should never block an Agent)
- [ ] `enabled: true` and registered in `manifest.yaml`'s `scaffold.hooks`;
      the Script itself registered in `manifest.yaml`'s top-level `scripts`

New Approval policy:
- [ ] `minApprovers`/`roles`/`separationOfDuties` match the actual
      authorization requirement — distinct approver *ids*, not receipt
      count, satisfy `minApprovers`
- [ ] `providers` matches an entry actually declared in `manifest.yaml`'s
      `approvals.providers`; `secretEnv` points at a real, populated
      environment variable wherever `xforge approve --receipt` runs
- [ ] Referenced from the right stage's `exit.approvals` or
      `terminal.archive.approvals` — a policy nobody references never
      blocks anything
- [ ] If an external system will sign receipts for it: `stableStringify` is
      reimplemented byte-for-byte (recursive key sort, 2-space-indented
      JSON) — verify it against a real signed receipt (e.g. one produced by
      `xforge approve --receipt` against a test project, or by the
      `approveCurrentRevision` test helper) before wiring it into anything
      that gates a real transition; `--dry-run` does not return a receipt to
      diff against
