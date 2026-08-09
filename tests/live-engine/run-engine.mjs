import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const allowedRoot = path.join(repositoryRoot, 'tests', '.tmp');
const claudeConfigRoot = path.join(allowedRoot, 'live-engine-claude-config');

function options(argv) {
  const result = { budget: '3' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Expected --root, --prompt, --output and optional --budget values.');
    result[key.slice(2)] = value;
  }
  if (!result.root || !result.prompt || !result.output) throw new Error('--root, --prompt and --output are required.');
  return result;
}

function dotenv(source) {
  const result = {};
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

const selected = options(process.argv.slice(2));
const projectRoot = await realpath(path.resolve(selected.root));
const safePrefix = `${await realpath(allowedRoot)}${path.sep}`;
if (!projectRoot.startsWith(safePrefix)) throw new Error(`Engine project must be inside ${allowedRoot}.`);

const configured = dotenv(await readFile(path.join(repositoryRoot, '.env'), 'utf8'));
for (const required of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
  if (!configured[required]) throw new Error(`Missing required engine setting: ${required}`);
}
const prompt = await readFile(path.resolve(selected.prompt), 'utf8');
const outputPath = path.resolve(selected.output);
await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(claudeConfigRoot, { recursive: true });

const args = [
  '-p',
  '--output-format', 'json',
  '--no-session-persistence',
  '--dangerously-skip-permissions',
  '--max-budget-usd', selected.budget,
];
if (configured.ANTHROPIC_MODEL) args.push('--model', configured.ANTHROPIC_MODEL);
if (configured.CLAUDE_CODE_EFFORT_LEVEL) args.push('--effort', configured.CLAUDE_CODE_EFFORT_LEVEL);
args.push(prompt);

const environment = {
  ...process.env,
  ...configured,
  // Keep Claude Code's session-env and other runtime writes inside the
  // disposable test root. Managed runners may make the user's ~/.claude
  // directory read-only even when the project and network are authorized.
  CLAUDE_CONFIG_DIR: claudeConfigRoot,
  PATH: `${path.join(allowedRoot, 'live-engine-bin')}${path.delimiter}${process.env.PATH ?? ''}`,
};
const child = spawn('claude', args, { cwd: projectRoot, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
const stdout = [];
const stderr = [];
child.stdout.on('data', (chunk) => stdout.push(chunk));
child.stderr.on('data', (chunk) => stderr.push(chunk));
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (status) => resolve(status ?? 1));
});
const output = Buffer.concat(stdout).toString('utf8');
const errorOutput = Buffer.concat(stderr).toString('utf8');
await writeFile(outputPath, output || `${JSON.stringify({ error: errorOutput, exitCode: code }, null, 2)}\n`);
if (errorOutput) process.stderr.write(errorOutput);
process.stdout.write(`${JSON.stringify({ ok: code === 0, exitCode: code, output: outputPath })}\n`);
process.exitCode = code;
