import { describe, expect, it } from 'vitest';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { changeYaml, fixture, runCli, updateYaml, write } from '../helpers.js';

/**
 * RC-7 closes the gap `eligibleWhen.contractImpact` leaves open.
 *
 * The classification is what a Change says about itself, and eligibility acts on the saying. Nothing
 * compared it with the document the Change also wrote — so "this Change moves no interface" and a
 * contract delta naming three elements could sit in the same directory, each perfectly valid, and
 * the only mechanism that reads the first would never see the second.
 *
 * It is `info`, like every reconciliation rule. It states the difference between two records this
 * Change holds and does not decide which one is wrong: a delta written before the classification was
 * updated and a classification written before the interface moved are the same observation from
 * opposite directions, and the CLI cannot tell them apart.
 */
async function contractFlowFixture(): Promise<string> {
  const root = await fixture();
  await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => {
    flow.artifacts.push({
      id: 'contract-delta',
      generates: 'contracts/**/*.md',
      validator: 'contract-delta',
      description: 'Declare this Change\'s delta to the module interface baseline',
      instruction: 'List every contract element this Change adds, modifies or removes.',
      outline: '## ADDED Contract Elements\n',
    });
    flow.stages.find((stage: any) => stage.id === 'design').produces.push('contract-delta');
    flow.terminal.archive.syncContracts = true;
    /* A Flow that collects and merges interface deltas is one a Change may declare a module contract
       on. The shipped `solid` refuses the claim precisely because it does neither. */
    flow.policy.eligibleWhen.contractImpact = 'allowed';
  });
  return root;
}

const observations = (json: any): Array<{ code: string; message: string }> =>
  json.diagnostics.filter((item: any) => item.code.startsWith('XFORGE_RECONCILE_CONTRACT'));

