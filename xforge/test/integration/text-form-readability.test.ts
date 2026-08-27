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

  it('names each active Change by id, Flow and Stage rather than joining objects', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, CHANGE);

    const text = await runCli(root, ['state', '--text']);

    /*
     * `activeChanges` carries `ActiveChangeSummary` objects, and this line declared them `string[]`
     * and joined them — so every project with anything in flight, which is the common case, printed
     * `Active Changes: [object Object]`. The portfolio line is the reason `--text` without
     * `--change` is worth running at all.
     */
    expect(text.stdout).not.toContain('[object Object]');
    expect(text.stdout).toContain(`Active Changes: ${CHANGE} — solid/apply`);
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

  it('carries the reconciliation entries into the readable form', async () => {
    /*
     * These used to print as a section of `xforge brief`, which a Skill relayed verbatim. The brief
     * is gone and the rules run from `check`, so the readable form of `check` is now the only place
     * a person meets them — a diagnostic that reaches the envelope and not the text would be a
     * finding that reaches a machine and not a reader.
     */
    const root = await fixture();
    await createCompleteSolidChange(root);

    const json = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    const text = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure', '--text']);
    const observations = (json.json.diagnostics as any[]).filter((item) => item.code.startsWith('XFORGE_RECONCILE_'));
    expect(observations.length, JSON.stringify((json.json.diagnostics as any[]).map((item) => item.code))).toBeGreaterThan(0);
    for (const entry of observations) expect(text.stdout + text.stderr, entry.code).toContain(entry.code);
    /* Stated as differences and never as verdicts, which is what lets an approver read them. */
    for (const entry of observations) expect(entry.severity).toBe('info');
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
