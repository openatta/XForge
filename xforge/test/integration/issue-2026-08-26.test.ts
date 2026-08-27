import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadProject } from '../../src/core/project-loader.js';
import { actualGitIdentity, runtimeInstallation } from '../../src/core/identity.js';
import { validateSpecMergeFeasibility } from '../../src/core/spec-merger.js';
import {
  advanceSolidToApply, createCompleteSolidChange, fixture, runCli, runCliWithStdin, updateYaml, write,
} from '../helpers.js';

const run = promisify(execFile);
const VERIFY_OK = [process.execPath, '-e', 'process.exit(0)'];

/** The plan shape `work-package.schema.json` accepts, with one package per id. */
function plan(ids: string[]): string {
  return stringify({
    apiVersion: 'xforge.dev/v1alpha1',
    kind: 'WorkPackagePlan',
    packages: ids.map((id) => ({
      id,
      goal: `Implement ${id}`,
      depends_on: [],
      inputs: [`xforge/changes/${CHANGE}/design.md`],
      write_paths: [`src/${id}/**`],
      skills: ['xforge-apply'],
      verify: [VERIFY_OK],
      done_when: [`${id} is covered by an automated check`],
    })),
  }, { lineWidth: 120 });
}

async function initializeGit(root: string): Promise<void> {
  for (const args of [['init', '-q'], ['config', 'user.name', 'XForge Test'], ['config', 'user.email', 'test@example.test'], ['add', '.'], ['commit', '-qm', 'base']]) {
    await run('git', ['-C', root, ...args]);
  }
}

const CHANGE = 'add-feature';

/**
 * The second field report from a Major delivery, closed one case at a time.
 *
 * Every case here is a place where XForge held the right answer and produced it too late, in the
 * wrong slot, or under a name that meant something else — never a place where it decided wrongly.
 * The tests are written against the symptom the report describes rather than the implementation
 * that produced it.
 */
