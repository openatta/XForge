import { describe, expect, it } from 'vitest';
import { CHECK_FINDINGS_PATH } from '../../src/core/check-findings.js';
import {
  advanceSolidToApply, createCompleteSolidChange, fixture, runCli, write, writeVerificationReceipt,
} from '../helpers.js';

const CHANGE = 'add-feature';

/**
 * What `--text` and a command's diagnostics leave a person able to act on.
 *
 * Each case here corresponds to a live run in which the CLI reported the right thing in a form
 * nobody could use: an approval command buried under fifty kilobytes of JSON, a Stage that declares
 * no Gates reporting `gates: []` and `OK`, a pending-delivery count with no policy attached, and a
 * rehearsal command answering `warning` when it had found nothing wrong.
 */
describe('the readable form of a result', () => {
  it('renders state as a summary that names its own omissions, and leaves the envelope alone', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, CHANGE);

    const json = await runCli(root, ['state', '--change', CHANGE]);
    const text = await runCli(root, ['state', '--change', CHANGE, '--text']);

    expect(text.code).toBe(json.code);
    expect(text.stdout).toContain(`CHANGE ${CHANGE} — flow solid, stage apply`);
    expect(text.stdout).toContain('Transitions available:');
    expect(text.stdout).toContain('Approvals pending:');
    /* A summary that quietly drops a section is at its most reassuring where it is least entitled
       to be, so it says what is missing and how to get it. */
    expect(text.stdout).toContain('Not shown here:');
    expect(text.stdout).toContain('--field change.governance.revision.contentRevision');
    /* Presentation only: the JSON envelope is what it always was. */
    expect(text.stdout).not.toContain('"installation"');
    expect(json.stdout.trim().startsWith('{')).toBe(true);
    expect(Object.keys(json.json.data)).toContain('installation');
    expect(text.stdout.length).toBeLessThan(json.stdout.length / 4);
  });

  it('keeps the approval command visible at ready-to-archive rather than below a JSON dump', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, CHANGE);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    await runCli(root, ['check', '--change', CHANGE]);
    await writeVerificationReceipt(root, CHANGE);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'ready-to-archive']);

    const text = await runCli(root, ['state', '--change', CHANGE, '--text']);
    expect(text.stdout).toContain('closing-solid for archive');
    /* `ready-to-archive` is synthetic and declares no legal target. Reported as that fact, because
       an empty list was read as a stuck Change. */
    expect(text.stdout).toContain('declares no legal target');
    const approve = text.stdout.indexOf('closing-solid for archive');
    const nextActions = text.stdout.indexOf('"approve"');
    expect(approve).toBeGreaterThan(-1);
    expect(nextActions).toBeGreaterThan(-1);
    expect(nextActions - approve).toBeLessThan(4_000);
  });

  it('says when no Gate ran because the Stage declares none, and stays quiet when Gates did run', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, CHANGE);

    const atApply = await runCli(root, ['check', '--change', CHANGE]);
    expect(atApply.json.ok).toBe(true);
    expect(atApply.json.data.gates).toEqual([]);
    const notice = atApply.json.diagnostics.find((item: any) => item.code === 'XFORGE_CHECK_NO_GATES_AT_STAGE');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('Stage apply declares none');

    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    const atVerify = await runCli(root, ['check', '--change', CHANGE]);
    expect(atVerify.json.data.gates.length).toBeGreaterThan(0);
    expect(atVerify.json.diagnostics.some((item: any) => item.code === 'XFORGE_CHECK_NO_GATES_AT_STAGE')).toBe(false);
  });

  it('explains an optional pending remote audit delivery instead of leaving a bare count', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, CHANGE);

    const result = await runCli(root, ['audit', 'verify', '--change', CHANGE]);
    expect(result.json.ok).toBe(true);
    expect(result.json.data.remotePending).toBeGreaterThan(0);
    expect(result.json.data.remoteDelivery).toMatchObject({ required: false, policy: 'optional', endpointConfigured: false });
    const notice = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_AUDIT_REMOTE_PENDING_OPTIONAL');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('do not block archive');
  });

  it('folds the brief\'s quoted layer without removing it, and refuses to fold the JSON', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, 'findings: []\n');
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'check']);
    await runCli(root, ['check', '--change', CHANGE]);

    const full = await runCli(root, ['brief', '--change', CHANGE, '--text']);
    const folded = await runCli(root, ['brief', '--change', CHANGE, '--text', '--compact']);

    expect(full.stdout).toContain('EXTRACTED — verbatim from the Artifacts');
    expect(folded.stdout).toContain('EXTRACTED — folded:');
    expect(folded.stdout).toContain('without --compact');
    expect(folded.stdout).toContain('proposal.md');
    /* The property is that the quoted *bodies* are gone while every heading is still named — not
       that the output is shorter, which on a Change with one-line sections it need not be. */
    expect(full.stdout).toContain('Use a deterministic fixture.');
    expect(folded.stdout).not.toContain('Use a deterministic fixture.');
    expect(folded.stdout).toContain('Decisions');
    /* The decision block is never folded: it is what the approval turns on. */
    expect(folded.stdout).toContain('WHAT IS BEING DECIDED');
    /* `data` is untouched, which is what keeps triage anchoring deciding on the same set. */
    const json = await runCli(root, ['brief', '--change', CHANGE]);
    expect(json.json.data.extracted.length).toBeGreaterThan(0);

    const refused = await runCli(root, ['brief', '--change', CHANGE, '--compact']);
    expect(refused.code).toBe(1);
    expect(refused.json.diagnostics[0].code).toBe('XFORGE_OPTION_NOT_ALLOWED');
  });

  it('reports a valid approval rehearsal as information, not as a warning', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'check']);
    await runCli(root, ['check', '--change', CHANGE]);

    const result = await runCli(root, ['approve', '--change', CHANGE, '--for', 'apply', '--policy', 'planning-solid', '--dry-run']);
    expect(result.json.ok).toBe(true);
    const notice = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_APPROVAL_DRY_RUN_VALID');
    expect(notice.severity).toBe('info');
    expect(result.json.changes).toEqual([]);
  });
});
