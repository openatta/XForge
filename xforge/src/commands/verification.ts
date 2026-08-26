import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext, VerificationEntry } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { validateSchema } from '../core/validator.js';
import { dumpYaml } from '../core/yaml.js';
import { parse as parseYaml } from 'yaml';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveWorkPackages } from '../core/work-packages.js';
import { legalTransitionTargets, resolveControlPlane } from '../core/control-plane.js';
import { VERIFICATION_RECEIPT_CONDITION, VERIFICATION_RECEIPT_PATH } from '../core/verification-receipt.js';

/**
 * Writes `manifest.verification` on the project's behalf, instead of asking an Agent to hand-edit
 * YAML into the one file it cannot afford to break.
 *
 * The Manifest is the governance dispatcher's input. When it does not parse or does not validate,
 * the dispatcher fails closed and denies every tool call — correctly, since it cannot vouch for a
 * policy set it cannot read. The consequence is a deadlock: the editor that broke the file is now
 * unable to open it. A live run reached exactly that state, having declared the right command but
 * indented it one level short, which swallowed `scaffold.mcpServers` into the new block:
 *
 *     verification:
 *       unit-tests:
 *         - command: [npm, test]
 *       mcpServers:            # belonged to scaffold:
 *         - enterprise-approvals
 *
 * `XFORGE_SCHEMA_INVALID`, then nothing worked, including the repair.
 *
 * XForge does not implement CRUD for every resource (`docs/internal/XFORGE_PRODUCT_SPEC.md` §5.9, unpublished), and this
 * is not a general exception to that. It is the same reasoning that already makes `approve`,
 * `transition` and `work-package` commands rather than files an Agent writes: correctness that
 * cannot be left to hand-editing, in a place where being wrong is expensive to undo. Everything a
 * project *authors* — Proposals, Specs, Designs, Skills — stays hand-written.
 *
 * Two properties make this worth the command:
 *
 * - **The result is validated before it is written.** A declaration that would produce a Manifest
 *   the dispatcher cannot load is refused, so this command cannot create the deadlock it exists to
 *   prevent.
 * - **Everything else in the file is preserved byte for byte.** Only the `verification:` block is
 *   rewritten, so comments, key order and formatting survive — the same discipline
 *   `reconcileDeclaredCliVersion` follows for the three version pins.
 */

interface VerificationDeclareOptions {
  gate: string;
  /** JSON array of argv, e.g. `["cargo","test"]`. */
  command?: string;
  module?: string;
  covers?: string;
  workingDirectory?: string;
  timeoutSeconds?: string;
  /** Marker path this Gate deliberately does not cover; mutually exclusive with `command`. */
  notApplicable?: string;
  justification?: string;
  by: string;
  dryRun: boolean;
}

function parseArgv(raw: string, option: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_COMMAND_INVALID',
      `${option} must be a JSON array of arguments, for example --command '["cargo","test"]'. A plain string is refused because splitting it would guess where the arguments are, and a command with a quoted argument would be split wrongly and silently.`,
    ));
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_COMMAND_INVALID',
      `${option} must be a non-empty JSON array of non-empty strings, for example --command '["cargo","test"]'.`,
    ));
  }
  return parsed as string[];
}

/**
 * Replaces the top-level `verification:` block, or appends one, leaving the rest of the file alone.
 *
 * The block is machine-owned, so re-serializing it costs nothing. Every other line is carried
 * across untouched, which is what keeps a project's own comments — and the ones this repository's
 * own tests assert survive an upgrade — from being erased by a YAML round trip.
 */
function withVerificationBlock(source: string, verification: Record<string, VerificationEntry[]>): string {
  const withoutBlock = source.replace(/^verification:\n(?:[ \t]+[^\n]*\n|\n(?=[ \t]))*/m, '');
  const trimmed = withoutBlock.replace(/\n+$/, '\n');
  if (Object.keys(verification).length === 0) return trimmed;
  return `${trimmed}${dumpYaml({ verification })}`;
}

