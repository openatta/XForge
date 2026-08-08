import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeResolve } from './path-safety.js';

export async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWrite(root: string, relative: string, content: string | Buffer): Promise<void> {
  const destination = await safeResolve(root, relative, { createParent: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.xforge-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function ensureDirectory(root: string, relative: string): Promise<string> {
  const destination = await safeResolve(root, relative);
  await mkdir(destination, { recursive: true });
  await safeResolve(root, relative);
  return destination;
}
