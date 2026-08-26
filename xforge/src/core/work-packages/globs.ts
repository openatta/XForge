/**
 * How a declared write boundary is matched against a changed path.
 *
 * Its own dialect, and deliberately narrower than the one `core/governance.ts` applies to
 * PermissionPolicy patterns: `*` and `**` are honoured and every other character is literal. The two
 * fail in opposite directions — a policy that matches too little fails open, a write boundary that
 * matches too little fails closed — which is why they are not one implementation, and why
 * `test/unit/path-semantics.test.ts` feeds both the same inputs and records where they part.
 *
 * The characters this dialect cannot honour are refused at plan time rather than matched literally;
 * see the `write_paths` validation in `core/work-packages.ts`.
 */

const GLOB_MAGIC = /[*?{}[\]]/;
export const UNSUPPORTED_GLOB_MAGIC = /[?{}[\]]/;

export function hasMagic(pattern: string): boolean {
  return GLOB_MAGIC.test(pattern);
}

export function staticPrefix(pattern: string): string {
  const segments = pattern.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/') || '.';
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (character === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    source += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
    index += 1;
  }
  return new RegExp(`${source}$`);
}

/**
 * Whether a changed path falls inside a declared write boundary.
 *
 * Exported for the differential test that compares it with `core/governance.ts`'s two matchers:
 * three implementations of "does this path match this glob" live in this package, and the only
 * honest way to hold them together is to feed them the same inputs and record where they part.
 */
export function matchesWritePath(filePath: string, pattern: string): boolean {
  return globRegex(pattern).test(filePath);
}
