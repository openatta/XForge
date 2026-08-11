[简体中文](extending-approvals-with-mcp.zh-CN.md) | English

# Extending Approvals with an MCP provider

This is the reference for the third Approval mechanism: an `mcp`-type
provider, where `xforge approve` itself becomes an MCP client and talks
directly to your approval platform's MCP server, live, instead of going
through a human at a TTY or a pre-signed receipt file. Read
[Extending Gates, Rules, PermissionPolicies, Hooks, and Approvals](extending-gates-rules-policies-hooks-approvals.md)
first for how Approvals bind to a Flow and revision in general, and for the
`local` and `hmac-sha256` provider paths this one sits alongside.

## When this is the right tool

Three provider types, three trust models — pick per policy, not globally:

| Provider `type` | Who/what decides | Trust boundary | Typical use |
|---|---|---|---|
| `local` | A human at a real TTY | The TTY itself (or, with `approvals.local.requireTty: false`, whatever your Agent harness already confirmed in-session) | Small teams, low-ceremony changes |
| `hmac-sha256` | Anything, offline | A shared secret signs the receipt after the fact | Bridging into an existing approval system (ServiceNow, an internal portal) that you don't want to give live API access to |
| `mcp` | Your platform, live | The MCP connection itself (transport + auth token) | Programmatic or automated review — a bot that evaluates the Change and decides, or a human workflow your platform already runs, reachable over MCP |

If your platform can already expose an MCP server, `mcp` is the one that
doesn't require anyone to manually construct and sign a JSON file — XForge
drives the round trip itself.

## Why submit + poll, not one blocking call

A naive design would be one `request_approval` MCP tool call that XForge
holds open until a decision comes back. That doesn't work for anything a
human might take hours or days to decide — no MCP transport wants a
connection held open that long, and there's no sane `timeoutSeconds` to
pick.

Instead, `xforge approve --provider <id>` does exactly one round per
invocation:

1. Connect to the MCP server.
2. Call `submit_approval_request` — idempotent, keyed by `governingDigest`
   (the same digest already used to bind receipts to a revision — see the
   Approvals reference doc). Submitting twice for the same Change/Flow/
   Stage/policy/revision is always safe; your platform should recognize the
   digest and not create a duplicate request.
3. Call `poll_approval` once.
4. If it's still `pending`: exit non-zero, write nothing, and print the
   exact command to re-run later — no separate resume mechanism needed,
   since `submit` is a no-op on an already-open request.
5. If it's `decided`: write an `ApprovalReceipt` (no signature — see
   "Trust model" below) and continue exactly like the other two provider
   paths.

Nothing about pacing (how often to re-run) is XForge's concern — that's
whatever polls `xforge state`'s `pendingApprovals` today already, whether
that's the Agent itself on its own cadence, a CI retry loop, or a human
re-running the command once they know their platform decided.

## Where the config lives

An `mcp` provider is two pieces:

**1. A `McpServer` resource** — its own YAML file, independent of the
provider entry, because connection details (how to reach it, what
credential to use) are a different concern from "which policy is this
provider allowed to satisfy":

```yaml
# xforge/scaffold/mcp-servers/review-bot.yaml
apiVersion: xforge.dev/v1alpha2
kind: McpServer
metadata: { name: review-bot, version: 1 }
spec:
  transport: stdio            # or "http"
  command: [node, review-bot-mcp/server.mjs]   # stdio only
  # url: https://review-bot.internal/mcp       # http only
  authTokenEnv: XFORGE_REVIEW_BOT_TOKEN
  timeoutSeconds: 30
```

Register it in `manifest.yaml`'s `scaffold.mcpServers` the same way Gates
and Hooks are registered — an `McpServer` file that isn't listed there is
never loaded:

```yaml
# manifest.yaml
scaffold:
  mcpServers: [review-bot]
```

**2. An `approvals.providers[]` entry** with `type: mcp`, referencing the
`McpServer` by name and declaring which roles it's trusted to approve as:

