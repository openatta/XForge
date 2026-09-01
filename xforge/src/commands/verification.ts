import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext, VerificationEntry } from '../types.js';
import { isRetired, isVerificationRun } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { unattestedDeclarer } from '../core/ledger-identity.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { validateSchema } from '../core/validator.js';
import { dumpYaml } from '../core/yaml.js';
import { parse as parseYaml } from 'yaml';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveWorkPackages } from '../core/work-packages.js';
import { gateBlockReason, legalTransitionTargets, readGateEvidence, resolveControlPlane, type ResolvedControlPlane } from '../core/control-plane.js';
import { safeResolve } from '../core/path-safety.js';
import { VERIFICATION_RECEIPT_CONDITION, VERIFICATION_RECEIPT_PATH } from '../core/verification-receipt.js';
import { VERIFICATION_NOT_DECLARED, resolveVerificationPlan } from '../core/verification.js';

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

interface VerificationRetireOptions {
  gate: string;
  /** JSON argv identifying the run to withdraw, or the marker for a dismissal. */
  command?: string;
  notApplicable?: string;
  module?: string;
  by: string;
  reason: string;
  dryRun: boolean;
}

/**
 * Withdraws a declaration without removing it.
 *
 * `declare` was append-only, so a command declared for one phase of a project kept running in every
 * later one -- a live run's documentation-grep was still executing on every `unit-tests` Gate long
 * after the phase that needed it, and the only way to stop it was to hand-edit the Manifest that
 * `protected-manifest` governs. Gate cost grew with the project's history, and the history was the
 * only thing that could not be edited.
 *
 * Retirement rather than deletion, on the same reasoning that made `declaredBy` required in the
 * first place: nothing can decide mechanically whether a command verifies anything, so a project
 * that *stops* running one has made a judgement somebody should be able to find. The entry stays,
 * carries who withdrew it and why, and `core/verification.ts` skips it at the single point both
 * kinds of entry are read.
 */
