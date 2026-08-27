import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_FINDINGS_PATH } from '../../src/core/check-findings.js';
import { project } from '../project-builder.js';
import {
  advanceSolidToApply, createCompleteSolidChange, fixture, runCli, temporaryDirectory, write,
} from '../helpers.js';

/**
 * What `--dry-run` promises, held to what the real run does.
 *
 * The rehearsal exists to answer one question — *what would this command do to my project* — and a
 * suite that only checks it wrote nothing answers half of it. The half it skips is where the defects
 * are: `work-package acknowledge --dry-run` reported `create` for a path an existing receipt
 * occupied, because the bytes it was about to replace were read only when it was about to replace
 * them, and `findings resolve --dry-run` announced that Gate Evidence "is now stale" with nothing
 * written and nothing stale. Both told the truth about the tree and lied about the plan.
 *
 * So each case here runs the command twice — once rehearsed, once for real — and compares the plan
 * against what actually changed on disk. Three assertions, in the order they matter:
 *
 * 1. **The rehearsal writes nothing.** The whole tree, by digest.
 * 2. **The plan is not empty.** A rehearsal reporting no changes reads as "this would change
 *    nothing", which is the one thing it must not say when it would.
 * 3. **The plan names what the real run touches.** Path for path, and `create` versus `modify`
 *    decided against the disk the real run will meet.
 *
 * The live-engine has had `assert-dry-run.mjs` since it was written, and it can only ever run behind
 * a paid model call. Everything above is decidable offline, which is where it belongs: a contract
 * checked once per release is a contract checked after the mistake ships.
 */

/** Paths a real run writes that no plan describes, and which no plan should. */
const BOOKKEEPING = [
  /* Append-only side effects of *having run*, not of what was asked for. `recordAudit` fires after
     the action succeeds, so a plan that listed the audit append would be describing itself. */
  'xforge/.audit/',
  /* Installation ownership, rewritten by the writer rather than planned by the planner. */
  'xforge/.state.json',
];

/**
 * The committed per-Change audit index, on the same reasoning as the append that produces it.
 *
 * It is a projection of the chain rather than a document the command was asked to write, and it is
 * refreshed after the action succeeds. Listing it in every plan would describe the mechanism instead
 * of the request. Matched by suffix because the Change id is in the middle of the path.
 */
const AUDIT_INDEX = '/evidence/audit/index.json';

async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (prefix === '' && (entry.name === '.git' || entry.name === 'node_modules')) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(absolute, relative); continue; }
      result.set(relative, createHash('sha256').update(await readFile(absolute)).digest('hex'));
    }
  }
  await walk(root, '');
  return result;
}

function difference(before: Map<string, string>, after: Map<string, string>): Map<string, 'create' | 'modify' | 'delete'> {
  const changed = new Map<string, 'create' | 'modify' | 'delete'>();
  for (const [file, digest] of after) {
    if (!before.has(file)) changed.set(file, 'create');
    else if (before.get(file) !== digest) changed.set(file, 'modify');
  }
  for (const file of before.keys()) if (!after.has(file)) changed.set(file, 'delete');
  return changed;
}

const bookkeeping = (file: string): boolean => file.endsWith(AUDIT_INDEX) || BOOKKEEPING.some((prefix) => file === prefix || file.startsWith(prefix));

