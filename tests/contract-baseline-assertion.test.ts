import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertContractBaselineAdvanced } from './live-engine/assert-contract-baseline.mjs';

/**
 * The live-engine's contract assertion, exercised without a live engine.
 *
 * It was written and shipped having never run. Nothing in the static suites archives a
 * contract-governed Flow, so the one code path that calls it was unreachable here, and it went to a
 * real run carrying a `flowDefinition` that does not exist in that scope and a `readdirSync` that
 * was imported nowhere in the file. The run spent every one of its model stages and then died on the
 * line after the archive, producing no verdict at all.
 *
 * That is the whole reason this file exists. The assertion reads a directory tree and returns a
 * verdict; a directory tree costs nothing to build, so there was never a good reason for it to be
 * decided only by a run that costs money and takes an hour.
 */
function project(baseline: string[], declared: string[]): { projectRoot: string; changeId: string; scenarioName: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'contract-assert-'));
  const changeId = 'order-cancel';

  mkdirSync(path.join(root, 'xforge', 'contracts'), { recursive: true });
  writeFileSync(
    path.join(root, 'xforge', 'contracts', 'http.md'),
    `# http\n\n## Elements\n\n${baseline.map((id) => `### Element: ${id}\n\n- module: api\n`).join('\n')}`,
  );

  const archived = path.join(root, 'xforge', 'changes', 'archive', `2026-08-31-${changeId}`, 'contracts');
  mkdirSync(archived, { recursive: true });
  writeFileSync(
    path.join(archived, 'http.md'),
    `## ADDED Contract Elements\n\n${declared.length === 0 ? '(none)\n' : declared.map((id) => `### Element: ${id}\n\n- module: api\n`).join('\n')}`,
  );
  return { projectRoot: root, changeId, scenarioName: 'solid-contract' };
}

describe('the live-engine assertion that the contract baseline advanced', () => {
  it('passes when the baseline records everything the delta declared', () => {
    const result = assertContractBaselineAdvanced(project(
      ['openapi:paths./orders.get', 'openapi:paths./orders/{id}/cancel.post'],
      ['openapi:paths./orders/{id}/cancel.post'],
    ));
    expect(result.declaredAdds).toEqual(['openapi:paths./orders/{id}/cancel.post']);
    expect(result.recorded).toContain('openapi:paths./orders/{id}/cancel.post');
  });

  it('fails when the Change archived and the baseline never moved', () => {
    /*
     * The defect this exists for. A Flow can declare a contract-delta Artifact, collect one every
     * Change, and merge none of them — both halves valid on their own, and the Change archives
     * perfectly either way. An outcome check cannot see it; only the record can.
     */
    expect(() => assertContractBaselineAdvanced(project(
      ['openapi:paths./orders.get'],
      ['openapi:paths./orders/{id}/cancel.post'],
    ))).toThrow(/did not merge/);
  });

  it('fails when the archived Change declared no interface change at all', () => {
    /* A run that declared nothing proves nothing about a baseline advancing, and must not pass by
       being trivially consistent with a baseline that also did not move. */
    expect(() => assertContractBaselineAdvanced(project(['openapi:paths./orders.get'], [])))
      .toThrow(/declares no ADDED element/);
  });

  it('fails when no archived directory exists for the Change', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'contract-assert-'));
    mkdirSync(path.join(root, 'xforge', 'changes', 'archive'), { recursive: true });
    expect(() => assertContractBaselineAdvanced({ projectRoot: root, changeId: 'order-cancel', scenarioName: 'solid-contract' }))
      .toThrow(/No archived directory/);
  });
});
