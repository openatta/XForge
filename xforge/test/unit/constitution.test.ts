import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConstitution } from '../../src/core/constitution.js';
import { temporaryDirectory } from '../helpers.js';

const EN_BODY = [
  '---', 'version: 1.0.0', 'ratified: 2026-01-01', 'lastAmended: 2026-01-01', '---', '',
  '# Project Constitution', '',
  '## Mission and boundaries', '', 'Text.', '',
  '## Architecture principles', '', 'Text.', '',
  '## Security, privacy, and compliance', '', 'Text.', '',
  '## Quality and observability', '', 'Text.', '',
  '## Compatibility and versioning', '', 'Text.', '',
  '## Governance', '', 'Text.', '',
].join('\n');

const ZH_BODY = [
  '---', 'version: 1.0.0', 'ratified: 2026-01-01', 'lastAmended: 2026-01-01', '---', '',
  '# 项目宪法', '',
  '## 使命与边界', '', '正文。', '',
  '## 架构原则', '', '正文。', '',
  '## 安全、隐私与合规', '', '正文。', '',
  '## 质量与可观测性', '', '正文。', '',
  '## 兼容性与版本管理', '', '正文。', '',
  '## 治理', '', '正文。', '',
].join('\n');

async function seed(files: Record<string, string>): Promise<string> {
  const root = await temporaryDirectory();
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

describe('Constitution locale selection', () => {
  it('reads the English default when no language is requested', async () => {
    const root = await seed({ 'xforge/constitution.md': EN_BODY });
    const { constitution, diagnostics } = await readConstitution(root);
    expect(diagnostics).toEqual([]);
    expect(constitution.path).toBe('xforge/constitution.md');
  });

  it('prefers constitution_cn.md when zh-CN is requested and it exists', async () => {
    const root = await seed({ 'xforge/constitution.md': EN_BODY, 'xforge/constitution_cn.md': ZH_BODY });
    const { constitution, diagnostics } = await readConstitution(root, 'zh-CN');
    expect(diagnostics).toEqual([]);
    expect(constitution.path).toBe('xforge/constitution_cn.md');
    expect(constitution.content).toContain('项目宪法');
  });

  it('falls back to the English default when zh-CN is requested but no _cn variant exists', async () => {
    const root = await seed({ 'xforge/constitution.md': EN_BODY });
    const { constitution, diagnostics } = await readConstitution(root, 'zh-CN');
    expect(diagnostics).toEqual([]);
    expect(constitution.path).toBe('xforge/constitution.md');
  });

  it('validates required sections in Chinese against the zh-CN file, not the English list', async () => {
    const root = await seed({ 'xforge/constitution.md': EN_BODY, 'xforge/constitution_cn.md': ZH_BODY.replace('## 治理', '## Not Governance') });
    const { diagnostics } = await readConstitution(root, 'zh-CN');
    expect(diagnostics.map((item) => item.code)).toContain('XFORGE_CONSTITUTION_SECTION_MISSING');
  });

  it('does not use the zh-CN file when English is requested even if one exists', async () => {
    const root = await seed({ 'xforge/constitution.md': EN_BODY, 'xforge/constitution_cn.md': ZH_BODY });
    const { constitution } = await readConstitution(root, 'en');
    expect(constitution.path).toBe('xforge/constitution.md');
  });
});
