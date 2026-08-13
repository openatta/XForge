import path from 'node:path';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';
import { runXforgeInteractive, runXforgeJson } from './xforge-cli.mjs';

/**
 * XForge supports exactly two approval mechanisms — a local interactive terminal and an mcp
 * provider — and no signed-file-import path. This harness stands in for the human/external system
 * either would normally require, deterministically and without spending a model turn on it (see
 * ../../docs/internal, or `core/control-plane.ts`: "Agents cannot self-approve").
 *
 * A Change's own Flow decides which mechanism a given policy takes through its `providers` list:
 * `mechanismFor` below prefers `local` whenever it is listed (Major's `implementation-major`/
 * `closing-major` currently do list it, so they are driven through the piped-stdin dialogue), and
 * falls back to an mcp provider otherwise. This script reads the policy definition and picks
 * whichever mechanism it actually allows, rather than assuming one.
 */

const MCP_TOKEN = 'xforge-live-e2e-mcp-token';

function options(argv) {
  const result = { 'simulate-rejection': 'false' };
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, '')] = argv[index + 1];
  for (const key of ['root', 'change', 'transition', 'policy']) if (!result[key]) throw new Error(`--${key} is required.`);
  result.root = path.resolve(result.root);
  result.simulateRejection = result['simulate-rejection'] === 'true';
  return result;
}

async function loadPolicyDefinition(root, flowName, policyId) {
  const { readFile } = await import('node:fs/promises');
  const flowPath = path.join(root, 'xforge', 'flows', `${flowName}.yaml`);
  const flow = parse(await readFile(flowPath, 'utf8'));
  const definition = flow.governance?.approvalPolicies?.find((entry) => entry.id === policyId);
  if (!definition) throw new Error(`Approval policy ${policyId} was not found in ${flowPath}.`);
  return definition;
}

/**
 * Picks `minApprovers` distinct actors. When `separationOfDuties` is set, roles are chosen to
 * be pairwise distinct up to `min(minApprovers, roles.length)` (the exact bound the CLI's own
 * governance engine enforces in control-plane.ts), cycling through the declared role list
 * again only once every distinct role has been used at least once.
 */
function planApprovers(definition) {
  const approvers = [];
  for (let index = 0; index < definition.minApprovers; index += 1) {
    const role = definition.roles[index % definition.roles.length];
    approvers.push({ id: `${role}-${Math.floor(index / definition.roles.length) + 1}@example.test`, role });
  }
  return approvers;
}

/**
 * Drives `xforge approve`'s local terminal dialogue over a piped stdin. `--actor`/`--role`/
 * `--reason` are only pre-fill suggestions (never the decision itself, by design — an Agent could
 * otherwise self-approve by stuffing argv), so blank lines accept them; the decision word must
 * still be typed. Requires `approvals.local.requireTty: false` in the project's manifest (set once
 * by setup.mjs) since this stdin is piped, not a real controlling terminal.
 */
function runLocalApproval(root, { changeId, transition, policyId, approver, decision, reason }) {
  /* Flags pre-fill identity/role/reason (blank answers below accept the suggestion); the decision
     word has no suggestion and must be the literal typed line. Prompt text must track
     collectLocalDecision in xforge/src/commands/approve.ts exactly. */
  return runXforgeInteractive(root, [
    'approve', '--change', changeId, '--for', transition, '--policy', policyId,
    '--actor', approver.id, '--role', approver.role, '--reason', reason,
  ], {
    exchanges: [
      { waitFor: 'Approver identity', send: '' },
      { waitFor: 'Approver role', send: '' },
      { waitFor: 'Decision (approve | reject)', send: decision },
      { waitFor: 'Reason', send: '' },
    ],
  });
}

/**
 * Drives `xforge approve --provider enterprise-approvals`, a real submit_approval_request /
 * poll_approval round trip against xforge/test/fixtures/mcp-approval-server.mjs (the same fixture
 * the internal integration suite uses), which setup.mjs already registered in place of the
 * scaffold's deliberately-inert placeholder McpServer. The fixture is env-var driven, so each call
 * gets its own decision/approver by setting fresh env for that one spawn.
 */
function runMcpApproval(root, { changeId, transition, policyId, providerId, approver, decision }) {
  return runXforgeJson(root, [
    'approve', '--change', changeId, '--for', transition, '--policy', policyId, '--provider', providerId,
  ], {
    XFORGE_ENTERPRISE_APPROVALS_TOKEN: MCP_TOKEN,
    XFORGE_TEST_MCP_TOKEN: MCP_TOKEN,
    XFORGE_TEST_MCP_EXPECTED_TOKEN: MCP_TOKEN,
    XFORGE_TEST_MCP_DECISION: decision,
    XFORGE_TEST_MCP_APPROVER_ID: approver.id,
    XFORGE_TEST_MCP_APPROVER_ROLE: approver.role,
  });
}

function mechanismFor(definition) {
  if (definition.providers.includes('local')) return { kind: 'local' };
  const providerId = definition.providers.find((id) => id !== 'local');
  if (!providerId) throw new Error(`Policy has no usable provider: ${JSON.stringify(definition.providers)}`);
  return { kind: 'mcp', providerId };
}

function decide(root, { changeId, transition, policyId, mechanism, approver, decision, reason }) {
  return mechanism.kind === 'local'
    ? runLocalApproval(root, { changeId, transition, policyId, approver, decision, reason })
    : runMcpApproval(root, { changeId, transition, policyId, providerId: mechanism.providerId, approver, decision });
}

const selected = options(process.argv.slice(2));
const state = runXforgeJson(selected.root, ['state', '--change', selected.change]);
const definition = await loadPolicyDefinition(selected.root, state.data.change.flow, selected.policy);
const mechanism = mechanismFor(definition);

const decisions = [];

if (selected.simulateRejection) {
  const rejector = { id: 'reviewer-1@example.test', role: definition.roles[0] };
  await decide(selected.root, {
    changeId: selected.change, transition: selected.transition, policyId: selected.policy, mechanism,
    approver: rejector, decision: 'reject',
    reason: 'Live-engine governance drill: exercising the reject-then-resubmit path before real approval.',
  });
  decisions.push({ approver: rejector, decision: 'reject', mechanism: mechanism.kind });
}

for (const approver of planApprovers(definition)) {
  const approved = await decide(selected.root, {
    changeId: selected.change, transition: selected.transition, policyId: selected.policy, mechanism,
    approver, decision: 'approve', reason: 'Approved by the isolated live-engine governance drill.',
  });
  decisions.push({ approver, decision: 'approve', receiptId: approved.data.receipt.receiptId, mechanism: mechanism.kind });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  policy: selected.policy,
  transition: selected.transition,
  mechanism: mechanism.kind,
  minApprovers: definition.minApprovers,
  separationOfDuties: definition.separationOfDuties,
  distinctRoles: [...new Set(decisions.filter((entry) => entry.decision === 'approve').map((entry) => entry.approver.role))],
  decisions,
})}\n`);
