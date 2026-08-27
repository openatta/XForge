import type { ArtifactMarker } from '../../types.js';

/**
 * A Requirement heading's citable id, on the same reading as `core/constitution-check.ts`:
 * `### Requirement: REQ-042 Widget works` cites as `REQ-042`.
 *
 * Unlike that reader, this one refuses a first token that is not id-shaped. Coverage rules search
 * for this string inside other documents, and a bare English word ("Widget") matches prose that
 * has nothing to do with the Requirement — which would report coverage that does not exist. When
 * no id-shaped token is present the full heading is the anchor: long, but never a false positive.
 */
const ID_SHAPED = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

export function requirementAnchor(heading: string): string {
  const [first] = heading.trim().split(/\s+/);
  return first && ID_SHAPED.test(first) ? first : heading.trim();
}

type ReconciliationRule = 'RC-1' | 'RC-2' | 'RC-3' | 'RC-4' | 'RC-5' | 'RC-6';

/**
 * The rows reconciliation is computed from, named once so the readers and the rules cannot
 * describe the same thing two ways.
 *
 * They are internal: `ReconciliationObservation` is what a caller sees, and these are what it is
 * computed out of. Keeping them here is what lets the reading layer and the judging layer be
 * separate modules without either importing the other.
 */

export interface SourceUnavailable {
  section: string;
  code: string;
  reason: string;
}

export interface ReconciliationObservation {
  id: string;
  rule: ReconciliationRule;
  code: string;
  provenance: 'computed';
  /** States the difference between two records. Never says whether it is a problem. */
  summary: string;
  refs: string[];
}
export interface SpecRequirement {
  anchor: string;
  heading: string;
  operation: string;
  file: string;
  line: number;
  scenarios: number;
}
export interface ArtifactSource {
  id: string;
  /** Project-relative. */
  path: string;
  content: string;
  markers: ArtifactMarker[];
  /**
   * Whether a Stage at or before the current one produces this Artifact.
   *
   * A Change directory can hold a file the Flow does not expect yet — a stub written early, or one
   * left by a Stage this Change has since reworked away from. Auditing it at an earlier approval
   * reports absences that mean nothing: `assurance.md` does not name a Requirement at the design
   * approval because nobody has written the assurance yet, not because coverage is missing. Rules
   * that ask "does this section mention X" therefore run only against Artifacts that are due.
   */
  due: boolean;
}
export interface LedgerFinding {
  id: string;
  severity: string;
  status: string;
  summary: string;
  refs: string[];
  reworkTo: string;
}
export interface LedgerPrinciple {
  principle: string;
  status: string;
  references: string[];
  approvedBy: string;
}
export interface MaterialDecision {
  id: string;
  decision: string;
  decidedAt: string;
  revises: string[];
}
