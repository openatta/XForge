import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { changeYaml, fixture, runCli, write } from '../helpers.js';

/**
 * A Rule's coverage report must not contradict itself, and the two places that decide what
 * "enforced" means must not drift apart.
 *
 * Both had happened. `resource-loader` counted `gateRefs`/`policyRefs`/`approvalRefs`;
 * `control-plane` counted `gateRefs`/`approvalRefs`/`validatorRefs`. Each omission is a different
 * wrong answer. A Rule whose only enforcement is a selected PermissionPolicy came back
 * `[instructed, guarded, uncovered]` -- it says a guard exists and in the same array says no
 * mechanism is cited -- on every Flow, and no test anywhere asserted on that Rule's coverage. A
 * Rule enforced only by an Artifact validator got `XFORGE_RULE_NOT_ENFORCED` "remains guidance"
 * from the loader while `state` called it `structural`; that one is still only reachable by a
 * project-authored Rule, which is why it went unnoticed when validators were added to one site and
 * not the other.
 *
 * These are written as invariants rather than as more examples, because the failure is a
 * contradiction rather than a wrong value: an example test only catches the cell it names, and the
 * cell nobody thought to name is where both defects lived.
 */
const POSITIVE = ['guarded', 'structural', 'verified', 'approved'] as const;
const NEGATIVE = ['uncovered', 'unenforceable'] as const;

/* Both shipped `scope.paths` families, so every selected Rule reaches the Change. With only
   `src/**` -- what `changeYaml` declares by default -- `governance-assets-are-integrator-only` is
   filtered out by `ruleApplies` before coverage is ever computed, which is precisely why its
   contradiction survived. */
const REACHES_EVERY_RULE = { scope: { modules: ['root'], paths: ['src/**', 'xforge/**'] } };

async function coverage(root: string, flow: 'quick' | 'solid' | 'major'): Promise<any[]> {
  const change = `cover-${flow}`;
  await write(root, `xforge/changes/${change}/change.yaml`, changeYaml(flow, REACHES_EVERY_RULE));
  const state = await runCli(root, ['state', '--change', change]);
  return ((state.json.data as any)?.change?.governance?.rules ?? []) as any[];
}

/*
 * A `must` Rule about testing must reach a Change that only touches the test surface.
 *
 * `ruleApplies` is a pattern-against-pattern relation, not a glob match: it asks whether the Rule's
 * scope and the Change's scope share a root, comparing the literal text either side of `/**`. So
 * `tests/**` does not reach a project whose suite lives in `test/` -- the singular Node convention,
 * and the layout of this repository's own major fixture. Nothing was ever observed failing, because
 * the shipped Rule also lists `src/**` and every measured Change declared that: the gap only opens
 * for a Change scoped to the test surface alone, which is precisely the Change this Rule exists to
 * govern. A rule about testing that switches itself off on a test-only Change fails in the one
 * direction it must not.
 */
describe('observable-requirements-are-tested reaches a test-only Change', () => {
  it('applies to a Change scoped to test/**, tests/** or src/**', async () => {
    const { ruleApplies } = await import('../../src/core/governance.js');
    const { parse } = await import('yaml');
    const shipped = parse(await readFile(
      path.join(process.cwd(), '..', 'scaffold', 'payload', 'xforge', 'scaffold', 'rules', 'observable-requirements-are-tested.yaml'),
      'utf8',
    ));
    expect(shipped.spec.severity, 'the gap only matters because this is a must Rule').toBe('must');
    const rule = { id: shipped.metadata.name, paths: shipped.spec.scope.paths as string[], modules: [] as string[], stages: [] as string[] };
    const scopedTo = (paths: string[]) => ruleApplies(
      rule as never,
      { scope: { paths, modules: [] } } as never,
    );
    /* The singular layout is the one that was missing. */
    expect(scopedTo(['test/**']), 'a Change touching only test/ must be governed by it').toBe(true);
    expect(scopedTo(['tests/**'])).toBe(true);
    expect(scopedTo(['src/**'])).toBe(true);
    /* And it still does not reach a Change that touches neither. */
    expect(scopedTo(['docs/**'])).toBe(false);
  });
});

