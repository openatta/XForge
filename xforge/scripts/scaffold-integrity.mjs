import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const scaffoldRoot = path.resolve(process.argv[2] ?? '../scaffold');
const payloadRoot = path.join(scaffoldRoot, 'payload');

async function filesUnder(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden in scaffold payload: ${relative}`);
    if (stat.isDirectory()) result.push(...await filesUnder(absolute, relative));
    else if (stat.isFile()) result.push(relative);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

const lines = [];
for (const relative of await filesUnder(payloadRoot)) {
  const bytes = await readFile(path.join(payloadRoot, relative));
  lines.push(`${createHash('sha256').update(bytes).digest('hex')}  payload/${relative}`);
}

const expected = `${lines.join('\n')}\n`;
const manifestPath = path.join(scaffoldRoot, 'files.sha256');
let actual = '';
try { actual = await readFile(manifestPath, 'utf8'); } catch {}

if (process.argv.includes('--write')) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(manifestPath, expected);
  process.stdout.write(`Wrote ${lines.length} entries to ${manifestPath}\n`);
} else if (actual !== expected) {
  process.stderr.write('scaffold/files.sha256 is stale; run with --write.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`Verified ${lines.length} scaffold payload files.\n`);
}
