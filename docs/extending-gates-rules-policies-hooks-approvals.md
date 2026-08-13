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
different runtime behavior per Hook. `runtime-audit.yaml` (shipped as an
unselected, disabled example — no dispatcher executes its `builtin: audit`
action yet) is the concrete shape:

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
`ApprovalReceipt` — JSON bound to the Change's exact
`stateRevision`/`contentRevision`/`policySnapshotDigest`/`gitHead`; any later
edit invalidates it. Neither approval path signs the receipt; instead, every
receipt is trusted only if it's backed by a matching event in the project's
own tamper-evident audit hash chain — see "Trust model" below.

### How it's actually invoked

`xforge approve --change <id> --for <stage|archive> --policy <id> ...` has
two paths:

1. **Local interactive** — requires a real TTY
   (`process.stdin.isTTY && process.stdout.isTTY`) and only works if the
   policy's `providers` includes `local`. The CLI runs its own
   `readline`-based dialogue that asks for approver identity, role, the
   decision word (approve/reject), and a reason, all typed live at the
   terminal — there is no confirmation/challenge code to read back, and none
   of this is taken from command-line flags: `--actor`/`--role`/`--reason`
   are only pre-fill suggestions for the prompts, never authoritative, and
   `--attestation human` is only an intent hint, not itself a decision.
   Deliberately not automatable: Agents cannot self-approve. If your Agent
   harness itself mediates the confirmation (e.g. it already asked the
   human in-session before shelling out) and the `xforge approve` subprocess
   therefore has no TTY, set `approvals.local.requireTty: false` in
   `manifest.yaml` — every other requirement (the live dialogue, and the
   policy allowing the `local` provider) still applies. The default is
   `true` (require a real TTY), unchanged from before.
2. **`mcp` provider** — `xforge approve --provider <id>`, where `<id>` names
   an entry in `manifest.yaml`'s `approvals.providers` of the only shape
   that exists, `{ id, type: mcp, mcpServer: <id>, roles: [...] }`. XForge
   calls `submit_approval_request` then `poll_approval` against the
   registered `McpServer`; a `pending` poll returns a successful envelope
   with a `nextActions` entry telling the caller to re-run later — it's not
   an error. See
   [Extending Approvals with an MCP provider](extending-approvals-with-mcp.md)
   for the full contract.

Receipts are re-verified on *every* `xforge state` computation, not cached
from approve-time — edit the Change after approval and the receipt goes
stale (`XFORGE_APPROVAL_STALE`, or the audit-chain check fails).

### Worked example: defining a policy

```yaml
# xforge/flows/major.yaml (excerpt)
governance:
  approvalPolicies:
    - id: implementation-major
      minApprovers: 2
      roles: [owner, maintainer, security]
      separationOfDuties: true
      providers: [enterprise-approvals]
```

```yaml
# manifest.yaml
approvals:
  providers:
    - id: enterprise-approvals
      type: mcp
      mcpServer: enterprise-approvals
      roles: [owner, maintainer, security]
```

`minApprovers`/`roles`/`separationOfDuties` are enforced by counting
**distinct approver ids** with **distinct roles** among valid `approve`
receipts for the current revision — one person cannot satisfy a 2-approver
requirement by approving twice, and with `separationOfDuties: true`, two
approvers sharing one role don't satisfy it either.

Note that the `enterprise-approvals` example above is a name/shape only —
there's no working default `McpServer` resource behind it. Using it without
registering a real `McpServer` (see
[Extending Approvals with an MCP provider](extending-approvals-with-mcp.md))
fails closed with `XFORGE_APPROVAL_MCP_SERVER_MISSING`, the same pattern the
`runtime-audit` Hook uses by shipping unselected and disabled.

### Trust model — why there's no signature

Neither `local` nor `mcp` receipts carry a `signature` field. What makes a
receipt trustworthy is the project's own tamper-evident audit hash chain,
not per-receipt cryptography: every successful `xforge approve` run writes
the receipt file *and* appends a matching `approval.decided` event to the
audit chain in the same run, before it returns. When receipts are loaded —
`loadApprovalReceipts` in `xforge/src/core/control-plane.ts` — each one is
checked, unconditionally for both provider types, against the chain via
`approvalVerifiedInChain()` (`xforge/src/core/audit.ts`). A receipt file
that was never produced by an actual `xforge approve` run (hand-copied,
restored from a stale branch, etc.) has no matching chain event and is
rejected with `XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN` — a non-blocking-severity
finding, so it doesn't accidentally freeze unrelated transitions, but the
receipt itself never counts as valid. On a fresh clone or CI machine without
the local (gitignored) audit log, the same check falls back to the
committed per-Change `evidence/audit/index.json`.

This replaced an earlier design where local approvals were paired with a
typed confirmation/challenge code and external approvals were authenticated
by an HMAC signature over a shared secret. Both were removed: the
confirmation code was a pure deterministic function of already
publicly-known data (change id, flow, policy, revision — all readable via
`xforge state`), so anyone with repo write access could compute it without
ever using a terminal; it forced a live dialogue to *exist* without adding
real forgery resistance, which the interactive-TTY requirement already
provides on its own. The audit-chain check above is what replaces both: it
verifies the receipt was actually produced by a real `xforge approve`
invocation, rather than asking the receipt to prove itself.

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
      `approvals.providers` — for an `mcp` provider, its `mcpServer` names a
      registered `McpServer` resource, not just an aspirational id
- [ ] Referenced from the right stage's `exit.approvals` or
      `terminal.archive.approvals` — a policy nobody references never
      blocks anything
- [ ] For an `mcp` provider: confirm at least one real approve/reject round
      trip against a test project (e.g. via the `approveCurrentRevision`
      test helper) before wiring it into anything that gates a real
      transition; `--dry-run` does not append an audit event or a receipt to
      check against
