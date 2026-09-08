import type { ChangeState, Diagnostic, FileChange, FlowAuthority, NextAction, ProjectContext } from '../types.js';
import { CLASSIFICATION_KEYS, changeTemplate } from '../core/change-template.js';
import { WORK_PACKAGE_PLAN_HEADER_KEYS, workPackagePlanTemplate } from '../core/work-package-template.js';
import { outlineSections } from '../core/artifact-markers.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { executeState } from './state.js';

/**
 * What the caller could do next, and how a write hands back the state it produced.
 *
 * Both functions here are read by more than one command -- `nextActionsFor` by `state`, `advance`
 * and `stage`, `withPostState` by every command that moves a Change -- and both lived in `cli.ts`
 * beside the argument parser, which is the one place in this codebase with no business holding
 * domain logic. Nothing about them changed in the move; `flowStages` and `StageSummary` come along
 * because they are read only by these two and by the commands that call them.
 */

/** A Flow Stage exactly as `readState` summarises it (see core/state-reader.ts). */
/**
 * A Flow Stage *as `readState` reports it*, which is not the shape the Flow declares.
 *
 * `state-reader.ts` flattens a Stage on the way out: `exit.gates` is unioned into `gates` and
 * `exit.conditions` becomes a top-level `exitConditions` array of keys. There is no `exit` member
 * on the payload at all. This type used to declare one anyway, and `stage` read
 * `definition.exit?.conditions` through it — which is `undefined` for every Stage of every Flow, so
 * `stageDeclares.exitConditions` answered `[]` always. The field exists so an Agent does not have
 * to open `xforge/flows/*.yaml`, and it was confidently telling Verify it had no exit conditions
 * while `verificationReceipt` was the thing about to refuse its Transition.
 *
 * So the type now says what arrives, and nothing more. An `exit` that is not there cannot be read
 * through a declaration that admits it exists; removing it is what makes the compiler answer this
 * question instead of the next reader.
 */
interface StageSummary {
  id: string;
  authority?: FlowAuthority;
  produces?: string[];
  /** Already the union of the Stage's own `gates` and its `exit.gates` — see `flowDetail`. */
  gates?: string[];
  reworkTo?: string[];
  /** The keys of `exit.conditions`, flattened by `readState`. */
  exitConditions?: string[];
}

/**
 * The Stages of the Flow the selected Change is running, taken from the state read that was just
 * performed rather than re-resolved.
 *
 * `nextActions` used to stamp a hardcoded `authority` on the Actions it emits, which made
 * `create-artifact` announce `planning-write` for every Artifact — including the ones whose Stage
 * declares `assurance-write`. Nothing in XForge compares an authority against an operation today, so
 * a hardcoded value cannot restrict anything; all it can do is misinform a reader who believes it,
 * and the Skill text does tell the Agent to match on it. The value therefore comes from the Flow
 * Stage that actually produces the Artifact, or is omitted when no Stage answers for the Action.
 */
export function flowStages(data: Record<string, unknown>, flowId: string | undefined): StageSummary[] {
  const flows = (data.flows ?? []) as Array<{ id?: string; stages?: StageSummary[] | null }>;
  return flows.find((flow) => flow.id === flowId)?.stages ?? [];
}


/**
 * Everything the caller could do next, computed from a resolved state payload.
 *
 * Extracted so that commands which *change* something can answer with it too. `transition` used to
 * return `nextActions: []` -- a successful Stage move read as "nothing left to do", and the only way
 * to learn the new Stage's Actions was a fresh `state` call. Across twenty recorded runs `state` was
 * half of every governance call, and four measured Stages spent 58-81% of their calls on orientation;
 * re-asking after every write is a large part of that.
 *
 * The rule this establishes: a command that moves the Change hands back the post-condition, so the
 * Agent never has to ask what it just did.
 */
