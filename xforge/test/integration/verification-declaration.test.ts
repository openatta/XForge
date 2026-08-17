import { describe, expect, it } from 'vitest';
import { detectToolchains } from '../../src/core/toolchain.js';
import { resolveVerificationPlan } from '../../src/core/verification.js';
import { loadProject } from '../../src/core/project-loader.js';
import { clearVerification, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

const CHANGE = 'add-feature';

async function declare(root: string, entries: unknown[], gate = 'unit-tests'): Promise<void> {
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    manifest.verification = { ...(manifest.verification ?? {}), [gate]: entries };
  });
}

function run(command: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command, declaredBy: 'owner@example.test', declaredAt: '2026-08-17T05:00:00Z', ...extra };
}

/** A command that always succeeds and prints, on any platform this test suite runs on. */
const OK = ['node', '-e', 'console.log("ran 2 tests")'];
const FAIL = ['node', '-e', 'process.exit(1)'];

/**
 * The defect these tests exist for: the shipped `unit-tests` Gate was `npm test` behind a guard
 * that exited 0 when there was no `package.json`, so every Rust, Go and Python project got a Gate
 * reporting `passed` having asserted nothing — and with it a `must` Rule whose only enforcement was
 * that Gate, and an archive whose mandatory Gate was empty.
 */
