import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* The repository root declares no dependencies; `yaml` lives with the CLI package, which is
   how every other harness script under tests/ reaches it. */
import { parse } from '../xforge/node_modules/yaml/dist/index.js';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/*
 * A scenario fixture describes the governance the Flow actually declares, or it teaches the model
 * something untrue.
 *
 * `major/project-seed/TEST_REQUEST.md` told every Major run that Apply needed "双签审批（2 名不同
 * 角色审批人）" long after the shipped Flow moved to `minApprovers: 1` with `separationOfDuties` —
 * and the Flow's own comment calls counting distinct roles "the bug this rule replaced". Nothing
 * caught it: no test compares the two, and the Major scenario is allowed to stop at Check, so no
 * run ever reached the approval it misdescribed.
 */
describe('live-engine fixtures agree with the Flow they exercise', () => {
  /*
   * The two Artifacts whose Skills are told to report what the CLI found must have somewhere to
   * put it.
   *
   * Not a general law about gated Stages -- `propose` declares the structure Gate and its Proposal
   * has no business reporting on it. It is these two specifically: `xforge-check` says to run
   * `xforge check` and report "CLI results", and `xforge-verify` produces assurance from Gate
   * Evidence. `assurance` carried `## Gates and evidence` all along; `check-report` did not, and a
   * cold live run showed the consequence -- given only a feature request it wrote three Artifacts
   * with their declared headings verbatim, then invented `## Gate evidence (CLI, deterministic)`
   * on this one. It was obeying the Skill into a space the outline did not offer.
   */
  it('gives check-report and assurance a section for what the Gates reported', async () => {
    for (const name of ['solid', 'major']) {
      const flow = parse(await readFile(
        path.join(repositoryRoot, `scaffold/payload/xforge/flows/${name}.yaml`), 'utf8',
      ));
      for (const artifactId of ['check-report', 'assurance']) {
        const artifact = flow.artifacts.find((entry: any) => entry.id === artifactId);
        expect(artifact, `${name} has no ${artifactId}`).toBeDefined();
        expect(
          artifact.outline,
          `${name}/${artifactId} has no section for what the Gates reported`,
        ).toContain('## Gates and evidence');
      }
    }
  });

  it('does not describe Major approval as needing two signatures or two roles', async () => {
    const request = await readFile(
      path.join(repositoryRoot, 'tests/live-engine/scenarios/major/project-seed/TEST_REQUEST.md'),
      'utf8',
    );
    const flow = parse(await readFile(
      path.join(repositoryRoot, 'scaffold/payload/xforge/flows/major.yaml'),
      'utf8',
    ));

    const policies = flow.governance.approvalPolicies;
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      /* The assertions below only hold while the Flow asks for one non-implementer. */
      expect(policy.minApprovers, `${policy.id} minApprovers`).toBe(1);
      expect(policy.separationOfDuties, `${policy.id} separationOfDuties`).toBe(true);
    }

    expect(request).not.toContain('双签');
    expect(request).not.toMatch(/2\s*名不同角色/);
    /* And states the rule that replaced it, so a reader is not left with nothing. */
    expect(request).toContain('separationOfDuties');
  });
});
