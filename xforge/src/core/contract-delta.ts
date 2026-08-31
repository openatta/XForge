import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import type { ArtifactDefinition, Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { safeResolve } from './path-safety.js';

type DeltaOperation = 'ADDED' | 'MODIFIED' | 'REMOVED';

interface ParsedContractElement {
  id: string;
  line: number;
  content: string;
}

interface ParsedContractSection {
  operation: DeltaOperation;
  line: number;
  elements: ParsedContractElement[];
  /** True when the section says `(none)` -- an assertion that it is empty rather than an omission. */
  assertedEmpty: boolean;
}

interface ParsedContractDelta {
  sections: ParsedContractSection[];
  orphanElements: ParsedContractElement[];
}

/*
 * Deliberately mirrors the header shapes core/contract-merger.ts recognises at archive time, for the
 * same reason core/spec-delta.ts does: anything this validator accepts still merges, and anything it
 * rejects would have failed later, after a human had approved it.
 *
 * English literals with no localisation table, matching spec-delta. That is a real constraint on a
 * bilingual product and it is the existing one: the section headers are a wire format between two
 * modules, not prose, and a Flow outline is what tells an author which words to type.
 */
const SECTION_HEADER = /^## (ADDED|MODIFIED|REMOVED) Contract Elements[ \t]*$/;
const OTHER_SECTION_HEADER = /^## /;
const ELEMENT_HEADER = /^### Element:[ \t]*(.*)$/;
const OTHER_ELEMENT_HEADER = /^### /;
/** The `(none)` assertion, on a line of its own, with or without a list marker. */
const EMPTY_ASSERTION = /^[ \t]*(?:[-*+][ \t]+)?\(none\)[ \t]*$/i;

/**
 * A contract element id: `<kind>:<selector>`.
 *
 * The kind is an adapter id and carries the same shape every other resource id does, because that is
 * what makes an id resolvable -- `openapi:paths./orders.post` names the adapter that can be asked
 * about it. The selector is opaque: it is the dialect's own address space, and a governance layer
 * that constrained its shape would be deciding what OpenAPI or protobuf are allowed to call things.
 * What it may not contain is whitespace, because the id has to survive being a heading, a `refs`
 * entry and a `blockedBy` token without needing to be quoted in any of them.
 */
const ELEMENT_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:\S+$/;

export function hasContractDeltaSections(source: string): boolean {
  return source.split(/\r?\n/).some((line) => SECTION_HEADER.test(line));
}

export function parseContractDelta(source: string): ParsedContractDelta {
  const sections: ParsedContractSection[] = [];
  const orphanElements: ParsedContractElement[] = [];
  let section: ParsedContractSection | null = null;
  let element: ParsedContractElement | null = null;
  let elementLines: string[] = [];

  const closeElement = (): void => {
    if (!element) return;
    element.content = elementLines.join('\n').trimEnd();
    if (section) section.elements.push(element);
    else orphanElements.push(element);
    element = null;
    elementLines = [];
  };
  const closeSection = (): void => {
    closeElement();
    if (section) sections.push(section);
    section = null;
  };

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const number = index + 1;
    const sectionMatch = SECTION_HEADER.exec(line);
    if (sectionMatch) {
      closeSection();
      section = { operation: sectionMatch[1] as DeltaOperation, line: number, elements: [], assertedEmpty: false };
      continue;
    }
    if (OTHER_SECTION_HEADER.test(line)) {
      /* A section this document does not own -- `## Breaking Changes`, `## Consumer Impact`. It ends
         the operation section without becoming one, so its prose is never read as an element. */
      closeSection();
      continue;
    }
    const elementMatch = ELEMENT_HEADER.exec(line);
    if (elementMatch) {
      closeElement();
      element = { id: elementMatch[1]!.trim(), line: number, content: '' };
      elementLines = [line];
      continue;
    }
    if (OTHER_ELEMENT_HEADER.test(line)) {
      closeElement();
      continue;
    }
    if (element) { elementLines.push(line); continue; }
    if (section && EMPTY_ASSERTION.test(line)) section.assertedEmpty = true;
  }
  closeSection();
  return { sections, orphanElements };
}

/**
 * Validates the markdown structure of one contract delta.
 *
 * Structural failures here are the same failures core/contract-merger.ts would raise at archive
 * time, reported at check time instead -- the posture core/spec-merger.ts's feasibility check
 * explains at length, and for the same reason: the route back from an archive-time merge conflict
 * voids an approval that has already been given.
 */
