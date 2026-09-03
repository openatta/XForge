import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * What the working set says at `apply`, asserted against a Change that really got there.
 *
 * `apply` is the Stage this repository had never measured, and the first look at it found the
 * working set answering "produces (nothing)" and "no Artifact is ready" — on the Stage that carries
 * dispatch, parallel workers, delivery records, integration and done_when evidence. The plan for all
 * of it sat in the reading list as one more file with a digest beside it.
 *
 * Driven from the frozen `solid-apply` fixture rather than assembled here. Building a Change up to
 * `apply` by hand takes an approval, three transitions and Gate Evidence at each one, and a fixture
 * that got there through a real run is both cheaper and a stronger claim: it is the state a Change
 * is actually in, not the state a test author believes it should be in.
 */
const repositoryRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const fixture = path.join(repositoryRoot, 'tests', 'probe', 'fixtures', 'solid-apply');
const cli = path.join(repositoryRoot, 'xforge', 'dist', 'cli.js');
const workspaces: string[] = [];

/*
 * The fixture is a live-engine snapshot, and `.gitignore` excludes the whole
 * `tests/probe/fixtures/` tree -- these are recorded from paid runs, not committed. So a fresh
 * clone has the test and not the state it reads, and an unguarded `cpSync` fails there for a reason
 * that has nothing to do with the code under test. Skipping says so; `snapshot.mjs` is how a
 * checkout gets one.
 */
const available = existsSync(fixture);

afterAll(() => { for (const dir of workspaces) rmSync(dir, { recursive: true, force: true }); });

function atApply(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'xforge-apply-'));
  workspaces.push(root);
  cpSync(fixture, root, { recursive: true });
  /*
   * The fixture pins the CLI of the day it was captured, and every managed operation refuses on the
   * mismatch. `update` is the supported move for exactly this: it advances the CLI pin and leaves
   * the Scaffold pin where the files are. The measurement harness aligns the same way.
   */
  execFileSync(process.execPath, [cli, '--root', root, 'update'], { encoding: 'utf8', stdio: 'ignore' });
  /*
   * And rewound to the Stage the fixture is named for. A fixture is captured at a Stage *boundary*,
   * which is the moment after the transition — so `solid-apply` sits at `verify`. `transition repair`
   * is the product's own route back: it drops one leaf receipt, only a leaf may go, and what was
   * discarded is recorded in the audit chain.
   */
  const stage = () => JSON.parse(execFileSync(process.execPath, [cli, '--root', root, 'state', '--change', 'task-ledger'], { encoding: 'utf8' })).data.change.stage;
  for (let guard = 0; stage() !== 'apply' && guard < 5; guard += 1) {
    const receipt = JSON.parse(execFileSync(process.execPath, [cli, '--root', root, 'state', '--change', 'task-ledger'], { encoding: 'utf8' }))
      .data.change.governance.transitions.latest.receiptId;
    execFileSync(process.execPath, [cli, '--root', root, 'transition', 'repair', '--change', 'task-ledger', '--receipt', receipt], { encoding: 'utf8', stdio: 'ignore' });
  }
  return root;
}

const run = (root: string, args: string[]) =>
  JSON.parse(execFileSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8' }));

describe.skipIf(!available)('the working set at apply', () => {
  it('reports the work plan, not just that no Artifact is ready', () => {
    const root = atApply();
    const data = run(root, ['stage', '--change', 'task-ledger']).data;

    expect(data.stage).toBe('apply');
    expect(data.work, JSON.stringify({ stage: data.stage, work: data.work })).toBeTruthy();

    const [first] = data.work.packages;
    expect(first.id).toBeTruthy();
    expect(first.goal).toBeTruthy();
    /* The three things a worker cannot start without: where it may write, what it must satisfy,
       and what runs to prove it. All were resolved by the CLI already and none were reported. */
    expect(Array.isArray(first.writePaths)).toBe(true);
    expect(Array.isArray(first.doneWhen)).toBe(true);
    expect(Array.isArray(first.verify)).toBe(true);
    expect(Array.isArray(data.work.protectedWritePaths)).toBe(true);
    expect(typeof data.work.baseCommit === 'string' || data.work.baseCommit === null).toBe(true);
  }, 120_000);

  it('renders the plan in the text form too', () => {
    const root = atApply();
    const text = execFileSync(process.execPath, [cli, '--root', root, 'stage', '--change', 'task-ledger', '--text'], { encoding: 'utf8' });
    expect(text).toContain('WORK ');
    expect(text).toMatch(/writes /);
  }, 120_000);
});