```yaml
# manifest.yaml
approvals:
  providers:
    - id: review-bot
      type: mcp
      mcpServer: review-bot
      roles: [owner, maintainer]
```

Then reference the provider id from a Flow's approval policy exactly like
any other provider — no Flow schema changes, this is the same
`governance.approvalPolicies[].providers` list `local` and `hmac-sha256`
providers already use:

```yaml
# xforge/flows/solid.yaml (excerpt)
governance:
  approvalPolicies:
    - id: planning-solid
      minApprovers: 1
      roles: [owner, maintainer]
      separationOfDuties: false
      providers: [local, review-bot]
```

Run it with:

```bash
xforge approve --change <id> --for <stage|archive> --policy planning-solid --provider review-bot
```

## `McpServer` field reference

| Field | Required | Meaning |
|---|---|---|
| `transport` | yes | `stdio` (XForge spawns your server as a subprocess) or `http` (XForge connects to a URL over Streamable HTTP) |
| `command` | if `stdio` | Argv array — first element is the executable, the rest are arguments |
| `cwd` | no | Working directory for the spawned process, relative to the project root; defaults to the project root |
| `url` | if `http` | The MCP endpoint |
| `authTokenEnv` | yes | Name of the environment variable holding the credential. Always required — even for `stdio`, because the server you're spawning locally may still need to authenticate to something downstream on your platform's behalf |
| `timeoutSeconds` | yes | Per-call RPC timeout (applies to `submit_approval_request` and `poll_approval` individually, and to the initial connection handshake) |

**How the token is delivered:**
- `stdio` — passed to the spawned process as the `XFORGE_MCP_TOKEN`
  environment variable (in addition to inheriting the rest of XForge's own
  environment). Your server reads that fixed variable name; it doesn't need
  to know XForge's own `authTokenEnv` name.
- `http` — sent as an `Authorization: Bearer <token>` header on every
  request.

**Connection retries:** if connecting (or a call once connected) fails,
XForge retries the whole round — connect, submit, poll — up to 3 times with
a short backoff, then exits with `XFORGE_APPROVAL_MCP_CONNECTION_FAILED`.
Retrying the whole round, not just the connect step, is safe specifically
because `submit_approval_request` is idempotent by `governingDigest` and
`poll_approval` is a pure read.

## The tool interface your MCP server must implement

Two tools, fixed names, no negotiation — this is deliberately not
configurable, so there's exactly one contract to implement and document.
Both take and return plain JSON: **arguments as the tool call's
`arguments` object, and the result as a single `text` content item whose
`text` is a JSON string** (not `structuredContent` — keeping to a plain
text-content JSON payload means any MCP server SDK, in any language, can
implement this without additional output-schema negotiation).

### `submit_approval_request`

Input:

```json
{
  "change": "add-feature",
  "flow": "solid",
  "stage": "design",
  "transition": "apply",
  "policyId": "planning-solid",
  "revision": {
    "stateRevision": "...", "contentRevision": "...", "policySnapshotDigest": "...",
    "gitBase": "...", "gitHead": "..."
  },
  "governingDigest": "<sha256 hex — the idempotency key>",
  "roles": ["owner", "maintainer"],
  "reason": ""
}
```

Output: any JSON object (XForge doesn't interpret it beyond confirming the
call succeeded) — `{"accepted": true}` is enough. Use `governingDigest` as
your platform's dedup key: if a request for that digest is already open,
treat this as a no-op and return the same acceptance.

### `poll_approval`

Input:

```json
{ "governingDigest": "<sha256 hex>" }
```

Output — still waiting:

```json
{ "status": "pending" }
```

Output — decided:

```json
{
  "status": "decided",
  "decision": "approve",
  "approver": { "id": "alice@example.test", "role": "owner" },
  "reason": "Looks good.",
  "expiresAt": "2026-09-01T00:00:00Z"
}
```

