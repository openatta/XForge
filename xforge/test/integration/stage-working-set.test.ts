import { describe, expect, it } from 'vitest';
import { CHECK_FINDINGS_PATH } from '../../src/core/check-findings.js';
import { CONSTITUTION_CHECK_PATH } from '../../src/core/constitution-check.js';
import { approveCurrentRevision, changeYaml, checkFindings, constitutionLedger, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/**
 * The working set has to be sufficient in one call, and has to stop there.
 *
 * Both halves are the requirement. Sufficient, because the command exists to end the round trips:
 * twelve measured Stages spent 70% of their calls opening the files a previous reply had merely
 * named. Bounded, because the same argument that justifies sending the text forbids sending text
 * nobody asked for -- a reply is paid for whether or not it is read, and "send everything" is not a
 * design, it is the absence of one.
 *
 * So the Action defines the boundary. What the ready Action declares as its inputs arrives with its
 * content; what it does not declare does not.
 */
describe('xforge stage working set', () => {
  it('carries the text of every input the ready Action declares', async () => {
    const root = await fixture();
    /* A Change stopped part-way, because a finished one has no next Artifact and so no inputs to
       be sufficient about. With the Proposal written, `delta-specs` is ready and declares it. */
    await write(root, 'xforge/changes/add-feature/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/add-feature/proposal.md', '## Why\nTest\n\n## Flow choice\nsolid\n');

    const stage = await runCli(root, ['stage', '--change', 'add-feature']);
    expect(stage.code).toBe(0);
    const data = stage.json.data as any;
    expect(data.action, JSON.stringify(data, null, 2)).toBeTruthy();

    const withText = new Map((data.read as Array<{ path: string; text?: string }>)
      .filter((entry) => typeof entry.text === 'string')
      .map((entry) => [entry.path, entry.text!]));
    for (const input of data.action.inputs as string[]) {
      expect(withText.has(input), `${input} was declared an input of the ready Action and arrived without its text`).toBe(true);
      expect(withText.get(input)!.length).toBeGreaterThan(0);
    }
  });

  it('inlines nothing outside the plan it computed', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const stage = await runCli(root, ['stage', '--change', 'add-feature']);
    const data = stage.json.data as any;

    /* Vouched files are the ones a digest stands in for. A voucher that also shipped the text would
       be the plan contradicting itself. */
    for (const entry of data.vouched as Array<Record<string, unknown>>) {
      expect(entry).not.toHaveProperty('text');
      expect(entry.digest).toBeTruthy();
    }
  });

  it('sends the plan alone when asked for no content, and everything when asked for all of it', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    const none = await runCli(root, ['stage', '--change', 'add-feature', '--content', 'none']);
    expect((none.json.data as any).read.every((entry: any) => entry.text === undefined)).toBe(true);

    const full = await runCli(root, ['stage', '--change', 'add-feature', '--content', 'full']);
    const fullData = full.json.data as any;
    expect(fullData.read.every((entry: any) => typeof entry.text === 'string')).toBe(true);
    /* `full` gives up the vouchers rather than adding text to them: a file is either read or
       stood in for, never both. */
    expect(fullData.vouched).toEqual([]);
    expect(fullData.read.length).toBeGreaterThan((none.json.data as any).read.length - 1);
  });

  it('sheds the largest contents until the reply fits, keeps the rest, and names what it dropped', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    /* A Change large enough to pass the inline budget. The fixture has no git history, so nothing
       can be vouched for and the whole plan is read — which is exactly the shape that overflowed a
       measured run: 49KB of working set, spilled to disk by the host, and five calls spent reading
       it back. */
    await write(root, 'xforge/changes/add-feature/design.md', `## Decisions\n${'Deterministic prose. '.repeat(2000)}\n`);

    const stage = await runCli(root, ['stage', '--change', 'add-feature']);
    const data = stage.json.data as any;
    const overBudget = (stage.json.diagnostics as Array<{ code: string; message: string }>)
      .find((entry) => entry.code === 'XFORGE_STAGE_CONTENT_OVER_BUDGET');
    expect(overBudget).toBeDefined();

    /*
     * The oversized Design goes; the small files stay.
     *
     * Dropping every text the moment one file pushed the reply over meant a 3KB Constitution was
     * withheld because a 40KB Design existed, and the caller opened both. Only the files that
     * actually have to go should go, and the diagnostic has to name exactly those -- a caller that
     * reads it should know what to open without diffing the reply against the plan.
     */
    const design = data.read.find((entry: any) => entry.path.endsWith('design.md'));
    expect(design?.text).toBeUndefined();
    expect(overBudget!.message).toContain('design.md');

    const kept = data.read.filter((entry: any) => typeof entry.text === 'string');
    expect(kept.length).toBeGreaterThan(0);
    for (const entry of kept) expect(overBudget!.message).not.toContain(entry.path);

    /* An explicit request for everything is still honoured: the budget guards the default, not the
       caller who asked. */
    const full = await runCli(root, ['stage', '--change', 'add-feature', '--content', 'full']);
    expect((full.json.data as any).read.some((entry: any) => typeof entry.text === 'string')).toBe(true);
  });

  it('describes every Artifact the Stage owes, not only the one that is ready', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-feature/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/add-feature/proposal.md', '## Why\nTest\n\n## Flow choice\nsolid\n');
    await write(root, 'xforge/changes/add-feature/specs/widget/spec.md', '## ADDED Requirements\n\n### Requirement: W\n\n#### Scenario: s\n- **WHEN** used\n- **THEN** it works\n');
    await write(root, 'xforge/changes/add-feature/design.md', '## Decisions\nd\n');
    await runCli(root, ['advance', '--change', 'add-feature', '--to', 'design']);
    await runCli(root, ['advance', '--change', 'add-feature', '--to', 'check']);

    const stage = await runCli(root, ['stage', '--change', 'add-feature']);
    const data = stage.json.data as any;
    /*
     * The Check Stage produces three Artifacts and the working set described one. The other two are
     * ledgers whose entire content is a YAML shape that lived only in the Flow file — so all four
     * measurement runs opened it right after calling this, each slicing the artifacts section. A
     * list of names is not something anyone can write from.
     */
    const owed = new Set((data.owes ?? []).map((entry: any) => entry.id));
    for (const id of data.stageDeclares.produces) expect(owed.has(id), `${id} is produced here and not described`).toBe(true);
    const ledger = (data.owes as any[]).find((entry) => entry.id === 'check-findings');
    expect(ledger.outline).toContain('findings:');
  });

  it('renders the plan as text and carries the contents READ names', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    const json = await runCli(root, ['stage', '--change', 'add-feature']);
    const text = await runCli(root, ['stage', '--change', 'add-feature', '--text']);

    /*
     * Still a summary first: the plan is at the top and the Stage's state is readable before any
     * document body starts. What changed is that the bodies now follow it rather than being left
     * on disk -- twelve measured runs called `--text`, none ever dropped it, and each then opened
     * the files this reply had already loaded.
     */
    expect(text.stdout).toContain('NEXT');
    expect(text.stdout.indexOf('NEXT')).toBeLessThan(text.stdout.indexOf('--- '));

    /*
     * And it never claims to carry what it dropped.
     *
     * The first draft printed "3 sent with this reply" — true of the JSON form, copied into the one
     * that prints no contents at all. A measured run believed it, went looking, found nothing, and
     * fell back to opening every file by hand: 25 calls against 18 for the run that did not read
     * that line. A reply that misdescribes itself costs more than one that says less.
     */
    expect(text.stdout).not.toContain('sent with this reply');

    /*
     * What it says it sent, it sent -- checked against the JSON form, which is the same reply.
     * The two forms disagreeing about their own contents is the failure this file keeps recording.
     */
    const carried = (json.json.data as any).read
      .filter((entry: any) => typeof entry.text === 'string')
      .map((entry: any) => entry.path);
    expect(carried.length).toBeGreaterThan(0);
    for (const relative of carried) {
      expect(text.stdout).toContain(`--- ${relative} ---`);
      expect(text.stdout).toContain(`--- end ${relative} ---`);
    }
    expect(text.stdout).toContain('constitution.md');
    /* The Constitution is one of the files it carries, so its body is here rather than named. */
    expect(text.stdout).toContain('## Parallel Development');
  });

  it('refuses a --content value that is not one of the three intents', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['stage', '--change', 'add-feature', '--content', 'inputs,constitution']);
    expect(result.code).toBe(1);
    expect((result.json.diagnostics as Array<{ code: string }>).map((entry) => entry.code))
      .toContain('XFORGE_OPTION_VALUE_INVALID');
  });

  /*
   * Reading one value back out costs one call, not two.
   *
   * `stage` was the only read command that refused `--field`, on the reasoning that a caller
   * enumerating what it needs is asking the question the command came to answer. That is right
   * about the way in and was wrong about the way out: withholding it did not stop callers narrowing
   * the reply, it stopped them narrowing it cheaply. A measured run read one stage reply with two
   * calls -- `| head -c 6000`, then `| tail -c 4500` re-running the whole command -- and hand-parsed
   * it with python on a third. The default is unchanged; this is the follow-up read.
   */
  it('lets one value be read back out without re-running the command to page through it', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-feature/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/add-feature/proposal.md', '## Why\nTest\n\n## Flow choice\nsolid\n');

    const narrowed = await runCli(root, ['stage', '--change', 'add-feature', '--field', 'action.id', '--field', 'stage']);
    /* On `ok: true` the requested paths are the whole reply, at the top level -- the envelope
       survives only on a refusal, where `ok: false` must never read like a success. */
    expect(narrowed.json).toEqual({ 'action.id': 'delta-specs', stage: 'propose' });

    /* And the whole reply is still what arrives when nothing is asked for by name: the default is
       the intent it always was, and `--field` only re-reads a reply already received. */
    const whole = await runCli(root, ['stage', '--change', 'add-feature']);
    expect((whole.json.data as any).action.id).toBe('delta-specs');
    expect((whole.json.data as any).read, 'the working set still arrives in full').toBeTruthy();
  });
});
