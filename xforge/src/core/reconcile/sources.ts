import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { ProjectContext, StageFlow, StageFlowArtifact } from '../../types.js';
import { CHECK_FINDINGS_PATH } from '../check-findings.js';
import { CONSTITUTION_CHECK_PATH } from '../constitution-check.js';
import { parseContractDelta } from '../contract-delta.js';
import { parseSpecDelta } from '../spec-delta.js';

import { flowArtifacts } from '../flow-resolver.js';
import { safeResolve } from '../path-safety.js';
import { loadYaml } from '../yaml.js';
import { requirementAnchor } from './model.js';
import type { ArtifactSource, ContractElement, SourceUnavailable, LedgerFinding, LedgerPrinciple, MaterialDecision, SpecRequirement } from './model.js';

/**
 * Reading the Artifacts and ledgers the reconciliation rules compare, and nothing else.
 *
 * Every function here answers "what does the repository say", never "is that acceptable" -- an
 * unreadable source becomes an `unavailable` entry rather than a judgement, because a report that
 * quietly drops a section it could not read is at its most reassuring exactly where it is least
 * entitled to be.
 */

/** Artifact ids a Stage at or before `stage` produces. Everything, once past the last Stage. */
function dueArtifactIds(flow: StageFlow, stage: string): Set<string> {
  const index = flow.stages.findIndex((entry) => entry.id === stage);
  const reached = index < 0 ? flow.stages : flow.stages.slice(0, index + 1);
  return new Set(reached.flatMap((entry) => entry.produces));
}
export async function readArtifactSources(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
  stage: string,
): Promise<{ sources: ArtifactSource[]; unavailable: SourceUnavailable[] }> {
  const sources: ArtifactSource[] = [];
  const unavailable: SourceUnavailable[] = [];
  const due = dueArtifactIds(flow, stage);
  for (const artifact of flowArtifacts(flow) as StageFlowArtifact[]) {
    // Only single-file Artifacts are sliceable by heading; a glob such as the delta-Spec pattern
    // is counted by the Requirement reader below instead.
    if (artifact.generates.includes('*')) continue;
    const relative = `${project.changesPath}/${changeId}/${artifact.generates}`;
    try {
      const absolute = await safeResolve(project.root, relative);
      sources.push({
        id: artifact.id,
        path: relative,
        content: await readFile(absolute, 'utf8'),
        markers: artifact.markers ?? [],
        due: due.has(artifact.id),
      });
    } catch {
      /* A not-yet-written Artifact is the normal case for a later Stage, not a failure. Only an
         Artifact the current Stage already required would be missing here, and the Gates report
         that far more precisely than a summary could. */
    }
  }
  return { sources, unavailable };
}
export async function readSpecRequirements(
  project: ProjectContext,
  changeId: string,
): Promise<{ requirements: SpecRequirement[]; unavailable: SourceUnavailable[] }> {
  const requirements: SpecRequirement[] = [];
  const unavailable: SourceUnavailable[] = [];
  const relative = `${project.changesPath}/${changeId}/specs`;
  let directory: string;
  try {
    directory = await safeResolve(project.root, relative);
  } catch {
    return { requirements, unavailable };
  }
  let files: string[] = [];
  try {
    files = (await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false })).sort();
  } catch {
    unavailable.push({ section: 'scale', code: 'XFORGE_RECONCILE_SPECS_UNREADABLE', reason: `Delta Spec directory could not be listed: ${relative}` });
    return { requirements, unavailable };
  }
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(directory, file), 'utf8');
    } catch {
      unavailable.push({ section: 'scale', code: 'XFORGE_RECONCILE_SPEC_UNREADABLE', reason: `Delta Spec could not be read: ${relative}/${file}` });
      continue;
    }
    const parsed = parseSpecDelta(content);
    for (const section of parsed.sections) {
      for (const requirement of section.requirements) {
        requirements.push({
          anchor: requirementAnchor(requirement.name),
          heading: requirement.name,
          operation: section.operation,
          file: `${relative}/${file}`,
          line: requirement.line,
          scenarios: requirement.scenarios.length,
        });
      }
    }
    for (const requirement of parsed.orphanRequirements) {
      requirements.push({
        anchor: requirementAnchor(requirement.name),
        heading: requirement.name,
        operation: 'ORPHAN',
        file: `${relative}/${file}`,
        line: requirement.line,
        scenarios: requirement.scenarios.length,
      });
    }
  }
  return { requirements, unavailable };
}
export async function readFindings(
  project: ProjectContext,
  changeId: string,
): Promise<{ findings: LedgerFinding[]; present: boolean; unavailable: SourceUnavailable[] }> {
  const relative = `${project.changesPath}/${changeId}/${CHECK_FINDINGS_PATH}`;
  const unavailable: SourceUnavailable[] = [];
  let document: { findings?: unknown };
  try {
    document = await loadYaml<{ findings?: unknown }>(await safeResolve(project.root, relative), relative);
  } catch {
    return { findings: [], present: false, unavailable };
  }
  if (!Array.isArray(document.findings)) {
    unavailable.push({ section: 'findings', code: 'XFORGE_RECONCILE_FINDINGS_UNREADABLE', reason: `Findings ledger has no findings list: ${relative}` });
    return { findings: [], present: true, unavailable };
  }
  const findings = document.findings.map((entry): LedgerFinding => {
    const value = (entry ?? {}) as Record<string, unknown>;
    const refs = Array.isArray(value.refs) ? value.refs.filter((item): item is string => typeof item === 'string') : [];
    return {
      id: typeof value.id === 'string' ? value.id : '(unnamed)',
      severity: typeof value.severity === 'string' ? value.severity : '(unset)',
      status: typeof value.status === 'string' ? value.status : '(unset)',
      summary: typeof value.summary === 'string' ? value.summary.trim() : '',
      refs,
      reworkTo: typeof value.reworkTo === 'string' ? value.reworkTo : '',
    };
  });
  return { findings, present: true, unavailable };
}
/** Decided material questions that name where their decision has to be written back. */
/**
 * The contract elements this Change's own deltas declare.
 *
 * The module comes out of the block body rather than out of a field the parser knows about, because
 * the delta is a document a person writes and `- module: api` is a convention its Artifact
 * instruction asks for, not a schema. A block that names none yields an empty module and the rule
 * that reads it says nothing -- an absent convention is not a difference between two records.
 */
