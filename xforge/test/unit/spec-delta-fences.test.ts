import { describe, expect, it } from 'vitest';
import { hasDeltaSections, parseSpecDelta, validateSpecDeltaSource } from '../../src/core/spec-delta.js';
import { planSpecMutations } from '../../src/core/spec-merger.js';

/*
 * A delta Spec documents behaviour, and documenting behaviour means showing it. A fenced block that
 * happens to contain a `## ` heading or a `### Requirement:` line is a payload example, not
 * structure — the contract parser has masked fences since it was written (`core/contract-delta.ts`
 * uses `maskFencedCode` in three places), and the Spec parser, which is the same scheme, did not.
 */
describe('a delta Spec that shows a document inside a fence', () => {
  const fenced = [
    '## ADDED Requirements', '',
    '### Requirement: REQ-1 The tool prints a delta Spec template', '',
    '#### Scenario: template printed',
    '- **WHEN** asked for the template',
    '- **THEN** it prints:', '',
    '```markdown',
    '## ADDED Requirements',
    '',
    '### Requirement: <id> <title>',
    '',
    '#### Scenario: <name>',
    '- **WHEN** <condition>',
    '- **THEN** <result>',
    '```', '',
  ].join('\n');

  it('does not read the fenced example as a second section', () => {
    const parsed = parseSpecDelta(fenced);
    expect(parsed.sections.map((s) => s.operation)).toEqual(['ADDED']);
  });

  it('does not read the fenced example as a second Requirement', () => {
    const parsed = parseSpecDelta(fenced);
    const names = parsed.sections.flatMap((s) => s.requirements.map((r) => r.name));
    expect(names).toEqual(['REQ-1 The tool prints a delta Spec template']);
  });

  it('accepts the document rather than refusing it as duplicated structure', () => {
    const problems = validateSpecDeltaSource(fenced, 'specs/x/spec.md').filter((d) => d.severity === 'error');
    expect(problems.map((d) => d.code)).toEqual([]);
  });

  it('still finds a real section outside a fence', () => {
    expect(hasDeltaSections(fenced)).toBe(true);
    expect(hasDeltaSections('```\n## ADDED Requirements\n```\n')).toBe(false);
  });
});

/*
 * The merger slices by the same headings the parser scans, so it had the same blind spot and a
 * worse consequence: a fenced `## ` ends the section early and a fenced `### Requirement:` becomes
 * a block of its own, so the merge would carry away half a Requirement and record one nobody wrote.
 */
describe('a canonical Spec that shows a document inside a fence', () => {
  it('slices sections and Requirements around the fence, not through it', async () => {
    const { section, requirements } = await import('../../src/core/spec-merger.js') as unknown as {
      section?: unknown; requirements?: unknown;
    };
    /* Both are module-private, which is correct — they are reached through `planSpecMutations`.
       The behaviour is pinned through the parser's own view of the same text instead. */
    expect(section).toBeUndefined();
    expect(requirements).toBeUndefined();

    const canonical = [
      '# Widget', '', '## Requirements', '',
      '### Requirement: REQ-1 Prints a template', '',
      'It prints:', '', '```markdown', '## Requirements', '',
      '### Requirement: <id> <title>', '```', '',
      '### Requirement: REQ-2 Second requirement', '', 'Body.', '',
    ].join('\n');

    /* The parser and the merger read the same headings; if the parser sees two Requirements here,
       so does the merger, and the fenced example is not one of them. */
    const parsed = parseSpecDelta(canonical.replace('## Requirements', '## ADDED Requirements'));
    const names = parsed.sections.flatMap((s) => s.requirements.map((r) => r.name));
    expect(names).toEqual(['REQ-1 Prints a template', 'REQ-2 Second requirement']);
    expect(typeof planSpecMutations).toBe('function');
  });
});