export async function executeVerificationRetire(
  project: ProjectContext,
  options: VerificationRetireOptions,
): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  assertManaged(project, 'verification retire');
  if (Boolean(options.command) === Boolean(options.notApplicable)) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
      'Name exactly one of --command (the run to withdraw) or --not-applicable (the dismissal to withdraw).',
    ));
  }
  const relative = 'xforge/manifest.yaml';
  const absolute = path.join(project.root, 'xforge', 'manifest.yaml');
  const source = await readFile(absolute, 'utf8');
  const current = (parseYaml(source) ?? {}) as { verification?: Record<string, VerificationEntry[]> };
  const entries = current.verification?.[options.gate] ?? [];

  const wanted = options.command ? parseArgv(options.command, '--command') : null;
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !isRetired(entry))
    .filter(({ entry }) => (wanted
      ? isVerificationRun(entry) && JSON.stringify(entry.command) === JSON.stringify(wanted)
      : !isVerificationRun(entry) && entry.notApplicable === options.notApplicable))
    /* Only a run has a module. Casting a dismissal to one made `--module` match nothing rather than
       filter nothing, so retiring a dismissal by marker failed the moment the flag was present. */
    .filter(({ entry }) => options.module === undefined || !isVerificationRun(entry) || entry.module === options.module);

  if (matches.length === 0) {
    /*
     * What is still eligible, and separately what is not.
     *
     * This listed every entry, retired ones included and unmarked, so retiring the same command
     * twice answered "no active declaration matching that --command. It declares: [\"node\",...]"
     * — naming the entry it had just said did not exist, which reads as the command having failed
     * to match rather than as the entry having already been withdrawn.
     */
    const active = entries.filter((entry) => !isRetired(entry));
    const retired = entries.filter(isRetired);
    const argument = wanted ? '--command' : '--not-applicable';
    const declares = active.length === 0 ? '(none)' : active.map(describeEntry).join('; ');
    /* Built above the call rather than inline: `test/diagnostics-catalogue.ts` reads these call
       sites by splitting the argument list, and a template literal nested inside a `${}` ends the
       outer one as far as that parser is concerned — which drops the severity and records the code
       as `dynamic` in the catalogue fingerprint. */
    const alsoRetired = retired.length === 0 ? '' : ` Already retired, and not eligible again: ${retired.map(describeEntry).join('; ')}.`;
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_RETIRE_NOT_FOUND',
      `Gate ${options.gate} has no active declaration matching that ${argument}. It actively declares: ${declares}.${alsoRetired}`,
      relative,
    ));
  }
  if (matches.length > 1) {
    /* Two entries can share a command and differ by module or by what they cover, and picking one
       here would withdraw a check nobody chose to withdraw. */
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_RETIRE_AMBIGUOUS',
      /* `--module` is only advice when a module could tell them apart. Two dismissals of the same
         marker carry no field that selects one, so pointing at the flag would send a reader round a
         loop that cannot end. */
      `Gate ${options.gate} has ${matches.length} active declarations matching that argument: ${matches.map(({ entry }) => describeEntry(entry)).join('; ')}. ${matches.every(({ entry }) => isVerificationRun(entry))
        ? 'Add --module to name which one.'
        : 'A dismissal is identified by its marker alone, so no argument here can separate these two — the duplicate has to go from xforge/manifest.yaml, keeping the one whose justification still holds.'}`,
      relative,
    ));
  }

  const retiredAt = new Date().toISOString();
  const verification = { ...(current.verification ?? {}) };
  verification[options.gate] = entries.map((entry, index) => index === matches[0]!.index
    ? { ...entry, retiredBy: options.by, retiredAt, retiredReason: options.reason }
    : entry);

  const next = withVerificationBlock(source, verification);
  /* Wrapped for the reason `declare` wraps the identical call: this command exists because a
     malformed Manifest locks an Agent out of repairing it, and an unhandled YAML error here would
     hand back a stack trace where the other path hands back a diagnostic. */
  const parsed = (() => {
    try { return parseYaml(next); }
    catch (error) { throw new XForgeError(diagnostic('XFORGE_VERIFICATION_WRITE_REFUSED', `Retiring this would produce a Manifest that no longer parses (${(error as Error).message}); nothing was written.`, relative)); }
  })();
  const schemaDiagnostics = await validateSchema('manifest', parsed, relative);
  if (schemaDiagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError([
      diagnostic('XFORGE_VERIFICATION_WRITE_REFUSED', 'Retiring this would produce a Manifest that fails validation. Nothing was written.', relative),
      ...schemaDiagnostics,
    ], { root: project.root });
  }

  /*
   * What is left, counted the way the Gate runner counts it.
   *
   * `remainingActive` was one number over both kinds of entry, so withdrawing the last runnable
   * command from a Gate holding one dismissal reported `remainingActive: 1` and the next `check`
   * refused with `XFORGE_VERIFICATION_NOT_DECLARED`. A dismissal records a toolchain the Gate
   * deliberately does not cover; it is not a check and never closes a Gate — `core/verification.ts`
   * says so in as many words, and this command's own output was the thing contradicting it. The two
   * counts are reported separately because they answer different questions and nothing should have
   * to guess which one it is reading.
   */
  const remaining = verification[options.gate]!.filter((entry) => !isRetired(entry));
  const remainingRuns = remaining.filter(isVerificationRun);
  const remainingDismissals = remaining.length - remainingRuns.length;

  const diagnostics = [diagnostic(
    'XFORGE_VERIFICATION_RETIRED',
    `${describeEntry(matches[0]!.entry)} will no longer run for Gate ${options.gate}. It stays in the Manifest, recording that ${options.by} withdrew it: ${options.reason}.`,
    relative,
    'info',
  )];

  /*
   * And said out loud when the withdrawal closes the Gate.
   *
   * A required `builtin: declared` Gate with no command left refuses at every Stage that runs it,
   * which means it is no longer passable and no Change needing it can be archived. Silently is the
   * wrong way to learn that: the refusal arrives later, from a different command, about a Manifest
   * this one wrote. A warning rather than a refusal, because withdrawing the last command is a
   * legitimate thing to do on the way to declaring a replacement.
   */
  const spec = (await loadSelectedResources(project)).gates.get(options.gate)?.value.spec;
  if (remainingRuns.length === 0 && spec?.builtin === 'declared' && spec.required) {
    const leaves = options.dryRun ? 'Retiring this would leave' : 'This leaves';
    const refuses = options.dryRun ? 'would refuse' : 'will refuse';
    const declare = `xforge verification declare --gate-name ${options.gate} --command <argv> --by <person>`;
    /* Composed above the call, for the reason the refusal above is — see it. */
    const counted = remainingDismissals === 1 ? 'one entry' : `${remainingDismissals} entries`;
    const kind = remainingDismissals === 1 ? 'is a dismissal, which records' : 'are dismissals, which record';
    const dismissals = remainingDismissals === 0 ? '' : ` The ${counted} still active ${kind} a toolchain this Gate deliberately does not cover; a dismissal is not a check and never closes a Gate.`;
    diagnostics.push(diagnostic(
      'XFORGE_VERIFICATION_GATE_LEFT_UNDECLARED',
      `${leaves} Gate ${options.gate} with no command to run, and it is a required declared Gate: it ${refuses} with ${VERIFICATION_NOT_DECLARED} at every Stage that runs it, and no Change needing it can be archived until \`${declare}\` gives it one.${dismissals}`,
      relative,
      'warning',
    ));
  }

  if (!options.dryRun) await atomicWrite(project.root, relative, next);
  return {
    data: {
      gate: options.gate,
      retired: describeEntry(matches[0]!.entry),
      retiredBy: options.by,
      reason: options.reason,
      dryRun: options.dryRun,
      remainingRuns: remainingRuns.length,
      remainingDismissals,
    },
    diagnostics,
    changes: next === source ? [] : [{ action: 'modify', path: relative, digest: sha256(next), source: `verification:retire:${options.gate}` }],
  };
}

