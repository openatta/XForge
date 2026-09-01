import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeYaml, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

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

/**
 * Puts `major` in scope by giving the project a Change that runs it.
 *
 * The rules are asked only about the Flows a project uses — its Manifest default plus whatever its
 * active Changes chose — so a fixture, whose default is `solid`, says nothing about `major` until
 * something picks it. Every test below that is about a major-only Stage needs this first.
 */
async function useMajor(root: string): Promise<void> {
  await write(root, 'xforge/changes/needs-major/change.yaml', changeYaml('major'));
}

const CONFORMANCE = [
  'XFORGE_FLOW_SKILL_ARTIFACT_UNNAMED',
  'XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED',
  'XFORGE_FLOW_SKILL_CONDITION_UNNAMED',
  'XFORGE_FLOW_CONTRACT_DELTA_UNMERGED',
];

describe('Flow/Skill gate conformance', () => {
  /* The shipped Scaffold is the control. A rule that fires on it is a rule nobody can act on. */
  it('is clean on the shipped Flows and Skills', async () => {
    const root = await fixture();
    expect((await doctorCodes(root)).filter((code) => CONFORMANCE.includes(code))).toEqual([]);
  });

  it('reports an evidence Artifact its own Skill never names', async () => {
    const root = await fixture();
    await useMajor(root);
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
    await useMajor(root);
    for (const variant of ['SKILL.md', 'SKILL_cn.md']) {
      const relative = `xforge/scaffold/skills/xforge-verify/${variant}`;
      const text = await readFile(await skillPath(root, 'xforge-verify', variant), 'utf8');
      await write(root, relative, text.replaceAll('verification declare', 'the declaration'));
    }
    const findings = (await runCli(root, ['doctor'])).json.diagnostics
      .filter((item: any) => item.code === 'XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED');

    /* Three: solid's verify declares unit-tests, major's declares unit-tests and security-scan,
       and `quick` — which nothing here uses — is not asked about at all. The count matters: a rule
       that reported the Skill once would hide the second Gate, which is the one a live run met
       several turns later, after approvals had already been collected. */
    expect(findings.length).toBe(3);
    expect(findings.map((item: any) => item.message).join('\n')).toContain('security-scan');
    expect(findings.every((item: any) => item.message.includes('SKILL.md') && item.message.includes('SKILL_cn.md'))).toBe(true);
  });

  it('reports an exit condition its Skill never mentions', async () => {
    const root = await fixture();
    await useMajor(root);
    const relative = 'xforge/scaffold/skills/xforge-verify/SKILL.md';
    const text = await readFile(await skillPath(root, 'xforge-verify', 'SKILL.md'), 'utf8');
    await write(root, relative, text.replaceAll('independentReview', 'the review condition'));

    const finding = (await runCli(root, ['doctor'])).json.diagnostics
      .find((item: any) => item.code === 'XFORGE_FLOW_SKILL_CONDITION_UNNAMED');
    expect(finding).toBeTruthy();
    /* Quoted the way the CLI reports the block, so the reader can match one to the other. */
    expect(finding.message).toContain('condition:independentReview:');
  });

  /*
   * Scope, which is what keeps these findings worth reading.
   *
   * Three Flows ship and a project runs one or two of them. Asked about every Flow in the project,
   * the rules reported a Stage of `major` to a project that only ever runs `solid` — and, worse,
   * reported all of it to any project that took a new CLI without upgrading its Scaffold, on every
   * command, forever. Neither reader can act on any of it. `usedFlows` is the same scope doctor's
   * unused-Flow and approval-reachability findings already answer to.
   */
  it('says nothing about a Flow no Change uses', async () => {
    const root = await fixture();
    const text = await readFile(await skillPath(root, 'xforge-clarify', 'SKILL.md'), 'utf8');
    await write(root, 'xforge/scaffold/skills/xforge-clarify/SKILL.md', text.replaceAll('evidence/conditions/materialQuestions.yaml', 'the ledger'));

    /* `clarify` is a major Stage and this project's default Flow is solid, so the defect is real
       and no concern of anyone here. It appears the moment a Change chooses major. */
    expect((await doctorCodes(root)).filter((code) => CONFORMANCE.includes(code))).toEqual([]);
    await useMajor(root);
    expect(await doctorCodes(root)).toContain('XFORGE_FLOW_SKILL_ARTIFACT_UNNAMED');
  });

  /*
   * And not from `check`, which is a command about one Change.
   *
   * This compares a Flow against a Skill. Both are project configuration, neither belongs to the
   * Change being checked, and for a Skill that ships with XForge the fix is `upgrade-scaffold` —
   * nothing a Change author can do. Reported from `check` they also fed
   * XFORGE_CHECK_PASSED_WITH_WARNINGS, so every green run of every un-upgraded project ended with
   * a notice counting warnings its reader could not act on.
   */
  it('is not reported by check, which is a command about one Change', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const text = await readFile(await skillPath(root, 'xforge-verify', 'SKILL.md'), 'utf8');
    await write(root, 'xforge/scaffold/skills/xforge-verify/SKILL.md', text.replaceAll('verification declare', 'the declaration'));

    const codes = (await runCli(root, ['check', '--change', 'add-feature'])).json.diagnostics.map((item: any) => item.code);
    expect(codes.filter((code: string) => CONFORMANCE.includes(code))).toEqual([]);
    expect(codes).not.toContain('XFORGE_CHECK_PASSED_WITH_WARNINGS');
    /* Still reported where it belongs. */
    expect(await doctorCodes(root)).toContain('XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED');
  });

  /* Its own list in the envelope: every reference here resolves, so it is not a dangling one. */
  it('lands in the conformance list and counts toward --strict', async () => {
    const root = await fixture();
    const text = await readFile(await skillPath(root, 'xforge-verify', 'SKILL.md'), 'utf8');
    await write(root, 'xforge/scaffold/skills/xforge-verify/SKILL.md', text.replaceAll('verification declare', 'the declaration'));
    const result = await runCli(root, ['doctor']);
    expect((result.json.data.conformance as any[]).map((item) => item.code))
      .toContain('XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED');
    expect(result.json.data.summary.conformance).toBeGreaterThan(0);
    expect(result.json.data.danglingReferences).toEqual([]);
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

describe('a Flow that collects contract deltas and never merges them', () => {
  it('is reported, because both halves are valid on their own', async () => {
    /*
     * The same defect as the three above, one level out: a reference that resolves while the thing
     * it resolves to does not cover the job. Declaring the Artifact makes an Agent write an interface
     * delta every Change; omitting `syncContracts` throws every one of them away at archive. The
     * baseline never advances, each Change re-declares what the last already said, and nothing says
     * why — because neither half is wrong by itself.
     */
    const root = await fixture();
    const flowPath = path.join(root, 'xforge', 'flows', 'solid.yaml');
    const flow = await readFile(flowPath, 'utf8');
    await write(root, 'xforge/flows/solid.yaml', flow.replace('  - id: check-report\n', [
      '  - id: contract-delta',
      '    generates: contracts/**/*.md',
      '    validator: contract-delta',
      '    description: Declare the interface delta',
      '    instruction: List every contract element this Change adds, modifies or removes.',
      '    outline: |',
      '      ## ADDED Contract Elements',
      '  - id: check-report\n',
    ].join('\n')).replace('    produces: [design]', '    produces: [design, contract-delta]'));

    expect(await doctorCodes(root)).toContain('XFORGE_FLOW_CONTRACT_DELTA_UNMERGED');

    /* And silent once the Flow merges what it collects. */
    await write(root, 'xforge/flows/solid.yaml', (await readFile(flowPath, 'utf8')).replace('    syncSpecs: true', '    syncSpecs: true\n    syncContracts: true'));
    expect(await doctorCodes(root)).not.toContain('XFORGE_FLOW_CONTRACT_DELTA_UNMERGED');
  });
});
