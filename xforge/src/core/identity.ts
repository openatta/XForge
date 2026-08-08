import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(new URL('../..', import.meta.url).pathname);

function git(args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', packageRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function actualGitIdentity(): { commit: string | null; repository: string | null } {
  return {
    commit: process.env.XFORGE_BUILD_COMMIT ?? git(['rev-parse', 'HEAD']),
    repository: process.env.XFORGE_BUILD_REPOSITORY ?? git(['remote', 'get-url', 'origin']),
  };
}

function filesUnder(directory: string, prefix: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) result.push(...filesUnder(absolute, relative));
    else if (stat.isFile()) result.push(relative);
  }
  return result;
}

export function runtimeCliIntegrity(): string {
  const candidates = [
    ...filesUnder(path.join(packageRoot, 'dist'), 'dist'),
    ...filesUnder(path.join(packageRoot, 'schemas'), 'schemas'),
    'package.json',
  ].filter((relative) => !relative.endsWith('.map')).sort();
  const aggregate = candidates.map((relative) => {
    const digest = createHash('sha256').update(readFileSync(path.join(packageRoot, ...relative.split('/')))).digest('hex');
    return `${relative}\0${digest}\n`;
  }).join('');
  return `sha256:${createHash('sha256').update(aggregate).digest('hex')}`;
}
