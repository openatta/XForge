import type { Envelope } from '../types.js';

/**
 * `--field`: taking one value out of an Envelope by a dotted path.
 *
 * Protocol rather than CLI, because what it addresses is the Envelope — `data` first, then the
 * envelope's own members, so `diagnostics` and `nextActions` are reachable by the same syntax. It
 * exists because the alternative people reached for was `grep` over the JSON, which returns a
 * confident wrong answer whenever a field name repeats: `contentRevision` appears once per
 * historical receipt in `xforge state`, and a line-oriented match reports whichever came first.
 */

/**
 * One value out of an Envelope's `data`, addressed by a dotted path.
 *
 * Array indices are plain segments (`readyTransitions.0.to`). The walk reports *where* it stopped
 * rather than a bare miss, because the whole point is to be told when the path is wrong instead of
 * receiving an empty string that a shell will happily assign to a variable.
 */
function resolveField(data: unknown, path: string): { found: true; value: unknown } | { found: false; reason: string } {
  let current: unknown = data;
  const walked: string[] = [];
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return { found: false, reason: `${walked.length ? walked.join('.') : 'data'} is ${current === null ? 'null' : typeof current}, which has no "${segment}".` };
    }
    const container = current as Record<string, unknown>;
    /* `hasOwnProperty`, not `in`: `in` walks the prototype chain, so `--field constructor` answered
       with `function Object() { [native code] }` — a confident value for a path the data does not
       contain, which is the exact failure this option exists to remove. */
    if (!Object.prototype.hasOwnProperty.call(container, segment)) {
      const available = Object.keys(container).slice(0, 12);
      /*
       * Where the name *does* live, when it lives one level down.
       *
       * Two live runs asked for `mandatoryGateEvidence` and got "data has no mandatoryGateEvidence
       * (it has: project, scaffold, …, change)" -- true, and one level short of useful: it is
       * `change.mandatoryGateEvidence`, and the key list printed the container it is inside. The
       * all-or-nothing rule means that guess costs every other field asked for in the same call, so
       * the round trip is not free. One level only: past that the search stops being a correction
       * and starts being a different question.
       */
      const nested = Object.keys(container).find((key) => {
        const child = container[key];
        return child !== null && typeof child === 'object'
          && Object.prototype.hasOwnProperty.call(child as object, segment);
      });
      const hint = nested ? ` Did you mean ${[...walked, nested, segment].join('.')}?` : '';
      return { found: false, reason: `${walked.length ? walked.join('.') : 'data'} has no "${segment}"${available.length ? ` (it has: ${available.join(', ')})` : ''}.${hint}` };
    }
    current = container[segment];
    walked.push(segment);
  }
  return { found: true, value: current };
}

/**
 * One value out of an Envelope, `data` first.
 *
 * `data` is what a caller almost always means, and it stays the default so `--field changes` --
 * a name both levels carry -- keeps resolving to `data.changes` for every existing caller. But the
 * Skills tell a Stage to consume the ready Action for the current revision, and `nextActions` is a
 * sibling of `data` rather than a member of it. Addressing only `data` meant the one thing a Stage
 * was told to read was the one thing it could not ask for, so it fetched the whole envelope
 * instead: 23 of 32 `state` calls in a solid run did exactly that.
 *
 * A miss reports the `data` walk, not the envelope walk, because that is the level the caller meant.
 */
export function resolveEnvelopeField(result: Envelope, path: string): { found: true; value: unknown } | { found: false; reason: string } {
  const inData = resolveField(result.data, path);
  if (inData.found) return inData;
  const head = path.split('.')[0]!;
  if (Object.prototype.hasOwnProperty.call(result, head)) return resolveField(result, path);
  return inData;
}