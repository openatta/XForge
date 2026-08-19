import { describe, expect, it } from 'vitest';
import {
  CONSTITUTION_CHECK_PATH,
  constitutionPrinciples,
  evaluateConstitutionCheck,
} from '../../src/core/constitution-check.js';
import { loadProject } from '../../src/core/project-loader.js';
import type { ApprovalReceipt } from '../../src/types.js';
import { changeYaml, fixture, write } from '../helpers.js';

const CHANGE = 'cited-change';
const BASE = `xforge/changes/${CHANGE}`;
const LEDGER = `${BASE}/${CONSTITUTION_CHECK_PATH}`;

/**
 * The Gate this file covers used to accept `status: compliant` with nothing else on the entry, so a
 * ledger of seven bare statuses passed — the same unfalsifiable claim the Gate was introduced to
 * replace, only with labels. These tests pin the two things that closed that gap: a compliant
 * answer must cite something the project can actually locate, and where the CLI already knows the
 * answer it checks rather than asking.
 */
async function project(root: string) {
  return loadProject(root, { exactRoot: true });
}

async function principlesOf(root: string): Promise<string[]> {
  return constitutionPrinciples((await project(root)).constitution.content);
}

function ledger(entries: Array<{ principle: string; body?: string }>): string {
  return `principles:\n${entries.map((entry) => `  - principle: ${JSON.stringify(entry.principle)}\n${entry.body ?? '    status: compliant\n'}`).join('')}`;
}

function compliant(reference: string): string {
  return `    status: compliant\n    references: [${JSON.stringify(reference)}]\n`;
}

/** A Change with a Proposal, one delta Spec Requirement, and passing unit-tests Gate Evidence. */
async function citableChange(root: string): Promise<void> {
  await write(root, `${BASE}/change.yaml`, changeYaml('solid'));
  await write(root, `${BASE}/proposal.md`, '## Why\nA bounded change.\n');
  await write(root, `${BASE}/specs/widget/spec.md`, [
    '## ADDED Requirements', '',
    '### Requirement: REQ-101 Widget reports its state', '',
    '#### Scenario: success',
    '- **WHEN** asked',
    '- **THEN** it answers', '',
  ].join('\n'));
  await write(root, `${BASE}/evidence/tests.json`, JSON.stringify({ gate: 'unit-tests', status: 'passed' }));
}

