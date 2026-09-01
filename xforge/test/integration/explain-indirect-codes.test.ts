import { describe, expect, it } from 'vitest';
import { fixture, runCli } from '../helpers.js';

/**
 * What `explain` can say about a code the product raises indirectly.
 *
 * `core/reconcile/rules.ts` and several others build a diagnostic as data — `{ code, summary }` or
 * `{ code, message }` — and hand it to `diagnostic()` somewhere else. The catalogue scan records the
 * code from the literal and recorded the message as the empty string, so every one of those codes
 * explained itself as nothing at all. `xforge-apply` tells an Agent that explain "gives that code's
 * severity and every message it can carry"; a hand-driven run asked about one and got a blank.
 *
 * The text still carries its `${...}` interpolations, because the values are computed. A reader
 * learns far more from the shape than from silence, and the interpolations are where the specifics
 * go. The scan stays deliberately near the code it started at: past a short window it stops being a
 * correction and starts reporting a neighbour's sentence, which is worse than reporting none.
 */
describe('explaining an indirectly raised code', () => {
  it('carries the sentence the reader will meet, not an empty string', async () => {
    const root = await fixture();
    const result = await runCli(root, ['explain', 'XFORGE_RECONCILE_OBSERVABILITY_UNVERIFIED']);
    expect(result.json.ok).toBe(true);
    const sources = ((result.json.data as any).messages ?? []) as any[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0].message, 'the code explains itself as nothing').not.toBe('');
    expect(sources[0].message).toContain('unit-tests Gate Evidence');
  });

  it('does the same for a code built as a remedy object rather than an observation', async () => {
    const root = await fixture();
    const result = await runCli(root, ['explain', 'XFORGE_CONDITION_LEDGER_STALE_REMEDY']);
    const sources = ((result.json.data as any).messages ?? []) as any[];
    expect(sources[0]?.message ?? '', 'the stale-ledger remedy explains itself as nothing').not.toBe('');
    /* The sentence that stops a reader re-dating a decision nobody re-made. */
    expect(sources[0].message).toContain('records an answer nobody gave');
  });

  it('leaves most of the indirect family explicable', async () => {
    const root = await fixture();
    const listed = await runCli(root, ['explain', 'XFORGE_RECONCILE_REQUIREMENT_UNANCHORED']);
    expect(((listed.json.data as any).messages ?? [])[0]?.message ?? '').not.toBe('');
  });
});
