import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runCli, write } from '../helpers.js';

/**
 * A Flow hangs a door on a Stage, the Stage names one Skill, and that Skill is what an Agent reads
 * when it arrives there. Nothing checked that the second knew about the first.
 *
 * Twice it did not, and both took three passes of hand review to find, because every other check in
 * this codebase asks whether a reference *resolves* rather than whether what it resolves to covers
 * the job: `xforge-clarify` forbade writing under `evidence/` while its Stage produced the
 * material-questions ledger there, and `xforge-verify` never named `xforge verification declare`
 * while its Stage declared two Gates that nothing else can clear.
 */
async function doctorCodes(root: string): Promise<string[]> {
  const result = await runCli(root, ['doctor']);
  return result.json.diagnostics.map((item: any) => item.code);
}

async function skillPath(root: string, id: string, variant: string): Promise<string> {
  return path.join(root, 'xforge', 'scaffold', 'skills', id, variant);
}

const CONFORMANCE = [
  'XFORGE_FLOW_SKILL_ARTIFACT_UNNAMED',
  'XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED',
  'XFORGE_FLOW_SKILL_CONDITION_UNNAMED',
];

describe('Flow/Skill gate conformance', () => {
  /* The shipped Scaffold is the control. A rule that fires on it is a rule nobody can act on. */
  it('is clean on the shipped Flows and Skills', async () => {
    const root = await fixture();
    expect((await doctorCodes(root)).filter((code) => CONFORMANCE.includes(code))).toEqual([]);
  });

  it('reports an evidence Artifact its own Skill never names', async () => {
    const root = await fixture();
    const relative = 'xforge/scaffold/skills/xforge-clarify/SKILL.md';
    const text = await readFile(await skillPath(root, 'xforge-clarify', 'SKILL.md'), 'utf8');
    /* Exactly the pre-fix wording: the ledger's path removed, the general prohibition left in. */
    await write(root, relative, text.replaceAll('evidence/conditions/materialQuestions.yaml', 'the ledger'));

    const finding = (await runCli(root, ['doctor'])).json.diagnostics
      .find((item: any) => item.code === 'XFORGE_FLOW_SKILL_ARTIFACT_UNNAMED');
    expect(finding, 'a Stage producing an evidence Artifact its Skill never names must be reported').toBeTruthy();
    expect(finding.message).toContain('material-questions');
    expect(finding.message).toContain('evidence/conditions/materialQuestions.yaml');
    /* Per locale, because a Skill localized in one language and not the other is the same defect
       for whichever half an Agent is served. Only the English variant was silenced here. */
    expect(finding.message).toContain('SKILL.md');
    expect(finding.message).not.toContain('SKILL_cn.md');
  });

  it('reports a declared Gate whose Skill never names the command that clears it', async () => {
    const root = await fixture();
    for (const variant of ['SKILL.md', 'SKILL_cn.md']) {
      const relative = `xforge/scaffold/skills/xforge-verify/${variant}`;
      const text = await readFile(await skillPath(root, 'xforge-verify', variant), 'utf8');
      await write(root, relative, text.replaceAll('verification declare', 'the declaration'));
    }
    const findings = (await runCli(root, ['doctor'])).json.diagnostics
      .filter((item: any) => item.code === 'XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED');

    /* Every Flow's verify Stage declares unit-tests; major adds security-scan. Four in total, and
       the count matters: a rule that reported the Skill once would hide the second Gate, which is
       the one a live run met several turns later, after approvals had already been collected. */
    expect(findings.length).toBe(4);
    expect(findings.map((item: any) => item.message).join('\n')).toContain('security-scan');
    expect(findings.every((item: any) => item.message.includes('SKILL.md') && item.message.includes('SKILL_cn.md'))).toBe(true);
  });

  it('reports an exit condition its Skill never mentions', async () => {
    const root = await fixture();
    const relative = 'xforge/scaffold/skills/xforge-verify/SKILL.md';
    const text = await readFile(await skillPath(root, 'xforge-verify', 'SKILL.md'), 'utf8');
    await write(root, relative, text.replaceAll('independentReview', 'the review condition'));

    const finding = (await runCli(root, ['doctor'])).json.diagnostics
      .find((item: any) => item.code === 'XFORGE_FLOW_SKILL_CONDITION_UNNAMED');
    expect(finding).toBeTruthy();
    /* Quoted the way the CLI reports the block, so the reader can match one to the other. */
    expect(finding.message).toContain('condition:independentReview:');
  });

  /* doctor --strict is the CI form: these are warnings, so they count toward hasFindings. */
  it('fails doctor --strict', async () => {
    const root = await fixture();
    const relative = 'xforge/scaffold/skills/xforge-verify/SKILL.md';
    const text = await readFile(await skillPath(root, 'xforge-verify', 'SKILL.md'), 'utf8');
    await write(root, relative, text.replaceAll('verification declare', 'the declaration'));
    const strict = await runCli(root, ['doctor', '--strict']);
    expect(strict.code).toBe(1);
    expect(strict.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_DOCTOR_STRICT');
  });
});
