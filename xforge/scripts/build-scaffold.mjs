import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { create } from 'tar';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const outputRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, 'release'));
const archive = path.join(outputRoot, 'xforge-scaffold-0.4.0.tar.gz');
await mkdir(outputRoot, { recursive: true });

const scaffoldRoot = path.join(repoRoot, 'scaffold');
execFileSync(process.execPath, [path.join(repoRoot, 'xforge', 'scripts', 'scaffold-integrity.mjs'), scaffoldRoot], { stdio: 'ignore' });
const manifest = await readFile(path.join(scaffoldRoot, 'files.sha256'), 'utf8');
const payloadFiles = manifest.trim().split('\n').filter(Boolean).map((line) => line.slice(66)).sort();
await create({
  cwd: scaffoldRoot,
  file: archive,
  gzip: true,
  portable: true,
  noMtime: true,
  follow: false,
  sync: false,
}, ['scaffold.yaml', 'files.sha256', ...payloadFiles]);

const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
process.stdout.write(`${archive}\n${digest}\n`);
