import { describe, expect, it } from 'vitest';
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
