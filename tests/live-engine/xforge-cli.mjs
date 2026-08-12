import { spawnSync } from 'node:child_process';

/**
 * The harness's external approval provider secret. Every CLI call that resolves the control plane
 * after an Approval receipt exists must verify that receipt's HMAC, so the secret has to be present
 * for `transition`, `state`, `check`, `audit`, and `archive` alike — not only for the approval step
 * that signs it. Passing it as spawn env keeps it out of the isolated project, which is the actual
 * rule; omitting it just made the CLI report XFORGE_APPROVAL_PROVIDER_UNAVAILABLE.
 */
export const APPROVAL_SECRET = 'xforge-live-e2e-external-provider-secret';

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
    env: { ...process.env, XFORGE_APPROVAL_HMAC_SECRET: APPROVAL_SECRET, ...env },
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