describe('Constitution ledger references', () => {
  it('rejects a ledger of bare compliant statuses, which used to pass', async () => {
    const root = await fixture();
    await citableChange(root);
    const principles = await principlesOf(root);
    await write(root, LEDGER, ledger(principles.map((principle) => ({ principle }))));

    const result = await evaluateConstitutionCheck(await project(root), CHANGE);
    expect(result.status).toBe('failed');
    /* Every principle is named and answered — and that is still not compliance. */
    expect(result.covered).toEqual(principles);
    expect(result.problems.filter((item) => item.includes('with no references'))).toHaveLength(principles.length);
    expect(result.problems.join(' ')).toContain('a ledger of bare statuses');
  });

  it('accepts a Requirement id, an existing path, and a passed Gate as citations', async () => {
    const root = await fixture();
    await citableChange(root);
    const principles = await principlesOf(root);
    const citations = ['REQ-101', 'proposal.md', 'gate:unit-tests', 'specs/widget/spec.md'];
    await write(root, LEDGER, ledger(principles.map((principle, index) => ({
      principle,
      body: compliant(citations[index % citations.length]!),
    }))));

    const result = await evaluateConstitutionCheck(await project(root), CHANGE);
    expect(result.problems).toEqual([]);
    expect(result.status).toBe('passed');
  });

  it('refuses a citation nobody can follow, and a Gate that did not pass', async () => {
    const root = await fixture();
    await citableChange(root);
    const [first, second, ...rest] = await principlesOf(root);
    await write(root, LEDGER, ledger([
      { principle: first!, body: compliant('docs/we-are-fine.md') },
      { principle: second!, body: compliant('gate:security-scan') },
      ...rest.map((principle) => ({ principle, body: compliant('proposal.md') })),
    ]));

    const result = await evaluateConstitutionCheck(await project(root), CHANGE);
    expect(result.status).toBe('failed');
    expect(result.problems.join(' ')).toContain('docs/we-are-fine.md');
    /* No Evidence exists for security-scan at all, so `gate:` resolves to nothing. */
    expect(result.problems.join(' ')).toContain('gate:security-scan');
  });

  it('contradicts an observability claim with the Change\'s own failing unit-tests Evidence', async () => {
    const root = await fixture();
    await citableChange(root);
    const principles = await principlesOf(root);
    const observability = principles.find((principle) => /observab/i.test(principle));
    expect(observability).toBeDefined();
    await write(root, `${BASE}/evidence/tests.json`, JSON.stringify({ gate: 'unit-tests', status: 'failed' }));
    await write(root, LEDGER, ledger(principles.map((principle) => ({ principle, body: compliant('proposal.md') }))));

    const result = await evaluateConstitutionCheck(await project(root), CHANGE);
    expect(result.status).toBe('failed');
    expect(result.problems.join(' ')).toContain('unit-tests Gate Evidence records status "failed"');
  });

  it('holds a Constitution exception to the approvers this Change actually has receipts from', async () => {
    const root = await fixture();
    await citableChange(root);
    const [first, ...rest] = await principlesOf(root);
    const deviation = (approver: string): string => ledger([
      {
        principle: first!,
        body: `    status: violation\n    justification: The legacy module cannot be split in this Change.\n    approvedBy: ${JSON.stringify(approver)}\n`,
      },
      ...rest.map((principle) => ({ principle, body: compliant('proposal.md') })),
    ]);
    const receipt = { decision: 'approve', approver: { id: 'owner@example.test' } } as ApprovalReceipt;

    await write(root, LEDGER, deviation('someone@example.test'));
    const invented = await evaluateConstitutionCheck(await project(root), CHANGE, undefined, { approvals: [receipt] });
    expect(invented.status).toBe('failed');
    expect(invented.problems.join(' ')).toContain('holds no approval receipt for this Change');

    await write(root, LEDGER, deviation('owner@example.test'));
    const approved = await evaluateConstitutionCheck(await project(root), CHANGE, undefined, { approvals: [receipt] });
    expect(approved.problems).toEqual([]);
    expect(approved.violations).toEqual([first]);

    /* Check runs before any approval Stage; with no receipts yet this must not become unrecordable. */
    await write(root, LEDGER, deviation('someone@example.test'));
    const preApproval = await evaluateConstitutionCheck(await project(root), CHANGE, undefined, { approvals: [] });
    expect(preApproval.status).toBe('passed');
  });

  /**
   * A receipt path resolves — the file is right there — which is why the locatability rules above
   * cannot catch this on their own. It is also not a hypothetical: for a principle about
   * governance a receipt is the evidence a Check Agent naturally reaches for, and two consecutive
   * live runs of `solid` cited only that — a stable choice by the model, not variance, which is
   * why it is refused by the Gate rather than discouraged in a Skill.
   */
  describe('an approval receipt is not evidence of compliance', () => {
    const receiptPath = `approvals/planning-solid/${'bc412e1c-9707-42ca-b322-2d93c5b91d29'}.json`;

    async function withReceiptFile(root: string): Promise<void> {
      await write(root, `${BASE}/${receiptPath}`, JSON.stringify({ decision: 'approve' }));
    }

    it('refuses a principle whose citations are all receipts, even though each one resolves', async () => {
      const root = await fixture();
      await citableChange(root);
      await withReceiptFile(root);
      const [first, ...rest] = await principlesOf(root);
      await write(root, LEDGER, ledger([
        { principle: first!, body: compliant(receiptPath) },
        ...rest.map((principle) => ({ principle, body: compliant('proposal.md') })),
      ]));

      const result = await evaluateConstitutionCheck(await project(root), CHANGE);
      expect(result.status).toBe('failed');
      expect(result.problems.join(' ')).toContain('cites only approval receipts');
      /* The refusal must say what a receipt does prove, or the fix is a guess. */
      expect(result.problems.join(' ')).toContain('not why this Change satisfies the principle');
    });

    it('accepts a receipt cited alongside something that is evidence', async () => {
      const root = await fixture();
      await citableChange(root);
      await withReceiptFile(root);
      const [first, ...rest] = await principlesOf(root);
      await write(root, LEDGER, ledger([
        {
          principle: first!,
          body: `    status: compliant\n    references: [${JSON.stringify(receiptPath)}, "REQ-101"]\n`,
        },
        ...rest.map((principle) => ({ principle, body: compliant('proposal.md') })),
      ]));

      const result = await evaluateConstitutionCheck(await project(root), CHANGE);
      expect(result.problems).toEqual([]);
      expect(result.status).toBe('passed');
    });

    it('does not mistake an ordinary governed Artifact for a receipt', async () => {
      const root = await fixture();
      await citableChange(root);
      const [first, ...rest] = await principlesOf(root);
      await write(root, `${BASE}/evidence/conditions/materialQuestions.yaml`, 'entries: []\n');
      await write(root, LEDGER, ledger([
        { principle: first!, body: compliant('evidence/conditions/materialQuestions.yaml') },
        ...rest.map((principle) => ({ principle, body: compliant('proposal.md') })),
      ]));

      /* The material-questions ledger is exactly what a governance principle should cite instead. */
      const result = await evaluateConstitutionCheck(await project(root), CHANGE);
      expect(result.problems).toEqual([]);
      expect(result.status).toBe('passed');
    });
  });
});
