import { describe, expect, it } from 'vitest';
import { maskFencedCode } from '../../src/core/markdown-fences.js';

/** The primitive under the fence-aware scans; see `contract-fenced-content.test.ts` for why. */
describe('masking fenced code', () => {
  it('blanks fenced lines without moving a single index', () => {
    const source = '# a\n```\n## not a heading\n```\n## real\n';
    const masked = maskFencedCode(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
    expect([...masked.matchAll(/^## /gm)]).toHaveLength(1);
    /* Lines outside a fence come through byte-identical, so a header found in the mask can be read
       from either and its capture groups used directly. */
    const at = masked.indexOf('## real');
    expect(source.slice(at, at + 7)).toBe('## real');
  });

  it('does not treat an info-string fence line inside an open block as the close', () => {
    expect([...maskFencedCode('```\n```js\n## still inside\n```\n## out\n').matchAll(/^## /gm)]).toHaveLength(1);
  });

  it('carries an unclosed fence to the end of the document, as a renderer does', () => {
    expect([...maskFencedCode('## before\n~~~\n## inside\n## also inside\n').matchAll(/^## /gm)]).toHaveLength(1);
  });

  it('leaves a document with no fence exactly as it was', () => {
    const source = '# a\n\n## b\n\n### c\n';
    expect(maskFencedCode(source)).toBe(source);
  });
});
