import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  advanceSolidToApply, changeYaml, checkFindings, clearVerification, createCompleteSolidChange,
  fixture, runCli, write,
} from '../helpers.js';

/**
 * Two questions moved to where they can still be answered cheaply.
 *
 * Both were already detected and both already reached a reader, and neither was acted on. The
 * undeclared-Gate notice has been on `state` since propose with the `declare` command already
 * substituted, and a measured `solid` run met it at propose and carried it unanswered to verify.
 * The unattestable ledger name passed with a warning saying it would be refused after the first
 * commit, and a live run wrote the Check report on the strength of the pass and met the refusal
 * afterwards. Adding a clearer sentence to either was not going to change the outcome; what
 * follows is the same fact, placed where the wrong path stops being available.
 *
 * @red-first behaviour: both blocks are new. Against the parent commit the first transition here
 * succeeds with the Gate unanswered, and the unattestable name passes under a configured provider
 * exactly as it does without one.
 */
describe('what a Change is held to before its first transition', () => {
  async function solidProject(): Promise<string> {
    const root = await fixture();
    await clearVerification(root);
    await write(root, 'xforge/changes/p/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/p/proposal.md', '## Why\nTest\n\n## Flow choice\nsolid\n');
    await write(root, 'xforge/changes/p/specs/widget/spec.md',
      '## ADDED Requirements\n\n### Requirement: Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n');
    return root;
  }

  it('refuses the first transition while a required declared Gate has no command, and names it', async () => {
    const root = await solidProject();
    const before = await runCli(root, ['transition', '--change', 'p', '--to', 'design']);
    expect(before.code).not.toBe(0);
    const blocked = (before.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_TRANSITION_BLOCKED');
    expect(blocked?.message).toContain('verification:unit-tests:undeclared');

    /* The remedy is the command, not a description of one: the blank is the part only a person
       can fill, and everything around it is already substituted. */
    const remedy = (before.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_VERIFICATION_UNDECLARED_BLOCKS_START');
    expect(remedy?.remedy?.commands?.[0]).toEqual(
      ['xforge', 'verification', 'declare', '--gate-name', 'unit-tests', '--command', '["<program>","<arg>"]', '--by', '<the person who answered>'],
    );

    const declared = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["node","-e","process.exit(0)"]', '--by', 'Test Owner']);
    expect(declared.code).toBe(0);
    await runCli(root, ['check', '--change', 'p', '--gate', 'structure']);
    const after = await runCli(root, ['transition', '--change', 'p', '--to', 'design']);
    expect(after.code, JSON.stringify(after.json?.diagnostics)).toBe(0);
  });

  it('asks once: a Change already past its first transition is not blocked again', async () => {
    const root = await solidProject();
    await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["node","-e","process.exit(0)"]', '--by', 'Test Owner']);
    await runCli(root, ['check', '--change', 'p', '--gate', 'structure']);
    expect((await runCli(root, ['transition', '--change', 'p', '--to', 'design'])).code).toBe(0);
    /* Withdrawing the answer afterwards must not strand a Change that is already under way: the
       Gate itself will still refuse at the Stage that runs it, which is a different report. */
    await clearVerification(root);
    const state = await runCli(root, ['state', '--change', 'p']);
    const blocks = ((state.json.data as any).change.governance.readyTransitions as any[]).flatMap((entry) => entry.blockedBy);
    expect(blocks.filter((block: string) => block.startsWith('verification:'))).toEqual([]);
  });
});

/**
 * The strictness of an unverifiable ledger name, decided by how this project collects approvals.
 *
 * These are the only coverage this branch has, and that is worth saying out loud rather than
 * leaving a reader to assume the live suite reaches it. It does not, and cannot as the harness
 * stands: `knownIdentities` is empty only while the Change has neither an approval receipt nor a
 * commit of its own, and `tests/live-engine/run-matrix.mjs` commits after every Stage — so by the
 * time any Stage writes a ledger, the Change directory already has commits and the ordinary branch
 * applies. Five live runs across four scenarios produced zero occurrences of the refusal below.
 *
 * The branch is still the right one for real use, where an Agent routinely writes a ledger before
 * anything is committed; that is the exact sequence the live run which motivated it followed --
 * two mandatory Gates passed, the Check report was written on the strength of that pass, the work
 * was committed, and the identical content was then refused. Closing the gap would mean changing
 * the harness's commit rhythm, which is the baseline every scenario's cost and revision history is
 * measured against, so it is recorded here instead of bought at that price.
 */
describe('a ledger name on a Change with no history of its own', () => {
  const TOKEN = 'XFORGE_ENTERPRISE_APPROVALS_TOKEN';

  async function checkedProject(resolvedBy: string, env: NodeJS.ProcessEnv = {}) {
    const root = await fixture();
    const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Devi Srinivasan']);
    git(['config', 'user.email', 'devi.srinivasan@example.test']);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'Seed']);
    await createCompleteSolidChange(root, 'add-feature');
    await write(root, 'xforge/changes/add-feature/evidence/check-findings.yaml', checkFindings(
      `  - id: F-001\n    severity: blocker\n    summary: A blocker that was closed.\n    refs: [proposal.md]\n    status: resolved\n    resolvedBy: ${resolvedBy}\n`,
    ));
    const ran = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'check-findings'], env);
    return (ran.json.data as any).gates[0];
  }

  it('is accepted and disclosed when approvals are collected at the terminal', async () => {
    const gate = await checkedProject('Nobody Who Exists');
    expect(gate.status).toBe('passed');
    expect(JSON.stringify(gate)).toContain('could not be checked against anything');
  });

  it('is refused when the project collects approvals through a configured provider', async () => {
    const gate = await checkedProject('Nobody Who Exists', { [TOKEN]: 'a-real-token' });
    expect(gate.status).toBe('failed');
    expect(JSON.stringify(gate)).toContain('does not match any Git author of this repository');
  });

  it('accepts a Git author of the repository under the same configured provider', async () => {
    const gate = await checkedProject('Devi Srinivasan', { [TOKEN]: 'a-real-token' });
    expect(gate.status).toBe('passed');
    /* The check ran and meant something, so there is no provisional pass left to disclose. */
    expect(JSON.stringify(gate)).not.toContain('could not be checked against anything');
  });
});

