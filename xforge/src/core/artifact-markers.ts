import { readFile } from 'node:fs/promises';
import type { ArtifactMarker, Diagnostic, ProjectContext, StageFlowArtifact } from '../types.js';
import { diagnostic } from './errors.js';
import { flowArtifacts, isStageFlow, resolveChangeState } from './flow-resolver.js';
import { safeResolve } from './path-safety.js';

/**
 * Flow-declared landmarks inside an Artifact, and the two things XForge does with them.
 *
 * `outline` says which `## ` sections an Artifact must have. A marker says what one of them is
 * *for* — which section records Requirement coverage, which entries are rejected alternatives,
 * which entries defer a question to a later Stage. That distinction is what lets a rule compute an
 * answer instead of asking somebody to read the prose and vouch for it.
 *
 * The `structure` Gate enforces `minOccurrences` so a declared shape is a shape the Artifact
 * actually has; `core/brief.ts` reads the same declarations to locate what it quotes. Both refuse
 * to guess: a marker naming a section the Artifact does not contain is reported, never widened to
 * the whole document.
 */

export interface DocumentSection {
  /** 1-based line of the `## ` heading itself. */
  line: number;
  body: string;
}

/** Splits a Markdown document into its `## ` sections, keyed by heading text. */
export function documentSections(content: string): Map<string, DocumentSection> {
  const found = new Map<string, DocumentSection>();
  const lines = content.split(/\r?\n/);
  let heading: string | null = null;
  let start = 0;
  let body: string[] = [];
  const close = (): void => {
    if (heading !== null) found.set(heading, { line: start, body: body.join('\n') });
    heading = null;
    body = [];
  };
  for (const [index, line] of lines.entries()) {
    // `## ` only. `### ` starts a Requirement, not a section, and must not close the one it is in.
    const match = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match && !line.startsWith('###')) {
      close();
      heading = match[1]!.trim();
      start = index + 1;
      continue;
    }
    if (heading !== null) body.push(line);
  }
  close();
  return found;
}

/**
 * Entries in `section` that match `marker`, with the 1-based document line each starts on.
 *
 * An entry runs from its marker to the end of its paragraph, not to the end of its line. Markdown
 * prose is hard-wrapped, so a one-line read of `**Rejected alternative:** signed stateless tokens.
 * Cheaper to verify and needs no // store, which is why...` returns a fragment ending mid-clause —
 * and a truncated quote is worse than no quote, because it still reads like the author's complete
 * sentence. Everything is joined verbatim; only the line breaks are normalized to spaces.
 */
export function markerOccurrences(section: DocumentSection, marker: ArtifactMarker): Array<{ line: number; text: string }> {
  if (!marker.pattern?.length) return [];
  const lines = section.body.split(/\r?\n/);
  const found: Array<{ line: number; text: string }> = [];
  for (const [index, line] of lines.entries()) {
    const matched = marker.pattern.find((prefix) => line.includes(prefix));
    if (!matched) continue;
    const paragraph = [line.slice(line.indexOf(matched))];
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = lines[next]!;
      /* A blank line ends the paragraph; so does the start of the next entry, which would
         otherwise be swallowed into the one before it. */
      if (!following.trim()) break;
      if (marker.pattern.some((prefix) => following.includes(prefix))) break;
      paragraph.push(following);
    }
    found.push({ line: section.line + index + 1, text: paragraph.join(' ').replace(/\s+/g, ' ').trim() });
  }
  return found;
}

/**
 * Structural diagnostics for every marker the active Flow declares.
 *
 * Only Artifacts that exist are checked. An Artifact a later Stage has not written yet is not a
 * violation of its own shape, and the Flow's own Stage requirements already decide when it is due.
 */
export async function validateArtifactMarkers(
  project: ProjectContext,
  changeId: string,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  let resolved: Awaited<ReturnType<typeof resolveChangeState>>;
  try {
    resolved = await resolveChangeState(project, changeId);
  } catch {
    /* An unresolvable Change is reported far more precisely by the caller that resolved it. */
    return diagnostics;
  }
  if (!isStageFlow(resolved.flow)) return diagnostics;

  for (const artifact of flowArtifacts(resolved.flow) as StageFlowArtifact[]) {
    const markers = artifact.markers ?? [];
    if (markers.length === 0 || artifact.generates.includes('*')) continue;
    const relative = `${project.changesPath}/${changeId}/${artifact.generates}`;
    let content: string;
    try {
      content = await readFile(await safeResolve(project.root, relative), 'utf8');
    } catch {
      continue;
    }
    const parsed = documentSections(content);
    for (const marker of markers) {
      const section = parsed.get(marker.section);
      if (!section) {
        /*
         * A warning, deliberately. `outline` has always been instruction rather than enforcement —
         * the shipped Flows describe sections no Gate has ever required — so promoting a missing
         * section to an error here would fail Changes that were valid before markers existed, for
         * a shape nothing had asked them to have. What the reader loses is one locating rule; what
         * an error would cost is every Change written under the previous reading.
         */
        diagnostics.push(diagnostic(
          'XFORGE_ARTIFACT_MARKER_SECTION_MISSING',
          `Artifact ${artifact.id} declares marker ${marker.id} in section "${marker.section}", which this file does not contain. Rules keyed on that marker will report nothing for this Artifact.`,
          relative,
          'warning',
        ));
        continue;
      }
      const minimum = marker.minOccurrences ?? 0;
      if (minimum === 0) continue;
      const occurrences = markerOccurrences(section, marker);
      if (occurrences.length >= minimum) continue;
      /* An error, equally deliberately: unlike the outline, `minOccurrences` is a Flow saying this
         section must carry at least N entries. Only a project that opted in ever reaches here. */
      diagnostics.push(diagnostic(
        'XFORGE_ARTIFACT_MARKER_UNDERPOPULATED',
        `Artifact ${artifact.id} section "${marker.section}" has ${occurrences.length} ${marker.id} entr${occurrences.length === 1 ? 'y' : 'ies'}, and the Flow requires at least ${minimum}.`,
        relative,
      ));
    }
  }
  return diagnostics;
}
