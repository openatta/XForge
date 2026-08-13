import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/* fileURLToPath, not .pathname + path.resolve: a file:// URL's .pathname keeps a leading
   slash before a Windows drive letter, which path.resolve does not strip. */
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(projectRoot, 'src', 'cli.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, encoding: 'utf8' });
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

test('greets a named person', () => {
  const result = run(['greet', '--name', 'Ada']);
  assertEnvelope(result, { code: 0, ok: true });
  assert.equal(result.json.data.message, 'Hello, Ada!');
});

test('shouts when --shout is set', () => {
  const result = run(['greet', '--name', 'Ada', '--shout']);
  assertEnvelope(result, { code: 0, ok: true });
  assert.equal(result.json.data.message, 'HELLO, ADA!!!!');
});

test('rejects a missing, blank, or whitespace-only name', () => {
  for (const args of [['greet'], ['greet', '--name', ''], ['greet', '--name', '   ']]) {
    const result = run(args);
    assertEnvelope(result, { code: 2, ok: false });
    assert.equal(result.json.diagnostics[0].code, 'USAGE_ERROR');
  }
});

test('rejects an unknown command', () => {
  const result = run(['unknown']);
  assertEnvelope(result, { code: 2, ok: false });
  assert.equal(result.json.diagnostics[0].code, 'USAGE_ERROR');
});