export async function readContractElements(
  project: ProjectContext,
  changeId: string,
): Promise<{ elements: ContractElement[]; declared: boolean; unavailable: SourceUnavailable[] }> {
  const elements: ContractElement[] = [];
  const unavailable: SourceUnavailable[] = [];
  const relative = `${project.changesPath}/${changeId}/contracts`;
  let directory: string;
  try {
    directory = await safeResolve(project.root, relative);
  } catch {
    return { elements, declared: false, unavailable };
  }
  let files: string[] = [];
  try {
    files = (await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false })).sort();
  } catch {
    /* The directory simply not existing is the ordinary case for a Change that touches no interface,
       and `fg` returns an empty list for it rather than throwing. Reaching here means it exists and
       could not be listed, which is a source that could not be read. */
    unavailable.push({ section: 'contracts', code: 'XFORGE_RECONCILE_CONTRACTS_UNREADABLE', reason: `Contract delta directory could not be listed: ${relative}` });
    return { elements, declared: false, unavailable };
  }
  /* Whether the Change holds a contract delta at all, which is a different fact from whether that
     delta names anything: "(none)" in every section is an assertion, and silence is not. */
  const declared = files.length > 0;
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(directory, file), 'utf8');
    } catch {
      unavailable.push({ section: 'contracts', code: 'XFORGE_RECONCILE_CONTRACT_UNREADABLE', reason: `Contract delta could not be read: ${relative}/${file}` });
      continue;
    }
    for (const section of parseContractDelta(content).sections) {
      for (const element of section.elements) {
        elements.push({
          id: element.id,
          operation: section.operation,
          module: /^[ \t]*[-*+][ \t]+module:[ \t]*(\S.*)$/m.exec(element.content)?.[1]?.trim() ?? '',
          file: `${relative}/${file}`,
          line: element.line,
        });
      }
    }
  }
  return { elements, declared, unavailable };
}

export async function readMaterialDecisions(project: ProjectContext, changeId: string): Promise<MaterialDecision[]> {
  for (const extension of ['yaml', 'yml', 'json']) {
    const relative = `${project.changesPath}/${changeId}/evidence/conditions/materialQuestions.${extension}`;
    let document: { entries?: unknown };
    try { document = await loadYaml<{ entries?: unknown }>(await safeResolve(project.root, relative), relative); }
    catch { continue; }
    if (!Array.isArray(document.entries)) return [];
    return document.entries.flatMap((entry): MaterialDecision[] => {
      const value = (entry ?? {}) as Record<string, unknown>;
      const revises = Array.isArray(value.revises) ? value.revises.filter((item): item is string => typeof item === 'string') : [];
      if (revises.length === 0 || typeof value.decision !== 'string') return [];
      return [{
        id: typeof value.id === 'string' ? value.id : '(unnamed)',
        decision: value.decision,
        decidedAt: typeof value.decidedAt === 'string' ? value.decidedAt : '',
        revises,
      }];
    });
  }
  return [];
}
export async function readPrinciples(
  project: ProjectContext,
  changeId: string,
): Promise<{ principles: LedgerPrinciple[]; present: boolean; unavailable: SourceUnavailable[] }> {
  const relative = `${project.changesPath}/${changeId}/${CONSTITUTION_CHECK_PATH}`;
  const unavailable: SourceUnavailable[] = [];
  let document: { principles?: unknown };
  try {
    document = await loadYaml<{ principles?: unknown }>(await safeResolve(project.root, relative), relative);
  } catch {
    return { principles: [], present: false, unavailable };
  }
  if (!Array.isArray(document.principles)) {
    unavailable.push({ section: 'constitution', code: 'XFORGE_RECONCILE_CONSTITUTION_UNREADABLE', reason: `Constitution ledger has no principles list: ${relative}` });
    return { principles: [], present: true, unavailable };
  }
  const principles = document.principles.map((entry): LedgerPrinciple => {
    const value = (entry ?? {}) as Record<string, unknown>;
    const references = Array.isArray(value.references) ? value.references.filter((item): item is string => typeof item === 'string') : [];
    return {
      principle: typeof value.principle === 'string' ? value.principle : '(unnamed)',
      status: typeof value.status === 'string' ? value.status : '(unset)',
      references,
      approvedBy: typeof value.approvedBy === 'string' ? value.approvedBy : '',
    };
  });
  return { principles, present: true, unavailable };
}
