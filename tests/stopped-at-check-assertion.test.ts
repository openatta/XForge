import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertStoppedAtCheck } from './live-engine/assert-stopped-at-check.mjs';

/**
 * The assertion that decides whether Major's `stopped-at-check` is a legitimate pass.
 *
 * It could not pass. Both of its `readdirSync` call sites were used here and imported nowhere, and
 * both sit inside a `try` — so the ReferenceError was caught and each silently took its failure
 * branch, reporting that Propose "never produced specs/(star)(star)/(star).md" with the Spec sitting
 * right there, and that the approval policy held zero receipts when it held a signed one. Two
 * fabricated problems, on every run that reached it.
 *
 * Nothing noticed because nothing reaches it: quick and solid archive, and only Major stops at check
 * — which its own README calls the common and intended outcome. So the mechanism written to score
 * that outcome had never scored it correctly, and a live run costs about seventeen dollars to find
 * out. A directory tree costs nothing.
 */
const FLOW = {
  stages: [
    { id: 'propose', produces: ['proposal', 'delta-specs'] },
    { id: 'check', produces: ['check-report'], exit: { approvals: ['implementation-major'] } },
    { id: 'apply', produces: [] },
  ],
  artifacts: [
    { id: 'proposal', generates: 'proposal.md' },
    { id: 'delta-specs', generates: 'specs/**/*.md' },
    { id: 'check-report', generates: 'check-report.md' },
  ],
  governance: { approvalPolicies: [{ id: 'implementation-major', minApprovers: 1, roles: ['owner'] }] },
};

function project(options: { spec?: boolean; receipt?: boolean; findingPath?: string; gateStdout?: string } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'stopped-at-check-'));
  const change = path.join(root, 'xforge', 'changes', 'credential-store');
  mkdirSync(change, { recursive: true });
  writeFileSync(path.join(change, 'proposal.md'), '## Why\nBecause.\n');
  writeFileSync(path.join(change, 'check-report.md'), '## Completeness\nDone.\n');

  if (options.spec !== false) {
    /* A glob Artifact: the Change cannot know its Spec filenames in advance, so the Flow declares a
       pattern and the check has to walk for it rather than stat it. */
    mkdirSync(path.join(change, 'specs', 'store'), { recursive: true });
    writeFileSync(path.join(change, 'specs', 'store', 'spec.md'), '## ADDED Requirements\n');
  }
  if (options.receipt !== false) {
    const approvals = path.join(change, 'approvals', 'implementation-major');
    mkdirSync(approvals, { recursive: true });
    /* The receipt shape the CLI writes: the role sits under `approver`, not at the top level. */
    writeFileSync(path.join(approvals, 'a.json'), JSON.stringify({ decision: 'approve', approver: { role: 'owner' } }));
  }
  const findings = { findings: [{ id: 'F-1', severity: 'blocker', status: 'open', refs: [options.findingPath ?? 'proposal.md'] }] };
  mkdirSync(path.join(change, 'evidence'), { recursive: true });
  writeFileSync(path.join(change, 'evidence', 'check-findings.yaml'), JSON.stringify(findings));
  /*
   * The Gate's own Evidence, because the criterion reads it rather than deciding again.
   *
   * `assertStoppedAtCheck` asks the check-findings Gate whether a blocker cites something real --
   * one source of truth for what counts as a citation, instead of a second copy that drifts when
   * the first widens. It only ever runs after the Check Stage's Gates, so this file exists in every
   * state it is asked about; a fixture without it modelled a run that cannot happen. `gateStdout`
   * lets a case plant the warning the Gate would have written.
   */
  writeFileSync(path.join(change, 'evidence', 'check-findings.json'), JSON.stringify({
    gate: 'check-findings', change: 'credential-store', status: 'failed', exitCode: 1,
    stdout: options.gateStdout ?? '', stderr: 'blocking finding(s) still open.',
  }));
  return root;
}

/** Returns the blockers on success; throws listing every problem otherwise. */
const run = (root: string) => assertStoppedAtCheck({
  projectRoot: root, changeId: 'credential-store', flowDefinition: FLOW as never,
  checkStage: FLOW.stages[1] as never, scenarioName: 'major',
});
const problemsOf = (root: string): string => {
  try { run(root); return ''; } catch (error) { return (error as Error).message; }
};

describe('scoring a Major run that stopped at Check', () => {
  /**
   * The criterion reads the Gate's verdict instead of deciding again, so it has to still fail when
   * the Gate does complain -- otherwise the change traded a wrong answer for no answer.
   *
   * A criterion that passes because it stopped looking is worse than one that fails, and this is
   * the shape that would hide it: the refs check moved from `existsSync` to reading Evidence, and
   * Evidence that says nothing looks exactly like Evidence that approves.
   */
  it('still fails when the Gate says a blocker cites nothing real', () => {
    const root = project({
      spec: true,
      receipt: true,
      gateStdout: 'warning: evidence/check-findings.yaml: finding F-1 refs "no-such-thing", which is neither a Requirement this Change declares nor a path that exists.',
    });
    expect(problemsOf(root)).toContain('no-such-thing');
  });

  it('accepts the intended outcome: every Stage produced its Artifacts and the approval holds', () => {
    expect(run(project()).blockers.map((b: any) => b.id)).toEqual(['F-1']);
  });

  it('finds a glob Artifact that really is there, instead of reporting it missing', () => {
    /* The exact false problem the broken version produced on every run. */
    expect(problemsOf(project())).toBe('');
  });

  it('reports a Stage that genuinely produced nothing', () => {
    expect(problemsOf(project({ spec: false }))).toContain('propose never produced specs/**/*.md');
  });

  it('counts approval receipts that exist, and reports a policy that is genuinely unsigned', () => {
    expect(problemsOf(project({ receipt: false }))).toContain('implementation-major holds 0 approval receipts');
  });
});