export function validateContractDeltaSource(source: string, filePath: string): Diagnostic[] {
  if (source.trim().length === 0) {
    return [diagnostic('XFORGE_CONTRACT_DELTA_FILE_EMPTY', 'Contract delta file is empty.', filePath)];
  }
  const parsed = parseContractDelta(source);
  if (parsed.sections.length === 0) {
    return [diagnostic(
      'XFORGE_CONTRACT_DELTA_NO_SECTION',
      'A contract delta must declare at least one "## ADDED Contract Elements", "## MODIFIED Contract Elements", or "## REMOVED Contract Elements" section.',
      filePath,
    )];
  }

  const diagnostics: Diagnostic[] = [];
  const seenOperations = new Set<DeltaOperation>();
  /* Across sections, not per section. "Added and also removed" is not a merge archive can perform in
     either order, and the two orders disagree about whether the element ends up in the baseline. */
  const seenIds = new Map<string, DeltaOperation>();

  for (const section of parsed.sections) {
    if (seenOperations.has(section.operation)) {
      diagnostics.push(diagnostic(
        'XFORGE_CONTRACT_DELTA_SECTION_DUPLICATE',
        `The contract delta declares "## ${section.operation} Contract Elements" more than once; only the first section is merged.`,
        filePath,
        'error',
        { operation: section.operation, line: section.line },
      ));
      continue;
    }
    seenOperations.add(section.operation);

    if (section.elements.length === 0 && !section.assertedEmpty) {
      diagnostics.push(diagnostic(
        'XFORGE_CONTRACT_DELTA_SECTION_EMPTY',
        `${section.operation} Contract Elements declares no "### Element:" block and does not say "(none)". A blank section cannot be told apart from one nobody reached; "(none)" asserts there is nothing here.`,
        filePath,
        'error',
        { operation: section.operation, line: section.line },
      ));
      continue;
    }
    if (section.elements.length > 0 && section.assertedEmpty) {
      diagnostics.push(diagnostic(
        'XFORGE_CONTRACT_DELTA_SECTION_CONTRADICTORY',
        `${section.operation} Contract Elements says "(none)" and also declares ${section.elements.length} element(s). One of the two is wrong and this document cannot say which.`,
        filePath,
        'error',
        { operation: section.operation, line: section.line },
      ));
      continue;
    }

    for (const element of section.elements) {
      if (element.id.length === 0) {
        diagnostics.push(diagnostic(
          'XFORGE_CONTRACT_DELTA_ELEMENT_UNNAMED',
          `A "### Element:" heading in ${section.operation} Contract Elements has no id.`,
          filePath,
          'error',
          { operation: section.operation, line: element.line },
        ));
        continue;
      }
      if (!ELEMENT_ID.test(element.id)) {
        diagnostics.push(diagnostic(
          'XFORGE_CONTRACT_DELTA_ELEMENT_ID_INVALID',
          `"${element.id}" is not a contract element id. An id is "<kind>:<selector>" with no whitespace, where the kind names the dialect it can be looked up in — for example openapi:paths./orders.post.`,
          filePath,
          'error',
          { operation: section.operation, element: element.id, line: element.line },
        ));
        continue;
      }
      const already = seenIds.get(element.id);
      if (already !== undefined) {
        diagnostics.push(diagnostic(
          'XFORGE_CONTRACT_DELTA_ELEMENT_DUPLICATE',
          already === section.operation
            ? `${section.operation} Contract Elements declares "${element.id}" more than once.`
            : `"${element.id}" is declared under both ${already} and ${section.operation} Contract Elements, which are two different merges and cannot both be performed.`,
          filePath,
          'error',
          { operation: section.operation, element: element.id, line: element.line },
        ));
        continue;
      }
      seenIds.set(element.id, section.operation);
    }
  }

  for (const orphan of parsed.orphanElements) {
    diagnostics.push(diagnostic(
      'XFORGE_CONTRACT_DELTA_ELEMENT_ORPHAN',
      `Element "${orphan.id || '(unnamed)'}" is not inside an ADDED, MODIFIED, or REMOVED Contract Elements section and would be dropped on archive.`,
      filePath,
      'error',
      { element: orphan.id, line: orphan.line },
    ));
  }
  return diagnostics;
}

export function contractDeltaIsValid(source: string): boolean {
  return validateContractDeltaSource(source, '').every((item) => item.severity !== 'error');
}

/**
 * A Flow may declare `validator: contract-delta` explicitly; otherwise any Artifact that writes
 * markdown under the Change's `contracts/` tree is a contract delta by convention.
 *
 * The first branch is what keeps this and `isSpecDeltaArtifact` from ever both claiming the same
 * Artifact: an explicit validator answers for itself, so a `spec-delta` under `contracts/` is a Spec
 * delta and nothing here disagrees.
 */
export function isContractDeltaArtifact(artifact: ArtifactDefinition): boolean {
  if (artifact.validator) return artifact.validator === 'contract-delta';
  const generates = artifact.generates.replaceAll('\\', '/');
  return generates.startsWith('contracts/') && generates.endsWith('.md');
}

export async function validateChangeContractDeltas(project: ProjectContext, changeId: string): Promise<Diagnostic[]> {
  const changeDirectory = await safeResolve(project.root, `${project.changesPath}/${changeId}`);
  const deltaPaths = (await fg('contracts/**/*.md', {
    cwd: changeDirectory, onlyFiles: true, followSymbolicLinks: false, dot: false, unique: true,
  })).sort();
  const diagnostics: Diagnostic[] = [];
  for (const relative of deltaPaths) {
    const source = await readFile(await safeResolve(changeDirectory, relative), 'utf8');
    diagnostics.push(...validateContractDeltaSource(source, `${project.changesPath}/${changeId}/${relative}`));
  }
  return diagnostics;
}
