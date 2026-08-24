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