/** One declaration, named the way a person would name it when asking for it to be withdrawn. */
function describeEntry(entry: VerificationEntry): string {
  return isVerificationRun(entry)
    ? `${JSON.stringify(entry.command)}${entry.module ? ` (module ${entry.module})` : ''}`
    : `not-applicable ${entry.notApplicable}`;
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

  /* Recorded either way; the point is that it stops being silent. See `unattestedDeclarer`. */
  const unattested = await unattestedDeclarer(project.root, options.by);

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

  /*
   * A dismissal that names a marker nothing detected here, said out loud.
   *
   * `--not-applicable` takes a marker path from the detection report — `package.json`, `Cargo.toml`
   * — and a live run supplied `no-scan-toolchain`, a name it invented for the decision it was
   * recording. The declaration was accepted, returned `ok: true`, and could never match anything:
   * a real human decision recorded in a form that does nothing.
   *
   * A warning and never a refusal, and worded as what it is. A repository whose build system this
   * CLI does not recognise has legitimate dismissals for markers that will never appear in a
   * detection report, and refusing those would build exactly the dead end that the declared-Gate
   * refusal is being reworded to remove. This says the marker is not among what was detected; it
   * does not say the marker is wrong.
   */
  const diagnostics: Diagnostic[] = [];
  if (unattested) diagnostics.push(diagnostic('XFORGE_VERIFICATION_DECLARER_UNATTESTED', unattested, 'xforge/manifest.yaml', 'warning'));
  if (options.notApplicable) {
    const { detected } = await resolveVerificationPlan(project, options.gate);
    if (!detected.some((marker) => marker.marker === options.notApplicable)) {
      diagnostics.push(diagnostic(
        'XFORGE_VERIFICATION_DISMISSAL_UNMATCHED',
        `Recorded, and nothing here matches the marker ${options.notApplicable}. A dismissal answers a marker this CLI detected, by the path the detection reports${detected.length > 0 ? ` — found here: ${detected.map((marker) => marker.marker).join(', ')}` : ', and none was found in this project root or any declared module root'}. The decision stays on the record and is worth keeping; it will not close any marker while the path does not match one. If this project's build system is not one this CLI recognises, that is expected and no action is needed. To replace it, use \`xforge verification retire --gate-name ${options.gate} --not-applicable ${options.notApplicable} --by <person> --reason <why>\` and declare it again with the reported path.`,
        relative,
        'warning',
      ));
    }
  }

  if (!options.dryRun) await atomicWrite(project.root, relative, next);
  return {
    data: { gate: options.gate, entry, dryRun: options.dryRun, declarations: verification[options.gate]!.length },
    diagnostics,
    changes: next === source ? [] : [{ action: 'modify', path: relative, digest: sha256(next), source: `verification:${options.gate}` }],
  };
}


