import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CHECK_FINDINGS_PATH, evaluateCheckFindings } from '../../src/core/check-findings.js';
import { loadProject } from '../../src/core/project-loader.js';
import {
  advanceSolidToApply, advanceSolidToReadyToArchive, createCompleteSolidChange, fixture, runCli, write, writeVerificationReceipt,
} from '../helpers.js';

const CHANGE = 'add-feature';

/**
 * A finding pointed at whoever signs, rather than at a Stage.
 *
 * `severity: warning` with no `reworkTo` is the shape `core/brief.ts` reports as
 * `awaitingDecision`: no Gate blocks on it, nothing routes it, and until this command existed
 * nothing after the Check Stage had the authority to close it.
 */
const AWAITING = `# The Check Stage's ledger. Comments here must survive a resolve.
findings:
  - id: CHK-001
    severity: warning
    summary: Should the retry budget be configurable?
    refs: [proposal.md]
`;

async function ledger(root: string): Promise<any> {
  return parse(await readFile(path.join(root, 'xforge', 'changes', CHANGE, 'evidence', 'check-findings.yaml'), 'utf8'));
}

async function atApply(root: string, findings = AWAITING): Promise<void> {
  await createCompleteSolidChange(root);
  await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, findings);
  await advanceSolidToApply(root, CHANGE);
}

