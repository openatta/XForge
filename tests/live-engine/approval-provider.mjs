import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';
import { runXforgeJson } from './xforge-cli.mjs';

// Mirrors xforge/src/core/hash.ts exactly: the CLI verifies `governingDigest`/`digest`
// bit-for-bit, so this harness cannot import a build artifact and must reproduce the same
// pure functions locally.
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new TypeError('Cannot stringify a circular value');
      seen.add(item);
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value), null, 2);
}

const approvalSecret = 'xforge-live-e2e-external-provider-secret';

function options(argv) {
  const result = { 'simulate-rejection': 'false' };
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, '')] = argv[index + 1];
  for (const key of ['root', 'change', 'transition', 'policy']) if (!result[key]) throw new Error(`--${key} is required.`);
  result.root = path.resolve(result.root);
  result.simulateRejection = result['simulate-rejection'] === 'true';
  return result;
}

async function loadPolicyDefinition(root, flowName, policyId) {
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

function buildPayload({ selected, state, definition, approver, decision, reason }) {
  const governance = state.data.change.governance;
  return {
    apiVersion: 'xforge.dev/v1alpha2',
    kind: 'ApprovalReceipt',
    receiptId: randomUUID(),
    change: selected.change,
    flow: state.data.change.flow,
    stage: governance.currentStage,
    transition: selected.transition,
    policyId: selected.policy,
    stateRevision: governance.revision.stateRevision,
    contentRevision: governance.revision.contentRevision,
    policySnapshotDigest: governance.revision.policySnapshotDigest,
    gitBase: governance.revision.gitBase,
    gitHead: governance.revision.gitHead,
    governingDigest: sha256(stableStringify({ change: selected.change, flow: state.data.change.flow, policyId: selected.policy, revision: governance.revision })),
    decision,
    approver: { id: approver.id, provider: definition.providers.includes('enterprise-hmac') ? 'enterprise-hmac' : definition.providers[0], role: approver.role, type: 'external-system' },
    decidedAt: new Date().toISOString(),
    reason,
    externalRef: `live-e2e:${approver.id}:${selected.transition}`,
  };
}

async function submitReceipt({ selected, payload, requestsDirectory, receiptsDirectory }) {
  await mkdir(requestsDirectory, { recursive: true });
  await writeFile(
    path.join(requestsDirectory, `${payload.receiptId}.json`),
    `${JSON.stringify({
      requestedAt: new Date().toISOString(),
      policyId: selected.policy,
      transition: selected.transition,
      requestedFrom: payload.approver,
      changeRevision: payload.stateRevision,
    }, null, 2)}\n`,
  );
  const signature = { algorithm: 'hmac-sha256', value: createHmac('sha256', approvalSecret).update(stableStringify(payload)).digest('hex') };
  const signed = { ...payload, signature };
  const receipt = { ...signed, digest: sha256(stableStringify(signed)) };
  await mkdir(receiptsDirectory, { recursive: true });
  const receiptPath = path.join(receiptsDirectory, `${receipt.receiptId}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

const selected = options(process.argv.slice(2));
const env = { XFORGE_APPROVAL_HMAC_SECRET: approvalSecret };
const state = runXforgeJson(selected.root, ['state', '--change', selected.change], env);
const definition = await loadPolicyDefinition(selected.root, state.data.change.flow, selected.policy);
const requestsDirectory = path.join(selected.root, '.xforge-e2e-approvals', selected.policy, 'requests');
const receiptsDirectory = path.join(selected.root, '.xforge-e2e-approvals', selected.policy, 'receipts');

const decisions = [];

if (selected.simulateRejection) {
  const rejector = { id: 'reviewer-1@example.test', role: definition.roles[0] };
  const payload = buildPayload({
    selected, state, definition, approver: rejector, decision: 'reject',
    reason: 'Live-engine governance drill: exercising the reject-then-resubmit path before real approval.',
  });
  const receiptPath = await submitReceipt({ selected, payload, requestsDirectory, receiptsDirectory });
  const relative = path.relative(selected.root, receiptPath).split(path.sep).join('/');
  runXforgeJson(selected.root, ['approve', '--change', selected.change, '--for', selected.transition, '--policy', selected.policy, '--receipt', relative], env);
  decisions.push({ approver: rejector, decision: 'reject', receipt: relative });
}

for (const approver of planApprovers(definition)) {
  const payload = buildPayload({
    selected, state, definition, approver, decision: 'approve',
    reason: 'Approved by the isolated live-engine enterprise governance drill.',
  });
  const receiptPath = await submitReceipt({ selected, payload, requestsDirectory, receiptsDirectory });
  const relative = path.relative(selected.root, receiptPath).split(path.sep).join('/');
  const approved = runXforgeJson(selected.root, ['approve', '--change', selected.change, '--for', selected.transition, '--policy', selected.policy, '--receipt', relative], env);
  decisions.push({ approver, decision: 'approve', receiptId: approved.data.receipt.receiptId, receipt: relative });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  policy: selected.policy,
  transition: selected.transition,
  minApprovers: definition.minApprovers,
  separationOfDuties: definition.separationOfDuties,
  distinctRoles: [...new Set(decisions.filter((entry) => entry.decision === 'approve').map((entry) => entry.approver.role))],
  decisions,
})}\n`);
