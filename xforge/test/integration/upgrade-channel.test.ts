import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runCli, updateYaml, yamlFile } from '../helpers.js';
import { CLI_VERSION } from '../../src/constants.js';

/*
 * The controlled declared-CLI-version upgrade channel (`canUpgradeDeclaredCli` /
 * `reconcileDeclaredCliVersion` in src/core/project-loader.ts, wired into `xforge update`).
 *
 * cli-protocol.test.ts already covers the happy path, the downgrade refusal, and the Protocol
 * mismatch refusal — but it stages every one of them with the `updateYaml` helper, which
 * round-trips the Manifest through the `yaml` library with `sortMapEntries: true`. That rewrites
 * the file's comments and key order *before* the assertion runs, so it structurally cannot observe
 * the design's headline claim: the reconciliation is a targeted text substitution precisely so a
 * hand-maintained manifest.yaml survives it byte-for-byte apart from the version pins themselves.
 * Every setup here therefore edits the Manifest as text.
 */

const MANIFEST = 'xforge/manifest.yaml';

/** A note no YAML round trip would keep, planted where a real project would keep one. */
const USER_COMMENT = '# project-specific note: this pin is reviewed by hand — do not reformat';

async function manifestText(root: string): Promise<string> {
  return readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
}

/**
 * Rewrites the three version pins (`xforge.version`, `scaffold.version`, `scaffold.source.version`)
 * by direct text substitution — never via `updateYaml`, so comments, key order, and formatting are
 * exactly what the shipped Scaffold ships. Fails loudly if the shipped Manifest ever stops having
 * exactly those three `version:` lines, rather than quietly staging a half-pinned project.
 */
async function pinDeclaredVersion(root: string, version: string): Promise<void> {
  const file = path.join(root, 'xforge', 'manifest.yaml');
  const source = await manifestText(root);
  const pattern = new RegExp(`^(\\s*version: )${CLI_VERSION.replace(/\./g, '\\.')}$`, 'gm');
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 3) throw new Error(`expected 3 version pins at ${CLI_VERSION} in the shipped Manifest, found ${matches.length}`);
  await writeFile(file, source.replace(pattern, `$1${version}`));
}

/** Inserts a standalone comment line immediately above a top-level block. */
async function commentAbove(root: string, blockKey: string, comment: string): Promise<void> {
  const file = path.join(root, 'xforge', 'manifest.yaml');
  const source = await manifestText(root);
  const anchor = `\n${blockKey}:\n`;
  if (!source.includes(anchor)) throw new Error(`no top-level ${blockKey}: block to anchor a comment to`);
  await writeFile(file, source.replace(anchor, `\n${comment}\n${blockKey}:\n`));
}

