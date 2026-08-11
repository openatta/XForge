import path from 'node:path';
import { spawnXforge } from './xforge-cli.mjs';

const approvalSecret = 'xforge-live-e2e-external-provider-secret';
const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex === -1 || !args[rootIndex + 1]) throw new Error('--root <project> is required.');
const projectRoot = path.resolve(args[rootIndex + 1]);
// Rewrite --root to its resolved absolute form: spawnXforge sets cwd to projectRoot, so a
// relative --root value here would otherwise be re-resolved against that cwd, not the caller's
// original cwd, silently pointing at the wrong (often nonexistent) directory.
args[rootIndex + 1] = projectRoot;

const result = spawnXforge(projectRoot, args, {
  env: { XFORGE_APPROVAL_HMAC_SECRET: approvalSecret },
  stdio: ['inherit', 'pipe', 'pipe'],
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