describe('the --dry-run contract', () => {
  /**
   * Runs one command rehearsed and then for real, and holds the first to the second.
   *
   * `expectPlanned` names the paths the plan must contain. Given rather than derived, because "what
   * this command is for" is the thing under test — deriving it from the real run would let a command
   * that plans nothing and writes nothing pass as consistent.
   */
  async function planMatchesReality(root: string, args: string[], expectPlanned: string[], volatile: string[] = []): Promise<void> {
    const before = await snapshot(root);

    const rehearsal = await runCli(root, [...args, '--dry-run']);
    expect(rehearsal.code, `${args.join(' ')} --dry-run: ${JSON.stringify(rehearsal.json?.diagnostics)}`).toBe(0);
    expect(rehearsal.json.data.dryRun, `${args.join(' ')} reports no dryRun flag`).toBe(true);

    /* 1. Nothing was written. */
    expect([...difference(before, await snapshot(root)).keys()], `${args.join(' ')} --dry-run wrote to the tree`).toEqual([]);

    /* 2. The plan says what it would do. */
    const planned = new Map<string, string>((rehearsal.json.changes as Array<{ path: string; action: string }>).map((item) => [item.path, item.action]));
    expect(planned.size, `${args.join(' ')} --dry-run planned nothing`).toBeGreaterThan(0);
    for (const expected of expectPlanned) expect([...planned.keys()], args.join(' ')).toContain(expected);

    /* 3. The plan describes the run. */
    const real = await runCli(root, args);
    expect(real.code, `${args.join(' ')}: ${JSON.stringify(real.json?.diagnostics)}`).toBe(0);
    const actual = difference(before, await snapshot(root));

    for (const [file, action] of actual) {
      if (bookkeeping(file)) continue;
      /*
       * A path whose basename the run mints cannot be predicted, and saying so is better than
       * pretending. `work-package dispatch` keys its receipt by a fresh `executionId`, so the
       * rehearsal names a sibling of the file the real run writes — the directory and the action are
       * the whole of what it can promise, and this holds it to exactly that.
       */
      const directory = file.slice(0, file.lastIndexOf('/'));
      if (volatile.includes(directory)) {
        const sibling = [...planned].find(([candidate]) => candidate.startsWith(`${directory}/`));
        expect(sibling, `${args.join(' ')} wrote into ${directory}, which the rehearsal did not plan`).toBeDefined();
        expect(sibling![1], `${args.join(' ')} planned ${sibling![1]} in ${directory} and performed ${action}`).toBe(action);
        continue;
      }
      expect(planned.has(file), `${args.join(' ')} wrote ${file}, which the rehearsal did not plan`).toBe(true);
      /*
       * `create` versus `modify` is the half a tree snapshot cannot check and the half that was
       * wrong: a supersede writes where a receipt already is, and answering `create` there is a
       * rehearsal describing a different project than the one on disk.
       */
      if (planned.get(file) === 'create' || planned.get(file) === 'modify') {
        expect(planned.get(file), `${args.join(' ')} planned ${planned.get(file)} for ${file} and performed ${action}`).toBe(action);
      }
    }
  }

  it('rehearses init into an empty directory', async () => {
    const root = await temporaryDirectory('xforge-dry-init-');
    await planMatchesReality(root, ['init', '--language', 'en', '--target', 'claude'], ['xforge/manifest.yaml']);
  }, 600_000);

  it('rehearses a Stage transition', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
    await planMatchesReality(root, ['transition', '--change', 'add-feature', '--to', 'design'], []);
  }, 600_000);

  it('rehearses resolving a finding', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/add-feature/${CHECK_FINDINGS_PATH}`, `findings:
  - id: CHK-001
    severity: warning
    summary: Should the retry budget be configurable?
    refs: [proposal.md]
`);
    await advanceSolidToApply(root);
    await planMatchesReality(
      root,
      ['findings', 'resolve', '--change', 'add-feature', '--id', 'CHK-001', '--answer', 'Yes, in the design.', '--by', 'owner@example.test'],
      [`xforge/changes/add-feature/${CHECK_FINDINGS_PATH}`],
    );
  }, 600_000);

  it('rehearses declaring and then retiring a verification command', async () => {
    const root = await fixture();
    await planMatchesReality(
      root,
      ['verification', 'declare', '--gate-name', 'unit-tests', '--command', '["node","-e","0"]', '--by', 'owner@example.test'],
      ['xforge/manifest.yaml'],
    );
    await planMatchesReality(
      root,
      ['verification', 'retire', '--gate-name', 'unit-tests', '--command', '["node","-e","0"]', '--by', 'owner@example.test', '--reason', 'The phase that needed it is over.'],
      ['xforge/manifest.yaml'],
    );
  }, 600_000);

  it('rehearses dispatching a work package', async () => {
    const built = await project().flow('solid').packages(1).atStage('apply').build();
    await planMatchesReality(
      built.root,
      ['work-package', 'dispatch', '--change', built.change, '--package', 'wp-001'],
      [],
      [`xforge/changes/${built.change}/evidence/agents/wp-001/dispatch`],
    );
  }, 600_000);

  /*
   * A supersede — the case that produced this contract — is exercised where its fixture already
   * lives: `acknowledge-supersede.test.ts` and `issue-2026-08-27.test.ts`. `create` versus `modify`
   * is checked generically above, on every case in this file.
   */
});
