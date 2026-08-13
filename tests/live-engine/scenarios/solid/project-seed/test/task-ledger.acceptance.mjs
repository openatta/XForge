import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

/* fileURLToPath, not .pathname + path.resolve: a file:// URL's .pathname keeps a leading
   slash before a Windows drive letter, which path.resolve does not strip. */
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(projectRoot, 'src', 'cli.mjs');
const temporaryDirectories = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'task-ledger-'));
  temporaryDirectories.push(root);
  return { root, store: path.join(root, 'nested', 'tasks.json') };
}

function run(store, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    env: { ...process.env, TASK_LEDGER_FILE: store },
    encoding: 'utf8',
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {}
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function assertEnvelope(result, { code, ok }) {
  assert.equal(result.code, code);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  assert.ok(result.json, `stdout must be one JSON document: ${result.stdout}`);
  assert.equal(result.json.ok, ok);
  assert.ok(Array.isArray(result.json.diagnostics));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('adds tasks with stable IDs and lists them in order', () => {
  const { store } = fixture();
  const first = run(store, ['add', '--title', '  Ship docs  ']);
  assertEnvelope(first, { code: 0, ok: true });
  assert.deepEqual(first.json.data.task, { id: 'T0001', title: 'Ship docs', status: 'open' });

  const second = run(store, ['add', '--title', 'Review release']);
  assertEnvelope(second, { code: 0, ok: true });
  assert.equal(second.json.data.task.id, 'T0002');

  const listed = run(store, ['list']);
  assertEnvelope(listed, { code: 0, ok: true });
  assert.deepEqual(listed.json.data.tasks.map((task) => task.id), ['T0001', 'T0002']);
});

test('filters by status and completes a task idempotently', () => {
  const { store } = fixture();
  run(store, ['add', '--title', 'First']);
  run(store, ['add', '--title', 'Second']);

  const completed = run(store, ['done', '--id', 'T0001']);
  assertEnvelope(completed, { code: 0, ok: true });
  assert.equal(completed.json.data.task.status, 'done');
  assertEnvelope(run(store, ['done', '--id', 'T0001']), { code: 0, ok: true });

  const open = run(store, ['list', '--status', 'open']);
  assertEnvelope(open, { code: 0, ok: true });
  assert.deepEqual(open.json.data.tasks.map((task) => task.id), ['T0002']);
  const done = run(store, ['list', '--status', 'done']);
  assert.deepEqual(done.json.data.tasks.map((task) => task.id), ['T0001']);
});

test('returns stable usage and not-found diagnostics', () => {
  const { store } = fixture();
  for (const args of [
    ['add'],
    ['add', '--title', '   '],
    ['list', '--status', 'invalid'],
    ['unknown'],
  ]) {
    const result = run(store, args);
    assertEnvelope(result, { code: 2, ok: false });
    assert.equal(result.json.diagnostics[0].code, 'USAGE_ERROR');
  }

  const missing = run(store, ['done', '--id', 'T9999']);
  assertEnvelope(missing, { code: 1, ok: false });
  assert.equal(missing.json.diagnostics[0].code, 'TASK_NOT_FOUND');
});

test('creates storage parents and never overwrites corrupt data', () => {
  const { store } = fixture();
  const created = run(store, ['add', '--title', 'Persist me']);
  assertEnvelope(created, { code: 0, ok: true });
  assert.equal(JSON.parse(readFileSync(store, 'utf8')).tasks[0].id, 'T0001');

  writeFileSync(store, '{not-json\n');
  const corrupt = run(store, ['list']);
  assertEnvelope(corrupt, { code: 1, ok: false });
  assert.equal(corrupt.json.diagnostics[0].code, 'DATA_INVALID');
  assert.equal(readFileSync(store, 'utf8'), '{not-json\n');
});

/* REQ-TASK-006 arrives mid-run as a simulated upstream stakeholder edit (run-matrix.mjs injects it
   before the revise step). Without coverage here the Change would carry an externally observable
   requirement with no automated verification, which the project Constitution's "Quality and
   observability" principle forbids — and the constitution-check Gate correctly refuses to let such
   a Change leave the Check Stage. */
test('limits list results and rejects a non-positive limit', () => {
  const { store } = fixture();
  for (const title of ['First', 'Second', 'Third']) {
    assertEnvelope(run(store, ['add', '--title', title]), { code: 0, ok: true });
  }

  const limited = run(store, ['list', '--limit', '2']);
  assertEnvelope(limited, { code: 0, ok: true });
  assert.deepEqual(limited.json.data.tasks.map((task) => task.id), ['T0001', 'T0002']);

  // A limit past the end of the result set is not an error, it just returns everything.
  const generous = run(store, ['list', '--limit', '99']);
  assertEnvelope(generous, { code: 0, ok: true });
  assert.equal(generous.json.data.tasks.length, 3);

  // --limit composes with --status rather than replacing it.
  assertEnvelope(run(store, ['done', '--id', 'T0001']), { code: 0, ok: true });
  const composed = run(store, ['list', '--status', 'open', '--limit', '1']);
  assertEnvelope(composed, { code: 0, ok: true });
  assert.deepEqual(composed.json.data.tasks.map((task) => task.id), ['T0002']);

  for (const bad of ['0', '-1', 'abc']) {
    const rejected = run(store, ['list', '--limit', bad]);
    assertEnvelope(rejected, { code: 2, ok: false });
    assert.equal(rejected.json.diagnostics[0].code, 'USAGE_ERROR');
  }
});