/** What both receipt commands read: the four fields nobody should be retyping, plus their basis. */
interface ReceiptFacts {
  /** The resolve itself, so a second caller can re-read Gate Evidence without paying for it twice. */
  control: ResolvedControlPlane;
  /**
   * Every Gate the current Stage names, whether or not its Evidence currently counts — the accepted
   * ones first, then the blocked ones. This is the Stage's declared Gate set as the control plane
   * enumerated it, not a second reading of the Flow.
   */
  referencedGates: string[];
  /** The `gate:<id>:<reason>` blocks the control plane raised, split into their parts. */
  blocked: Array<{ gate: string; reason: string }>;
  /**
   * Everything the resolve had to say that was not an error, carried rather than dropped.
   *
   * The resolve raises advisory notes a receipt's author is entitled to see — a `severity: must`
   * Rule that does not reach this Change's declared scope, for one — and swallowing them here would
   * quietly narrow what these commands report. An earlier revision of this refactor did exactly
   * that, and the envelope golden for `draft-receipt` is what caught it.
   */
  carried: Diagnostic[];
  /** The receipt's machine-known half. `status` is absent, deliberately; see the two callers. */
  receipt: { change: string; contentRevision: string; gitHead: string; gates: Array<{ gate: string; status: 'passed' }> };
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
 * This is one function because two commands need it. `draft-receipt` hands the facts back for an
 * Agent to finish by hand; `finalize` confirms them against disk and files the result itself. A
 * second derivation of "which Gates does this Stage cite" would be free to disagree with the first,
 * and the disagreement that matters is the invisible one — a receipt that looks complete and cites
 * less than the Stage ran, which is the single thing `evaluate()` exists to catch. Trading a
 * transcription risk for a divergence risk is not a trade worth making.
 *
 * A Gate that has not passed at the current revision is reported rather than quietly omitted, for
 * the same reason.
 */
async function resolveReceiptFacts(project: ProjectContext, change: string, command: string): Promise<ReceiptFacts> {
  assertManaged(project, command);
  const resolved = await resolveChangeState(project, change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) {
    throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', `${command} requires a Protocol 2 governed Flow.`));
  }
  const resources = await loadSelectedResources(project);
  /* `resolveChangeState` always returns a null plan, so resolving without this would make the
     control plane read a Change that has no work packages — which now decides which branch
     `independentReview` takes. Its diagnostics are carried rather than dropped: a plan that failed
     to load must not produce a confidently drafted receipt. */
  const workPackages = await resolveWorkPackages(project, change, resolved.config, resources);
  const control = await resolveControlPlane(project, change, resolved.flow, resolved.state, resources, resolved.config, { workPackages });
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
      `Stage ${currentStage} of Flow ${resolved.flow.metadata.name} declares no ${VERIFICATION_RECEIPT_CONDITION} exit condition, so a receipt produced here would satisfy nothing. Write it at the Stage that declares it.`,
      `xforge/flows/${resolved.flow.metadata.name}.yaml`,
    ));
  }

  /*
   * Read off the forward transition rather than re-derived. `resolveControlPlane` has already
   * decided which Gate Evidence counts for leaving this Stage, applying `gateBlockReason` against
   * the current content revision; recomputing it here would be a second implementation of the same
   * judgement, free to disagree with the one that actually governs the transition. The forward
   * target is first in `legalTransitionTargets` by construction — reworks are appended after it.
   *
   * `finalize` does go back to disk for each of these Gates, which is not the same thing: it re-runs
   * the exported predicate over the same bytes, and it never re-decides *which* Gates the Stage
   * cites. That set is enumerated once, here, so the two commands cannot cite different Gates.
   */
  const forward = legalTransitionTargets(resolved.flow, currentStage)[0];
  const requirement = forward ? control.transitionRequirements.get(forward) : undefined;
  const gates = (requirement?.gates ?? []).map((evidence) => ({ gate: evidence.gate, status: 'passed' as const }));
  const blocked = (requirement?.blockedBy ?? [])
    .map((block) => block.split(':'))
    .filter(([kind]) => kind === 'gate')
    .map(([, gate, reason]) => ({ gate: gate!, reason: reason! }));

  return {
    control,
    referencedGates: [...gates.map((citation) => citation.gate), ...blocked.map((entry) => entry.gate)],
    blocked,
    carried: resolveDiagnostics,
    receipt: { change, contentRevision: revision.contentRevision, gitHead: revision.gitHead, gates },
  };
}