describe('field report 2026-08-26', () => {
  /** A main Spec the Change's delta will be merged into. */
  async function withMainSpec(root: string, requirement: string): Promise<void> {
    await write(root, `xforge/specs/widget/spec.md`, `# widget\n\n## Purpose\n\nExisting.\n\n## Requirements\n\n### Requirement: ${requirement}\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n`);
  }

  it('reports an unmergeable delta at check, and names the requirement the retitled block meant', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await withMainSpec(root, 'MCP-009 capability discovery is scoped per project');
    /* The reported failure exactly: a MODIFIED block whose heading was reworded to reflect the
       revision. The heading is the merge key, so it no longer locates anything. */
    await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, `## MODIFIED Requirements\n\n### Requirement: MCP-009 capability discovery is scoped per project and role\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n`);

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    expect(result.code).toBe(1);
    const conflict = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_SPEC_MERGE_CONFLICT');
    expect(conflict.message).toContain('Cannot modify missing requirement');
    /* The near miss, which is the whole difference between a diagnosis and a symptom. */
    expect(conflict.message).toContain('MCP-009 capability discovery is scoped per project');
    expect(conflict.message).toContain('RENAMED');
    /* Two sentences, joined as two. Concatenated bare they ran together — "…scoped per project and
       role The main Spec has…" — and the seam is exactly where the diagnosis starts. */
    expect(conflict.message).toContain('and role. The main Spec has');
  });

  it('collects every merge conflict in one pass instead of one per round trip', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await withMainSpec(root, 'REQ-1 one');
    await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, `## MODIFIED Requirements\n\n### Requirement: REQ-2 two\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n\n## REMOVED Requirements\n\n### Requirement: REQ-3 three\n`);

    const diagnostics = await validateSpecMergeFeasibility(await loadProject(root, { exactRoot: true }), CHANGE);
    expect(diagnostics.map((item) => item.code)).toEqual(['XFORGE_SPEC_MERGE_CONFLICT', 'XFORGE_SPEC_MERGE_CONFLICT']);
    /* `archive` keeps the opposite reading: it is a transaction and stops at the first one. */
    expect(diagnostics.some((item) => item.message.includes('REQ-2'))).toBe(true);
    expect(diagnostics.some((item) => item.message.includes('REQ-3'))).toBe(true);
  });

  it('passes a delta that merges, and does not fail a Flow that syncs no Specs', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await withMainSpec(root, 'REQ-1 one');
    await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, `## MODIFIED Requirements\n\n### Requirement: REQ-1 one\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n`);
    expect(await validateSpecMergeFeasibility(await loadProject(root, { exactRoot: true }), CHANGE)).toEqual([]);
  });

  it('drafts a delivery for one package without reporting the rest of the plan as unknown', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/work-packages.yaml`, plan(['wp-one', 'wp-two', 'wp-three']));
    await initializeGit(root);
    await advanceSolidToApply(root, CHANGE);
    for (const id of ['wp-one', 'wp-two', 'wp-three']) {
      const dispatched = await runCli(root, ['work-package', 'dispatch', '--change', CHANGE, '--package', id]);
      expect(dispatched.code).toBe(0);
    }
    /* A delivery is measured from the commit that dispatched it, so the receipts have to be in one. */
    await run('git', ['-C', root, 'add', '.']);
    await run('git', ['-C', root, 'commit', '-qm', 'dispatch']);

    const draft = await runCli(root, ['work-package', 'draft', '--change', CHANGE, '--package', 'wp-two']);
    /*
     * `latestDispatchFor` used to scan every package's receipts while holding a known-package set of
     * one, so each *other* package produced an error and the count scaled with the plan.
     */
    expect(draft.json.diagnostics.filter((item: any) => item.code === 'XFORGE_WORK_PACKAGE_DISPATCH_UNKNOWN')).toEqual([]);
    expect(draft.code, JSON.stringify(draft.json.diagnostics, null, 2)).toBe(0);
    expect(draft.json.data.packageId).toBe('wp-two');
  });

  it('says which file does not belong when a review transcript sits in the delivery slot', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/work-packages.yaml`, plan(['wp-one']));
    /* What the Skill used to prescribe: a YAML transcript one level above where deliveries are read. */
    await write(root, `xforge/changes/${CHANGE}/evidence/agents/wp-one/review-abc123.yaml`, 'verdict: pass\nnotes: read-only review\n');

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    const misuse = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_WORK_PACKAGE_DELIVERY_SLOT_MISUSED');
    expect(misuse.message).toContain('evidence/agents/wp-one/review/');
    expect(misuse.message).toContain('.md');
  });

  it('records a review scope when one is given, and omits it when none is', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, CHANGE);
    await write(root, `xforge/changes/${CHANGE}/evidence/review/reviewer.md`, '# Review\n\nChecked the five listed fixes only.\n');

    const scoped = await runCli(root, [
      'review', 'acknowledge', '--change', CHANGE,
      '--evidence', `xforge/changes/${CHANGE}/evidence/review/reviewer.md`,
      '--scope', 'The five fixes listed in the transcript, nothing else.',
    ]);
    expect(scoped.code).toBe(0);
    const receiptPath = scoped.json.changes[0].path;
    const receipt = JSON.parse(await readFile(path.join(root, receiptPath), 'utf8'));
    expect(receipt.scope).toBe('The five fixes listed in the transcript, nothing else.');

    /* Absent means nobody said, which is what every receipt written before the field existed means. */
    await write(root, `xforge/changes/${CHANGE}/evidence/review/second.md`, '# Review\n\nFull pass.\n');
    const unscoped = await runCli(root, [
      'review', 'acknowledge', '--change', CHANGE, '--evidence', `xforge/changes/${CHANGE}/evidence/review/second.md`,
    ]);
    expect(unscoped.code).toBe(0);
    expect(JSON.parse(await readFile(path.join(root, unscoped.json.changes[0].path), 'utf8')).scope).toBeUndefined();
  });

  it('names both remedies by audience when the dispatcher CLI does not match the pin, and still allows a read', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.xforge.version = '0.0.1'; });

    const write_ = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts', content: 'x' } });
    const denied = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], write_);
    const deniedReason = JSON.stringify(denied.json?.data?.platformOutput ?? denied.stdout);
    expect(deniedReason).toContain('deny');
    /* Both remedies, labelled by who may perform them, and the install one naming its prefix. */
    expect(deniedReason).toContain('npm i -g @xforge/cli@0.0.1');
    expect(deniedReason).toContain('which -a xforge');
    expect(deniedReason).toContain('belongs to a human or the Integrator');

    /*
     * A read is how this gets diagnosed from inside the session the denial applies to. It used to
     * be denied with everything else: the version refusal sat outside the repair affordance that
     * the neighbouring "governance will not load" refusal has had all along.
     */
    const read = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'xforge/manifest.yaml' } });
    const allowed = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], read);
    const allowedReason = JSON.stringify(allowed.json?.data?.platformOutput ?? allowed.stdout);
    expect(allowedReason).toContain('a read, which cannot change anything');
    expect(allowedReason).not.toContain('"deny"');
  });

  it('reports a must Rule that this Change never sees', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    /* A monorepo-shaped scope: nothing it declares shares a root with the shipped `src/**`. */
    await updateYaml(root, `xforge/changes/${CHANGE}/change.yaml`, (config) => { config.scope.paths = ['apps/widget/**']; });

    const state = await runCli(root, ['state', '--change', CHANGE]);
    const notice = state.json.diagnostics.find((item: any) => item.code === 'XFORGE_RULE_OUT_OF_CHANGE_SCOPE');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('observable-requirements-are-tested');
    expect(notice.message).toContain('never with the repository');
    expect(state.json.data.change.governance.rules.map((rule: any) => rule.id)).not.toContain('observable-requirements-are-tested');
  });

  it('reports a Rule whose scope matches no file in the repository', async () => {
    const root = await fixture();
    const result = await runCli(root, ['doctor']);
    const empty = result.json.data.suggestions.filter((item: any) => item.code === 'XFORGE_DOCTOR_RULE_SCOPE_EMPTY');
    /* The fixture has no `src/` or `tests/` tree, which is the shape the report describes. */
    expect(empty.map((item: any) => item.id)).toContain('observable-requirements-are-tested');
    expect(empty[0].severity).toBe('info');
    expect(empty[0].message).toContain('reaching nothing');
  });

  it('separates a declared remote audit sink from a resolvable one', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, CHANGE);
    const index = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', CHANGE, 'evidence', 'audit', 'index.json'), 'utf8'));
    /* The shipped Manifest always declares the env-var names, so the old single field read `true`
       in every project that had never configured anything. */
    expect(index.delivery.remoteDeclared).toBe(true);
    expect(index.delivery.remoteEndpointResolved).toBe(false);
    expect(index.delivery).not.toHaveProperty('remoteConfigured');
  });

  it('does not attribute the build to whatever repository contains the install prefix', async () => {
    /* In this checkout the package's own package.json is tracked, so the identity is real. */
    expect(runtimeInstallation().kind).toBe('git-checkout');
    expect(actualGitIdentity().commit).toMatch(/^[0-9a-f]{40}$/);

    /* An installed copy is not tracked by anything, and `git -C` would otherwise walk up and report
       whichever repository happens to contain the prefix — a live run was told Homebrew's. */
    const version = await runCli(await fixture(), ['version']);
    expect(version.json.data.installation.kind).toBeDefined();
    expect(version.json.data.installation.path).toContain('xforge');
  });
});
