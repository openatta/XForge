import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnXforge } from './xforge-cli.mjs';

const separator = process.argv.indexOf('--');
if (separator < 0 || separator === process.argv.length - 1) throw new Error('Usage: assert-dry-run.mjs <root> -- <xforge args>.');
const root = path.resolve(process.argv[2]);
const args = process.argv.slice(separator + 1);

async function snapshot(directory, relative = '') {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && (entry.name === '.git' || entry.name === 'node_modules')) continue;
    const childRelative = path.posix.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(absolute, childRelative));
    else if (entry.isFile()) result[childRelative] = createHash('sha256').update(await readFile(absolute)).digest('hex');
    else result[childRelative] = `other:${(await lstat(absolute)).mode}`;
  }
  return result;
}

const before = await snapshot(root);
// `--root root` is injected here, not expected in `args` after `--`: spawnXforge already sets
// cwd to the resolved absolute `root`, so a caller-supplied `--root` value would be resolved
// against that cwd a second time instead of the caller's original cwd.
const execution = spawnXforge(root, ['--root', root, ...args], { env: { XFORGE_APPROVAL_HMAC_SECRET: 'xforge-live-e2e-external-provider-secret' } });
let envelope = null;
try { envelope = JSON.parse(execution.stdout); } catch {}
if (execution.status !== 0 || !envelope?.ok) throw new Error(`Dry-run command failed: ${execution.stdout || execution.stderr}`);
const after = await snapshot(root);
const unchanged = JSON.stringify(before) === JSON.stringify(after);
if (!unchanged) throw new Error('Dry-run changed the project tree.');
process.stdout.write(`${JSON.stringify({ ok: true, command: args, filesCompared: Object.keys(before).length, changesPlanned: envelope.changes.length, treeUnchanged: true })}\n`);
