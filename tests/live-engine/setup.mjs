import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const temporaryRoot = path.join(repositoryRoot, 'tests', '.tmp');
const projectRoot = path.join(temporaryRoot, 'live-engine-project');
const binRoot = path.join(temporaryRoot, 'live-engine-bin');
const claudeConfigRoot = path.join(temporaryRoot, 'live-engine-claude-config');
const cliPath = path.join(repositoryRoot, 'xforge', 'dist', 'cli.js');

function run(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

await rm(projectRoot, { recursive: true, force: true });
await rm(binRoot, { recursive: true, force: true });
await rm(claudeConfigRoot, { recursive: true, force: true });
await mkdir(projectRoot, { recursive: true });
await mkdir(binRoot, { recursive: true });
await mkdir(claudeConfigRoot, { recursive: true });
await cp(path.join(repositoryRoot, 'scaffold', 'payload'), projectRoot, { recursive: true });
await cp(path.join(repositoryRoot, 'tests', 'live-engine', 'project-seed'), projectRoot, { recursive: true, force: true });

const manifestPath = path.join(projectRoot, 'xforge', 'manifest.yaml');
const manifest = (await readFile(manifestPath, 'utf8')).replace('name: xforge-project', 'name: live-engine-task-ledger');
await writeFile(manifestPath, manifest);
await writeFile(
  path.join(binRoot, 'xforge'),
  `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`,
  { mode: 0o755 },
);

run('git', ['init', '--quiet', '--initial-branch=main']);
run('git', ['config', 'user.name', 'XForge Live E2E']);
run('git', ['config', 'user.email', 'xforge-live@example.test']);
run('git', ['add', '.']);
run('git', ['commit', '--quiet', '-m', 'Seed live engine sample']);

process.stdout.write(`${projectRoot}\n`);
