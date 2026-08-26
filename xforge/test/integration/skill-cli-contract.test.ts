import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { golden } from '../golden.js';
import { repositoryRoot } from '../helpers.js';

/**
 * Where a Skill tells an Agent to write, checked against where the CLI parses.
 *
 * `xforge-apply` said to transcribe a Reviewer's verbatim result into
 * `<change>/evidence/agents/<package>/review-<execution>.yaml`. Everything directly under that
 * directory with a `.yaml` extension is read as a delivery record, so the transcript was validated
 * as one — and a read-only review has no honest value in that envelope: `status` is
 * `succeeded|blocked|failed`, `changed_paths` is required and empty, `done_when_evidence` cannot be
 * produced. `blocked` pushed a succeeded package backwards; `succeeded` demanded evidence that
 * cannot exist. A live Major run spent six rounds locating it, including a bisect by moving files
 * out of the directory and back.
 *
 * Neither half was wrong on its own. The Skill named a reasonable path; the CLI parsed a reasonable
 * namespace; nothing compared them, because they live in different test worlds — one is prose the
 * suite never reads, the other is a glob the suite never enumerates. This reads both.
 *
 * The recording is the deliverable rather than a pass/fail alone: which paths the Skills instruct
 * and which namespaces the CLI claims are both facts worth seeing move.
 */
describe('Skill and CLI path contract', () => {
  /**
   * The globs the CLI uses to decide what a file *is*, by content of its directory.
   *
   * Only the ones that classify by location. A glob that reads a specific path (`change.yaml`) can
   * be pointed at safely; one that says "everything shaped like this here is a delivery" is a claim
   * over a namespace, and that is what a Skill can walk into.
   */
  const CLAIMED = [
    /*
     * `expects` is the filename shape the namespace is *for*, matched against the basename. It is what separates a Skill
     * legitimately naming where deliveries live from one instructing a different kind of file into
     * the same slot -- which is the whole defect: `review-<execution>.yaml` and `<execution>.yaml`
     * are both `.yaml` directly under the package directory, and only the second is a delivery.
     */
    { glob: 'evidence/agents/*/*.yaml', means: 'a work-package delivery record', expects: /^(?:<[^>]+>|\*)\.yaml$/, source: "'evidence/agents/*/*.yaml'" },
    { glob: 'evidence/agents/*/dispatch/*.json', means: 'a dispatch receipt', expects: /^(?:<[^>]+>|\*)\.json$/, source: "'evidence/agents/*/dispatch/*.json'" },
    { glob: 'evidence/agents/*/ack/*.json', means: 'an acknowledgement receipt', expects: /^(?:<[^>]+>|\*)\S*\.json$/, source: "'evidence/agents/*/ack/*.json'" },
    { glob: 'evidence/receipts/transitions/*.json', means: 'a transition receipt', expects: /^(?:<[^>]+>|\*|\d+)\.json$/, source: "TRANSITION_RECEIPTS_RELATIVE = 'evidence/receipts/transitions'" },
    { glob: 'evidence/review/ack/*.json', means: 'a Change-level review receipt', expects: /^(?:<[^>]+>|\*)\.json$/, source: "REVIEW_ACK_DIRECTORY = 'evidence/review'" },
  ];

  /** Turns a claimed glob into a matcher over the templates a Skill writes. */
  function claims(glob: string, template: string): boolean {
    const source = glob
      .split('/')
      .map((segment) => segment === '*' ? '[^/]+' : segment.replace(/\*/g, '[^/]*').replace(/\./g, '\\.'))
      .join('/');
    /* A Skill's `<placeholder>` stands for one path segment, which is what the CLI's `*` matches. */
    const concrete = template.replace(/<[^>/]+>/g, 'PLACEHOLDER');
    return new RegExp(`^${source}$`).test(concrete);
  }

  async function skillTemplates(): Promise<Array<{ skill: string; template: string }>> {
    const root = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'skills');
    const found: Array<{ skill: string; template: string }> = [];
    for (const skill of (await readdir(root)).sort()) {
      for (const file of (await readdir(path.join(root, skill))).filter((name) => name.endsWith('.md')).sort()) {
        const source = await readFile(path.join(root, skill, file), 'utf8');
        /* Paths the Skill instructs a write to, in the two spellings the Skills use. */
        for (const match of source.matchAll(/`(?:<change>\/|evidence\/)([A-Za-z0-9_<>./*-]+)`/g)) {
          const template = match[0].replace(/`/g, '').replace(/^<change>\//, '');
          if (!template.startsWith('evidence/')) continue;
          found.push({ skill: `${skill}/${file}`, template });
        }
      }
    }
    return found;
  }

  it('never instructs a write into a namespace the CLI parses as something else', async () => {
    const collisions: string[] = [];
    for (const { skill, template } of await skillTemplates()) {
      for (const claimed of CLAIMED) {
        if (!claims(claimed.glob, template)) continue;
        /* Inside the namespace is fine when it *is* what the namespace holds. */
        /* Matched on the basename: what distinguishes a delivery from a transcript in the same
           directory is the filename, and `review-<execution>.yaml` differs from `<execution>.yaml`
           exactly there. */
        if (claimed.expects.test(template.slice(template.lastIndexOf('/') + 1))) continue;
        collisions.push(`${skill} writes ${template}, which the CLI reads as ${claimed.means} (${claimed.glob})`);
      }
    }
    /*
     * Empty, not recorded. A Skill instructing a write into a parsed namespace is not a debt to
     * track — it is the defect, and the file it produces is refused or misread the first time
     * anybody follows the instruction.
     */
    expect(collisions.sort()).toEqual([]);
  });

  it('records the evidence paths the Skills instruct', async () => {
    const templates = [...new Set((await skillTemplates()).map(({ skill, template }) => `${template}  <- ${skill}`))].sort();
    expect(templates.length).toBeGreaterThan(3);
    const { actual, expected } = await golden('contracts/skill-evidence-paths.txt', `${templates.join('\n')}\n`);
    expect(actual).toBe(expected);
  });

  it('records the namespaces the CLI claims, so adding one is a decision', async () => {
    /*
     * The other half of the pair. A new glob here silently annexes a namespace some Skill may
     * already be writing into, and the collision check above is only as good as this list.
     */
    const { actual, expected } = await golden(
      'contracts/cli-claimed-namespaces.txt',
      `${CLAIMED.map((entry) => `${entry.glob}  ${entry.means}`).sort().join('\n')}\n`,
    );
    expect(actual).toBe(expected);

    /*
     * And the list is real. `source` names how the CLI actually spells each one, because three are
     * glob literals and two are assembled from a path constant -- deriving the string to look for
     * from the glob guessed wrong and asserted a substring that appears nowhere. Naming it means a
     * namespace renamed in the source fails here rather than silently leaving this list describing
     * a claim nobody makes any more.
     */
    const sources = await allSources(path.join(repositoryRoot, 'xforge', 'src'));
    for (const entry of CLAIMED) {
      expect(sources, entry.glob).toContain(entry.source);
    }
  });
});

async function allSources(directory: string): Promise<string> {
  let out = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) out += await allSources(absolute);
    else if (entry.name.endsWith('.ts')) out += await readFile(absolute, 'utf8');
  }
  return out;
}
