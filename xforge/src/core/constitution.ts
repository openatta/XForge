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
 * `init` now collapses the Constitution to one file per project, the way Skills already installed:
 * a zh-CN project gets Chinese text under the canonical `xforge/constitution.md`, and no `_cn`
 * file at all. Language therefore no longer selects a *file* — it selects which section headings
 * this file is required to carry.
 *
 * The `_cn` lookup stays for projects initialized before that change, which have both files and a
 * Chinese Constitution only under the `_cn` name. Reading the canonical file for them would
 * silently swap a customized Chinese Constitution for the English default it sits beside, so the
 * legacy layout keeps working rather than being migrated out from under a project that may have
 * edited it.
 */
export async function readConstitution(root: string, language?: ScaffoldLanguage): Promise<{ constitution: Constitution; diagnostics: Diagnostic[] }> {
  const defaultRelative = 'xforge/constitution.md';
  const localizedRelative = localizedVariant(defaultRelative);
  let relative = defaultRelative;
  if (language === 'zh-CN') {
    try {
      await readFile(path.join(root, ...localizedRelative.split('/')), 'utf8');
      relative = localizedRelative;
    } catch { /* collapsed layout: the canonical file already holds the zh-CN text */ }
  }
  const filePath = path.join(root, ...relative.split('/'));
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
  /*
   * Which heading set to require is decided by the document, not by the Manifest's language. The
   * filename used to answer this — `constitution.md` meant English, `_cn` meant Chinese — and the
   * collapse removed that signal without removing the question.
   *
   * Trusting the Manifest instead would fail a project that set `language: zh-CN` while keeping a
   * complete English Constitution: every principle is present and answerable, so reporting them as
   * missing is friction without safety. Preferring the declared language keeps its error message
   * when neither set matches, which is the case actually worth reporting.
   */
  const declared = language === 'zh-CN' ? REQUIRED_SECTIONS_ZH : REQUIRED_SECTIONS_EN;
  const other = declared === REQUIRED_SECTIONS_ZH ? REQUIRED_SECTIONS_EN : REQUIRED_SECTIONS_ZH;
  const satisfies = (sections: readonly string[]): boolean => sections.every((section) => source.includes(`## ${section}`));
  const requiredSections = satisfies(declared) || !satisfies(other) ? declared : other;

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