describe('rule coverage is internally consistent', () => {
  for (const flow of ['quick', 'solid', 'major'] as const) {
    it(`reports no shipped Rule as both enforced and unenforced under ${flow}`, async () => {
      const root = await fixture();
      const rules = await coverage(root, flow);
      expect(rules.length, 'no Rule reached this Change, so the assertions below prove nothing').toBeGreaterThan(0);

      for (const rule of rules) {
        const positive = POSITIVE.filter((tier) => rule.coverage.includes(tier));
        const negative = NEGATIVE.filter((tier) => rule.coverage.includes(tier));
        expect(
          positive.length > 0 && negative.length > 0,
          `Rule ${rule.id} reports ${positive.join('+')} and ${negative.join('+')} at once: ${JSON.stringify(rule.coverage)}`,
        ).toBe(false);
      }
    });
  }

  /* The observed symptom, pinned. On solid this Rule's `contract-delta` validator resolves and
     carries the assertion by itself, which is why `contract-default-layer.test.ts` passed
     throughout; quick declares no Artifact running that validator, so only the guard is left. */
  it('does not call a policy-guarded Rule unenforceable on a Flow with no validator for it', async () => {
    const root = await fixture();
    const rules = await coverage(root, 'quick');
    const rule = rules.find((item) => item.id === 'interfaces-are-contract-governed');
    expect(rule, 'the Rule ships selected').toBeTruthy();
    expect(rule.coverage).toContain('guarded');
    expect(rule.coverage).not.toContain('unenforceable');
    /* Nothing in quick runs the contract-delta validator, so the tier it would earn is absent --
       the guard is genuinely all this Rule has here, and the report should say exactly that. */
    expect(rule.coverage).not.toContain('structural');
  });

  it('does not call a Rule whose only enforcement is a guard uncovered', async () => {
    const root = await fixture();
    for (const flow of ['quick', 'solid', 'major'] as const) {
      const rule = (await coverage(root, flow)).find((item) => item.id === 'governance-assets-are-integrator-only');
      expect(rule, `the Rule ships selected and its xforge/** scope is declared (${flow})`).toBeTruthy();
      expect(rule.coverage, flow).toContain('guarded');
      expect(rule.coverage, flow).not.toContain('uncovered');
    }
  });
});

describe('the loader and the control plane agree on what counts as citing a mechanism', () => {
  /*
   * Stated directly: a Rule the loader does not warn about must not come back `uncovered`, and the
   * reverse. Only field membership is under test -- how strongly a ref resolves may legitimately
   * differ, since the loader has no Flow in scope and cannot know whether an approval policy or a
   * validator exists.
   */
  const CASES = [
    { id: 'guard-only', enforcement: { policyRefs: ['protected-files'] } },
    { id: 'validator-only', enforcement: { validatorRefs: ['contract-delta'] } },
    { id: 'gate-only', enforcement: { gateRefs: ['unit-tests'] } },
    { id: 'approval-only', enforcement: { approvalRefs: ['planning-solid'] } },
    { id: 'cites-nothing', enforcement: {} },
  ];

  for (const testCase of CASES) {
    it(`agrees about a must Rule citing ${testCase.id}`, async () => {
      const root = await fixture();
      const refs = Object.entries(testCase.enforcement)
        .map(([key, value]) => `    ${key}: [${(value as string[]).join(', ')}]`).join('\n');
      await write(root, `xforge/scaffold/rules/${testCase.id}.yaml`, [
        'apiVersion: xforge.dev/v1',
        'kind: Rule',
        `metadata:\n  name: ${testCase.id}`,
        'spec:',
        '  severity: must',
        `  instruction: A synthetic Rule citing ${testCase.id}.`,
        '  scope:\n    paths: ["src/**"]',
        refs ? `  enforcement:\n${refs}` : '',
      ].filter(Boolean).join('\n') + '\n');

      const manifestPath = path.join(root, 'xforge', 'manifest.yaml');
      const manifest = await readFile(manifestPath, 'utf8');
      const selected = manifest.replace(/\n  rules:\n/, `\n  rules:\n    - ${testCase.id}\n`);
      expect(selected, 'the Manifest still lists rules the way this edit expects').not.toEqual(manifest);
      await writeFile(manifestPath, selected);

      const change = 'agreement';
      await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('solid'));
      const state = await runCli(root, ['state', '--change', change]);
      const rules = ((state.json.data as any)?.change?.governance?.rules ?? []) as any[];
      const rule = rules.find((item) => item.id === testCase.id);
      expect(rule, 'the synthetic Rule was selected and reaches this Change').toBeTruthy();

      const warned = (state.json.diagnostics ?? []).some((item: any) => item.code === 'XFORGE_RULE_NOT_ENFORCED' && item.message.includes(testCase.id));
      expect(
        rule.coverage.includes('uncovered'),
        `loader ${warned ? 'warned' : 'did not warn'} but state reports coverage ${JSON.stringify(rule.coverage)}`,
      ).toBe(warned);
    });
  }
});
