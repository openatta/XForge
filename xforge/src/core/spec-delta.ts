import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import type { ArtifactDefinition, Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { safeResolve } from './path-safety.js';

export type DeltaOperation = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

export interface ParsedScenario {
  name: string;
  line: number;
  hasWhen: boolean;
  hasThen: boolean;
}

export interface ParsedRequirement {
  name: string;
  line: number;
  scenarios: ParsedScenario[];
}

export interface ParsedSection {
  operation: DeltaOperation;
  line: number;
  body: string;
  requirements: ParsedRequirement[];
}

export interface ParsedSpecDelta {
  sections: ParsedSection[];
  orphanRequirements: ParsedRequirement[];
}

export interface RenameEntries {
  pairs: Array<{ from: string; to: string }>;
  unmatchedFrom: string[];
  unmatchedTo: string[];
}

// Deliberately mirrors the header shapes core/spec-merger.ts recognises at archive time so that
// anything this validator accepts still merges, and anything it rejects would have failed later.
const SECTION_HEADER = /^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements[ \t]*$/;
const OTHER_SECTION_HEADER = /^## /;
const REQUIREMENT_HEADER = /^### Requirement:[ \t]*(.*)$/;
const OTHER_REQUIREMENT_HEADER = /^### /;
const SCENARIO_HEADER = /^#### Scenario:[ \t]*(.*)$/;
const OTHER_SCENARIO_HEADER = /^#### /;
// Tolerant of list markers and bold/italic emphasis: "- **WHEN** x", "* WHEN: x", "THEN x".
const WHEN_LINE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__|\*|_)?[ \t]*WHEN(?:\*\*|__|\*|_)?[ \t]*:?[ \t]*(\S.*)$/i;
const THEN_LINE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__|\*|_)?[ \t]*THEN(?:\*\*|__|\*|_)?[ \t]*:?[ \t]*(\S.*)$/i;

export function hasDeltaSections(source: string): boolean {
  return source.split(/\r?\n/).some((line) => SECTION_HEADER.test(line));
}

/**
 * Parses a `## RENAMED Requirements` body into FROM/TO pairs plus the unbalanced leftovers.
 * `renamePairs` below is the exact pair set core/spec-merger.ts applies, so both agree.
 */
export function parseRenameEntries(source: string): RenameEntries {
  const pairs: Array<{ from: string; to: string }> = [];
  const unmatchedFrom: string[] = [];
  const unmatchedTo: string[] = [];
  let from: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const fromMatch = line.match(/FROM:\s*(?:`?### Requirement:\s*)?(.+?)`?\s*$/i);
    if (fromMatch) {
      if (from !== null) unmatchedFrom.push(from);
      from = fromMatch[1]!.trim();
      continue;
    }
    const toMatch = line.match(/TO:\s*(?:`?### Requirement:\s*)?(.+?)`?\s*$/i);
    if (!toMatch) continue;
    const to = toMatch[1]!.trim();
    if (from) { pairs.push({ from, to }); from = null; }
    else unmatchedTo.push(to);
  }
  if (from !== null) unmatchedFrom.push(from);
  return { pairs, unmatchedFrom, unmatchedTo };
}

export function renamePairs(source: string): Array<{ from: string; to: string }> {
  return parseRenameEntries(source).pairs;
}

export function parseSpecDelta(source: string): ParsedSpecDelta {
  const sections: ParsedSection[] = [];
  const orphanRequirements: ParsedRequirement[] = [];
  let section: ParsedSection | null = null;
  let bodyLines: string[] = [];
  let requirement: ParsedRequirement | null = null;
  let scenario: ParsedScenario | null = null;

  const closeSection = (): void => {
    if (!section) return;
    section.body = bodyLines.join('\n');
    sections.push(section);
    section = null;
    bodyLines = [];
  };
  const pushRequirement = (value: ParsedRequirement): void => {
    if (section) section.requirements.push(value);
    else orphanRequirements.push(value);
  };

  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const sectionMatch = SECTION_HEADER.exec(line);
    if (sectionMatch) {
      closeSection();
      requirement = null;
      scenario = null;
      section = { operation: sectionMatch[1] as DeltaOperation, line: number, body: '', requirements: [] };
      continue;
    }
    if (OTHER_SECTION_HEADER.test(line)) {
      closeSection();
      requirement = null;
      scenario = null;
      continue;
    }
    if (section) bodyLines.push(line);
    const requirementMatch = REQUIREMENT_HEADER.exec(line);
    if (requirementMatch) {
      scenario = null;
      requirement = { name: requirementMatch[1]!.trim(), line: number, scenarios: [] };
      pushRequirement(requirement);
      continue;
    }
    if (OTHER_REQUIREMENT_HEADER.test(line)) {
      requirement = null;
      scenario = null;
      continue;
    }
    const scenarioMatch = SCENARIO_HEADER.exec(line);
    if (scenarioMatch) {
      scenario = { name: scenarioMatch[1]!.trim(), line: number, hasWhen: false, hasThen: false };
      requirement?.scenarios.push(scenario);
      continue;
    }
    if (OTHER_SCENARIO_HEADER.test(line)) {
      scenario = null;
      continue;
    }
    if (!scenario) continue;
    if (WHEN_LINE.test(line)) scenario.hasWhen = true;
    else if (THEN_LINE.test(line)) scenario.hasThen = true;
  }
  closeSection();
  return { sections, orphanRequirements };
}

