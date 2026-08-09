import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const cliPath = path.join(repositoryRoot, 'xforge', 'dist', 'cli.js');
const approvalSecret = 'xforge-live-e2e-external-provider-secret';
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env: { ...process.env, XFORGE_APPROVAL_HMAC_SECRET: approvalSecret },
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'pipe'],
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
