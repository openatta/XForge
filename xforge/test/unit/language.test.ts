import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';
import { detectScaffoldLanguage, localizedVariant, parseScaffoldLanguage } from '../../src/core/language.js';
import { scaffoldPayload } from '../helpers.js';

describe('Scaffold language resolution', () => {
  it('uses explicit XForge language before system locale', () => {
    expect(detectScaffoldLanguage({ XFORGE_LANGUAGE: 'zh-CN', LANG: 'en_US.UTF-8' }, 'en-US')).toBe('zh-CN');
    expect(detectScaffoldLanguage({ XFORGE_LANGUAGE: 'en', LANG: 'zh_CN.UTF-8' }, 'zh-CN')).toBe('en');
  });

  it('maps Chinese locales to zh-CN and every other real locale to English', () => {
    expect(detectScaffoldLanguage({ LANG: 'zh_TW.UTF-8' }, 'en-US')).toBe('zh-CN');
    expect(detectScaffoldLanguage({ LANG: 'fr_FR.UTF-8' }, 'zh-CN')).toBe('en');
  });

  it('returns no language for neutral C/POSIX environments', () => {
    expect(detectScaffoldLanguage({ LANG: 'C.UTF-8' }, 'en-US')).toBeNull();
    expect(detectScaffoldLanguage({ LC_ALL: 'POSIX' }, 'en-US')).toBeNull();
  });

  it('accepts only supported explicit languages and uses the _cn convention', () => {
    expect(parseScaffoldLanguage('zh')).toBe('zh-CN');
    expect(parseScaffoldLanguage('en-US')).toBe('en');
    expect(() => parseScaffoldLanguage('fr')).toThrow(/Unsupported Scaffold language/);
    expect(localizedVariant('SKILL.md')).toBe('SKILL_cn.md');
    expect(localizedVariant('agents/openai.yaml')).toBe('agents/openai_cn.yaml');
  });

  it('keeps only Skills and sub-agents bilingual while every other Scaffold asset stays English', async () => {
    const scaffoldRoot = path.join(scaffoldPayload, 'xforge', 'scaffold');
    const files = (await fg('**/*', { cwd: scaffoldRoot, onlyFiles: true, dot: true })).sort();
    const fileSet = new Set(files);

    const skillDefaults = files.filter((file) => /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(file));
    expect(skillDefaults).toHaveLength(12);
    for (const file of skillDefaults) expect(fileSet.has(localizedVariant(file))).toBe(true);

    const agentDefaults = files.filter((file) => /^agents\/[^/]+\.md$/.test(file) && !file.endsWith('_cn.md'));
    expect(agentDefaults).toHaveLength(3);
    for (const file of agentDefaults) expect(fileSet.has(localizedVariant(file))).toBe(true);

    const metadataDefaults = files.filter((file) => /(^|\/)skills\/[^/]+\/agents\/openai\.yaml$/.test(file));
    for (const file of metadataDefaults) expect(fileSet.has(localizedVariant(file))).toBe(true);

    const localizedFiles = files.filter((file) => /_cn\.(?:md|yaml)$/.test(file));
    for (const file of localizedFiles) {
      const defaultFile = file.replace(/_cn(?=\.(?:md|yaml)$)/, '');
      expect(fileSet.has(defaultFile)).toBe(true);
      expect(defaultFile.startsWith('agents/') || defaultFile.startsWith('skills/')).toBe(true);
    }

    /*
     * A Flow template is a Flow, and a Flow carries the marker patterns an Agent's own prose has to
     * match -- `solid.yaml` already ships `['**Rejected alternative:', '**被否决的替代方案：']`,
     * because a Chinese-language project writes the Chinese heading and the marker has to find it.
     * Those live in `xforge/flows/`, which this scan does not reach; a template of the same kind
     * under `xforge/scaffold/flows/` is the same file waiting to be copied there, and holding it to
     * a rule its destination does not have would ship a template that stops working on arrival.
     *
     * The exemption is the pattern list and nothing else: the rest of a template is English like
     * every other asset here.
     */
    const englishOnlyFiles = files
      .filter((file) => !/_cn\.(?:md|yaml)$/.test(file))
      .filter((file) => !/^flows\/[^/]+\.yaml$/.test(file));
    const nonEnglish = [];
    for (const file of englishOnlyFiles) {
      const content = await readFile(path.join(scaffoldRoot, file), 'utf8');
      if (/\p{Script=Han}/u.test(content)) nonEnglish.push(file);
    }
    expect(nonEnglish).toEqual([]);

    /* And the templates themselves, held to the narrower rule: Han characters only inside a marker
       `pattern:` list, never in an instruction, description or comment a reader depends on. */
    const templates = files.filter((file) => /^flows\/[^/]+\.yaml$/.test(file));
    expect(templates.length).toBeGreaterThan(0);
    for (const file of templates) {
      const offending = (await readFile(path.join(scaffoldRoot, file), 'utf8'))
        .split('\n')
        .filter((line) => /\p{Script=Han}/u.test(line))
        .filter((line) => !/^\s*(?:-\s*)?pattern:\s*\[/.test(line));
      expect(offending, `${file} has Han characters outside a marker pattern list`).toEqual([]);
    }
  });
});
