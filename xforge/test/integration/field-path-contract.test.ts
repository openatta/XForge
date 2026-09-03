import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, repositoryRoot, runCli } from '../helpers.js';

/**
 * Every `--field <path>` the product instructs, resolved against a real project.
 *
 * This was the one thing a Skill says that nothing checked. Commands were covered, flags were
 * covered, evidence paths were covered, classification keys were covered — and the dotted paths,
 * which are the most fragile of the lot, were not. `--field` is all-or-nothing by design: one path
 * that does not resolve fails the whole call and returns none of the values, so a stale path in a
 * Skill costs an Agent the entire reply and reads as the CLI refusing.
 *
 * A measured run wrote `--field stage --field gates` against `state`, which carries neither, and got
 * exactly that. That one was invented rather than instructed; this makes sure the instructed ones
 * cannot become invented by drift.
 */
describe('instructed --field paths resolve', () => {
  async function instructedPaths(): Promise<Array<{ path: string; source: string; command: 'state' | 'check' }>> {
    const found: Array<{ path: string; source: string; command: 'state' | 'check' }> = [];
    const roots = [
      path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'skills'),
      path.join(repositoryRoot, 'scaffold', 'payload', 'xforge'),
    ];
    const documents: Array<{ label: string; text: string }> = [];
    for (const skill of (await readdir(roots[0]!)).sort()) {
      for (const file of (await readdir(path.join(roots[0]!, skill))).filter((name) => name.endsWith('.md'))) {
        documents.push({ label: `${skill}/${file}`, text: await readFile(path.join(roots[0]!, skill, file), 'utf8') });
      }
    }
    for (const file of ['XFORGE.md', 'XFORGE_cn.md']) {
      documents.push({ label: file, text: await readFile(path.join(roots[1]!, file), 'utf8') });
    }
    for (const { label, text } of documents) {
      /*
       * Which command a path belongs to is read from the line, not assumed. `gates` resolves on
       * `check` and nowhere else, and a test that ran every path against `state` would report the
       * product's own correct instruction as a defect. Prose names a path outside a full command
       * line often enough -- "--field change.governance.currentStage prints one string" -- that
       * scoping is taken from the path itself rather than from whether `--change` happens to sit on
       * the same line.
       */
      for (const line of text.split('\n')) {
        const command = /xforge\s+check\b/.test(line) ? 'check' as const : 'state' as const;
        for (const match of line.matchAll(/--field\s+([A-Za-z][\w.]*)/g)) {
          found.push({ path: match[1]!, source: label, command });
        }
      }
    }
    return found;
  }

  it('never instructs a --field path the CLI cannot resolve', async () => {
    const paths = await instructedPaths();
    expect(paths.length).toBeGreaterThan(5);

    const root = await fixture();
    await createCompleteSolidChange(root);
    const problems: string[] = [];
    for (const entry of [...new Map(paths.map((item) => [`${item.path}:${item.command}`, item])).values()]) {
      /* Anything under `change.` needs a Change named, whatever the surrounding line looked like. */
      const scoped = entry.command === 'check' || entry.path === 'change' || entry.path.startsWith('change.');
      const args = scoped
        ? [entry.command, '--change', 'add-feature', '--field', entry.path]
        : [entry.command, '--field', entry.path];
      const result = await runCli(root, args);
      /*
       * The exit code, not the parsed envelope. A single `--field` that resolves to a string prints
       * the bare value and nothing else -- which is deliberate, so `$(xforge state --field ...)` is
       * safe -- and that reply is not JSON. Parsing it is the mistake this very test was written
       * after making twice elsewhere.
       */
      if (result.code !== 0) {
        problems.push(`${entry.source} instructs ${entry.command} --field ${entry.path}, which the CLI refused: ${result.stdout.slice(0, 200)}`);
      }
    }
    expect([...new Set(problems)].sort()).toEqual([]);
  }, 600_000);
});