/**
 * The order Verify's own Skill now states, pinned as behaviour rather than as prose.
 *
 * `assurance.md` is a declared Artifact, so writing it moves `contentRevision` and stales the Gate
 * Evidence produced before it — and `verification finalize` refuses to cite a stale Gate, because a
 * receipt naming one would vouch for content that Gate never saw. Writing assurance and finalizing
 * straight after therefore cannot work, in any Change, ever; the Skill used to say to re-run "if
 * you touch any Artifact afterwards", and its own step always does.
 *
 * @red-first coverage-only: the refusal is not new. This exists because the Skill's step order was
 * changed on the strength of reading these two facts together, and a claim about what a documented
 * order avoids is worth an assertion that the unordered version really does fail.
 */
describe('finalize against Evidence that assurance staled', () => {
  it('refuses, and passes once the Gates are re-run against the current content', async () => {
    const root = await fixture();
    const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Devi Srinivasan']);
    git(['config', 'user.email', 'devi.srinivasan@example.test']);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'Seed']);
    await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["node","-e","process.exit(0)"]', '--by', 'Devi Srinivasan']);
    await createCompleteSolidChange(root, 'add-feature');
    await advanceSolidToApply(root, 'add-feature');
    await runCli(root, ['transition', '--change', 'add-feature', '--to', 'verify']);
    await runCli(root, ['check', '--change', 'add-feature']);

    /* Step 5's first act, done in the order the Skill used to imply. */
    await write(root, 'xforge/changes/add-feature/assurance.md',
      '## Completeness\nAll requirements are covered, with the evidence named.\n');
    const early = await runCli(root, ['verification', 'finalize', '--change', 'add-feature',
      '--status', 'passed', '--by', 'Devi Srinivasan']);
    expect(early.code).not.toBe(0);
    expect(JSON.stringify(early.json.diagnostics)).toContain('no longer binds the current one');

    /* And the narrow re-run the Skill now names: this Stage's Gates, without the work-package
       verify commands a bare `check` would execute again. */
    const rerun = await runCli(root, ['check', '--change', 'add-feature', '--stage', 'verify']);
    expect(rerun.code, JSON.stringify(rerun.json?.diagnostics)).toBe(0);
    const late = await runCli(root, ['verification', 'finalize', '--change', 'add-feature',
      '--status', 'passed', '--by', 'Devi Srinivasan']);
    expect(late.code, JSON.stringify(late.json?.diagnostics)).toBe(0);
  });
});

/**
 * The signal that decides strictness, taken from the project rather than from the environment.
 *
 * `XFORGE_ENTERPRISE_APPROVALS_TOKEN` was the whole test at first, and the live-engine harness is
 * what showed it was the wrong one: it sets that variable on the `xforge approve` spawn and on
 * nothing else, so a project whose every approval goes through a real MCP provider answered "not
 * managed" on every `check` — failing open, silently, in exactly the deployment the strict branch
 * exists for. The shipped McpServer names itself unconfigured in its own `command`; a provider that
 * no longer carries that sentinel is one somebody wired up, and that fact reads the same from every
 * command.
 *
 * @red-first behaviour: against the parent commit this project reads as unmanaged and the invented
 * name passes with a warning.
 */
describe('a project whose approval provider is wired up but whose token is absent', () => {
  it('is managed, and holds a ledger name to the repository', async () => {
    const root = await fixture();
    const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Devi Srinivasan']);
    git(['config', 'user.email', 'devi.srinivasan@example.test']);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'Seed']);

    /* The same rewrite `tests/live-engine/setup.mjs` performs: the placeholder command replaced by
       a real one. No token is set anywhere in this test. */
    const serverPath = path.join(root, 'xforge', 'scaffold', 'mcp-servers', 'enterprise-approvals.yaml');
    const server = await readFile(serverPath, 'utf8');
    expect(server).toContain('xforge-enterprise-approvals-server-not-configured');
    await writeFile(serverPath, server.replace(
      '["xforge-enterprise-approvals-server-not-configured"]',
      '["node","/somewhere/real-approval-server.mjs"]',
    ));

    await createCompleteSolidChange(root, 'add-feature');
    await write(root, 'xforge/changes/add-feature/evidence/check-findings.yaml', checkFindings(
      '  - id: F-001\n    severity: blocker\n    summary: A blocker that was closed.\n    refs: [proposal.md]\n    status: resolved\n    resolvedBy: Nobody Who Exists\n',
    ));
    const ran = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'check-findings']);
    const gate = (ran.json.data as any).gates[0];
    expect(gate.status).toBe('failed');
    expect(JSON.stringify(gate)).toContain('does not match any Git author of this repository');
  });
});
