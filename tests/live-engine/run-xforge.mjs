import path from 'node:path';
import { spawnXforge } from './xforge-cli.mjs';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex === -1 || !args[rootIndex + 1]) throw new Error('--root <project> is required.');
const projectRoot = path.resolve(args[rootIndex + 1]);
// Rewrite --root to its resolved absolute form: spawnXforge sets cwd to projectRoot, so a
// relative --root value here would otherwise be re-resolved against that cwd, not the caller's
// original cwd, silently pointing at the wrong (often nonexistent) directory.
args[rootIndex + 1] = projectRoot;

// stdio inherits the real terminal, so a human running this by hand can answer a local Approval's
// interactive dialogue (identity/role/decision/reason) directly.
const result = spawnXforge(projectRoot, args, { stdio: ['inherit', 'pipe', 'pipe'] });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
