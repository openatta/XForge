import { describe, expect, it } from 'vitest';
import { CHECK_FINDINGS_PATH, evaluateCheckFindings } from '../../src/core/check-findings.js';
import { CONSTITUTION_CHECK_PATH, constitutionPrinciples, evaluateConstitutionCheck } from '../../src/core/constitution-check.js';
import { loadProject } from '../../src/core/project-loader.js';
import { approvalTestEnv, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

const CHANGE = 'add-feature';
const ledgerPath = `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`;

async function evaluate(root: string): Promise<ReturnType<typeof evaluateCheckFindings>> {
  return evaluateCheckFindings(await loadProject(root, { exactRoot: true }), CHANGE);
}

describe('Check findings ledger', () => {
  it('refuses a Check Stage that only produced narrative prose', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const { rm } = await import('node:fs/promises');
    const path = await import('node:path');
    await rm(path.join(root, ...ledgerPath.split('/')), { force: true });

    /* check-report.md still exists and reads convincingly; that is exactly the problem. */
    const result = await evaluate(root);
    expect(result.status).toBe('failed');
    expect(result.problems.join(' ')).toContain('narrative in check-report.md does not satisfy this Gate');
  });

  it('accepts a review that found nothing only when it says so explicitly', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, ledgerPath, 'findings: []\n');
    expect((await evaluate(root)).status).toBe('passed');

    /* An empty file is silence, not a clean review. */
    await write(root, ledgerPath, '\n');
    expect((await evaluate(root)).status).toBe('failed');

    await write(root, ledgerPath, 'summary: looks fine\n');
    const missing = await evaluate(root);
    expect(missing.status).toBe('failed');
    expect(missing.problems.join(' ')).toContain('expected a top-level "findings" list');
  });

  it('blocks while a blocker is open and passes once it is resolved', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const blocker = (status: string): string => [
      'findings:',
      '  - id: F-1',
      '    severity: blocker',
      '    summary: The delta Spec has no scenario for the failure path.',
      '    refs: [specs/widget/spec.md]',
      `    status: ${status}`,
      '    reworkTo: propose',
      '    resolvedBy: owner@example.test',
      '',
    ].join('\n');

    await write(root, ledgerPath, blocker('open'));
    const open = await evaluate(root);
    expect(open.status).toBe('failed');
    expect(open.openBlockers).toEqual(['F-1']);
    expect(open.counts.blocker).toBe(1);

    await write(root, ledgerPath, blocker('resolved'));
    expect((await evaluate(root)).status).toBe('passed');
  });

  it('does not count a resolved blocker as resolved unless resolvedBy names a known identity', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const project = await loadProject(root, { exactRoot: true });
    const ledger = (extra: string): string => [
      'findings:',
      '  - id: F-1',
      '    severity: blocker',
      '    summary: The delta Spec has no scenario for the failure path.',
      '    refs: [specs/widget/spec.md]',
      '    status: resolved',
      '    reworkTo: propose',
      extra,
      '',
    ].join('\n');

    /* Marked resolved but nobody named: an unattributed resolution does not count as one. */
    await write(root, ledgerPath, ledger(''));
    const unattributed = await evaluateCheckFindings(project, CHANGE);
    expect(unattributed.status).toBe('failed');
    expect(unattributed.openBlockers).toEqual(['F-1']);
    expect(unattributed.problems.join(' ')).toContain('names no resolvedBy');

    /* A project with recorded identities must not accept a resolvedBy that is not one of them. */
    const known = { values: new Set(['owner@example.test']), empty: false };
    await write(root, ledgerPath, ledger('    resolvedBy: the team'));
    const unknown = await evaluateCheckFindings(project, CHANGE, known);
    expect(unknown.status).toBe('failed');
    expect(unknown.openBlockers).toEqual(['F-1']);
    expect(unknown.problems.join(' ')).toContain('does not match any approver or Git author');

    await write(root, ledgerPath, ledger('    resolvedBy: owner@example.test'));
    const resolved = await evaluateCheckFindings(project, CHANGE, known);
    expect(resolved.status).toBe('passed');
    expect(resolved.openBlockers).toEqual([]);
  });

  it('warns, but does not fail the Gate, when a refs path does not exist in the Change', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, ledgerPath, [
      'findings:',
      '  - id: F-1',
      '    severity: suggestion',
      '    summary: Naming is inconsistent.',
      '    refs: [design.md, specs/does-not-exist.md]',
      '',
    ].join('\n'));
    const result = await evaluate(root);
    expect(result.status).toBe('passed');
    expect(result.warnings.join(' ')).toContain('F-1');
    expect(result.warnings.join(' ')).toContain('specs/does-not-exist.md');
  });

  it('requires a blocker to name where the work goes back to, and every finding to cite something', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, ledgerPath, [
      'findings:',
      '  - id: F-1',
      '    severity: blocker',
      '    summary: Unresolved contradiction between Design and Proposal.',
      '    refs: [design.md]',
      '    status: open',
      '  - id: F-2',
      '    severity: warning',
      '    summary: Naming is inconsistent.',
      '    refs: []',
      '',
    ].join('\n'));
    const result = await evaluate(root);
    expect(result.status).toBe('failed');
    const problems = result.problems.join(' ');
    expect(problems).toContain('does not name a reworkTo Stage');
    expect(problems).toContain('cites no artifact');
  });

  it('rejects an unknown severity and duplicate finding ids', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, ledgerPath, [
      'findings:',
      '  - id: F-1',
      '    severity: nit',
      '    summary: Style.',
      '    refs: [design.md]',
      '  - id: F-1',
      '    severity: suggestion',
      '    summary: Duplicate id.',
      '    refs: [design.md]',
      '',
    ].join('\n'));
    const result = await evaluate(root);
    expect(result.status).toBe('failed');
    expect(result.problems.join(' ')).toContain('expected one of blocker, warning, suggestion');
    expect(result.problems.join(' ')).toContain('duplicate finding id F-1');
  });

  it('stops the Solid Check Stage from exiting while a blocker is open', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    await write(root, ledgerPath, [
      'findings:',
      '  - id: F-1',
      '    severity: blocker',
      '    summary: Design contradicts the delta Spec.',
      '    refs: [design.md]',
      '    status: open',
      '    reworkTo: design',
      '',
    ].join('\n'));

    const gate = await runCli(root, ['check', '--change', CHANGE, '--gate', 'check-findings'], approvalTestEnv);
    expect(gate.code).toBe(1);
    expect(gate.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_GATE_FAILED');
    expect(gate.json.data.gates.find((item: any) => item.id === 'check-findings').status).toBe('failed');
    /* The failure is recorded as Evidence, not merely printed. */
    expect(gate.json.data.gates.find((item: any) => item.id === 'check-findings').evidence.stderr).toContain('F-1');
  });
});

