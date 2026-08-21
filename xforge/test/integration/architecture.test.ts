import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

async function doctor(root: string): Promise<any> {
  return (await runCli(root, ['doctor'])).json;
}

/**
 * `xforge/architecture.md` is the durable half of what a Change's design produces.
 *
 * Requirements survive a Change because `syncSpecs` merges them; architecture does not, so the
 * decisions a Change makes archive with it and the next Change inherits nothing. The file closes
 * that gap — but only if a project without one stays a working project. An architecture file that
 * projects create to silence a tool would be worse than none, because an empty one reads as
 * configured, which is the same failure the npm placeholder Gates had.
 */
describe('the architecture file', () => {
  it('is suggested when absent, and does not make the project unhealthy', async () => {
    const root = await fixture();
    const result = await doctor(root);

    expect(result.ok).toBe(true);
    const suggestion = result.data.suggestions.find((item: any) => item.code === 'XFORGE_DOCTOR_ARCHITECTURE_ABSENT');
    expect(suggestion).toBeTruthy();
    expect(suggestion.path).toBe('xforge/architecture.md');
    /* Info, not warning: absence is a project that has not written its architecture down. */
    expect(result.diagnostics.find((item: any) => item.code === 'XFORGE_DOCTOR_ARCHITECTURE_ABSENT').severity).toBe('info');
  });

  it('does not count towards --strict, so absence never changes the verdict', async () => {
    const root = await fixture();
    const absent = await runCli(root, ['doctor', '--strict']);
    expect(absent.json.data.suggestions.length).toBeGreaterThan(0);

    await write(root, 'xforge/architecture.md', '# Architecture — test\n');
    const present = await runCli(root, ['doctor', '--strict']);
    /* Asserted by code rather than as an empty list: `suggestions` is a shared channel and other
       setup questions land in it, none of which this test is about. */
    expect((present.json.data.suggestions as any[]).map((item) => item.code)).not.toContain('XFORGE_DOCTOR_ARCHITECTURE_ABSENT');

    /*
     * Compared against itself with and without the file, rather than asserted absolutely: the
     * fixture has unrelated findings of its own, so `--strict` may fail either way. What must hold
     * is that the suggestion contributes nothing to that verdict — a suggestion that can fail
     * `--strict` is a requirement wearing a suggestion's label, and projects would create an empty
     * file to silence it.
     */
    const strictFired = (result: any) => result.json.diagnostics.some((item: any) => item.code === 'XFORGE_DOCTOR_STRICT');
    expect(strictFired(absent)).toBe(strictFired(present));
    expect(absent.code).toBe(present.code);
  });

  it('stops suggesting once the file exists', async () => {
    const root = await fixture();
    await write(root, 'xforge/architecture.md', '# Architecture — test\n\nOne module, no decisions yet.\n');
    const result = await doctor(root);
    expect(result.data.suggestions.find((item: any) => item.code === 'XFORGE_DOCTOR_ARCHITECTURE_ABSENT')).toBeUndefined();
  });

  it('says nothing at all when the project has not selected the Skill', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.scaffold.skills = manifest.scaffold.skills.filter((skill: string) => skill !== 'xforge-architect');
    });
    /* Suggesting an asset owned by a Skill the project deselected is advice about somebody else's
       project. Deselection is an answer, and this respects it. */
    const result = await doctor(root);
    expect(result.data.suggestions.map((item: any) => item.code)).not.toContain('XFORGE_DOCTOR_ARCHITECTURE_ABSENT');
  });

  it('leaves every Change command working on a project that has no architecture', async () => {
    const root = await fixture();
    const { createCompleteSolidChange } = await import('../helpers.js');
    await createCompleteSolidChange(root);

    /* The whole design rests on this: the file is an asset a project may have, never a
       precondition. Nothing here consults it, and nothing here may start to. */
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['state', '--change', 'add-feature'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
  });
});

describe('what the Scaffold ships for it', () => {
  it('selects the Skill and the Rule, and keeps the Rule advisory', async () => {
    const root = await fixture();
    const manifest = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('xforge-architect');
    expect(manifest).toContain('design-within-the-declared-architecture');

    const rule = await readFile(path.join(root, 'xforge', 'scaffold', 'rules', 'design-within-the-declared-architecture.yaml'), 'utf8');
    /* Conformance is a judgement about a document. A Gate scoring it would be scoring prose — the
       same mistake as accepting an Agent's PASS as Gate Evidence. */
    expect(rule).toContain('severity: should');
    expect(rule).toContain('gateRefs: []');
  });

  it('ships the Skill in both languages, with the same authority in each', async () => {
    const root = await fixture();
    const base = path.join(root, 'xforge', 'scaffold', 'skills', 'xforge-architect');
    const [english, chinese] = await Promise.all([
      readFile(path.join(base, 'SKILL.md'), 'utf8'),
      readFile(path.join(base, 'SKILL_cn.md'), 'utf8'),
    ]);
    for (const source of [english, chinese]) {
      /* One writer, one file: a Change may propose an architecture change, only this merges one. */
      expect(source).toContain('xforge/architecture.md');
      expect(source).toContain('architectureDeltas.yaml');
    }
    expect(english).toContain('name: xforge-architect');
    expect(chinese).toContain('name: xforge-architect');
  });

  it('tells design and apply to read it, and what to do when it is not there', async () => {
    const root = await fixture();
    for (const skill of ['xforge-design', 'xforge-apply']) {
      for (const file of ['SKILL.md', 'SKILL_cn.md']) {
        const source = await readFile(path.join(root, 'xforge', 'scaffold', 'skills', skill, file), 'utf8');
        expect(source, `${skill}/${file}`).toContain('architecture.md');
        /* Absence has to be handled in the instruction itself, or an Agent meeting a project
           without the file has to decide for itself whether that is a violation. */
        expect(source, `${skill}/${file}`).toMatch(/does not exist|不存在/);
      }
    }
  });
});
