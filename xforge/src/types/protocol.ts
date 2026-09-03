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
  /**
   * What to run, for the diagnostics that know.
   *
   * A remedy has only ever been English inside `message`: of the 520 sites that raise one, the ones
   * that name a command name it in prose, and a reader has to parse it back out of a sentence. The
   * seven codes ending `_REMEDY` promise one in their name and deliver a paragraph.
   *
   * Deliberately narrow. Most diagnostics have no command -- the next step is work, or a decision,
   * or a human -- and inventing one for them would be worse than the prose. This is populated only
   * where the command is determinate, and `message` stays the authority: it says *why*, which is
   * the half a command cannot carry.
   *
   * `commands` rather than `command` because a block is routinely plural -- three undispatched
   * packages are three dispatches, and collapsing them to the first would name a step that does not
   * finish the job. An argv may contain a `<placeholder>` the reader has to fill; that is still
   * more useful than the same argv inside a sentence.
   */
  remedy?: { commands?: string[][] };
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
  /**
   * A starting document for an Action that writes a file no outline describes.
   *
   * `requiredSections` answers this for a Markdown Artifact: the Flow declares the `## ` headings
   * and the CLI states them verbatim. A `change.yaml` has no outline to declare — it is a schema,
   * not a document — so the shape lived as a fenced block inside `xforge-propose`, maintained by
   * hand, and a classification key added to the schema could ship as a guard the one Skill expected
   * to trigger it never mentioned. That happened to `moduleContract`.
   *
   * Rendered by the product with this project's own default Flow and first module substituted in,
   * because those are the two fields an author is most likely to accept unread.
   */
  template?: string;
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
