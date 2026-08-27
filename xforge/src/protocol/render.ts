/**
 * Shared rendering for the `--text` form.
 *
 * `present()` in `envelope.ts` decides *whether* a command renders; this holds the pieces the
 * renderers themselves share. Two copies of `wrap` existed before it, and they were not identical:
 * one collapsed runs of whitespace before wrapping and `state`'s did not, which is a
 * difference nobody chose — the second was written by copying the first and dropping a line. The
 * collapsing version is kept, because the text being wrapped is quoted from Artifacts and ledgers
 * where a newline inside a paragraph is an authoring accident rather than a layout instruction.
 */

/**
 * Wraps at `width`, prefixing every line with `indent`.
 *
 * A long word goes on its own line rather than being broken: this text carries Requirement ids and
 * file paths, and cutting one mid-token would corrupt an identifier that readers grep for. A
 * CJK-heavy line has almost no spaces, so it wraps at whole tokens or not at all — accepted, on the
 * same reasoning: a break in the wrong place costs more than a long line.
 */
export function wrap(text: string, width: number, indent: string): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && `${current} ${word}`.length > width) {
      lines.push(indent + current);
      current = word;
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(indent + current);
  return lines;
}