`decision` is `"approve"` or `"reject"`. `approver.role` must be one of the
roles configured on both the `approvals.providers[]` entry and the Flow
policy being satisfied — if it isn't, XForge rejects the decision with
`XFORGE_APPROVAL_ROLE_FORBIDDEN` and writes nothing; check this on your
platform's side too, so a misconfigured role fails before you tell a human
their approval "worked." `expiresAt` is optional; if present, `xforge
state` stops counting the resulting receipt as valid once it passes.

## Trust model — why there's no signature

Receipts produced through this path have `approver.type: "external-system"`
and `approver.provider` set to your provider id, same shape as an
`hmac-sha256` receipt — but no `signature` field, and
`verifyApprovalReceipt()` doesn't require one for `mcp`-type providers.

This isn't a weaker tier bolted on for convenience — it's the same
trust-by-provenance model `local` receipts already have (a `local` receipt
also carries no signature). An `hmac-sha256` receipt needs a signature
because it arrives as a file from anywhere and has to be authenticated
after the fact. An `mcp` receipt is authenticated by the live round trip
itself: XForge dialed a connection it trusts (the `McpServer` resource is
project-owned, version-controlled config) using a credential from a
protected environment variable, and got a decision back synchronously in
the same process invocation that writes the receipt. The receipt file is
still tamper-evident after the fact (its own `digest` covers its content,
and `xforge state` re-verifies that digest on every read), but there's no
independent cryptographic proof that the decision itself was genuine beyond
"this repository's `<change>/approvals/` directory hasn't been hand-edited"
— exactly the same guarantee `local` approvals already rely on.

If you need retroactively-verifiable proof independent of repository
integrity, use the `hmac-sha256` path instead, or have your MCP server sign
its own decision with a secret it and your compliance tooling both hold
(outside anything XForge inspects).

## Activating this without teaching every Agent about it

Deliberately, there's no new Skill and no prompt/Constitution text added
for this feature — that would grow every session's context for a mechanism
most Flows will never use. Instead, `xforge state`'s
`governance.pendingApprovals[]` entries carry a `providers` array —
`[{ "id": "local", "type": "local" }, { "id": "review-bot", "type": "mcp" }]`
— so an Agent (or a human) discovers that `--provider review-bot` is
available purely by reading already-machine-readable `xforge state` output,
the same way it already discovers the exact `xforge approve ...` command
to run from `nextActions`. No documentation needs to be pre-loaded into a
session for this to work; the affordance is data, not prose.

## Checklist

New `mcp` Approval provider:
- [ ] `McpServer` resource created, registered in `manifest.yaml`'s
      `scaffold.mcpServers` — an unregistered `McpServer` file is never
      loaded and `--provider` will fail with `XFORGE_APPROVAL_MCP_SERVER_MISSING`
      (run `xforge doctor` to catch a `providers[].mcpServer` typo statically,
      as `XFORGE_APPROVAL_MCP_SERVER_UNKNOWN`, before it ever reaches an
      `approve` call; a registered-but-unreferenced `McpServer` shows up
      there too, as an `uncited` finding)
- [ ] `approvals.providers[]` entry references it by name, `roles` matches
      what your platform will actually return in `poll_approval`
- [ ] Referenced from the Flow policy's `providers` list alongside (or
      instead of) `local`/`hmac-sha256` — same rule as any other provider:
      unreferenced never blocks or satisfies anything
- [ ] `authTokenEnv` points at a real, populated environment variable
      wherever `xforge approve --provider` actually runs (developer
      machine, CI, both)
- [ ] Your server implements both `submit_approval_request` (idempotent by
      `governingDigest`) and `poll_approval` (returns `pending` promptly,
      never blocks) exactly as specified above — tested against a real
      `xforge approve --provider <id>` run, not just unit-tested in
      isolation
- [ ] Decided one way manually first (approve, then reject) to confirm role
      enforcement and the written receipt both look right before relying on
      it to gate a real transition
