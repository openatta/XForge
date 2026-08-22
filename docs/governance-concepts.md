[简体中文](governance-concepts.zh-CN.md) | English

# Skills, Flows, Rules, Gates, Hooks, PermissionPolicies, and Approvals

Seven names get used together constantly and conflated easily. This page is
the concept map: what each one actually is, what triggers it, and which
guide to read when you want to extend it. For the how-to (schemas, worked
YAML, checklists) see [Extending Skills and Flows](extending-skills-and-flows.md)
and [Extending Gates, Rules, PermissionPolicies, Hooks, and Approvals](extending-gates-rules-policies-hooks-approvals.md).

## At a glance

| | Primary function | Triggered by | Extend when you want to... |
| --- | --- | --- | --- |
| **Skill** | The Agent-facing instructions for one unit of work | The user or the Flow's stage graph naming it | Add a new capability |
| **Flow** | The stage graph + governance a Change moves through | Chosen at Propose, from manifest default or override | Model a different delivery/risk process |
| **Rule** | A declared instruction, with its enforcement claim verified, not trusted | Re-evaluated every `xforge state` computation | Make a written standard mechanically honest |
| **Gate** | A deterministic check producing signed, revision-bound Evidence | `xforge check`, before a Transition or Archive | Add an objective correctness/quality checkpoint |
| **Hook** | The wiring from a coding tool's native event to XForge logic | Every matching Agent-tool or governance event, live | Bridge a new event, or plug in custom logic |
| **PermissionPolicy** | An `allow`/`ask`/`deny` decision for one capability | Every matching tool call, via a Hook, live | Block a specific dangerous action in real time |
| **Approval** | A human or external-system decision, bound to the current revision | A Flow stage's declared `exit.approvals` | Embed a real authorization step |

## Two independent tracks, not one pipeline

The easiest wrong mental model is "Gate, then Rule, then Policy, then
Approval" as one sequential check per Stage. It's actually two tracks that
don't feed into each other, plus one cross-cutting honesty check:

**Stage-transition governance** — Gates and Approvals only. A Flow stage
declares which Gates it requires (`gates: [...]`) and which Approval
policies gate its exit (`exit.approvals: [...]`, or
`terminal.archive.approvals` before Archive). These are evaluated when
something asks to advance — `xforge check`, `xforge transition`,
`xforge archive` — and nowhere else. Most stages have neither; only the
ones a Flow author explicitly wired.

**Live runtime governance** — PermissionPolicies and (most) Hooks. These
run continuously, on every matching Agent tool call, completely independent
of which Stage the Change is in or whether there's an active Change at all.
A `Write` call gets evaluated against PermissionPolicies whether the Agent
is in Propose, Apply, or doing something with no Change open.

**Rules sit across both, verifying, not gating.** A Rule doesn't get
"checked" as a step in either track. It declares `severity` + `instruction`
+ which Gates/Policies/Approvals it claims back it up
(`enforcement.gateRefs`/`policyRefs`/`approvalRefs`), and every `xforge
state` computation cross-references that claim against what's actually
true right now, producing `coverage`: `instructed` (baseline) →
`guarded`/`verified`/`approved` (a real Policy/Gate/Approval backs it) or
`uncovered` (a `must` Rule with nothing mechanical behind it). A Rule never
blocks anything by itself — it makes the gap between "written down" and
"actually enforced" visible instead of hidden.

## Skills

The Agent-facing interface. Each Skill is `SKILL.md` (+ `SKILL_cn.md`) with
five fixed sections — Invariants, Authority, Execution, Evidence, Stop and
rework. A Skill consumes the current ready Action from `xforge state` and
follows that Action's data (instruction/outline), never hardcodes another
Skill's steps or a Flow's name. 10 ship by default: the lifecycle ones
(`xforge-propose`/`clarify`/`design`/`check`/`apply`/`verify`), governance
utilities (`xforge-revise`, `xforge-scaffold`), and read-only reporting
(`xforge-status`, `xforge-kanban`).

## Flows

The stage graph a Change moves through, plus the governance bound to it:
which Skill owns each stage, which Gates and Approvals each stage requires,
work-package execution mode, and audit policy. Three ship by default —
`quick` (Propose→Apply→Verify), `solid` (adds Design), `major` (adds
Clarify, Design, Check, and stronger dual-approval, dual-role governance).
Flow policy can make a Flow *required* (not just eligible) for a given risk/
impact classification, and can make one *ineligible* (Quick refuses
cross-module or non-low-risk work) — this is enforced structurally, not by
an Agent's judgment call.

## Rules

See "Two independent tracks" above for the mechanism. Rules are the only
one of the seven that ships with zero examples by default — `xforge/scaffold/rules/`
is empty, waiting for a project to author its own standards.

## Gates

A deterministic check: either a fixed `command` (any language, any
toolchain — `npm test`, `pytest`, `go vet`, whatever your project runs) or
the one special case `builtin: structure` (the CLI's own in-process schema/
reference/eligibility validator, wrapped in the same Evidence shape for
uniformity). Every shipped Flow requires `structure` + `unit-tests` at
Verify at minimum; `major` adds `security-scan`. Gates are the closest thing
to a non-optional baseline among the seven — there's no shipped Flow that
skips correctness checking before Archive.

## Hooks