function scenarioDiagnostics(
  operation: DeltaOperation,
  requirement: ParsedRequirement,
  filePath: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (requirement.scenarios.length === 0) {
    return [diagnostic(
      'XFORGE_SPEC_DELTA_SCENARIO_MISSING',
      `${operation} requirement "${requirement.name}" has no "#### Scenario:" block; every requirement needs at least one observable scenario.`,
      filePath,
      'error',
      { requirement: requirement.name, line: requirement.line },
    )];
  }
  const seen = new Set<string>();
  for (const scenario of requirement.scenarios) {
    if (scenario.name.length === 0) {
      diagnostics.push(diagnostic(
        'XFORGE_SPEC_DELTA_SCENARIO_UNNAMED',
        `A "#### Scenario:" heading under requirement "${requirement.name}" has no name.`,
        filePath,
        'error',
        { requirement: requirement.name, line: scenario.line },
      ));
    } else if (seen.has(scenario.name)) {
      diagnostics.push(diagnostic(
        'XFORGE_SPEC_DELTA_SCENARIO_DUPLICATE',
        `Requirement "${requirement.name}" declares scenario "${scenario.name}" more than once.`,
        filePath,
        'error',
        { requirement: requirement.name, scenario: scenario.name, line: scenario.line },
      ));
    } else {
      seen.add(scenario.name);
    }
    const missing = [scenario.hasWhen ? null : 'WHEN', scenario.hasThen ? null : 'THEN'].filter((item): item is string => item !== null);
    if (missing.length > 0) {
      diagnostics.push(diagnostic(
        'XFORGE_SPEC_DELTA_WHEN_THEN_MISSING',
        `Scenario "${scenario.name || '(unnamed)'}" under requirement "${requirement.name}" is missing a ${missing.join(' and ')} line.`,
        filePath,
        'error',
        { requirement: requirement.name, scenario: scenario.name, missing, line: scenario.line },
      ));
    }
  }
  return diagnostics;
}

function renameDiagnostics(section: ParsedSection, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const entries = parseRenameEntries(section.body);
  for (const from of entries.unmatchedFrom) {
    diagnostics.push(diagnostic(
      'XFORGE_SPEC_DELTA_RENAME_UNBALANCED',
      `RENAMED requirement "${from}" has a FROM entry without a matching TO entry.`,
      filePath,
      'error',
      { from, line: section.line },
    ));
  }
  for (const to of entries.unmatchedTo) {
    diagnostics.push(diagnostic(
      'XFORGE_SPEC_DELTA_RENAME_UNBALANCED',
      `RENAMED requirement "${to}" has a TO entry without a preceding FROM entry.`,
      filePath,
      'error',
      { to, line: section.line },
    ));
  }
  if (entries.pairs.length === 0 && diagnostics.length === 0) {
    diagnostics.push(diagnostic(
      'XFORGE_SPEC_DELTA_SECTION_EMPTY',
      'RENAMED Requirements declares no "- FROM: ... / - TO: ..." pair.',
      filePath,
      'error',
      { operation: 'RENAMED', line: section.line },
    ));
  }
  for (const pair of entries.pairs) {
    if (pair.from === pair.to) {
      diagnostics.push(diagnostic(
        'XFORGE_SPEC_DELTA_RENAME_UNBALANCED',
        `RENAMED requirement "${pair.from}" renames to itself.`,
        filePath,
        'error',
        { from: pair.from, to: pair.to, line: section.line },
      ));
    }
  }
  return diagnostics;
}

/**
 * Validates the markdown structure of one Change delta Spec. Structural failures here are the
 * same failures core/spec-merger.ts would raise at archive time, reported at propose time instead.
 */
