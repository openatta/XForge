import { spawnSync } from 'node:child_process';

/**
 * Invokes the project-locally installed CLI the same way a real user or Agent does:
 * `npx --no-install xforge ...` with cwd set to the isolated project root. This works
 * identically whether that project's `node_modules/@xforge/cli` came from the real npm
 * registry or from a locally packed tarball (see cli-source.mjs) — the harness never
 * hardcodes a path to this repository's own `xforge/dist/cli.js`.
 */
export function spawnXforge(projectRoot, args, { env = {}, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  return spawnSync('npx', ['--no-install', 'xforge', ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio,
  });
}

export function runXforgeJson(projectRoot, args, env = {}) {
  const result = spawnXforge(projectRoot, args, { env });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  if (result.status !== 0 || !json) throw new Error(`xforge ${args.join(' ')} failed: ${result.stdout || result.stderr}`);
  return json;
}
