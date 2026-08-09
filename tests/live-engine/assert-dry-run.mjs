import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const separator = process.argv.indexOf('--');
if (separator < 0 || separator === process.argv.length - 1) throw new Error('Usage: assert-dry-run.mjs <root> -- <xforge args>.');
const root = path.resolve(process.argv[2]);
const args = process.argv.slice(separator + 1);
const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const cliPath = path.join(repositoryRoot, 'xforge', 'dist', 'cli.js');

async function snapshot(directory, relative = '') {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && entry.name === '.git') continue;
    const childRelative = path.posix.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(absolute, childRelative));
    else if (entry.isFile()) result[childRelative] = createHash('sha256').update(await readFile(absolute)).digest('hex');
    else result[childRelative] = `other:${(await lstat(absolute)).mode}`;
  }
  return result;
}

const before = await snapshot(root);
const execution = spawnSync(process.execPath, [cliPath, '--root', root, ...args], {
  cwd: root,
  env: { ...process.env, XFORGE_APPROVAL_HMAC_SECRET: 'xforge-live-e2e-external-provider-secret' },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let envelope = null;
try { envelope = JSON.parse(execution.stdout); } catch {}
if (execution.status !== 0 || !envelope?.ok) throw new Error(`Dry-run command failed: ${execution.stdout || execution.stderr}`);
const after = await snapshot(root);
const unchanged = JSON.stringify(before) === JSON.stringify(after);
if (!unchanged) throw new Error('Dry-run changed the project tree.');
process.stdout.write(`${JSON.stringify({ ok: true, command: args, filesCompared: Object.keys(before).length, changesPlanned: envelope.changes.length, treeUnchanged: true })}\n`);