export async function executeVerificationDeclare(
  project: ProjectContext,
  options: VerificationDeclareOptions,
): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  assertManaged(project, 'verification declare');
  if (Boolean(options.command) === Boolean(options.notApplicable)) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
      'Declare exactly one of --command (this is how the Gate runs) or --not-applicable (this Gate deliberately does not cover that toolchain).',
    ));
  }
  if (options.notApplicable && !options.justification) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
      '--not-applicable requires --justification. A toolchain left uncovered without a stated reason is indistinguishable from one nobody noticed.',
    ));
  }

  const declaredAt = new Date().toISOString();
  const entry: VerificationEntry = options.command
    ? {
      command: parseArgv(options.command, '--command'),
      ...(options.module ? { module: options.module } : {}),
      ...(options.covers ? { covers: parseArgv(options.covers, '--covers') } : {}),
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      ...(options.timeoutSeconds ? { timeoutSeconds: Number(options.timeoutSeconds) } : {}),
      declaredBy: options.by,
      declaredAt,
    }
    : { notApplicable: options.notApplicable!, justification: options.justification!, declaredBy: options.by, declaredAt };

  const relative = 'xforge/manifest.yaml';
  const absolute = path.join(project.root, 'xforge', 'manifest.yaml');
  const source = await readFile(absolute, 'utf8');
  const current = (parseYaml(source) ?? {}) as { verification?: Record<string, VerificationEntry[]> };
  const verification = { ...(current.verification ?? {}) };
  verification[options.gate] = [...(verification[options.gate] ?? []), entry];

  const next = withVerificationBlock(source, verification);

  /*
   * Validated before it reaches disk. This command exists because a malformed Manifest locks an
   * Agent out of repairing it, so producing one here would defeat the entire point — a refusal
   * costs a retry, a bad write costs the session.
   */
  const parsed = (() => {
    try { return parseYaml(next); }
    catch (error) { throw new XForgeError(diagnostic('XFORGE_VERIFICATION_WRITE_REFUSED', `Declaring this would produce a Manifest that no longer parses (${(error as Error).message}); nothing was written.`, relative)); }
  })();
  const schemaDiagnostics = await validateSchema('manifest', parsed, relative);
  if (schemaDiagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError([
      diagnostic('XFORGE_VERIFICATION_WRITE_REFUSED', 'Declaring this would produce a Manifest that fails validation, which would make the governance dispatcher deny every tool call. Nothing was written.', relative),
      ...schemaDiagnostics,
    ], { root: project.root });
  }

  if (!options.dryRun) await atomicWrite(project.root, relative, next);
  return {
    data: { gate: options.gate, entry, dryRun: options.dryRun, declarations: verification[options.gate]!.length },
    diagnostics: [],
    changes: next === source ? [] : [{ action: 'modify', path: relative, digest: sha256(next), source: `verification:${options.gate}` }],
  };
}

/**
 * The verification receipt's machine-known half, computed instead of transcribed.
 *
 * `work-package draft` exists because a Worker retyping `execution_id`, `base_commit` and three
 * bindings that XForge itself issued bought nothing and cost transcription errors. The verification
 * receipt is the same shape of problem and had no equivalent: of the five things
 * `core/verification-receipt.ts` decides a receipt on, exactly one — `status` — is a claim a person
 * or an Agent makes. `change`, `contentRevision`, `gitHead` and the cited Gate set are all facts
 * this process is already holding at the moment it asks somebody to write them down.
 *
 * A live XOps run wrote one by hand and made two errors doing it, and both were errors this
 * function cannot make:
 *
 * - It read `contentRevision` out of `xforge state` with `grep -m1`. That output carries one
 *   `contentRevision` per historical receipt, so the first match was an old one.
 * - It copied Gate Evidence digests into the receipt. Citations name the Gate, never a digest —
 *   see the note in `core/verification-receipt.ts` on why every per-run digest moves under ordinary
 *   progress — so the transcription was both laborious and wrong.
 *
 * What it deliberately does not produce, on the same principle as `work-package draft`:
 *
 * - `status` is absent. It is the assertion the receipt exists to record, and a CLI that filled it
 *   in would be deciding the thing it is asking about.
 * - Nothing is written to disk. The receipt is the Verify Stage's claim; filing it here would be
 *   signing that claim on the Stage's behalf.
 *
 * A Gate that has not passed at the current revision is reported rather than quietly omitted: a
 * draft that silently dropped it would produce a receipt that looks complete and cites less than
 * the Stage ran, which is the one thing `evaluate()` is there to catch.
 */
