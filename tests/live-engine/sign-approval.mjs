import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, stableStringify } from '../../xforge/dist/core/hash.js';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const cliPath = path.join(repositoryRoot, 'xforge', 'dist', 'cli.js');
const approvalSecret = 'xforge-live-e2e-external-provider-secret';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, '')] = argv[index + 1];
  for (const key of ['root', 'change', 'transition', 'policy', 'actor', 'role']) if (!result[key]) throw new Error(`--${key} is required.`);
  result.root = path.resolve(result.root);
  return result;
}

function cli(root, args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  if (result.status !== 0 || !json) throw new Error(`${args.join(' ')} failed: ${result.stdout || result.stderr}`);
  return json;
}

const selected = options(process.argv.slice(2));
const state = cli(selected.root, ['state', '--change', selected.change], { XFORGE_APPROVAL_HMAC_SECRET: approvalSecret });
const governance = state.data.change.governance;
const payload = {
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
  decision: 'approve',
  approver: { id: selected.actor, provider: 'enterprise-hmac', role: selected.role, type: 'external-system' },
  decidedAt: new Date().toISOString(),
  reason: 'Approved by the isolated live E2E governance harness.',
  externalRef: `live-e2e:${selected.actor}:${selected.transition}`,
};
const signature = {
  algorithm: 'hmac-sha256',
  value: createHmac('sha256', approvalSecret).update(stableStringify(payload)).digest('hex'),
};
const signed = { ...payload, signature };
const receipt = { ...signed, digest: sha256(stableStringify(signed)) };
const receiptDirectory = path.join(selected.root, '.xforge-e2e-approvals');
await mkdir(receiptDirectory, { recursive: true });
const receiptPath = path.join(receiptDirectory, `${receipt.receiptId}.json`);
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
const relativeReceipt = path.relative(selected.root, receiptPath).split(path.sep).join('/');
const approved = cli(selected.root, [
  'approve', '--change', selected.change, '--for', selected.transition,
  '--policy', selected.policy, '--receipt', relativeReceipt,
], { XFORGE_APPROVAL_HMAC_SECRET: approvalSecret });
process.stdout.write(`${JSON.stringify({ ok: true, receiptId: approved.data.receipt.receiptId, policy: selected.policy, transition: selected.transition })}\n`);
