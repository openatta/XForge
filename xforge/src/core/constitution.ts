import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { Constitution, Diagnostic, ScaffoldLanguage } from '../types.js';
import { diagnostic } from './errors.js';
import { localizedVariant } from './language.js';

const REQUIRED_SECTIONS_EN = [
  'Mission and boundaries',
  'Architecture principles',
  'Security, privacy, and compliance',
  'Quality and observability',
  'Compatibility and versioning',
  'Governance',
];

// Kept in the exact order of REQUIRED_SECTIONS_EN so the two lists stay pairwise comparable.
const REQUIRED_SECTIONS_ZH = [
  '使命与边界',
  '架构原则',
  '安全、隐私与合规',
  '质量与可观测性',
  '兼容性与版本管理',
  '治理',
];

/**
 * Like Skills, the Constitution ships an English default and an optional `_cn` variant; unlike
 * Skills it has no per-target projection step, so the locale-appropriate file is selected here,
 * at read time, rather than at `xforge install`/`sync`.
 */
export async function readConstitution(root: string, language?: ScaffoldLanguage): Promise<{ constitution: Constitution; diagnostics: Diagnostic[] }> {
  const defaultRelative = 'xforge/constitution.md';
  const localizedRelative = localizedVariant(defaultRelative);
  let relative = defaultRelative;
  if (language === 'zh-CN') {
    try {
      await readFile(path.join(root, ...localizedRelative.split('/')), 'utf8');
      relative = localizedRelative;
    } catch { /* no zh-CN variant present; fall back to the default */ }
  }
  const filePath = path.join(root, ...relative.split('/'));
  const requiredSections = relative === localizedRelative ? REQUIRED_SECTIONS_ZH : REQUIRED_SECTIONS_EN;
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch {
    return {
      constitution: { version: '', ratified: '', lastAmended: '', content: '', path: relative },
      diagnostics: [diagnostic('XFORGE_CONSTITUTION_MISSING', 'Project Constitution is required.', relative)],
    };
  }

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    return {
      constitution: { version: '', ratified: '', lastAmended: '', content: source, path: relative },
      diagnostics: [diagnostic('XFORGE_CONSTITUTION_FRONTMATTER_INVALID', 'Constitution requires YAML frontmatter.', relative)],
    };
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = parse(match[1] ?? '') as Record<string, unknown>;
  } catch (error) {
    return {
      constitution: { version: '', ratified: '', lastAmended: '', content: source, path: relative },
      diagnostics: [diagnostic('XFORGE_CONSTITUTION_FRONTMATTER_INVALID', (error as Error).message, relative)],
    };
  }

  const value = (key: string): string => {
    const item = metadata[key];
    if (item instanceof Date) return item.toISOString().slice(0, 10);
    return String(item ?? '');
  };
  const constitution: Constitution = {
    version: value('version'),
    ratified: value('ratified'),
    lastAmended: value('lastAmended'),
    content: source,
    path: relative,
  };
  const diagnostics: Diagnostic[] = [];
  if (!/^\d+\.\d+\.\d+$/.test(constitution.version)) {
    diagnostics.push(diagnostic('XFORGE_CONSTITUTION_VERSION_INVALID', 'Constitution version must be semantic MAJOR.MINOR.PATCH.', relative));
  }
  for (const [key, date] of [['ratified', constitution.ratified], ['lastAmended', constitution.lastAmended]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      diagnostics.push(diagnostic('XFORGE_CONSTITUTION_DATE_INVALID', `Constitution ${key} must be YYYY-MM-DD.`, relative));
    }
  }
  for (const section of requiredSections) {
    if (!source.includes(`## ${section}`)) {
      diagnostics.push(diagnostic('XFORGE_CONSTITUTION_SECTION_MISSING', `Constitution section is missing: ${section}`, relative));
    }
  }
  return { constitution, diagnostics };
}
