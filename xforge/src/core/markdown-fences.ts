/**
 * Header scanning that a fenced code block cannot fool.
 *
 * The Spec and contract documents are markdown that a person and an Agent both write, and the
 * natural way to document a payload is to show it -- inside a fence, where a line beginning `## `
 * or `### ` is content rather than structure. Every scanner here reads structure off a bare
 * `^## `-style regex, so the first such line inside a fence was read as the end of the section.
 *
 * On the contract side that was silent, and it lost data. A baseline whose first element documents
 * a markdown response reported one element where the file held three (`xforge contract list`); the
 * merger then refused to modify an element the baseline plainly records, saying "the baseline does
 * not record it"; and the refusal's own remedy -- declare it under ADDED -- was accepted with no
 * conflict, which writes a second block carrying an id the baseline already held.
 *
 * The Spec parsers share the blindness and are saved by validation rather than by the scan: a
 * Requirement whose `#### Scenario:` block fell inside the swallowed region is refused outright,
 * so the author meets a confusing error instead of a silent loss. Confusing is still wrong, and it
 * is the same one-line cause, so they read through here too.
 */

/**
 * The same text with every fenced-code line blanked, preserving length, line count and every index.
 *
 * A match found in the mask therefore addresses the same position in the original: callers scan the
 * mask and slice the source. Lines outside a fence are copied through unchanged, so a header the
 * scan does find is byte-identical in both and its capture groups can be used directly.
 */
export function maskFencedCode(source: string): string {
  let masked = '';
  let open: string | null = null;
  for (const match of source.matchAll(/[^\n]*\n?/g)) {
    const chunk = match[0];
    if (chunk === '') continue;
    const line = chunk.replace(/\r?\n$/, '');
    const terminator = chunk.slice(line.length);
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (open === null) {
      if (!fence) { masked += chunk; continue; }
      open = fence[1]!;
    } else if (fence && fence[1]![0] === open[0] && fence[1]!.length >= open.length && fence[2]!.trim() === '') {
      /* CommonMark: a fence closes only on the same character, at least as long, and carrying no
         info string. A ```js line inside an open block is content, not a close. */
      open = null;
    }
    masked += ' '.repeat(line.length) + terminator;
  }
  /* An unclosed fence runs to the end of the document, which is what a renderer does with it too. */
  return masked;
}
