import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot } from '../xforge/test/helpers.js';
import { assertCassetteReplayable, cassettesRoot, unreplayableReason } from './live-engine/cassette.mjs';

/**
 * A replay re-signs approvals, so its receipts land at freshly minted UUID filenames. A Constitution
 * principle citing an approval receipt and nothing else therefore points at a file the replay never
 * creates, `constitution-check` refuses the citation, and the replay dies as a Gate failure deep
 * inside Check that is indistinguishable from a product defect.
 *
 * The hazard was known and documented in tests/live-engine/README.md, fixes and all. Documenting it
 * was not enough: nothing in the harness acted on it, so every recurrence cost a fresh diagnosis
 * from a misleading symptom — most recently a paid live re-record that reproduced the same citation,
 * because for a principle about governance an approval receipt is the evidence a Check Agent
 * naturally reaches for. These tests are that knowledge moved out of prose and into the harness.
 */
describe('cassette replayability', () => {
  const receipt = 'xforge/changes/task-ledger/approvals/planning-solid/bc412e1c-9707-42ca-b322-2d93c5b91d29.json';
  const ledgerFile = 'xforge/changes/task-ledger/evidence/constitution-check.yaml';

  it('refuses a recording whose principle cites only an approval receipt', () => {
    const reason = unreplayableReason({
      principles: [{ principle: 'Governance', status: 'compliant', references: [receipt] }],
    }, ledgerFile);
    expect(reason).toContain('principle "Governance" cites an approval receipt and nothing else');
    expect(reason).toContain(ledgerFile);
  });

  /*
   * The condition is "only", not "at all". A receipt cited beside something the replay can locate
   * still resolves the principle, which is why this is a property of a recording rather than of a
   * scenario — a later `solid` run that cites both records as replayable with no code change.
   */
  it('accepts a receipt cited alongside a reference the replay can resolve', () => {
    expect(unreplayableReason({
      principles: [{ principle: 'Governance', status: 'compliant', references: [receipt, 'REQ-TASK-005'] }],
    }, ledgerFile)).toBeNull();
  });

  it('ignores a principle that cites nothing, which is a different gate\'s complaint', () => {
    expect(unreplayableReason({
      principles: [{ principle: 'Governance', status: 'not-applicable', references: [] }],
    }, ledgerFile)).toBeNull();
  });

  it('refuses to replay a cassette carrying a reason, and names it', () => {
    expect(() => assertCassetteReplayable({ scenario: 'solid', unreplayableReason: 'because X' }))
      .toThrowError(/record-only and cannot be replayed[\s\S]*because X[\s\S]*do not re-record/);
  });

  it('replays a cassette with no reason, including older ones that predate the field', () => {
    expect(() => assertCassetteReplayable({ scenario: 'quick', unreplayableReason: null })).not.toThrow();
    expect(() => assertCassetteReplayable({ scenario: 'quick' })).not.toThrow();
  });

  /*
   * Every recording must state its verdict, so that "replayable" is a decision someone made rather
   * than a field nobody wrote. A missing key would silently reopen the failure mode above.
   */
  it('has every committed cassette declare a verdict', async () => {
    const manifests = (await readdir(cassettesRoot)).filter((name) => name.endsWith('.json'));
    expect(manifests.length).toBeGreaterThan(0);
    for (const name of manifests) {
      const manifest = JSON.parse(await readFile(path.join(cassettesRoot, name), 'utf8'));
      expect(Object.keys(manifest), `${name} does not declare unreplayableReason`).toContain('unreplayableReason');
      expect([null, 'string']).toContain(manifest.unreplayableReason === null ? null : typeof manifest.unreplayableReason);
    }
  });

  /*
   * The refusal has to happen where the harness reads the cassette, not only in a helper nobody
   * calls. Asserting the wiring rather than trusting it is what the prose version of this rule
   * lacked: the README described the hazard correctly while `run-matrix.mjs` did nothing about it.
   */
  it('wires the refusal into the replay entry point', async () => {
    const source = await readFile(path.join(repositoryRoot, 'tests', 'live-engine', 'run-matrix.mjs'), 'utf8');
    expect(source).toContain('assertCassetteReplayable(replay)');
  });

  it('wires the verdict into the recorder', async () => {
    const source = await readFile(path.join(repositoryRoot, 'tests', 'live-engine', 'record-cassette.mjs'), 'utf8');
    expect(source).toContain('unreplayableReason: unreplayable');
  });
});