export async function executeVerificationDraftReceipt(project: ProjectContext, options: {
  change: string;
}): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  assertManaged(project, 'verification draft-receipt');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) {
    throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'verification draft-receipt requires a Protocol 2 governed Flow.'));
  }
  const resources = await loadSelectedResources(project);
  /* `resolveChangeState` always returns a null plan, so resolving without this would make the
     control plane read a Change that has no work packages — which now decides which branch
     `independentReview` takes. Its diagnostics are carried rather than dropped: a plan that failed
     to load must not produce a confidently drafted receipt. */
  const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config, { workPackages });
  /*
   * All four sources, and a refusal on any error — the shape `work-package draft` and `review
   * acknowledge` already use. The draft is read straight off `control.transitionRequirements`, so a
   * broken transition chain or a rejected review receipt surfaces only in `control.diagnostics`:
   * carrying just the plan's diagnostics still let this return a confident, complete-looking draft
   * built from a control plane that had failed. Throwing also avoids the mixed signal of reporting
   * `ok: false` while handing back a full receipt.
   */
  const resolveDiagnostics = [...resolved.diagnostics, ...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  if (resolveDiagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError(resolveDiagnostics, { root: project.root });
  }
  const { currentStage, revision } = control.governance;
  const stage = resolved.flow.stages.find((item) => item.id === currentStage);
  if (stage?.exit?.conditions?.[VERIFICATION_RECEIPT_CONDITION] === undefined) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_RECEIPT_NOT_REQUIRED',
      `Stage ${currentStage} of Flow ${resolved.flow.metadata.name} declares no ${VERIFICATION_RECEIPT_CONDITION} exit condition, so a receipt drafted here would satisfy nothing. Draft it at the Stage that declares it.`,
      `xforge/flows/${resolved.flow.metadata.name}.yaml`,
    ));
  }

  /*
   * Read off the forward transition rather than re-derived. `resolveControlPlane` has already
   * decided which Gate Evidence counts for leaving this Stage, applying `gateBlockReason` against
   * the current content revision; recomputing it here would be a second implementation of the same
   * judgement, free to disagree with the one that actually governs the transition. The forward
   * target is first in `legalTransitionTargets` by construction — reworks are appended after it.
   */
  const forward = legalTransitionTargets(resolved.flow, currentStage)[0];
  const requirement = forward ? control.transitionRequirements.get(forward) : undefined;
  const diagnostics: Diagnostic[] = [...resolveDiagnostics];
  const gates = (requirement?.gates ?? []).map((evidence) => ({ gate: evidence.gate, status: 'passed' as const }));
  for (const block of requirement?.blockedBy ?? []) {
    const [kind, gateId, reason] = block.split(':');
    if (kind !== 'gate') continue;
    diagnostics.push(diagnostic(
      'XFORGE_VERIFICATION_DRAFT_GATE_UNAVAILABLE',
      `Gate ${gateId} is ${reason} at the current content revision, so this draft cannot cite it — and a receipt omitting a Gate the Stage runs is refused. Run \`xforge check --change ${options.change}\` after your last write, then draft again.`,
      `${project.changesPath}/${options.change}`,
      'warning',
    ));
  }

  return {
    data: {
      change: options.change,
      target: `${project.changesPath}/${options.change}/${VERIFICATION_RECEIPT_PATH}`,
      /* Named rather than implied: the one field a person supplies, and what it means. */
      supply: ['status: passed — your assertion that this Stage verified the work. XForge will not write it for you.'],
      receipt: {
        change: options.change,
        contentRevision: revision.contentRevision,
        gitHead: revision.gitHead,
        gates,
      },
    },
    diagnostics,
    changes: [],
  };
}