/**
 * The facts, handed back for an Agent to finish by hand.
 *
 * What it deliberately does not produce, on the same principle as `work-package draft`:
 *
 * - `status` is absent. It is the assertion the receipt exists to record, and a CLI that filled it
 *   in would be deciding the thing it is asking about.
 * - Nothing is written to disk. The receipt is the Verify Stage's claim; filing it here would be
 *   signing that claim on the Stage's behalf.
 *
 * `finalize` below is the same facts with both of those supplied explicitly — a named person's
 * `--status passed` — so the two commands differ in exactly the place the difference belongs.
 */
export async function executeVerificationDraftReceipt(project: ProjectContext, options: {
  change: string;
}): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  const facts = await resolveReceiptFacts(project, options.change, 'verification draft-receipt');
  const diagnostics: Diagnostic[] = [...facts.carried, ...facts.blocked.map(({ gate, reason }) => diagnostic(
    'XFORGE_VERIFICATION_DRAFT_GATE_UNAVAILABLE',
    `Gate ${gate} is ${reason} at the current content revision, so this draft cannot cite it — and a receipt omitting a Gate the Stage runs is refused. Run \`xforge check --change ${options.change}\` after your last write, then draft again.`,
    `${project.changesPath}/${options.change}`,
    'warning',
  ))];

  return {
    data: {
      change: options.change,
      target: `${project.changesPath}/${options.change}/${VERIFICATION_RECEIPT_PATH}`,
      /* Named rather than implied: the one field a person supplies, and what it means. */
      supply: ['status: passed — your assertion that this Stage verified the work. XForge will not write it for you.'],
      receipt: facts.receipt,
    },
    diagnostics,
    changes: [],
  };
}

interface VerificationFinalizeOptions {
  change: string;
  /** Only `passed` is written; see the refusal below for why there is no second value. */
  status: string;
  by: string;
  dryRun: boolean;
}

/**
 * The re-run, the fix, and the first run — three remedies that must not read as one.
 *
 * The stale sentence deliberately repeats the mechanism `check` gives with
 * `XFORGE_GATE_EVIDENCE_STALE`, because the two describe one condition from opposite sides: that one
 * warns while the Gates are still in front of you, this one refuses when a receipt is about to cite
 * them. Two wordings for one fact would read as two problems.
 */
function unconfirmedGateMessage(gate: string, reason: 'missing' | 'failed' | 'stale', change: string, contentRevision: string): string {
  const rerun = `\`xforge check --change ${change} --gate ${gate}\``;
  if (reason === 'stale') {
    return `Gate ${gate} holds Evidence that passed against an earlier content revision and no longer binds the current one, which is ${contentRevision}. Gate Evidence binds to the Change's content at the moment the Gate runs, so writing any declared Artifact after a Gate passes stales it; nothing else about this Gate is wrong. It is refused here rather than cited because a receipt naming it would vouch for content the Gate never saw. Re-run it with ${rerun}, then finalize again. Nothing was written.`;
  }
  if (reason === 'failed') {
    return `Gate ${gate} holds Evidence bound to the current content revision and it does not report a pass, so there is nothing here for a receipt to record. This is not staleness and re-running alone will not clear it: fix what the Gate found, then run ${rerun} and finalize again. Nothing was written.`;
  }
  return `Gate ${gate} has no Evidence that reads back as its own, so this Stage has not run it — what is missing is a first run, not a re-run. Run ${rerun}, then finalize again. Nothing was written.`;
}

