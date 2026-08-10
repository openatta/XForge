import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, '')] = argv[index + 1];
  for (const key of ['root', 'change', 'package']) if (!result[key]) throw new Error(`--${key} is required.`);
  result.root = path.resolve(result.root);
  return result;
}

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${name} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const selected = options(process.argv.slice(2));
const dispatchDirectory = path.join(selected.root, 'xforge', 'changes', selected.change, 'evidence', 'agents', selected.package, 'dispatch');
const dispatchNames = (await readdir(dispatchDirectory)).filter((name) => name.endsWith('.json')).sort();
if (dispatchNames.length !== 1) throw new Error(`Expected exactly one dispatch receipt, found ${dispatchNames.length}.`);
const dispatch = JSON.parse(await readFile(path.join(dispatchDirectory, dispatchNames[0]), 'utf8'));
const head = command('git', ['rev-parse', 'HEAD'], selected.root);
const changedPaths = command('git', ['diff', '--name-only', `${dispatch.gitHead}..${head}`], selected.root).split('\n').filter(Boolean);
const testResult = spawnSync('npm', ['test'], { cwd: selected.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const workPackages = parse(await readFile(path.join(selected.root, 'xforge', 'changes', selected.change, 'work-packages.yaml'), 'utf8'));
const workPackage = workPackages.packages.find((item) => item.id === selected.package);
if (!workPackage) throw new Error(`Work package ${selected.package} was not found.`);
const delivery = {
  execution_id: dispatch.executionId,
  recorded_at: new Date().toISOString(),
  status: testResult.status === 0 ? 'succeeded' : 'failed',
  package_id: selected.package,
  base_commit: dispatch.gitHead,
  head_commit: head,
  changed_paths: changedPaths,
  validation: [{ command: 'npm test', exit_code: testResult.status }],
  issues: testResult.status === 0 ? [] : ['The independent acceptance suite failed.'],
  done_when_evidence: testResult.status === 0
    ? workPackage.done_when.map((criterion) => ({ criterion, evidence: ['npm test', ...changedPaths] }))
    : [],
  state_revision: dispatch.stateRevision,
  policy_snapshot_digest: dispatch.policySnapshotDigest,
  audit_correlation_id: dispatch.auditCorrelationId,
};
const deliveryPath = path.join(dispatchDirectory, '..', `${dispatch.executionId}.yaml`);
await writeFile(deliveryPath, `${JSON.stringify(delivery, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: testResult.status === 0, delivery: deliveryPath, changedPaths })}\n`);
process.exitCode = testResult.status ?? 1;
