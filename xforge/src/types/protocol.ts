import type { TargetId } from '../constants.js';
import type { FlowAuthority } from './flow.js';

/**
 * Everything a command returns, independent of what the command does.
 *
 * The envelope, its diagnostics, its file changes and its next actions: the shape every caller
 * parses, and the only part of this package a consumer can depend on without knowing anything about
 * Flows or Changes.
 */

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  details?: unknown;
}

export interface FileChange {
  action: 'create' | 'modify' | 'delete' | 'move' | 'skip' | 'conflict';
  path: string;
  from?: string;
  digest?: string;
  source?: string;
  target?: TargetId;
  reason?: string;
}

export interface NextAction {
  action: string;
  reason: string;
  type?: 'artifact' | 'transition' | 'approval' | 'gate' | 'archive' | 'governance' | 'maintenance';
  id?: string;
  status?: 'ready' | 'blocked' | 'pending';
  blockedBy?: string[];
  command?: string[];
  actor?: 'main' | 'worker' | 'integrator' | 'reviewer' | 'human' | 'system';
  authority?: FlowAuthority;
  inputs?: string[];
  writes?: string[];
  /**
   * The `## ` headings this Artifact's Flow outline declares, verbatim.
   *
   * `outline` is a Markdown fragment in the Flow, and reads to an author as a suggested shape
   * rather than a literal one. A live run that was told nothing else wrote every required section
   * of two Artifacts and then, on the third, decorated two headings it wanted to qualify --
   * `## Completeness` became `## Completeness (at the current revision)`. The content was right and
   * the heading no longer resolved, which breaks anything keyed to it: markers, and the passages
   * `core/reconcile/sources.ts` reads to locate what RC-1 and RC-3 compare.
   *
   * Stated here for the same reason `writes` is: the CLI knows the answer at the moment the author
   * needs it, and a fact the product can state is one no Skill has to carry.
   */
  requiredSections?: string[];
  doneWhen?: string[];
  requiredEvidence?: string[];
  reworkTo?: string[];
}

export type ScaffoldLanguage = 'en' | 'zh-CN';

export interface Envelope<T = unknown> {
  protocolVersion: '2';
  ok: boolean;
  command: string;
  root: string | null;
  data: T | null;
  diagnostics: Diagnostic[];
  changes: FileChange[];
  nextActions: NextAction[];
}