describe('Constitution ledger', () => {
  const constitutionPath = `xforge/changes/${CHANGE}/${CONSTITUTION_CHECK_PATH}`;

  async function evaluateConstitution(root: string) {
    return evaluateConstitutionCheck(await loadProject(root, { exactRoot: true }), CHANGE);
  }

  it('cannot be satisfied by a blanket claim of compliance', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, constitutionPath, 'principles:\n  - principle: everything\n    status: compliant\n');
    const result = await evaluateConstitution(root);
    expect(result.status).toBe('failed');
    expect(result.problems.join(' ')).toContain('is not a principle in');
    /* Each real principle is still unanswered. */
    expect(result.problems.filter((item) => item.includes('is not answered')).length).toBe(result.principles.length);
  });

  it('goes stale the moment the Constitution gains a principle', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await evaluateConstitution(root)).status).toBe('passed');

    /* An amendment must be considered by work already in flight, not silently inherited. */
    const { appendFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await appendFile(path.join(root, 'xforge', 'constitution.md'), '\n## Data residency\n\nStore customer data in region.\n');
    const stale = await evaluateConstitution(root);
    expect(stale.status).toBe('failed');
    expect(stale.problems.join(' ')).toContain('"Data residency" is not answered');
  });

  it('allows a recorded deviation but never a silent one', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const source = await (await import('node:fs/promises')).readFile(
      (await import('node:path')).join(root, 'xforge', 'constitution.md'), 'utf8');
    const [first, ...rest] = constitutionPrinciples(source);
    const ledger = (violation: string): string => [
      'principles:',
      `  - principle: ${JSON.stringify(first)}`,
      '    status: violation',
      violation,
      ...rest.map((name) => `  - principle: ${JSON.stringify(name)}\n    status: compliant\n    references: [proposal.md]`),
      '',
    ].join('\n');

    await write(root, constitutionPath, ledger('    justification: Legacy module cannot be split this Change.'));
    const unapproved = await evaluateConstitution(root);
    expect(unapproved.status).toBe('failed');
    expect(unapproved.problems.join(' ')).toContain('needs a named approver in approvedBy');

    await write(root, constitutionPath, ledger('    justification: Legacy module cannot be split this Change.\n    approvedBy: owner@example.test'));
    const approved = await evaluateConstitution(root);
    expect(approved.status).toBe('passed');
    expect(approved.violations).toEqual([first]);
  });
});

describe('Ledger identity', () => {
  it('refuses an approver the project has never recorded, and accepts one it has', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const project = await loadProject(root, { exactRoot: true });
    const source = await (await import('node:fs/promises')).readFile(
      (await import('node:path')).join(root, 'xforge', 'constitution.md'), 'utf8');
    const [first, ...rest] = constitutionPrinciples(source);
    const ledger = (approver: string): string => [
      'principles:',
      `  - principle: ${JSON.stringify(first)}`,
      '    status: violation',
      '    justification: Legacy module cannot be split in this Change.',
      `    approvedBy: ${JSON.stringify(approver)}`,
      ...rest.map((name) => `  - principle: ${JSON.stringify(name)}\n    status: compliant\n    references: [proposal.md]`),
      '',
    ].join('\n');
    const path2 = `xforge/changes/${CHANGE}/${CONSTITUTION_CHECK_PATH}`;

    /* A project with recorded identities must not accept a name that is not one of them. */
    const known = { values: new Set(['owner@example.test']), empty: false };
    await write(root, path2, ledger('the team'));
    const invented = await evaluateConstitutionCheck(project, CHANGE, known);
    expect(invented.status).toBe('failed');
    expect(invented.problems.join(' ')).toContain('does not match any approver or Git author');

    await write(root, path2, ledger('owner@example.test'));
    expect((await evaluateConstitutionCheck(project, CHANGE, known)).status).toBe('passed');

    /* A repository with no recorded identities yet cannot check, and must not block on that. */
    await write(root, path2, ledger('the team'));
    const fresh = await evaluateConstitutionCheck(project, CHANGE, { values: new Set(), empty: true });
    expect(fresh.status).toBe('passed');
  });
});
