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
 * actually has; `core/reconcile/sources.ts` reads the same declarations to locate what RC compares. Both refuse
 * to guess: a marker naming a section the Artifact does not contain is reported, never widened to
 * the whole document.
 */

interface DocumentSection {
  /** 1-based line of the `## ` heading itself. */
  line: number;
  body: string;
}

/**
 * The `## ` headings an `outline` declares, in the order it declares them.
 *
 * The outline is a Markdown fragment, so its own headings are read with the same rule the produced
 * document is read with. Anything deeper (`### `, `#### `) is a template for repeating structure
 * rather than a section, and is not a heading this compares.
 */
export function outlineSections(outline: string): string[] {
  const found: string[] = [];
  for (const line of outline.split(/\r?\n/)) {
    /* `###` cannot match: the pattern requires whitespace directly after the two hashes. */
    const match = /^##\s+(.*\S)\s*$/.exec(line);
    if (match) found.push(match[1]!);
  }
  return [...new Set(found)];
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
    const enforcesOutline = artifact.validator === 'outline';
    if ((markers.length === 0 && !enforcesOutline) || artifact.generates.includes('*')) continue;
    const relative = `${project.changesPath}/${changeId}/${artifact.generates}`;
    let content: string;
    try {
      content = await readFile(await safeResolve(project.root, relative), 'utf8');
    } catch {
      continue;
    }
    const parsed = documentSections(content);

    /*
     * `validator: outline` promotes the outline from instruction to requirement, for this Artifact
     * only and only where a Flow says so.
     *
     * A warning, matching the marker-section rule directly above it, and no shipped Flow declares
     * it. Both of those were decided by measurement rather than argument.
     *
     * Declared an error -- on the reasoning that an opt-in cannot fail anything written under the
     * previous reading -- it failed 176 of 574 tests the moment the shipped Flows adopted it. That
     * was not fixture debt: the fixtures write focused Artifacts carrying the sections that matter,
     * which is what a real minimal Change looks like, and Quick would have needed eleven headings
     * across two Artifacts to stay Quick.
     *
     * Demoted to a warning but still shipped on by default, it then fired on every clean run and
     * left `XFORGE_CHECK_PASSED_WITH_WARNINGS` permanently lit -- the failure the notice's own test
     * is named for ("stays quiet on a clean run, so the notice keeps meaning something"). A warning
     * every project always has is one every project learns to skip, which costs more than the rule
     * gains.
     *
     * So the capability ships and the decision to use it does not: a Flow that wants its outline
     * enforced says `validator: outline` on the Artifact where it matters, next to the outline it
     * enforces. A Flow that wants a section not merely present but populated already has a sharper
     * tool in a marker with `minOccurrences`.
     *
     * Only omission is checked. A section the outline does not list is left alone: an extra `##
     * Risks` in a design is usually more information rather than a defect, and requiring exact
     * equality pushes an author to bury content under a heading that does not fit it. What breaks
     * when a declared section goes missing is concrete -- markers keyed to it resolve to nothing,
     * a reconciliation rule keyed to that section finds nothing, and a reader promised coverage finds
     * nothing there.
     */
    if (enforcesOutline) {
      const missing = outlineSections(artifact.outline ?? '').filter((heading) => !parsed.has(heading));
      if (missing.length > 0) {
        diagnostics.push(diagnostic(
          'XFORGE_ARTIFACT_OUTLINE_SECTION_MISSING',
          `Artifact ${artifact.id} is missing ${missing.length} section(s) its Flow outline declares: ${missing.map((heading) => `"${heading}"`).join(', ')}. Anything keyed to those sections -- a marker, a reconciliation rule -- will find nothing there. Sections the outline does not list are not reported.`,
          relative,
          'warning',
        ));
      }
    }
    if (markers.length === 0) continue;
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