/** Key names, in file order, of the top-level mapping. */
function topLevelKeys(text: string): string[] {
  return [...text.matchAll(/^([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]!);
}

/** Key names, in file order, of the direct children of a top-level block. */
function childKeys(text: string, blockKey: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${blockKey}:`);
  if (start === -1) throw new Error(`no top-level ${blockKey}: block`);
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith('  ')) break;
    const match = /^ {2}([A-Za-z][A-Za-z0-9]*):/.exec(line);
    if (match) keys.push(match[1]!);
  }
  return keys;
}

/** `update` needs an existing installation record, so a real upgrade always starts from a clean install. */
async function installedFixture(): Promise<string> {
  const root = await fixture();
  const install = await runCli(root, ['install']);
  expect(install.code, JSON.stringify(install.json?.diagnostics)).toBe(0);
  return root;
}

describe('declared CLI version upgrade channel', () => {
  it('keeps comments, key order, and formatting — only the three version lines change', async () => {
    const root = await installedFixture();
    await pinDeclaredVersion(root, '0.7.7');
    await commentAbove(root, 'xforge', USER_COMMENT);
    const before = await manifestText(root);

    /* Preconditions the assertions below depend on: the shipped Manifest is genuinely comment-bearing
       and genuinely not in alphabetical key order, so a YAML round trip could not fake passing. */
    expect(before).toContain(USER_COMMENT);
    expect(before).toContain('# XForge supports exactly two approval mechanisms');
    expect(topLevelKeys(before)).not.toEqual([...topLevelKeys(before)].sort());
    expect(childKeys(before, 'scaffold').slice(0, 3)).toEqual(['version', 'language', 'source']);

    const update = await runCli(root, ['update']);
    expect(update.code, JSON.stringify(update.json.diagnostics)).toBe(0);
    expect(update.json.changes).toContainEqual(expect.objectContaining({
      action: 'modify', path: MANIFEST, source: `xforge:declared-version-upgrade:0.7.7->${CLI_VERSION}`,
    }));

    const after = await manifestText(root);
    expect(after).toContain(USER_COMMENT);
    expect(after).toContain('# XForge supports exactly two approval mechanisms');
    expect(topLevelKeys(after)).toEqual(topLevelKeys(before));
    expect(childKeys(after, 'scaffold')).toEqual(childKeys(before, 'scaffold'));
    expect(childKeys(after, 'xforge')).toEqual(childKeys(before, 'xforge'));

    /* The strongest form of the claim: line for line, the only edits anywhere in the file are the
       three version pins moving from the declared version to the running one. */
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    const edits = beforeLines.flatMap((line, index) => (line === afterLines[index] ? [] : [[line.trim(), afterLines[index]!.trim()]]));
    expect(edits).toEqual([
      ['version: 0.7.7', `version: ${CLI_VERSION}`],
      ['version: 0.7.7', `version: ${CLI_VERSION}`],
      ['version: 0.7.7', `version: ${CLI_VERSION}`],
    ]);

    const manifest = await yamlFile<any>(root, MANIFEST);
    expect(manifest.xforge.version).toBe(CLI_VERSION);
    expect(manifest.scaffold.version).toBe(CLI_VERSION);
    expect(manifest.scaffold.source.version).toBe(CLI_VERSION);
  });

  it('converges the lockfile onto the reconciled version in the same run', async () => {
    const root = await installedFixture();
    /* A project that really did install under an older CLI has both files pinned to it, so the
       lockfile has to move too — asserting against a lock that already holds the running version
       would pass no matter what the reconciliation did. The lock is machine-generated, so unlike
       the Manifest it is fine to stage through a YAML round trip. */
    await pinDeclaredVersion(root, '0.7.7');
    await updateYaml(root, 'xforge/lock.yaml', (lock) => {
      lock.xforge.version = '0.7.7';
      lock.scaffold.version = '0.7.7';
      lock.scaffold.source.version = '0.7.7';
    });

    const update = await runCli(root, ['update']);
    expect(update.code, JSON.stringify(update.json.diagnostics)).toBe(0);
    expect(update.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/lock.yaml', source: 'xforge:lock' }));

    /* The Manifest is the source of the lock's recorded identity, so a reconciliation that did not
       also reach the lock would leave the project reporting a mismatch it can never resolve. */
    const lock = await yamlFile<any>(root, 'xforge/lock.yaml');
    expect(lock.xforge.version).toBe(CLI_VERSION);
    expect(lock.scaffold.version).toBe(CLI_VERSION);

    const state = await runCli(root, ['state']);
    expect(state.code, JSON.stringify(state.json.diagnostics)).toBe(0);
    expect(state.json.data.project.compatibility.mode).toBe('managed');
    expect(state.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_LOCK_CLI_MISMATCH');
  });

  it('reports no changes at all when it refuses a downgrade', async () => {
    const root = await fixture();
    await pinDeclaredVersion(root, '9.9.9');
    const before = await manifestText(root);

    const update = await runCli(root, ['update']);
    expect(update.code).toBe(1);
    /* Not just a non-zero exit: a refusal that had already written half the reconciliation would
       report it here, and would have left the project in the corrupt state the refusal exists for. */
    expect(update.json.changes).toEqual([]);
    expect(update.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CLI_IDENTITY_MISMATCH');
    expect(update.json.nextActions[0].action).toBe('resolve-declared-xforge');
    expect(update.json.nextActions[0].command).toBeUndefined();
    expect(await manifestText(root)).toBe(before);
  });

  it('does not touch the Manifest when the declared version already equals the running one', async () => {
    const root = await installedFixture();
    const before = await manifestText(root);

    const update = await runCli(root, ['update']);
    expect(update.code, JSON.stringify(update.json.diagnostics)).toBe(0);
    /* `canUpgradeDeclaredCli` refuses equality as firmly as it refuses a downgrade, so an ordinary
       up-to-date `update` must never report the Manifest as modified — no churn, no rewrite. */
    expect(update.json.changes.filter((item: any) => item.path === MANIFEST)).toEqual([]);
    expect(update.json.changes.some((item: any) => String(item.source ?? '').startsWith('xforge:declared-version-upgrade'))).toBe(false);
    expect(await manifestText(root)).toBe(before);
  });

  it('treats a prerelease pin of the running version as an upgrade to its GA release', async () => {
    const root = await installedFixture();
    /* SemVer precedence: 0.7.8-rc.1 is older than 0.7.8. A comparator that compared dot segments or
       fell back to a plain lexical compare would rank the rc as newer and refuse this outright. */
    await pinDeclaredVersion(root, `${CLI_VERSION}-rc.1`);

    const update = await runCli(root, ['update']);
    expect(update.code, JSON.stringify(update.json.diagnostics)).toBe(0);
    expect(update.json.changes).toContainEqual(expect.objectContaining({
      action: 'modify', path: MANIFEST, source: `xforge:declared-version-upgrade:${CLI_VERSION}-rc.1->${CLI_VERSION}`,
    }));

    const manifest = await yamlFile<any>(root, MANIFEST);
    expect(manifest.xforge.version).toBe(CLI_VERSION);
    expect(manifest.scaffold.version).toBe(CLI_VERSION);
    expect(manifest.scaffold.source.version).toBe(CLI_VERSION);
  });

  it('refuses a prerelease of a newer version, and keeps that project loadable', async () => {
    const root = await fixture();
    await pinDeclaredVersion(root, '9.9.9-rc.1');

    /*
     * All three version fields share one `semver` $def in manifest.schema.json. If `scaffold.version`
     * kept a narrower GA-only pattern, this Manifest would fail schema validation in `loadProject` —
     * and since `reconcileDeclaredCliVersion` writes the running CLI's version verbatim into all
     * three fields, a prerelease CLI would write exactly this state and brick the project with
     * XFORGE_SCHEMA_INVALID on every subsequent command, with no in-tool way out.
     */
    const state = await runCli(root, ['state']);
    expect(state.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_SCHEMA_INVALID');
    expect(state.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CLI_IDENTITY_MISMATCH');
    expect(state.json.data.project.compatibility.mode).toBe('portable');

    /* 9.9.9-rc.1 is still newer than the running CLI, so reconciling to it would be a downgrade. */
    const update = await runCli(root, ['update']);
    expect(update.code).toBe(1);
    expect(update.json.changes).toEqual([]);
    expect((await yamlFile<any>(root, MANIFEST)).xforge.version).toBe('9.9.9-rc.1');
  });

  it('shows the reconciliation under --dry-run without writing it', async () => {
    const root = await installedFixture();
    await pinDeclaredVersion(root, '0.7.7');
    const before = await manifestText(root);

    const dryRun = await runCli(root, ['update', '--dry-run']);
    expect(dryRun.code, JSON.stringify(dryRun.json.diagnostics)).toBe(0);
    expect(dryRun.json.changes).toContainEqual(expect.objectContaining({
      action: 'modify', path: MANIFEST, source: `xforge:declared-version-upgrade:0.7.7->${CLI_VERSION}`,
    }));
    expect(await manifestText(root)).toBe(before);
    expect((await yamlFile<any>(root, 'xforge/lock.yaml')).xforge.version).toBe(CLI_VERSION);
  });
});