describe('RC-7: the contract delta against what the Change says about itself', () => {
  it('states the difference when a delta declares elements and the classification does not', async () => {
    const root = await contractFlowFixture();
    await write(root, 'xforge/changes/silent/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/silent/proposal.md', '## Why\nA change that moves an interface quietly.\n');
    await write(root, 'xforge/changes/silent/specs/fix/spec.md', '## ADDED Requirements\n\n### Requirement: REQ-1 Works\n\n#### Scenario: ok\n- **WHEN** used\n- **THEN** it works\n');
    await write(root, 'xforge/changes/silent/contracts/http.md', [
      /* `root` is the fixture project's only module, and naming it here keeps this case to the one
         difference it is about: the module-scope rule is exercised on its own below. */
      '## ADDED Contract Elements', '', '### Element: openapi:paths./orders.post', '', '- module: root', '',
    ].join('\n'));
    expect((await runCli(root, ['install'])).code).toBe(0);

    const checked = await runCli(root, ['check', '--change', 'silent']);
    const found = observations(checked.json);
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe('XFORGE_RECONCILE_CONTRACT_IMPACT_UNDECLARED');
    expect(found[0]!.message).toContain('RC-7');
    expect(found[0]!.message).toContain('openapi:paths./orders.post');
    const item = checked.json.diagnostics.find((entry: any) => entry.code === 'XFORGE_RECONCILE_CONTRACT_IMPACT_UNDECLARED');
    expect(item.severity).toBe('info');
  });

  it('states the difference the other way round too', async () => {
    const root = await contractFlowFixture();
    await write(root, 'xforge/changes/loud/change.yaml', changeYaml('solid', {
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
    await write(root, 'xforge/changes/loud/proposal.md', '## Why\nSays it moves an interface.\n');
    await write(root, 'xforge/changes/loud/specs/fix/spec.md', '## ADDED Requirements\n\n### Requirement: REQ-1 Works\n\n#### Scenario: ok\n- **WHEN** used\n- **THEN** it works\n');
    await write(root, 'xforge/changes/loud/contracts/http.md', [
      '## ADDED Contract Elements', '', '(none)', '',
      '## MODIFIED Contract Elements', '', '(none)', '',
      '## REMOVED Contract Elements', '', '(none)', '',
    ].join('\n'));
    expect((await runCli(root, ['install'])).code).toBe(0);

    const found = observations((await runCli(root, ['check', '--change', 'loud'])).json);
    expect(found.map((item) => item.code)).toEqual(['XFORGE_RECONCILE_CONTRACT_DELTA_EMPTY']);
  });

  it('says nothing when the two records agree, in either direction', async () => {
    const root = await contractFlowFixture();
    await write(root, 'xforge/changes/agree/change.yaml', changeYaml('solid', {
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
    await write(root, 'xforge/changes/agree/proposal.md', '## Why\nBoth records say the same thing.\n');
    await write(root, 'xforge/changes/agree/specs/fix/spec.md', '## ADDED Requirements\n\n### Requirement: REQ-1 Works\n\n#### Scenario: ok\n- **WHEN** used\n- **THEN** it works\n');
    await write(root, 'xforge/changes/agree/contracts/http.md', '## ADDED Contract Elements\n\n### Element: openapi:paths./orders.post\n\n- module: root\n');
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect(observations((await runCli(root, ['check', '--change', 'agree'])).json)).toEqual([]);

    /* And the ordinary Change: no contract delta at all, nothing claimed, nothing to reconcile. */
    await write(root, 'xforge/changes/plain/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/plain/proposal.md', '## Why\nNo interface anywhere near this.\n');
    await write(root, 'xforge/changes/plain/specs/fix/spec.md', '## ADDED Requirements\n\n### Requirement: REQ-1 Works\n\n#### Scenario: ok\n- **WHEN** used\n- **THEN** it works\n');
    expect(observations((await runCli(root, ['check', '--change', 'plain'])).json)).toEqual([]);
  });

  it('names an element whose module the Change never brought into scope', async () => {
    /*
     * The second difference worth stating. `scope.modules` is what the Change says it touches and
     * the delta says which module owns each element it moves; an element owned by a module outside
     * the scope means one of the two is understating the Change, and the work-package write
     * boundaries are derived from the narrower one.
     */
    const root = await contractFlowFixture();
    await write(root, 'xforge/changes/narrow/change.yaml', changeYaml('solid', {
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
      scope: { modules: ['root'], paths: ['src/**'] },
    }));
    await write(root, 'xforge/changes/narrow/proposal.md', '## Why\nDeclares one module and moves another one\'s interface.\n');
    await write(root, 'xforge/changes/narrow/specs/fix/spec.md', '## ADDED Requirements\n\n### Requirement: REQ-1 Works\n\n#### Scenario: ok\n- **WHEN** used\n- **THEN** it works\n');
    await write(root, 'xforge/changes/narrow/contracts/http.md', '## ADDED Contract Elements\n\n### Element: openapi:paths./orders.post\n\n- module: billing\n');
    expect((await runCli(root, ['install'])).code).toBe(0);

    const found = observations((await runCli(root, ['check', '--change', 'narrow'])).json);
    expect(found.map((item) => item.code)).toContain('XFORGE_RECONCILE_CONTRACT_MODULE_OUT_OF_SCOPE');
    expect(found.find((item) => item.code === 'XFORGE_RECONCILE_CONTRACT_MODULE_OUT_OF_SCOPE')!.message).toContain('billing');
  });
});

describe('reading the contract baseline back', () => {
  it('lists what the baseline records, filters by dialect, and says so when there is none', async () => {
    /*
     * A delta addresses elements by ids it does not invent, so a writer who cannot see how the
     * baseline spells one retypes it from memory -- and a retyped id does not fail loudly. It merges
     * as an ADDED element beside the one it was meant to modify, and the baseline grows a
     * near-duplicate nothing compares.
     */
    const root = await fixture();
    const empty = await runCli(root, ['contract', 'list']);
    expect(empty.code).toBe(0);
    expect(empty.json.data.domains).toEqual([]);

    await write(root, 'xforge/contracts/http.md', [
      '# http', '', '## Elements', '',
      '### Element: openapi:paths./orders.post', '', '- module: api', '',
      '### Element: sql:table.orders.column.status', '', '- module: store', '',
    ].join('\n'));

    const listed = await runCli(root, ['contract', 'list']);
    expect(listed.json.data.elementCount).toBe(2);
    expect(listed.json.data.domains[0].domain).toBe('http');
    expect(listed.json.data.domains[0].elements.map((item: any) => item.id)).toEqual([
      'openapi:paths./orders.post', 'sql:table.orders.column.status',
    ]);
    expect(listed.json.data.domains[0].elements[0].module).toBe('api');

    /* `--kind` here is a contract dialect and not a resource kind, over an open set nothing can
       validate against -- shipping a list of dialects is the coupling declared Gates exist to
       avoid. The same flag on `state` keeps its closed set and its typo message. */
    const filtered = await runCli(root, ['contract', 'list', '--kind', 'sql']);
    expect(filtered.json.data.elementCount).toBe(1);
    expect(filtered.json.data.domains[0].elements[0].id).toBe('sql:table.orders.column.status');

    const refused = await runCli(root, ['state', '--kind', 'sql']);
    expect(refused.code).toBe(1);
    expect(refused.json.diagnostics.map((item: any) => item.code)).toEqual(['XFORGE_KIND_UNKNOWN']);

    const unknownSubcommand = await runCli(root, ['contract', 'draft']);
    expect(unknownSubcommand.code).toBe(1);
    expect(unknownSubcommand.json.diagnostics[0].code).toBe('XFORGE_SUBCOMMAND_UNKNOWN');
  });
});

describe('what every Change in flight will do to the baseline', () => {
  it('lists each Change\'s declared elements and names the ones two Changes both claim', async () => {
    /*
     * The question the control plane is structurally unable to answer. `contentRevision` is computed
     * per Change over that Change's own directory and its Flow, so two Changes can each be entirely
     * compliant, each carry a human approval, and each say something different about the same
     * interface — and nothing compares them. No Gate can close it either: a Gate runs inside one
     * Change and sees one Change.
     */
    const root = await fixture();
    await write(root, 'xforge/changes/expand/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/expand/contracts/http.md', [
      '## ADDED Contract Elements', '', '### Element: openapi:paths./orders/{id}/cancel.post', '', '- module: api', '',
      '## MODIFIED Contract Elements', '', '### Element: openapi:components.schemas.Order', '', '- module: api', '',
    ].join('\n'));
    await write(root, 'xforge/changes/contract-half/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/contract-half/contracts/http.md', [
      '## REMOVED Contract Elements', '', '### Element: openapi:components.schemas.Order', '', '- module: api', '',
    ].join('\n'));
    /* A Change with a delta that asserts it moves nothing is still listed: it has said something,
       and leaving it out would read as a Change nobody looked at. */
    await write(root, 'xforge/changes/quiet/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/quiet/contracts/http.md', '## ADDED Contract Elements\n\n(none)\n');
    /* And one with no delta at all, which is most Changes and is not part of this answer. */
    await write(root, 'xforge/changes/unrelated/change.yaml', changeYaml('solid'));

    const status = await runCli(root, ['contract', 'status']);
    expect(status.code).toBe(0);
    expect(status.json.data.changes.map((item: any) => item.change)).toEqual(['contract-half', 'expand', 'quiet']);
    expect(status.json.data.changes.find((item: any) => item.change === 'quiet').elements).toEqual([]);

    expect(status.json.data.overlaps).toHaveLength(1);
    const [overlap] = status.json.data.overlaps;
    expect(overlap.id).toBe('openapi:components.schemas.Order');
    expect(overlap.claims).toEqual([
      { change: 'contract-half', operation: 'REMOVED' },
      { change: 'expand', operation: 'MODIFIED' },
    ]);

    /* Reporting, never blocking. An expand half and a contract half of one planned migration look
       exactly like a collision, and a CLI that refused would be deciding a question it cannot see
       the answer to. */
    expect(status.json.diagnostics).toEqual([]);

    const text = await runCli(root, ['contract', 'status', '--text']);
    expect(text.stdout).toContain('CLAIMED BY MORE THAN ONE CHANGE');
    expect(text.stdout).toContain('openapi:components.schemas.Order');
  });

  it('says plainly when nothing in flight touches an interface', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/plain/change.yaml', changeYaml('solid'));
    const status = await runCli(root, ['contract', 'status']);
    expect(status.code).toBe(0);
    expect(status.json.data).toEqual({ changes: [], overlaps: [] });
    const text = await runCli(root, ['contract', 'status', '--text']);
    expect(text.stdout).toContain('No Change in flight declares a contract delta.');
  });
});

describe('an element id addresses one element, across the whole Change', () => {
  it('refuses the same id in two of a Change\'s own domain files', async () => {
    /*
     * A contract element id is a global address — it is what a later Change's MODIFIED block names —
     * while a domain file is only where the record of it happens to live. Validating each file alone
     * let one Change write the same id into two baseline records at archive, after which `contract
     * list` shows it twice and a later MODIFIED reaches whichever domain it names, leaving the other
     * copy stale with nothing reporting the divergence.
     */
    const root = await contractFlowFixture();
    await write(root, 'xforge/changes/split/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/split/proposal.md', '## Why\nOne id, two domain files.\n');
    await write(root, 'xforge/changes/split/specs/fix/spec.md', '## ADDED Requirements\n\n### Requirement: REQ-1 Works\n\n#### Scenario: ok\n- **WHEN** used\n- **THEN** it works\n');
    await write(root, 'xforge/changes/split/contracts/orders.md', '## ADDED Contract Elements\n\n### Element: openapi:paths./orders.post\n\n- module: root\n');
    await write(root, 'xforge/changes/split/contracts/payments.md', '## ADDED Contract Elements\n\n### Element: openapi:paths./orders.post\n\n- module: root\n');
    expect((await runCli(root, ['install'])).code).toBe(0);

    const checked = await runCli(root, ['check', '--change', 'split']);
    const duplicate = checked.json.diagnostics.find((item: any) => item.code === 'XFORGE_CONTRACT_DELTA_ELEMENT_DUPLICATE');
    expect(duplicate, JSON.stringify(checked.json.diagnostics.map((d: any) => d.code))).toBeTruthy();
    expect(duplicate.message).toContain('contracts/orders.md');
    expect(duplicate.message).toContain('contracts/payments.md');
  });

  it('counts a collision by Change, not by delta file', async () => {
    /*
     * `contract status` exists to say that two Changes disagree. One Change naming an id in two of
     * its own files appended two claims, and the report announced "claimed by more than one Change"
     * about one Change — false about the only fact the command reports.
     */
    const root = await fixture();
    await write(root, 'xforge/changes/one/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/one/contracts/orders.md', '## ADDED Contract Elements\n\n### Element: a:b\n');
    await write(root, 'xforge/changes/one/contracts/payments.md', '## MODIFIED Contract Elements\n\n### Element: a:b\n');
    expect((await runCli(root, ['contract', 'status'])).json.data.overlaps).toEqual([]);

    await write(root, 'xforge/changes/two/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/two/contracts/orders.md', '## REMOVED Contract Elements\n\n### Element: a:b\n');
    const overlaps = (await runCli(root, ['contract', 'status'])).json.data.overlaps;
    expect(overlaps).toHaveLength(1);
    expect(new Set(overlaps[0].claims.map((claim: any) => claim.change))).toEqual(new Set(['one', 'two']));
  });

  it('lists exactly the ids the merge can find', async () => {
    /*
     * The list and the merge read the same file, and they used to read it differently: the list
     * scanned every `### Element:` heading, the merge only those inside `## Elements`. An id outside
     * that section — a hand-seeded baseline, or one carried in a trailing section — was offered here
     * as addressable and then refused at merge, on the archive path, after the closing approval.
     */
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', [
      '# http', '', '### Element: openapi:stray.get', '', '## Elements', '',
      '### Element: openapi:paths./orders.get', '', '- module: api', '',
      '## Notes', '', '### Element: openapi:alsoStray.get', '',
    ].join('\n'));
    const listed = await runCli(root, ['contract', 'list']);
    expect(listed.json.data.domains[0].elements.map((item: any) => item.id)).toEqual(['openapi:paths./orders.get']);
    expect(listed.json.data.domains[0].elements[0].module).toBe('api');
  });
});

describe('a read that failed does not answer as a read that found nothing', () => {
  it('reports an unreadable baseline instead of reporting no baseline', async () => {
    /*
     * `safeResolve` rethrows a raw Node error for anything that is not a missing path, and those
     * carry no diagnostics. Taking `?? []` there left an empty list, the envelope derives `ok` from
     * the diagnostics, and an unreadable baseline printed "No contract baseline" and exited 0.
     *
     * The Skills send the design Agent here to read the ids it has to address. That answer would
     * have it declare every element as ADDED against a baseline that already records them, and find
     * out at archive.
     */
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', '# http\n\n## Elements\n\n### Element: a:b\n');
    await write(root, 'xforge/contracts/orders.md', '# orders\n\n## Elements\n\n### Element: c:d\n');
    await chmod(path.join(root, 'xforge', 'contracts', 'http.md'), 0o000);
    try {
      const listed = await runCli(root, ['contract', 'list']);
      expect(listed.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CONTRACT_READ_FAILED');
      expect(listed.code).not.toBe(0);
      /* The domains that could be read are still reported: one unreadable file does not make the
         rest unreportable, and it does not pass as a domain that records nothing either. */
      expect(listed.json.data.domains.map((item: any) => item.domain)).toEqual(['orders']);
    } finally {
      await chmod(path.join(root, 'xforge', 'contracts', 'http.md'), 0o644);
    }
  });

  it('reports an unreadable contract delta instead of a Change that claims nothing', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/one/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/one/contracts/orders.md', '## ADDED Contract Elements\n\n### Element: a:b\n');
    await chmod(path.join(root, 'xforge', 'changes', 'one', 'contracts', 'orders.md'), 0o000);
    try {
      const status = await runCli(root, ['contract', 'status']);
      expect(status.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CONTRACT_READ_FAILED');
      expect(status.code).not.toBe(0);
      expect(status.stdout).not.toContain('No Change in flight declares a contract delta.');
    } finally {
      await chmod(path.join(root, 'xforge', 'changes', 'one', 'contracts', 'orders.md'), 0o644);
    }
  });
});