export async function nextActionsFor(
  project: ProjectContext,
  /* `readState`'s payload, which has no type of its own. Every member this reads is narrowed where
     it is read, so `unknown` rather than `any`: a wrong assumption about the payload has to be
     written down as a cast instead of passing silently. */
  data: Record<string, unknown>,
  changeId: string | undefined,
): Promise<NextAction[]> {
  const nextActions: NextAction[] = [];
  /* Hoisted: both the Change and the work-package plan are written under it, and a second copy of
     the fallback string is a second thing to keep in step with the Manifest. */
  const changesPath = (data.project as { paths?: { changes?: { value?: string } } } | undefined)?.paths?.changes?.value ?? 'xforge/changes';
  if (project.compatibility.mode === 'portable') nextActions.push({ action: 'resolve-declared-xforge', reason: 'Managed operations require the exact declared CLI identity.' });
  /* The `ChangeState` the resolvers built, not a hand-written subset of it. The subset that stood
     here named five members and omitted `governance` and most of the plan, so every read of those
     went through `as any` -- a cast per site to reach fields the product already types. */
  const stateChange = (data.change ?? null) as ChangeState | null;
  const stages = flowStages(data, stateChange?.flow);
  /*
   * Starting a Change, as an Action rather than as prose.
   *
   * Every other step of a governed Flow is a typed Action; this one was a YAML block inside
   * `xforge-propose` and the destination was left for the Agent to assemble from the Changes
   * path. Offered only at the portfolio view, which is where the question "should this become a
   * Change" is actually asked -- inside a Change, the answer is already yes.
   */
  if (!changeId) {
    const projectFacts = data.project as { modules?: Array<{ id: string }> } | undefined;
    nextActions.push({
      action: 'create-change',
      type: 'artifact',
      actor: 'main',
      authority: 'planning-write',
      status: 'ready',
      inputs: [],
      writes: [`${changesPath}/<change-id>/change.yaml`],
      template: changeTemplate(project.manifest.flow, (projectFacts?.modules ?? []).map((module) => module.id)),
      doneWhen: [
        'change.yaml exists under a new kebab-case Change id in the resolved Changes directory.',
        `Every classification key is answered from the work: ${CLASSIFICATION_KEYS.join(', ')}.`,
      ],
      requiredEvidence: ['xforge state --change <id> resolves the Change and reports its first ready Artifact.'],
      reason: 'A governed Change begins with change.yaml; no other Action creates one.',
    });
  }
  if (stateChange?.nextArtifact?.id && changeId) {
    const artifactId = stateChange.nextArtifact.id;
    /* From the Stage that produces this Artifact, never a constant: a Flow is free to produce a
       check-stage Artifact under assurance-write. A Flow that declares no producing Stage for it
       leaves the field off rather than inventing a level. */
    const authority = stages.find((stage) => (stage.produces ?? []).includes(artifactId))?.authority;
    /* A glob Artifact's outline is a repeating template, not a section set, so it has no literal
       headings to state. `outlineSections` returns none for one either way; the check keeps the
       intent visible. */
    const sections = stateChange.nextArtifact.generates?.includes('*')
      ? []
      : outlineSections(stateChange.nextArtifact.outline ?? '');
    /*
     * A glob Artifact's destination, answered rather than handed back as the glob.
     *
     * `writePath` for `delta-specs` is the glob the Flow declares, which is a pattern and not a place. Four
     * measured runs produced three different paths from it -- `specs/root/spec.md`,
     * `specs/root/task-ledger.md`, `specs/task-ledger/spec.md` -- and two of them went reading the
     * CLI's own compiled source to decide, spending 13% of the Stage's calls on the question. The
     * paths are not interchangeable: `core/spec-merger.ts` reads the segment as a capability name and
     * archive merges the delta into the canonical Specs at that relative path, so three answers are
     * three different canonical files that nothing ever compares.
     *
     * What the product can state is the part it knows: which capabilities this project already
     * records. The naming rule itself belongs to the Flow's `instruction`, beside the rest of the
     * Artifact's shape; this adds the project's own facts to it, which is the half a Flow cannot
     * carry.
     */
    const capabilities = [...new Set(((data.specs ?? []) as string[])
      .map((entry) => entry.replace(/\.md$/, ''))
      .map((entry) => entry.endsWith('/spec') ? entry.slice(0, -'/spec'.length) : entry))].sort();
    const globDestination = stateChange.nextArtifact.generates?.includes('*') && stateChange.nextArtifact.outputPaths?.length === 0
      ? capabilities.length > 0
        ? `Write it under a capability this project already records: ${capabilities.join(', ')}. Inventing a second name for one of these splits the canonical Spec in two.`
        : 'This project records no canonical Spec yet, so the capability named in this path becomes the first one, and every later Change touching the same behaviour has to match it.'
      : null;
    nextActions.push({
      action: 'create-artifact',
      type: 'artifact',
      id: artifactId,
      actor: 'main',
      ...(authority ? { authority } : {}),
      status: 'ready',
      /*
       * What to read, not what is absent.
       *
       * This was `missingDependencies`, which is empty exactly when the Action is ready — so the
       * one field a Skill is told to reread was `[]` at every moment it could have been acted on.
       * Twelve Skills carry "reread every Action input from disk" and it pointed at nothing, which
       * left the Agent to fall back on rereading the whole Change: the cost `stage-bundle` was
       * built to measure. The real answer is the Artifact's satisfied `requires`, resolved to the
       * project-relative files they actually produced.
       */
      inputs: (stateChange.nextArtifact.requires ?? []).flatMap((required) => {
        const dependency = stateChange.artifacts?.find((artifact) => artifact.id === required);
        if (!dependency) return [];
        const changeRoot = stateChange.path;
        if (dependency.outputPaths?.length && changeRoot) return dependency.outputPaths.map((output) => `${changeRoot}/${output}`);
        return dependency.writePath ? [dependency.writePath] : [];
      }),
      /* A not-yet-written Artifact has no outputPaths, which used to leave `writes` empty and the
         destination for the Agent to guess. State the project-relative path instead. */
      writes: stateChange.nextArtifact.outputPaths?.length
        ? stateChange.nextArtifact.outputPaths
        : [stateChange.nextArtifact.writePath].filter((item): item is string => Boolean(item)),
      /* The headings verbatim, so the author is not left inferring them from a Markdown fragment.
         Omitted for a glob Artifact, whose outline is a repeating template rather than a section
         set, and when the Flow declares none. */
      ...(sections.length > 0 ? { requiredSections: sections } : {}),
      doneWhen: [
        `Artifact ${artifactId} exists and satisfies the active Flow instructions.`,
        ...(globDestination ? [globDestination] : []),
      ],
      requiredEvidence: ['xforge state reports the artifact as done for the current Change revision.'],
      reason: `Next Flow Artifact is ${artifactId}.`,
    });
  }
  const governance = stateChange?.governance;
  if (governance?.currentStage === 'apply') {
    /* The dispatch happens in the Stage the Change is in, so that Stage's declared authority is
       the one that applies — `implementation-write` only because the shipped Flows say so. */
    const applyAuthority = stages.find((stage) => stage.id === governance.currentStage)?.authority;
    /*
     * The Stage offers a plan before it offers a dispatch.
     *
     * `state.workPackages` is null both when no plan exists and when one exists that the schema
     * refused, and the template is the right answer to both: the second case is overwhelmingly a
     * plan written without `apiVersion` and `kind`, because those keys were documented nowhere an
     * Agent reads. An Agent that wrote a headerless plan now gets XFORGE_SCHEMA_INVALID and, beside
     * it, the shape that satisfies the schema.
     *
     * Offered only where a plan is legal to write. A persistent plan is one of two ways to run this
     * Stage -- direct serial work is the other -- so this is `status: 'pending'`, an Action the
     * Stage may take rather than one it owes.
     */
    if (!stateChange?.workPackages) {
      nextActions.push({
        action: 'create-work-packages', type: 'artifact', actor: 'main', ...(applyAuthority ? { authority: applyAuthority } : {}), status: 'pending',
        inputs: [],
        writes: [`${changesPath}/${changeId}/work-packages.yaml`],
        template: workPackagePlanTemplate(),
        doneWhen: [
          `work-packages.yaml carries ${WORK_PACKAGE_PLAN_HEADER_KEYS.join(' and ')} beside packages, and nothing else: the schema is additionalProperties: false and refuses the plan outright without them.`,
          'Every path a package writes falls inside its own write_paths, and no two packages claim one path.',
        ],
        requiredEvidence: ['xforge state --change <id> reports the plan resolved, with a ready set.'],
        reason: 'This Stage can be run from a persistent plan; no plan is resolvable for this Change.',
      });
    }
    for (const packageId of stateChange?.workPackages?.ready ?? []) {
      const workPackage = stateChange?.workPackages?.packages?.find((item) => item.id === packageId);
      nextActions.push({
        action: 'dispatch-work-package', type: 'governance', id: packageId, actor: 'main', ...(applyAuthority ? { authority: applyAuthority } : {}), status: 'ready',
        inputs: workPackage?.inputs ?? [], writes: workPackage?.write_paths ?? [], doneWhen: workPackage?.done_when ?? [],
        requiredEvidence: ['revision-bound dispatch receipt', 'Git delivery diff', 'verify command evidence', 'done_when evidence mapping'],
        reworkTo: ['apply'],
        reason: `Work package ${packageId} is ready for a revision-bound dispatch.`,
        command: ['xforge', 'work-package', 'dispatch', '--change', changeId!, '--package', packageId],
      });
    }
  }
  for (const pending of governance?.pendingApprovals ?? []) nextActions.push({
    action: 'approve', type: 'approval', id: pending.policyId, actor: 'human', status: 'pending',
    inputs: ['current state revision', `approval policy ${pending.policyId}`], writes: ['approval receipt'],
    doneWhen: [`Approval policy ${pending.policyId} is satisfied for ${pending.transition}.`], requiredEvidence: ['current-revision approval receipt'],
    reason: `Approval ${pending.policyId} is required for ${pending.transition}.`, blockedBy: [`missing:${pending.missing}`],
    command: ['xforge', 'approve', '--change', changeId!, '--for', pending.transition, '--policy', pending.policyId],
  });
  /*
   * A Gate that has not run yet, as something to do rather than something to be stuck behind.
   *
   * A blocked transition reports `gate:<id>:missing`, and no Action named the command that clears
   * it -- the answer lived only in the Skills' prose. An Agent following the Invariant every Skill
   * carries, "run the command state.nextActions gives you", had a `ready: false` transition, a block
   * it could read, and nothing to run. A cold end-to-end run reported exactly that and stopped.
   *
   * Only `missing` gets an Action. `failed` is a Gate that ran and said no, and re-running it
   * changes nothing until the content does; offering the same command there would suggest the
   * refusal is a retry away from clearing.
   */
  const missingGates = [...new Set((governance?.readyTransitions ?? [])
    .flatMap((entry) => entry.blockedBy ?? [])
    .filter((block: string) => block.startsWith('gate:') && block.endsWith(':missing'))
    .map((block: string) => block.slice('gate:'.length, -':missing'.length)))] as string[];
  /*
   * The Evidence filename comes from the Gate, not from the Gate's name.
   *
   * This built `evidence/<gate>.json`, and `unit-tests` writes `tests.json` -- the Gate resource
   * declares its own `spec.evidence` and `core/state-reader.ts` says so in as many words. A live
   * Verify believed the prediction, wrote `evidence/unit-tests.json` into its assurance document,
   * found the real path later, and the correcting edit moved the content revision: the Gates it had
   * just run went stale, and the verification receipt it had just filed had to be re-drafted. One
   * wrong path in a `writes` field cost a re-gate and a re-finalize.
   *
   * Loaded only when a Gate is actually missing, which is the branch that emits these actions --
   * the common reply pays nothing.
   */
  if (changeId && missingGates.length > 0) {
    const { gates } = await loadSelectedResources(project);
    for (const gateId of missingGates) {
      /* A Gate the project does not have cannot be named here at all, so falling back to the
         convention is the honest answer rather than a guess: `check` will refuse it by name. */
      const evidence = gates.get(gateId)?.value.spec.evidence ?? `${gateId}.json`;
      nextActions.push({
        action: 'run-gates', type: 'gate', id: gateId, actor: 'main', status: 'ready',
        inputs: [], writes: [`${stateChange?.path ?? ''}/evidence/${evidence}`],
        doneWhen: [`Gate ${gateId} has Evidence bound to the current content revision.`],
        requiredEvidence: [`evidence/${evidence} written by xforge check at the current content revision`],
        reason: `Gate ${gateId} has not run at this content revision, which is what blocks the Transition.`,
        command: ['xforge', 'check', '--change', changeId, '--gate', gateId],
      });
    }
  }

  for (const transition of governance?.readyTransitions ?? []) nextActions.push({
    action: 'transition', type: 'transition', id: transition.to, actor: 'main', status: transition.ready ? 'ready' : 'blocked',
    inputs: ['current Change state', 'required gates and approvals'], writes: ['transition receipt'],
    doneWhen: [`Current Stage is ${transition.to}.`], requiredEvidence: ['valid transition receipt'], reworkTo: governance?.currentStage ? [governance.currentStage] : [],
    reason: transition.ready ? `Transition to ${transition.to} is ready.` : `Transition to ${transition.to} is blocked.`, blockedBy: transition.blockedBy,
    command: ['xforge', 'transition', '--change', changeId!, '--to', transition.to],
  });
  /*
   * The one-call form, offered where it is the whole remaining job.
   *
   * `advance` runs this Stage's Gates and takes the Transition if none refuses -- the CLI's own
   * description calls it "a call-count optimisation and nothing else". `xforge-apply` tells an Agent
   * to leave with it. And `nextActions`, which is where the Skills say to take a command from, never
   * mentioned it: a Stage blocked only by Gates it can run was told to make N `check` calls and then
   * a `transition`, and the `transition` it was handed would refuse until those N had happened. Two
   * commands for one act, and the one the product named was the one that fails first.
   *
   * Offered only when every remaining blocker is a Gate this Stage can actually clear. An approval,
   * an artifact or a condition in the set means `advance` cannot finish the job either, and naming
   * it there would point at a command that refuses for a reason the reader has already been told.
   * `:failed` is excluded on the same reading the `run-gates` block above uses: that Gate ran and
   * said no, and re-running changes nothing until the content does.
   *
   * Additive. The `run-gates` and `transition` rows stay, because both remain true -- a reader who
   * wants the Gate results separately, or who is scripting the two halves, is not being told to stop.
   */
  const clearableByAdvance = (block: string): boolean => /^gate:.+:(missing|stale)$/.test(block);
  if (changeId) for (const transition of governance?.readyTransitions ?? []) {
    const blocks: string[] = transition.blockedBy ?? [];
    if (blocks.length === 0 || !blocks.every(clearableByAdvance)) continue;
    const gates = blocks.map((block) => block.slice('gate:'.length, block.lastIndexOf(':')));
    nextActions.push({
      action: 'advance', type: 'transition', id: transition.to, actor: 'main', status: 'ready',
      inputs: ['current Change state'], writes: ['gate evidence', 'transition receipt'],
      doneWhen: [`Current Stage is ${transition.to}.`],
      requiredEvidence: ['current-revision Gate Evidence and a valid transition receipt'],
      reason: `Only Gates this Stage runs (${[...new Set(gates)].join(', ')}) stand between here and ${transition.to}. advance runs them and takes the Transition if none refuses, in one call instead of ${gates.length + 1}.`,
      command: ['xforge', 'advance', '--change', changeId, '--to', transition.to],
    });
  }
  /*
   * The receipt, when the receipt is what stands between this Stage and the next.
   *
   * This was four paragraphs of Skill prose -- what `finalize` writes, why it is not a shortcut
   * past the check, and that `draft-receipt` exists for the hand-assembled case. All of it was
   * resident in every verify Stage and re-sent on every turn of it, to be acted on at one moment.
   * A blocked transition already names the condition; the instruction belongs on that signal.
   *
   * `--by` ships as a placeholder and `--status` does not, which is not an inconsistency: they are
   * different kinds of field. `passed` is the only status `finalize` accepts -- anything else is
   * refused at `commands/verification.ts:586` -- so substituting it decides nothing. `--by` names
   * the person asserting it, is written to `finalizedBy` unvalidated, and is the one field an
   * Agent filling in for itself would be recording an authorisation nobody gave.
   */
  if (governance?.currentStage && changeId) {
    const blockedOnReceipt = (governance.readyTransitions ?? []).some((transition) =>
      (transition.blockedBy ?? []).some((item: string) => item.startsWith('condition:verificationReceipt:')));
    if (blockedOnReceipt) nextActions.push({
      action: 'finalize-verification', type: 'governance', actor: 'human', status: 'ready',
      inputs: ['this Stage\'s Gate Evidence at the current content revision'], writes: ['verification receipt'],
      doneWhen: ['The Stage\'s verificationReceipt exit condition is satisfied.'],
      requiredEvidence: ['current-revision verification receipt'],
      reason: `The verification receipt is what blocks this Stage. XForge already holds the change, contentRevision, gitHead and cited Gate set, and writes them from the same resolved Gate Evidence the exit condition is decided against — do not transcribe them, and do not assemble the receipt by hand. It is not a shortcut past the check: the Gate Evidence is re-read from disk first, and nothing is written if any cited Gate is stale, failed, or never ran. Supply --by yourself: it names the person asserting the verification, and is the field this command will not compute. Use \`xforge verification draft-receipt --change ${changeId}\` to compute the same facts without writing.`,
      command: ['xforge', 'verification', 'finalize', '--change', changeId, '--status', 'passed', '--by', '<the person asserting it>'],
    });
  }
  /* `ready-to-archive` is a synthetic terminal Stage, not one of `flow.stages`, so there is no
     Stage to read here. The archive authority comes from `flow.terminal.archive.authority`, which
     flow.schema.json pins to the const `archive-write` — this literal is the schema's only legal
     value for it, not a level invented at this call site. */
  if (governance?.currentStage === 'ready-to-archive') nextActions.push({
    action: 'archive', type: 'archive', actor: 'main', authority: 'archive-write', status: (governance.pendingApprovals ?? []).some((item) => item.transition === 'archive') ? 'blocked' : 'ready',
    inputs: ['current-revision verification, approval, gate, and audit evidence'], writes: ['canonical Specs', 'archived Change'],
    doneWhen: ['The Change is archived atomically and canonical Specs are synchronized.'], requiredEvidence: ['archive transaction result'],
    reason: 'The Change reached ReadyToArchive; terminal governance still applies.', command: ['xforge', 'archive', '--change', changeId!],
  });
  return nextActions;
}