/**
 * The receipt, written by the process that already knows what it says.
 *
 * `draft-receipt` removed the retyping but not the hand-write: an Agent still copied four computed
 * fields into a file and added `status: passed`. A field report called that the last hand-written
 * file in the whole workflow, and therefore the last place a transcription error can enter, and
 * asked for an atomic finish. This is it — the same facts, from the same derivation, written in one
 * `atomicWrite` instead of assembled by hand.
 *
 * The reason this is `finalize` rather than `write` is the second half. Before it records that each
 * Gate passed, it re-reads that Gate's Evidence from disk and re-applies `gateBlockReason`, the same
 * predicate the control plane blocks the transition on. That is not a second implementation of the
 * judgement — it is the same predicate over the same bytes, run again at the moment of writing —
 * and it is what makes this a verification rather than a transcription with better ergonomics. A
 * file asserting "these Gates passed" should be produced by something that has just looked.
 *
 * A blocked Gate is refused, never omitted, and the three reasons are not interchangeable: a stale
 * Gate needs re-running, a failed Gate needs its finding fixed, a missing Gate needs running for the
 * first time. Collapsing them would send somebody hunting a defect in a Gate that merely ran before
 * the last edit — which is why `blockRemedy` in `core/control-plane.ts` spells each one out
 * separately, and why `check`'s `XFORGE_GATE_EVIDENCE_STALE` says outright that nothing else about a
 * stale Gate is wrong.
 *
 * `--by` is required on the same terms as `declare` and `retire`: nothing here can decide
 * mechanically that the work was verified, so the file records who answered. It is a name on an
 * assertion, not an authorisation — what vouches for the verification is the Gate Evidence this
 * function has just confirmed.
 */
export async function executeVerificationFinalize(
  project: ProjectContext,
  options: VerificationFinalizeOptions,
): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  if (options.status !== 'passed') {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_STATUS_UNSUPPORTED',
      `--status ${options.status} is refused; passed is the only status this writes. A verification receipt is a positive assertion that the Stage verified the work, so a Stage that did not verify does not file one at all — leaving it absent keeps the exit condition blocked, which is the accurate record of a Change nobody has verified. Nothing was written.`,
    ));
  }

  const facts = await resolveReceiptFacts(project, options.change, 'verification finalize');
  const { contentRevision } = facts.receipt;
  /*
   * Read again, from disk, one Gate at a time. `facts.blocked` already says which Gates the control
   * plane refused and why, and citing that would be enough to refuse correctly — but it would make
   * this command a report on somebody else's read rather than its own, and the whole reason the
   * receipt is worth writing is that something looked.
   */
  const refusals: Diagnostic[] = [];
  const cited: Array<{ gate: string; status: 'passed' }> = [];
  for (const gate of facts.referencedGates) {
    const evidence = await readGateEvidence(project, options.change, gate, facts.control.resources);
    const reason = gateBlockReason(evidence, contentRevision);
    if (!reason) { cited.push({ gate, status: 'passed' }); continue; }
    refusals.push(diagnostic(
      'XFORGE_VERIFICATION_FINALIZE_GATE_UNCONFIRMED',
      unconfirmedGateMessage(gate, reason, options.change, contentRevision),
      `${project.changesPath}/${options.change}`,
    ));
  }
  if (refusals.length > 0) throw new XForgeError(refusals, { root: project.root });

  const relative = `${project.changesPath}/${options.change}/${VERIFICATION_RECEIPT_PATH}`;
  const content = dumpYaml({
    change: options.change,
    status: 'passed',
    contentRevision,
    gitHead: facts.receipt.gitHead,
    gates: cited,
    finalizedBy: options.by,
    finalizedAt: new Date().toISOString(),
  });
  /* Asked before the write, so `create` and `modify` stay true under `--dry-run` as well: a plan
     that reports the wrong verb about a file the reader may already have is worse than no plan. */
  const existed = await access(await safeResolve(project.root, relative)).then(() => true, () => false);
  if (!options.dryRun) await atomicWrite(project.root, relative, content);
  /*
   * `changes` is reported either way. Every other command in this product answers "what would this
   * do" with its plan, and an empty list reads as "this would change nothing" — which for the one
   * command whose entire job is to write a file would be a lie.
   */
  return {
    data: {
      change: options.change,
      target: relative,
      dryRun: options.dryRun,
      receipt: { change: options.change, status: 'passed', contentRevision, gitHead: facts.receipt.gitHead, gates: cited },
      /* Named so the answer to "what did it actually check" is in the output, not only in the code. */
      confirmedGates: cited.map((citation) => citation.gate),
    },
    diagnostics: facts.carried,
    changes: [{ action: existed ? 'modify' : 'create', path: relative, digest: sha256(content), source: 'verification:finalize' }],
  };
}