export function validateSpecDeltaSource(source: string, filePath: string): Diagnostic[] {
  if (source.trim().length === 0) {
    return [diagnostic('XFORGE_SPEC_DELTA_FILE_EMPTY', 'Delta Spec file is empty.', filePath)];
  }
  const parsed = parseSpecDelta(source);
  if (parsed.sections.length === 0) {
    return [diagnostic(
      'XFORGE_SPEC_DELTA_NO_SECTION',
      'Delta Spec must declare at least one "## ADDED Requirements", "## MODIFIED Requirements", "## REMOVED Requirements", or "## RENAMED Requirements" section.',
      filePath,
    )];
  }

  const diagnostics: Diagnostic[] = [];
  const seenOperations = new Set<DeltaOperation>();
  for (const section of parsed.sections) {
    if (seenOperations.has(section.operation)) {
      diagnostics.push(diagnostic(
        'XFORGE_SPEC_DELTA_SECTION_DUPLICATE',
        `Delta Spec declares "## ${section.operation} Requirements" more than once; only the first section is merged.`,
        filePath,
        'error',
        { operation: section.operation, line: section.line },
      ));
      continue;
    }
    seenOperations.add(section.operation);
    if (section.operation === 'RENAMED') {
      diagnostics.push(...renameDiagnostics(section, filePath));
      continue;
    }
    if (section.requirements.length === 0) {
      diagnostics.push(diagnostic(
        'XFORGE_SPEC_DELTA_SECTION_EMPTY',
        `${section.operation} Requirements declares no "### Requirement:" block.`,
        filePath,
        'error',
        { operation: section.operation, line: section.line },
      ));
      continue;
    }
    const seenNames = new Set<string>();
    for (const requirement of section.requirements) {
      if (requirement.name.length === 0) {
        diagnostics.push(diagnostic(
          'XFORGE_SPEC_DELTA_REQUIREMENT_UNNAMED',
          `A "### Requirement:" heading in ${section.operation} Requirements has no name.`,
          filePath,
          'error',
          { operation: section.operation, line: requirement.line },
        ));
        continue;
      }
      if (seenNames.has(requirement.name)) {
        diagnostics.push(diagnostic(
          'XFORGE_SPEC_DELTA_REQUIREMENT_DUPLICATE',
          `${section.operation} Requirements declares requirement "${requirement.name}" more than once.`,
          filePath,
          'error',
          { operation: section.operation, requirement: requirement.name, line: requirement.line },
        ));
        continue;
      }
      seenNames.add(requirement.name);
      // A removal only needs to name the requirement it deletes from the main Spec.
      if (section.operation === 'REMOVED') continue;
      diagnostics.push(...scenarioDiagnostics(section.operation, requirement, filePath));
    }
  }
  for (const orphan of parsed.orphanRequirements) {
    diagnostics.push(diagnostic(
      'XFORGE_SPEC_DELTA_REQUIREMENT_ORPHAN',
      `Requirement "${orphan.name || '(unnamed)'}" is not inside an ADDED, MODIFIED, REMOVED, or RENAMED Requirements section and would be dropped on archive.`,
      filePath,
      'error',
      { requirement: orphan.name, line: orphan.line },
    ));
  }
  return diagnostics;
}

export function specDeltaIsValid(source: string): boolean {
  return validateSpecDeltaSource(source, '').every((item) => item.severity !== 'error');
}

/**
 * A Flow may declare `validator: spec-delta` explicitly; otherwise any Artifact that writes
 * markdown under the Change's `specs/` tree is a delta Spec by convention.
 */
export function isSpecDeltaArtifact(artifact: ArtifactDefinition): boolean {
  if (artifact.validator) return artifact.validator === 'spec-delta';
  const generates = artifact.generates.replaceAll('\\', '/');
  return generates.startsWith('specs/') && generates.endsWith('.md');
}

export async function validateChangeSpecDeltas(project: ProjectContext, changeId: string): Promise<Diagnostic[]> {
  const changeDirectory = await safeResolve(project.root, `${project.changesPath}/${changeId}`);
  const deltaPaths = (await fg('specs/**/*.md', {
    cwd: changeDirectory, onlyFiles: true, followSymbolicLinks: false, dot: false, unique: true,
  })).sort();
  const diagnostics: Diagnostic[] = [];
  for (const relative of deltaPaths) {
    const source = await readFile(await safeResolve(changeDirectory, relative), 'utf8');
    diagnostics.push(...validateSpecDeltaSource(source, `${project.changesPath}/${changeId}/specs/${relative.slice('specs/'.length)}`));
  }
  return diagnostics;
}