describe('xforge findings resolve', () => {
  it('records the answer, the person and the time, and leaves the rest of the file alone', async () => {
    const root = await fixture();
    await atApply(root);

    const result = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001',
      '--answer', 'No. A constant is correct until a second caller needs it.',
      '--by', 'owner@example.test',
    ]);

    expect(result.code).toBe(0);
    const entry = (await ledger(root)).findings[0];
    expect(entry.status).toBe('resolved');
    expect(entry.answer).toBe('No. A constant is correct until a second caller needs it.');
    expect(entry.resolvedBy).toBe('owner@example.test');
    expect(typeof entry.resolvedAt).toBe('string');
    /* Everything it did not write is preserved, comments included: this edits one entry in place
       rather than re-serializing a ledger a person authored. */
    const source = await readFile(path.join(root, 'xforge', 'changes', CHANGE, 'evidence', 'check-findings.yaml'), 'utf8');
    expect(source).toContain("# The Check Stage's ledger.");
    expect(entry.severity).toBe('warning');
    expect(entry.refs).toEqual(['proposal.md']);
  });

  it('says what it invalidated and where that leaves the Change', async () => {
    const root = await fixture();
    await atApply(root);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    await runCli(root, ['check', '--change', CHANGE]);
    await writeVerificationReceipt(root, CHANGE);

    const result = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001', '--answer', 'Answered.', '--by', 'owner@example.test',
    ]);

    expect(result.code).toBe(0);
    /* The write moves `contentRevision`, so the Gates it just staled are the reader's next step.
       A command that moved a revision silently would be worse than the hand edit it replaces. */
    const moved = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_FINDINGS_REVISION_MOVED');
    expect(moved.severity).toBe('info');
    expect(moved.message).toContain('verification-receipt.yaml');
    expect(result.json.nextActions.map((item: any) => item.command.join(' '))).toEqual([
      `xforge check --change ${CHANGE}`,
      `xforge verification draft-receipt --change ${CHANGE}`,
    ]);
  });

  it('refuses at ready-to-archive and names the route back instead of staling the receipt', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, AWAITING);
    await advanceSolidToReadyToArchive(root, CHANGE);

    const result = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001', '--answer', 'Answered.', '--by', 'owner@example.test',
    ]);

    expect(result.code).toBe(1);
    expect(result.json.diagnostics[0].code).toBe('XFORGE_FINDINGS_STAGE_CLOSED');
    expect(result.json.diagnostics[0].message).toContain('transition repair');
    expect((await ledger(root)).findings[0].status).toBeUndefined();
  });

  it('refuses a resolver the Change does not record, an unknown id, an empty answer, and a second close', async () => {
    const root = await fixture();
    await atApply(root);

    const unknownResolver = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001', '--answer', 'Answered.', '--by', 'the team',
    ]);
    expect(unknownResolver.code).toBe(1);
    expect(unknownResolver.json.diagnostics[0].code).toBe('XFORGE_FINDINGS_RESOLVER_UNKNOWN');

    const unknownId = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-404', '--answer', 'Answered.', '--by', 'owner@example.test',
    ]);
    expect(unknownId.code).toBe(1);
    expect(unknownId.json.diagnostics[0].code).toBe('XFORGE_FINDINGS_ID_UNKNOWN');
    expect(unknownId.json.diagnostics[0].message).toContain('CHK-001');

    const noAnswer = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001', '--answer', '   ', '--by', 'owner@example.test',
    ]);
    expect(noAnswer.code).toBe(1);
    expect(noAnswer.json.diagnostics[0].code).toBe('XFORGE_FINDINGS_ANSWER_REQUIRED');

    await runCli(root, ['findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001', '--answer', 'First.', '--by', 'owner@example.test']);
    const second = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001', '--answer', 'Second.', '--by', 'owner@example.test',
    ]);
    expect(second.code).toBe(1);
    expect(second.json.diagnostics[0].code).toBe('XFORGE_FINDINGS_ALREADY_RESOLVED');
    expect((await ledger(root)).findings[0].answer).toBe('First.');
  });

  it('writes nothing under --dry-run, and requires every argument', async () => {
    const root = await fixture();
    await atApply(root);
    const before = await readFile(path.join(root, 'xforge', 'changes', CHANGE, 'evidence', 'check-findings.yaml'), 'utf8');

    const dry = await runCli(root, [
      'findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001', '--answer', 'Answered.', '--by', 'owner@example.test', '--dry-run',
    ]);
    expect(dry.code).toBe(0);
    expect(dry.json.changes).toEqual([]);
    expect(await readFile(path.join(root, 'xforge', 'changes', CHANGE, 'evidence', 'check-findings.yaml'), 'utf8')).toBe(before);

    const missing = await runCli(root, ['findings', 'resolve', '--change', CHANGE, '--id', 'CHK-001']);
    expect(missing.code).toBe(1);
    expect(missing.json.diagnostics[0].code).toBe('XFORGE_FINDINGS_ARGUMENTS_REQUIRED');

    const wrongAction = await runCli(root, ['findings', 'add', '--change', CHANGE]);
    expect(wrongAction.code).toBe(1);
    expect(wrongAction.json.diagnostics[0].code).toBe('XFORGE_FINDINGS_ACTION_REQUIRED');
  });

  it('reports an unattributable non-blocker resolution without failing the Gate', async () => {
    const root = await fixture();
    await atApply(root, `findings:
  - id: CHK-001
    severity: warning
    summary: Should the retry budget be configurable?
    refs: [proposal.md]
    status: resolved
`);

    const result = await evaluateCheckFindings(await loadProject(root, { exactRoot: true }), CHANGE);
    /* Only a blocker's attribution fails this Gate — promoting a warning's would refuse ledgers
       that were valid before the rule existed. Silence about it was the actual defect. */
    expect(result.status).toBe('passed');
    expect(result.warnings.join('\n')).toContain('names no resolvedBy');

    /* And the Gate itself says so. Its warnings used to be collected and then dropped, so the
       disclosure this evaluator is documented to make reached nobody. */
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    const gate = await runCli(root, ['check', '--change', CHANGE, '--gate', 'check-findings']);
    expect(gate.json.data.gates[0].evidence.status).toBe('passed');
    expect(gate.json.data.gates[0].evidence.stdout).toContain('warning: ');
    expect(gate.json.data.gates[0].evidence.stdout).toContain('names no resolvedBy');
  });

  it('points the brief at the command instead of at a hand edit', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, AWAITING);
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'check']);

    const text = (await runCli(root, ['brief', '--change', CHANGE, '--text'])).stdout;
    expect(text).toContain('Awaiting your answer: CHK-001');
    expect(text).toContain('xforge findings resolve --change <id> --id <finding-id>');
  });
});
