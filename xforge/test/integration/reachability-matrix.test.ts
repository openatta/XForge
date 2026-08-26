import { describe, expect, it } from 'vitest';
import { golden } from '../golden.js';
import { project, type FlowName } from '../project-builder.js';
import { runCli } from '../helpers.js';

/**
 * What each command can answer, at each Stage — recorded as a table.
 *
 * The question this exists for is not "does the command work" but "is the answer available here",
 * and the difference cost a live Major run a human approval. `archive` returns before it plans any
 * Spec mutation whenever a governance block is present, and both "the closing transition has not
 * happened" and "the closing approval is missing" are governance blocks — so `archive --dry-run`
 * structurally could not report a merge conflict until after somebody had signed. Nothing was
 * broken. The answer simply was not obtainable anywhere earlier, and no test asked whether it was.
 *
 * A matrix asks. Each cell records what the command produced at that Stage, reduced to the kinds of
 * thing a caller could act on, and the recording makes an answer that moves — or disappears —
 * visible as a diff rather than as a live run's bad afternoon.
 *
 * It is also the page `docs/cli-tool-usage.md` most wants and does not have.
 */
describe('reachability matrix', () => {
  /**
   * Read-only commands only.
   *
   * A command that writes would change the Stage it was measured at, so the row after it would be
   * measuring a different Change. `--dry-run` where the command offers one, nothing otherwise.
   */
  const COMMANDS: Array<{ name: string; argv: (change: string) => string[] }> = [
    { name: 'state', argv: (c) => ['state', '--change', c] },
    { name: 'check', argv: (c) => ['check', '--change', c] },
    { name: 'brief', argv: (c) => ['brief', '--change', c] },
    { name: 'audit verify', argv: (c) => ['audit', 'verify', '--change', c] },
    { name: 'draft-receipt', argv: (c) => ['verification', 'draft-receipt', '--change', c] },
    { name: 'archive --dry-run', argv: (c) => ['archive', '--change', c, '--dry-run'] },
  ];

  /**
   * What a caller could actually do with the result, rather than the result itself.
   *
   * Digests, timings and revisions differ every run and say nothing about availability; what
   * matters is whether the command answered, what kind of thing it answered with, and — when it
   * refused — what it refused about.
   */
  function cell(result: { code: number; json: any }): string {
    if (!result.json) return 'no envelope';
    if (result.json.ok === false) {
      const codes = [...new Set(result.json.diagnostics.filter((d: any) => d.severity === 'error').map((d: any) => d.code))].sort();
      return `refused: ${(codes as string[]).join(', ') || '(no code)'}`;
    }
    const data = result.json.data ?? {};
    const facts: string[] = [];
    if (data.change?.governance) facts.push(`stage=${data.change.governance.currentStage}`);
    if (Array.isArray(data.gates)) facts.push(`gates=${data.gates.length}`);
    if (data.decision) facts.push(`decision=${data.decision.applicable ? 'applicable' : 'none'}`);
    if (data.receipt) facts.push(`receipt=${(data.receipt.gates ?? []).length} gate(s)`);
    if (Array.isArray(data.specs)) facts.push(`specPlan=${data.specs.length}`);
    if (data.remoteDelivery) facts.push(`remoteDelivery=${data.remoteDelivery.required ? 'required' : 'optional'}`);
    const actions = (result.json.nextActions ?? []).map((item: any) => item.action).sort();
    if (actions.length > 0) facts.push(`next=${[...new Set(actions)].join('|')}`);
    return facts.join(' ') || 'ok';
  }

  it('records what every command answers at every Stage of every Flow', async () => {
    const rows: string[] = [];
    for (const flow of ['quick', 'solid', 'major'] as FlowName[]) {
      const stages = await stagesOf(flow);
      for (const stage of stages) {
        const built = await project().flow(flow).atStage(stage).build();
        for (const command of COMMANDS) {
          const result = await runCli(built.root, command.argv(built.change));
          rows.push(`${flow.padEnd(6)} ${stage.padEnd(18)} ${command.name.padEnd(18)} ${cell(result)}`);
        }
      }
    }
    const { actual, expected } = await golden('reachability/matrix.txt', `${rows.join('\n')}\n`);
    expect(actual).toBe(expected);
  }, 1_800_000);

  it('shows that the Spec merge plan is unobtainable from archive before the approval', async () => {
    /*
     * The cell that cost the approval, asserted rather than left for a reader to find in the table.
     * `archive --dry-run` at `ready-to-archive` with the closing approval still missing returns on
     * the governance block and never reaches `planSpecMutations` — so the merge conflict it would
     * have found is not available from this command at any earlier point.
     */
    const built = await project().flow('quick').atStage('verify').build();
    await runCli(built.root, ['check', '--change', built.change]);
    const early = await runCli(built.root, ['archive', '--change', built.change, '--dry-run']);
    expect(early.json.ok).toBe(false);
    expect(early.json.data?.specs ?? []).toEqual([]);

    /* And that `check` answers it instead, which is why the check-time validation exists. */
    const checked = await runCli(built.root, ['check', '--change', built.change]);
    expect(checked.json.ok).toBe(true);
  }, 300_000);
});

async function stagesOf(flow: FlowName): Promise<string[]> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { parse } = await import('yaml');
  const { repositoryRoot } = await import('../helpers.js');
  const source = await readFile(path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'flows', `${flow}.yaml`), 'utf8');
  const parsed = parse(source) as { stages: Array<{ id: string }> };
  return [...parsed.stages.map((stage) => stage.id), 'ready-to-archive'];
}
