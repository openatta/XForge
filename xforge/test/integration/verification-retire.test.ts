import { describe, expect, it } from 'vitest';
import { fixture, runCli, updateYaml, yamlFile } from '../helpers.js';

/**
 * Withdrawing a verification declaration without erasing that it was made.
 *
 * `declare` was append-only. A live run declared a documentation grep for one phase of a project,
 * declared `npm test` for the next, and could not stop the first: the Gate executed every
 * declaration in order on every run, and the only route to removing one was hand-editing a Manifest
 * that `protected-manifest` governs. Gate cost grew with the project's history, and the history was
 * the one thing that could not be edited.
 *
 * Retirement rather than deletion, on the reasoning that made `declaredBy` required in the first
 * place. Nothing can decide mechanically whether a command verifies anything, so a project that
 * stops running one has made a judgement, and the judgement is worth keeping even though the
 * execution is not.
 */
describe('verification retire', () => {
  /** Two runs on one Gate: one to withdraw, one that must keep running. */
  async function twoDeclarations(): Promise<string> {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.verification = {
        'unit-tests': [
          { command: ['node', '-e', 'process.exit(0)'], declaredBy: 'owner@example.test', declaredAt: '2026-01-01T00:00:00Z' },
          { command: ['node', '-e', 'console.log("docs")'], declaredBy: 'owner@example.test', declaredAt: '2026-01-02T00:00:00Z' },
        ],
      };
    });
    return root;
  }

  it('keeps the entry, records who withdrew it and why, and stops running it', async () => {
    const root = await twoDeclarations();
    const result = await runCli(root, [
      'verification', 'retire', '--gate-name', 'unit-tests',
      '--command', '["node","-e","console.log(\\"docs\\")"]',
      '--by', 'owner@example.test', '--reason', 'The phase that needed the documentation grep is over.',
    ]);

    expect(result.code, JSON.stringify(result.json?.diagnostics)).toBe(0);
    /* It says what it did, and to whom it is attributed — the withdrawal is a judgement, so the
       command reports it rather than leaving it to be read out of the Manifest afterwards. */
    const notice = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_VERIFICATION_RETIRED');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('owner@example.test');
    expect(notice.message).toContain('documentation grep');

    const manifest = await yamlFile<any>(root, 'xforge/manifest.yaml');
    const entries = manifest.verification['unit-tests'];
    /* Both still there: the record is what retirement keeps. */
    expect(entries).toHaveLength(2);
    const retired = entries.find((entry: any) => entry.retiredAt);
    expect(retired.command).toEqual(['node', '-e', 'console.log("docs")']);
    expect(retired.retiredBy).toBe('owner@example.test');
    expect(retired.retiredReason).toContain('documentation grep');
    expect(entries.find((entry: any) => !entry.retiredAt).command).toEqual(['node', '-e', 'process.exit(0)']);
  });

  it('runs only the declarations that are still active', async () => {
    const { project } = await import('../project-builder.js');
    const built = await project().flow('quick').atStage('apply').build();
    /* Two commands on one Gate, each printing a marker, so the Gate's own stdout says which ran. */
    await updateYaml(built.root, 'xforge/manifest.yaml', (manifest) => {
      manifest.verification = {
        'unit-tests': [
          { command: ['node', '-e', 'console.log("KEPT")'], declaredBy: 'owner@example.test', declaredAt: '2026-01-01T00:00:00Z' },
          { command: ['node', '-e', 'console.log("RETIRED")'], declaredBy: 'owner@example.test', declaredAt: '2026-01-02T00:00:00Z' },
        ],
      };
    });

    const before = await runCli(built.root, ['check', '--change', built.change, '--gate', 'unit-tests']);
    expect(before.json.data.gates[0].evidence.stdout).toContain('RETIRED');
    expect(before.json.data.gates[0].evidence.stdout).toContain('KEPT');

    const retired = await runCli(built.root, [
      'verification', 'retire', '--gate-name', 'unit-tests', '--command', '["node","-e","console.log(\\"RETIRED\\")"]',
      '--by', 'owner@example.test', '--reason', 'The phase that needed it is over.',
    ]);
    expect(retired.code, JSON.stringify(retired.json?.diagnostics)).toBe(0);

    /*
     * The Gate's own record of what it executed is the assertion that matters. A retired entry that
     * still ran would leave the project paying for a check it withdrew — which is the whole defect:
     * a live run's documentation grep executed on every `unit-tests` Gate long after its phase.
     */
    const after = await runCli(built.root, ['check', '--change', built.change, '--gate', 'unit-tests']);
    expect(after.json.data.gates[0].evidence.status).toBe('passed');
    expect(after.json.data.gates[0].evidence.stdout).toContain('KEPT');
    expect(after.json.data.gates[0].evidence.stdout).not.toContain('RETIRED');
  }, 300_000);


  it('refuses when the argument names no active declaration, and says what there is', async () => {
    const root = await twoDeclarations();
    const missing = await runCli(root, [
      'verification', 'retire', '--gate-name', 'unit-tests', '--command', '["cargo","test"]',
      '--by', 'owner@example.test', '--reason', 'x',
    ]);
    expect(missing.code).toBe(1);
    expect(missing.json.diagnostics[0].code).toBe('XFORGE_VERIFICATION_RETIRE_NOT_FOUND');
    expect(missing.json.diagnostics[0].message).toContain('node');

    /* Retiring the same entry twice names nothing active, which is the same refusal rather than a
       second no-op write. */
    await runCli(root, ['verification', 'retire', '--gate-name', 'unit-tests', '--command', '["node","-e","process.exit(0)"]', '--by', 'owner@example.test', '--reason', 'first']);
    const again = await runCli(root, ['verification', 'retire', '--gate-name', 'unit-tests', '--command', '["node","-e","process.exit(0)"]', '--by', 'owner@example.test', '--reason', 'second']);
    expect(again.code).toBe(1);
    expect(again.json.diagnostics[0].code).toBe('XFORGE_VERIFICATION_RETIRE_NOT_FOUND');
  });

  it('refuses to choose between two declarations that match the same argument', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.verification = {
        'unit-tests': [
          { command: ['npm', 'test'], module: 'root', declaredBy: 'owner@example.test', declaredAt: '2026-01-01T00:00:00Z' },
          { command: ['npm', 'test'], declaredBy: 'owner@example.test', declaredAt: '2026-01-02T00:00:00Z' },
        ],
      };
    });
    const ambiguous = await runCli(root, ['verification', 'retire', '--gate-name', 'unit-tests', '--command', '["npm","test"]', '--by', 'owner@example.test', '--reason', 'x']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.json.diagnostics[0].code).toBe('XFORGE_VERIFICATION_RETIRE_AMBIGUOUS');
    expect(ambiguous.json.diagnostics[0].message).toContain('--module');

    /* Naming the module resolves it, and withdraws exactly one. */
    const scoped = await runCli(root, ['verification', 'retire', '--gate-name', 'unit-tests', '--command', '["npm","test"]', '--module', 'root', '--by', 'owner@example.test', '--reason', 'x']);
    expect(scoped.code, JSON.stringify(scoped.json?.diagnostics)).toBe(0);
    const entries = (await yamlFile<any>(root, 'xforge/manifest.yaml')).verification['unit-tests'];
    expect(entries.filter((entry: any) => entry.retiredAt)).toHaveLength(1);
    expect(entries.find((entry: any) => entry.retiredAt).module).toBe('root');
  });

  it('requires a person and a reason, on the same terms as declare', async () => {
    const root = await twoDeclarations();
    const nameless = await runCli(root, ['verification', 'retire', '--gate-name', 'unit-tests', '--command', '["npm","test"]', '--reason', 'x']);
    expect(nameless.code).toBe(1);
    expect(nameless.json.diagnostics[0].code).toBe('XFORGE_VERIFICATION_ARGUMENTS_REQUIRED');
    expect(nameless.json.diagnostics[0].message).toContain('has to carry a name');
  });

  it('writes nothing under --dry-run', async () => {
    const root = await twoDeclarations();
    const dry = await runCli(root, [
      'verification', 'retire', '--gate-name', 'unit-tests', '--command', '["node","-e","process.exit(0)"]',
      '--by', 'owner@example.test', '--reason', 'x', '--dry-run',
    ]);
    expect(dry.code).toBe(0);
    /* The plan is reported and the file is not touched — the convention every other command follows. */
    expect(dry.json.changes.map((item: any) => item.path)).toEqual(['xforge/manifest.yaml']);
    const entries = (await yamlFile<any>(root, 'xforge/manifest.yaml')).verification['unit-tests'];
    expect(entries.some((entry: any) => entry.retiredAt)).toBe(false);
  });
});