The bridge between a coding tool's native event (`PreToolUse`, a session
start, a permission request) and XForge logic. `xforge init`/`install`/`sync`
projects enabled Hook resources into each platform's native hook config,
wired to call `xforge hook dispatch --target <platform>
--event <event>`. Three things flow through that one dispatch call:

1. **Live PermissionPolicy evaluation** (always runs on a relevant event —
   see PermissionPolicies below).
2. **Audit recording** (`builtin: audit`, or implicitly on every dispatch
   regardless — see "What actually gets recorded" below).
3. **Custom scriptRef logic** — a Hook can reference a project-owned
   `kind: Script` (Node or Python) that reads the event payload from stdin
   and can itself contribute an `allow`/`ask`/`deny` opinion, merged with
   the PermissionPolicy result by the same deny-beats-ask-beats-allow rule.

### What actually gets recorded for audit

Every dispatch call writes one hash-chained `AuditEvent` (previousHash links
each event to the one before it, so tampering breaks the chain, not just one
record). The fields that matter when you actually go read this:

```json
{
  "eventType": "agent.tool.before",
  "plane": "runtime",
  "platform": "codex",
  "actor": { "id": "worker", "provider": "codex", "role": "agent", "type": "agent" },
  "change": "credential-store", "flow": "major", "stage": "apply",
  "refs": { "policies": ["protected-files"], "rules": [], "gates": [] },
  "decision": "deny",
  "reason": "Shared governance files may be written only by the Integrator...",
  "outcome": "denied",
  "inputDigest": "sha256:...", "outputDigest": "sha256:...",
  "redaction": "strict",
  "coverage": { "observed": true, "gaps": [] },
  "previousHash": "sha256:...", "deliveryState": "delivered", "hash": "sha256:..."
}
```

Note what's *not* there: the actual file content, the actual shell command
text, the actual tool arguments. Only `inputDigest`/`outputDigest` (hashes)
are recorded by default (`redaction: strict`) — the trail proves *that* a
decision happened and *why* (`refs`, `decision`, `reason`), without leaking
whatever the Agent was reading or writing.

Read this trail with:

```bash
xforge audit status                 # counts by eventType, coverage gaps, remote-pending count
xforge audit status --change <id>    # scoped to one Change
xforge audit verify --change <id>     # hash-chain integrity + required-event-type completeness for that Change's Flow
xforge audit export --change <id> --output report.json   # the full redacted event list, for external review
```

`audit verify` is what actually gates Archive for Flows with
`remoteDelivery: required` (Major, by default) — if required events haven't
been delivered to a configured remote sink, Archive is blocked until
`audit retry` clears the backlog or the remote comes back.

## PermissionPolicies

One `capability` (`fs.read`/`fs.write`/`shell`/`network`/`mcp`/`subagent`/
`external.write`), one `effect` (`deny`/`ask`/`allow`), and a `match`
pattern. Evaluated live, via the Hook dispatch described above, on every
matching tool call — not bound to any Stage. Whether you need custom
PermissionPolicies is less a question of team size than of supervision: an
interactive, human-watched session already gets a permission prompt from
the coding tool itself; unattended or parallel-Worker execution has nobody
watching, which is exactly when a PermissionPolicy is the only thing that
can still catch a dangerous action. One ships by default
(`protected-files`, denying writes to `constitution.md`/`specs/**`/
`manifest.yaml`/`lock.yaml` outside the Integrator) protecting XForge's own
governance files from accidental self-inflicted damage.

## Approvals

A human or external-system decision, produced as an `ApprovalReceipt` bound
to the exact current `stateRevision`/`contentRevision`/`gitHead` — any later
edit invalidates it. Two ways to produce one: local interactive
(`xforge approve` run in a real TTY, a `readline` dialogue asks for
identity, role, decision and reason live — deliberately not automatable,
Agents cannot self-approve) or an `mcp` provider registered in
`manifest.yaml`'s `approvals.providers`, which submits and polls a request
against an external `McpServer`. Neither path signs the receipt; instead,
`xforge approve` writes the receipt and appends a matching event to the
project's tamper-evident audit chain in the same run, and a receipt is only
trusted if that chain event exists. Every shipped Flow requires at least one
Approval before Archive, even Quick — the rigor scales with the Flow
(Quick: one attester at Archive; Solid: one before implementation and one at
Archive; Major: the same two points, each with `separationOfDuties: true`).
Both provider kinds are accepted at every level, including Major: the shipped
`enterprise-approvals` provider is a placeholder that fails loudly rather than
pretending to work, so until it is pointed at a real system every decision is
in practice captured through `local`. What `separationOfDuties` requires is
that the approver is **not an implementer of this Change** — implementers being
the Git authors of the Change directory and of every work-package delivery
range. It has never compared roles: `roles` is an eligibility filter for who
may approve at all. Approval is the one
concept among the seven where "do I need this" isn't really optional in the
defaults — only the weight is adjustable.

## Where to go next

- [Extending Skills and Flows](extending-skills-and-flows.md) — add a
  Skill, add a Flow, and where Flow-conditional behavior belongs.
- [Extending Gates, Rules, PermissionPolicies, Hooks, and Approvals](extending-gates-rules-policies-hooks-approvals.md)
  — schemas, worked YAML, and how each one is actually invoked at runtime.
- [Governance control plane design](governance-control-plane-design.md) —
  the deeper design rationale and tradeoffs behind this model, if you want
  the why, not just the what.
