import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const flow = (relative: string) => parse(readFileSync(path.join(repositoryRoot, relative), 'utf8')) as Record<string, unknown>;

/**
 * `solid-contract` is `solid` plus four Gates, and this pins the "plus".
 *
 * The other three shipped Flows nest — `quick ⊂ solid ⊂ major` holds on artifacts, stages and
 * gates — so the text they share is the tier increment expressing itself, and it cannot drift: a
 * Stage major adds is a Stage solid does not have. `solid-contract` is not a tier. It sits at the
 * same `assuranceLevel`, declares the same artifacts and the same Stages, and differs only by the
 * four `builtin: declared` contract Gates and where they hang. That makes it the one shipped Flow
 * that is a *sibling copy*, and a sibling copy drifts.
 *
 * It already had. `solid`'s check-report was rewritten to name the finding ids rather than restate
 * them, and its assurance instruction grew from one sentence to a Requirement-by-Requirement
 * coverage table; `solid-contract` carried the superseded text of both for as long as the two files
 * existed, and nothing reported it. This test is what would have.
 *
 * Adding a difference here is allowed and expected — the point is that adding one is a decision
 * somebody records, not something that happens by omission.
 */
const EXPECTED_DIVERGENCE = new Set([
  /* Its own identity. */
  'metadata.name',
  'metadata.version',
  'metadata.description',
  /*
   * The delta is owed by every Change on this Flow rather than only by one declaring an interface
   * change: a project adopts `solid-contract` precisely because its interfaces are governed, so the
   * question "does this Change touch one" is answered by the adoption, not per Change.
   */
  'artifacts.3.requiredWhen',
  'artifacts.3.instruction',
  'stages.2.exit.conditions.contractDecisions',
  /* The four Gates and where each hangs: lint at design, compat at check, drift and boundaries at verify. */
  'stages.1.gates',
  'stages.2.gates.3',
  'stages.4.gates.2',
  'stages.4.gates.3',
]);

function divergence(left: unknown, right: unknown, at = ''): string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return [at];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => divergence(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
    at ? `${at}.${key}` : key,
  ));
}

describe('solid-contract as a delta over solid', () => {
  it('differs from solid only where the contract feature requires it', () => {
    const found = divergence(
      flow('scaffold/payload/xforge/flows/solid.yaml'),
      flow('scaffold/payload/xforge/scaffold/flows/solid-contract.yaml'),
    ).sort();

    const unexpected = found.filter((entry) => !EXPECTED_DIVERGENCE.has(entry));
    expect(unexpected, [
      'solid-contract has drifted from solid at a field the contract feature does not explain.',
      'Either carry the change across, or add the path to EXPECTED_DIVERGENCE with the reason.',
    ].join(' ')).toEqual([]);

    /* And the reverse: a divergence that stops existing means the list is stale and now hides a
       real one. Both directions have to be checked or the list rots into an allowlist. */
    const vanished = [...EXPECTED_DIVERGENCE].filter((entry) => !found.includes(entry)).sort();
    expect(vanished, 'EXPECTED_DIVERGENCE names differences that no longer exist; remove them.').toEqual([]);
  });

  it('is a sibling of solid, not a tier above it', () => {
    const solid = flow('scaffold/payload/xforge/flows/solid.yaml') as any;
    const contract = flow('scaffold/payload/xforge/scaffold/flows/solid-contract.yaml') as any;

    /* If either of these ever stops holding, `solid-contract` has become a tier and the whole
       premise of this file — that it is a copy which can drift — needs revisiting. */
    expect(contract.policy.assuranceLevel).toBe(solid.policy.assuranceLevel);
    expect(contract.artifacts.map((a: any) => a.id)).toEqual(solid.artifacts.map((a: any) => a.id));
    expect(contract.stages.map((s: any) => s.id)).toEqual(solid.stages.map((s: any) => s.id));
  });
});
