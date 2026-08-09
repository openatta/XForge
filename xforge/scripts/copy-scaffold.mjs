import { execFileSync } from 'node:child_process';
import { cp, lstat, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const source = fileURLToPath(new URL('../../scaffold', import.meta.url));
const destination = fileURLToPath(new URL('../scaffold', import.meta.url));
const integrityScript = fileURLToPath(new URL('./scaffold-integrity.mjs', import.meta.url));

async function rejectSymlinks(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symlink forbidden in packaged Scaffold: ${relative}`);
    if (info.isDirectory()) await rejectSymlinks(absolute, relative);
  }
}

execFileSync(process.execPath, [integrityScript, source], { stdio: 'inherit' });
await rejectSymlinks(source);
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
