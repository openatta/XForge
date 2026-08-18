import { describe, expect, it } from 'vitest';
import {
  adoptionReport, buildUpgradePlan, classifyScaffold, driftedPaths, unselectedAssets,
} from '../../src/core/upgrade.js';
import type { Manifest } from '../../src/types.js';

const file = (text: string) => Buffer.from(text, 'utf8');
const skill = (id: string) => `xforge/scaffold/skills/${id}/SKILL.md`;
const rule = (id: string) => `xforge/scaffold/rules/${id}.yaml`;

const manifest = (scaffold: Partial<Record<string, unknown>> = {}): Manifest => ({
  scaffold: { skills: [], rules: [], gates: [], flows: [], hooks: [], ...scaffold },
} as unknown as Manifest);

/**
 * `xforge/scaffold/**` is seeded once and never updated, so every project runs the assets it was
 * born with. The natural repair is a three-way merge and it cannot be built here: `lock.yaml`
 * records each file's digest *as it stands*, so a project that adapted a Gate has already
 * overwritten the only record of what shipped. There is no base.
 *
 * These tests pin the classification that stands in for one — the part that can be computed, so
 * that the part that cannot is small enough for a person to do carefully.
 */
describe('classifying a Scaffold against the one the CLI ships', () => {
  it('separates identical, changed and added files', () => {
    const entries = classifyScaffold(
      new Map([[skill('a'), file('same')], [skill('b'), file('old')]]),
      new Map([[skill('a'), file('same')], [skill('b'), file('new')], [skill('c'), file('brand new')]]),
    );
    expect(entries.map((entry) => [entry.path, entry.disposition])).toEqual([
      [skill('a'), 'identical'],
      [skill('b'), 'changed'],
      [skill('c'), 'added'],
    ]);
  });

  it('calls a file only the project has project-only, never removed', () => {
    /*
     * Without a base, a file the payload lacks is either an asset upstream dropped or one the
     * project wrote itself, and nothing here can tell those apart. `removed` would name the
     * upstream reading of an ambiguous fact and invite deleting somebody's own Skill on the
     * strength of a guess.
     */
    const [entry] = classifyScaffold(new Map([[skill('ours'), file('ours')]]), new Map());
    expect(entry.disposition).toBe('project-only');
    expect(entry.incomingDigest).toBeNull();
    expect(entry.currentDigest).not.toBeNull();
  });

  it('is ordered and complete, so a plan reads the same way twice', () => {
    const entries = classifyScaffold(
      new Map([[skill('z'), file('1')], [skill('a'), file('1')]]),
      new Map([[skill('m'), file('1')]]),
    );
    expect(entries.map((entry) => entry.path)).toEqual([skill('a'), skill('m'), skill('z')]);
  });

  it('counts every file into exactly one disposition', () => {
    const plan = buildUpgradePlan({
      fromVersion: '0.7.12',
      toVersion: '0.7.14',
      manifest: manifest(),
      current: new Map([[skill('a'), file('x')], [skill('b'), file('old')], [skill('ours'), file('m')]]),
      incoming: new Map([[skill('a'), file('x')], [skill('b'), file('new')], [skill('c'), file('n')]]),
    });
    expect(plan.counts).toEqual({ identical: 1, changed: 1, added: 1, 'project-only': 1 });
    expect(Object.values(plan.counts).reduce((total, count) => total + count, 0)).toBe(plan.entries.length);
  });
});

describe('assets the payload ships and the project has not selected', () => {
  it('reports them by kind and id', () => {
    const found = unselectedAssets(manifest({ skills: ['kept'] }), new Map([
      [skill('kept'), file('1')],
      [skill('xforge-architect'), file('1')],
      ['xforge/scaffold/skills/xforge-architect/SKILL_cn.md', file('1')],
      [rule('design-within-the-declared-architecture'), file('1')],
    ]));
    expect(found).toEqual([
      { kind: 'skill', id: 'xforge-architect', path: 'xforge/scaffold/skills/xforge-architect' },
      { kind: 'rule', id: 'design-within-the-declared-architecture', path: rule('design-within-the-declared-architecture') },
    ]);
  });

  it('reports rather than adopts, so nothing selects a Skill on the project\'s behalf', () => {
    /*
     * Selecting a Skill changes what every Agent on the project is told to do. Doing that because a
     * newer package contains a file is the same category error as answering a Gate's verification
     * question for the project — the upgrade brings the file, a person decides whether it is theirs.
     */
    const before = manifest({ skills: ['kept'] });
    unselectedAssets(before, new Map([[skill('new-one'), file('1')]]));
    expect((before.scaffold as { skills: string[] }).skills).toEqual(['kept']);
  });

  it('says nothing about an asset the project already selected', () => {
    expect(unselectedAssets(manifest({ rules: ['r'] }), new Map([[rule('r'), file('1')]]))).toEqual([]);
  });
});

describe('deciding whether a rollback would destroy work', () => {
  it('finds files edited, added or lost since the baseline', () => {
    expect(driftedPaths(
      { a: 'd1', b: 'd2', gone: 'd3' },
      { a: 'd1', b: 'CHANGED', added: 'd4' },
    )).toEqual(['added', 'b', 'gone']);
  });

  it('is empty when nothing moved, so an untouched project rolls back without a prompt', () => {
    expect(driftedPaths({ a: 'd1' }, { a: 'd1' })).toEqual([]);
  });
});

describe('reporting how much of the plan the merge took up', () => {
  const plan = buildUpgradePlan({
    fromVersion: '0.7.12',
    toVersion: '0.7.14',
    manifest: manifest(),
    current: new Map([[skill('a'), file('old')], [skill('same'), file('s')]]),
    incoming: new Map([[skill('a'), file('new')], [skill('same'), file('s')], [skill('b'), file('added')]]),
  });

  it('counts only the files the plan actually asked about', () => {
    /* `identical` files were never a decision, so counting them would inflate every report. */
    const report = adoptionReport(plan, new Map([[skill('a'), file('new')], [skill('b'), file('added')]]));
    expect(report).toEqual({ considered: 2, matching: 2, notMatching: [] });
  });

  it('names what does not match without calling it wrong', () => {
    /*
     * A project that deliberately kept its own wording is not behind, and no digest can tell that
     * from an oversight. The log records what is true and leaves the judgement to the reader.
     */
    const report = adoptionReport(plan, new Map([[skill('a'), file('ours')], [skill('b'), file('added')]]));
    expect(report.matching).toBe(1);
    expect(report.notMatching).toEqual([skill('a')]);
  });
});
