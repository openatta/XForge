import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(projectRoot, 'src', 'cli.mjs');
const temporaryDirectories = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'credential-store-'));
  temporaryDirectories.push(root);
  return { root, store: path.join(root, 'nested', 'store.json') };
}

function run(store, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    env: { ...process.env, CREDENTIAL_STORE_FILE: store },
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

test('stores a credential without persisting the plaintext secret', () => {
  const { store } = fixture();
  const stored = run(store, ['store', '--id', 'svc-a', '--secret', 'correct-horse-battery-staple']);
  assertEnvelope(stored, { code: 0, ok: true });

  const raw = readFileSync(store, 'utf8');
  assert.ok(!raw.includes('correct-horse-battery-staple'), 'the raw secret must never be written to disk');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2);
  assert.ok(parsed.credentials['svc-a'].hash);
  assert.ok(parsed.credentials['svc-a'].salt);
  assert.equal(parsed.credentials['svc-a'].algorithm, 'scrypt');
});

test('rejects storing a duplicate id', () => {
  const { store } = fixture();
  run(store, ['store', '--id', 'svc-a', '--secret', 'first-secret-value']);
  const duplicate = run(store, ['store', '--id', 'svc-a', '--secret', 'second-secret-value']);
  assertEnvelope(duplicate, { code: 1, ok: false });
  assert.equal(duplicate.json.diagnostics[0].code, 'CREDENTIAL_EXISTS');
});

test('verifies a correct secret and rejects an incorrect one', () => {
  const { store } = fixture();
  run(store, ['store', '--id', 'svc-a', '--secret', 'correct-horse-battery-staple']);

  const valid = run(store, ['verify', '--id', 'svc-a', '--secret', 'correct-horse-battery-staple']);
  assertEnvelope(valid, { code: 0, ok: true });
  assert.equal(valid.json.data.valid, true);

  const invalid = run(store, ['verify', '--id', 'svc-a', '--secret', 'wrong-guess']);
  assertEnvelope(invalid, { code: 0, ok: true });
  assert.equal(invalid.json.data.valid, false);
});

test('reports not-found for an unknown id on verify or rotate', () => {
  const { store } = fixture();
  const verifyMissing = run(store, ['verify', '--id', 'ghost', '--secret', 'anything']);
  assertEnvelope(verifyMissing, { code: 1, ok: false });
  assert.equal(verifyMissing.json.diagnostics[0].code, 'CREDENTIAL_NOT_FOUND');

  const rotateMissing = run(store, ['rotate', '--id', 'ghost', '--secret', 'anything']);
  assertEnvelope(rotateMissing, { code: 1, ok: false });
  assert.equal(rotateMissing.json.diagnostics[0].code, 'CREDENTIAL_NOT_FOUND');
});

test('rotating a credential invalidates the old secret immediately with no grace period', () => {
  const { store } = fixture();
  run(store, ['store', '--id', 'svc-a', '--secret', 'old-secret-value']);
  const rotated = run(store, ['rotate', '--id', 'svc-a', '--secret', 'new-secret-value']);
  assertEnvelope(rotated, { code: 0, ok: true });

  const oldStillValid = run(store, ['verify', '--id', 'svc-a', '--secret', 'old-secret-value']);
  assertEnvelope(oldStillValid, { code: 0, ok: true });
  assert.equal(oldStillValid.json.data.valid, false, 'the old secret must not validate after rotation');

  const newValid = run(store, ['verify', '--id', 'svc-a', '--secret', 'new-secret-value']);
  assertEnvelope(newValid, { code: 0, ok: true });
  assert.equal(newValid.json.data.valid, true);
});

test('migrates a v1 store to v2 in place without losing data', () => {
  const { store } = fixture();
  run(store, ['store', '--id', 'seed', '--secret', 'seed-secret-value']);
  const v2 = JSON.parse(readFileSync(store, 'utf8'));
  const v1 = { credentials: { 'legacy-svc': { hash: v2.credentials.seed.hash, salt: v2.credentials.seed.salt } } };
  writeFileSync(store, JSON.stringify(v1));

  const verified = run(store, ['verify', '--id', 'legacy-svc', '--secret', 'seed-secret-value']);
  assertEnvelope(verified, { code: 0, ok: true });
  assert.equal(verified.json.data.valid, true);

  const migrated = JSON.parse(readFileSync(store, 'utf8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.credentials['legacy-svc'].algorithm, 'scrypt');
});

test('creates storage parents and never overwrites corrupt data', () => {
  const { store } = fixture();
  const created = run(store, ['store', '--id', 'svc-a', '--secret', 'correct-horse-battery-staple']);
  assertEnvelope(created, { code: 0, ok: true });

  writeFileSync(store, '{not-json\n');
  const corrupt = run(store, ['verify', '--id', 'svc-a', '--secret', 'correct-horse-battery-staple']);
  assertEnvelope(corrupt, { code: 1, ok: false });
  assert.equal(corrupt.json.diagnostics[0].code, 'DATA_INVALID');
  assert.equal(readFileSync(store, 'utf8'), '{not-json\n');
});

test('returns stable usage diagnostics', () => {
  const { store } = fixture();
  for (const args of [['store'], ['store', '--id', 'svc-a'], ['verify', '--id', 'svc-a'], ['unknown']]) {
    const result = run(store, args);
    assertEnvelope(result, { code: 2, ok: false });
    assert.equal(result.json.diagnostics[0].code, 'USAGE_ERROR');
  }
});