describe('declared verification', () => {
  it('refuses instead of passing when nothing is declared', async () => {
    const root = await fixture();
      await clearVerification(root);
    await createCompleteSolidChange(root);
    await write(root, 'Cargo.toml', '[package]\nname = "demo"\n');

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_VERIFICATION_NOT_DECLARED');
    /* The whole point: an undeclared Gate must never be reported as satisfied. */
    expect(result.json.data.gates[0].status).toBe('failed');
  });

  it('carries the question and the place to answer it, for a human', async () => {
    const root = await fixture();
      await clearVerification(root);
    await createCompleteSolidChange(root);
    await write(root, 'Cargo.toml', '[package]\nname = "demo"\n');

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
    const [action] = result.json.nextActions;
    expect(action.action).toBe('declare-verification');
    expect(action.actor).toBe('human');
    expect(action.reason).toContain('Cargo.toml');
    expect(action.reason).toContain('cargo test');
    /* A suggestion is a starting point for a question. The Agent must not adopt one on its own. */
    expect(action.reason).toContain('Do not guess');
    expect(action.reason).toContain('manifest.yaml');
  });

  it('asks without a suggestion when it recognises nothing, rather than passing', async () => {
    const root = await fixture();
      await clearVerification(root);
    await createCompleteSolidChange(root);
    await write(root, 'Makefile.inhouse', 'all:\n\t./build.sh\n');

    /* This is the case that decides whether the design generalises: a toolchain no table lists
       still produces a question, never a pass. Teaching the CLI more languages would only move
       the edge of the old failure; refusing to answer removes it. */
    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_VERIFICATION_NOT_DECLARED');
    expect(result.json.nextActions[0].reason).toContain('no command to suggest');
    expect(result.json.nextActions[0].reason).toContain('Do not guess');
  });

  it('runs what was declared, in any language, and reports its real result', async () => {
    const root = await fixture();
      await clearVerification(root);
    await createCompleteSolidChange(root);
    await write(root, 'Cargo.toml', '[package]\nname = "demo"\n');

    await declare(root, [run(FAIL)]);
    await runCli(root, ['install']);
    const failing = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
    expect(failing.code).toBe(1);
    expect(failing.json.data.gates[0].status).toBe('failed');
    expect(failing.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_GATE_FAILED');

    await declare(root, [run(OK)]);
    await runCli(root, ['install']);
    const passing = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
    expect(passing.code).toBe(0);
    expect(passing.json.data.gates[0].status).toBe('passed');
    /* `passed` here always means something ran; the transcript is the evidence of that. */
    expect(passing.json.data.gates[0].evidence.stdout).toContain('ran 2 tests');
    expect(passing.json.data.gates[0].evidence.stdout).toContain('declared by owner@example.test');
  });

  it('stops at the first failing command and names it', async () => {
    const root = await fixture();
      await clearVerification(root);
    await createCompleteSolidChange(root);
    await declare(root, [run(FAIL), run(OK)]);
    await runCli(root, ['install']);

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
    expect(result.json.data.gates[0].status).toBe('failed');
    expect(result.json.data.gates[0].evidence.stderr).toContain('failed');
    expect(result.json.data.gates[0].evidence.stdout).not.toContain('ran 2 tests');
  });

  it('reports a missing tool as a missing tool, not as a failing check', async () => {
    const root = await fixture();
      await clearVerification(root);
    await createCompleteSolidChange(root);
    await declare(root, [run(['definitely-not-a-real-tool', 'test'])]);
    await runCli(root, ['install']);

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_GATE_COMMAND_UNAVAILABLE');
    /* Still blocking. An unrunnable check is not a pass either. */
    expect(result.json.data.gates[0].status).toBe('failed');
  });

  describe('more than one toolchain', () => {
    async function polyglot(root: string): Promise<void> {
      await createCompleteSolidChange(root);
      await write(root, 'Cargo.toml', '[package]\nname = "demo"\n');
      await write(root, 'package.json', '{"name":"web"}\n');
    }

    it('does not let one declared command silently account for a second toolchain', async () => {
      const root = await fixture();
      await clearVerification(root);
      await polyglot(root);
      await declare(root, [run(OK)]);
      await runCli(root, ['install']);

      const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED');
      expect(result.json.diagnostics.find((item: any) => item.code === 'XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED').message).toContain('package.json');
    });

    it('accepts an explicit covers, and accepts a recorded dismissal, equally', async () => {
      const root = await fixture();
      await clearVerification(root);
      await polyglot(root);
      await declare(root, [
        run(OK, { covers: ['Cargo.toml'] }),
        {
          notApplicable: 'package.json',
          justification: 'The web client is verified by its own repository pipeline.',
          declaredBy: 'owner@example.test',
          declaredAt: '2026-08-17T05:01:00Z',
        },
      ]);
      await runCli(root, ['install']);

      const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'unit-tests']);
      expect(result.code).toBe(0);
      expect(result.json.data.gates[0].status).toBe('passed');
    });

    it('asks nothing extra of a single-toolchain project that declared a command', async () => {
      const root = await fixture();
      await clearVerification(root);
      await createCompleteSolidChange(root);
      await write(root, 'Cargo.toml', '[package]\nname = "demo"\n');
      await declare(root, [run(OK)]);
      await runCli(root, ['install']);

      /* With one toolchain there is nothing to disambiguate, and a prompt people must click
         through is how a useful question becomes noise. */
      const project = await loadProject(root, { exactRoot: true });
      expect((await resolveVerificationPlan(project, 'unit-tests')).uncovered).toEqual([]);
    });
  });

  describe('toolchain detection', () => {
    it('finds markers in the project root and in declared module roots only', async () => {
      const root = await fixture();
      await clearVerification(root);
      await write(root, 'go.mod', 'module demo\n');
      await write(root, 'services/api/Cargo.toml', '[package]\nname = "api"\n');
      /* A dependency directory is not this project's toolchain, and asking about every
         package.json under node_modules is how a prompt becomes something people ignore. */
      await write(root, 'node_modules/left-pad/package.json', '{"name":"left-pad"}\n');
      await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
        manifest.project.modules = [
          { id: 'root', path: '.', kind: 'application' },
          { id: 'api', path: 'services/api', kind: 'service' },
        ];
      });

      const detected = await detectToolchains(await loadProject(root, { exactRoot: true }));
      expect(detected.map((entry) => entry.marker)).toEqual(['go.mod', 'services/api/Cargo.toml']);
      expect(detected.find((entry) => entry.marker.startsWith('services'))?.module).toBe('api');
    });
  });

  describe('projects that already exist', () => {
    /**
     * `xforge/scaffold/**` is seeded once by `init` and never updated afterwards, so shipping a
     * corrected Gate in the bundle reaches new projects only. Without this migration every project
     * created before it keeps the placeholder — and its silent pass — through every upgrade.
     */
    const PLACEHOLDER = [
      'apiVersion: xforge.dev/v1alpha1',
      'kind: Gate',
      'metadata:',
      '  name: unit-tests',
      '  version: 2',
      'spec:',
      '  required: true',
      '  command:',
      '    - node',
      '    - -e',
      '    - |',
      "      if (!require('fs').existsSync('package.json')) {",
      "        console.log('unit-tests: passing WITHOUT asserting anything.');",
      '        process.exit(0);',
      '      }',
      '  workingDirectory: .',
      '  timeoutSeconds: 900',
      '  evidence: tests.json',
      '',
    ].join('\n');

    it('replaces the shipped placeholder on update, and says why', async () => {
      const root = await fixture();
      await clearVerification(root);
      await write(root, 'xforge/scaffold/gates/unit-tests.yaml', PLACEHOLDER);
      await write(root, 'Cargo.toml', '[package]\nname = "demo"\n');
      await runCli(root, ['install']);

      const result = await runCli(root, ['update']);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_VERIFICATION_GATE_MIGRATED');
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const migrated = await readFile(path.join(root, 'xforge', 'scaffold', 'gates', 'unit-tests.yaml'), 'utf8');
      expect(migrated).toContain('builtin: declared');
      expect(migrated).not.toContain('passing WITHOUT');
      /* The migration and the lock it invalidates are resolved by the same run. */
      expect(result.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_LOCK_RESOURCES_MISMATCH');
    });

    it('never touches a Gate the project has adapted to itself', async () => {
      const root = await fixture();
      await clearVerification(root);
      const mine = PLACEHOLDER.replace(/  command:[\s\S]*?  workingDirectory: \./, '  command: [cargo, test]\n  workingDirectory: .');
      await write(root, 'xforge/scaffold/gates/unit-tests.yaml', mine);
      await runCli(root, ['install']);

      const result = await runCli(root, ['update']);
      expect(result.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_VERIFICATION_GATE_MIGRATED');
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      /* Overwriting somebody's real test command because a newer default exists would be a worse
         failure than the one being repaired. */
      expect(await readFile(path.join(root, 'xforge', 'scaffold', 'gates', 'unit-tests.yaml'), 'utf8')).toContain('cargo');
    });
  });
});
