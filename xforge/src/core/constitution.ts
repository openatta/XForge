import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { Constitution, Diagnostic } from '../types.js';
import { diagnostic } from './errors.js';

const REQUIRED_SECTIONS = [
  'Mission and boundaries',
  'Architecture principles',
  'Security, privacy, and compliance',
  'Quality and observability',
  'Compatibility and versioning',
  'Governance',
];

export async function readConstitution(root: string): Promise<{ constitution: Constitution; diagnostics: Diagnostic[] }> {
  const relative = 'xforge/constitution.md';
  const filePath = path.join(root, 'xforge', 'constitution.md');
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
  for (const section of REQUIRED_SECTIONS) {
    if (!source.includes(`## ${section}`)) {
      diagnostics.push(diagnostic('XFORGE_CONSTITUTION_SECTION_MISSING', `Constitution section is missing: ${section}`, relative));
    }
  }
  return { constitution, diagnostics };
}