/**
 * A mutating command's reply, with the post-condition attached.
 *
 * Every command here already returns its own `nextActions` where it has something specific to say --
 * a refusal's remedy, an approval the transition still needs. This adds what none of them said: where
 * the Change now stands and what its next Action is. The command's own entries come first, because
 * they are about what just happened; the state's follow.
 *
 * Resolving state costs one extra in-process read and saves the caller a round trip, which is the
 * trade this whole change is built on: a turn re-sends the entire conversation, a second file read
 * does not.
 */
export async function withPostState(
  project: ProjectContext,
  changeId: string | undefined,
  result: { data?: unknown; diagnostics?: Diagnostic[]; changes?: FileChange[]; nextActions?: NextAction[] },
  dryRun?: boolean,
): Promise<{ data?: unknown; diagnostics?: Diagnostic[]; changes?: FileChange[]; nextActions: NextAction[] }> {
  const own = result.nextActions ?? [];
  /*
   * A rehearsal has no post-condition. `--dry-run` reports what a command *would* do and leaves the
   * Change exactly where it was, so the state after it is the state before it -- which the caller
   * either already has or can ask for. Attaching it would be the clearest case of the thing this
   * change exists to stop: paying to send data nobody reads.
   */
  if (dryRun) return { ...result, nextActions: own };
  /*
   * Nothing is attached to a refusal. A command that was refused changed nothing, so it has no
   * post-condition to report -- and a menu of onward moves printed under a refusal reads as though
   * some of them were now available. What the caller needs there is the refusal and its remedy,
   * which the command already returned.
   */
  if ((result.diagnostics ?? []).some((entry) => entry.severity === 'error')) return { ...result, nextActions: own };
  try {
    const state = await executeState(project, { change: changeId });
    const following = await nextActionsFor(project, state.data as Record<string, any>, changeId);
    /* De-duplicated on the identity a reader acts by. A command that already named the transition it
       just unblocked should not have the state repeat it as a second, identical entry. */
    const seen = new Set(own.map((entry) => `${entry.action}:${entry.id ?? ''}`));
    /*
     * Only what can be acted on. `state` lists blocked transitions too, because "why can I not go
     * forward" is a question it exists to answer; repeating them after every write would be the
     * unused half of every reply, and this whole change is an argument about not paying for data
     * nobody reads. A caller who wants the blocked set asks `state` for it.
     */
    const actionable = following.filter((entry) => entry.status === undefined || entry.status === 'ready' || entry.status === 'pending');
    return { ...result, nextActions: [...own, ...actionable.filter((entry) => !seen.has(`${entry.action}:${entry.id ?? ''}`))] };
  } catch {
    /* A state that cannot resolve after a write is itself worth not hiding, but it is the command's
       result that the caller asked for -- returning it unadorned beats failing the whole call. */
    return { ...result, nextActions: own };
  }
}
