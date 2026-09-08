import { readFile } from 'node:fs/promises';
import type { ChangeState, Diagnostic, NextAction, ProjectContext } from '../types.js';
import { diagnostic } from '../core/errors.js';
import { outlineSections } from '../core/artifact-markers.js';
import { knownIdentities } from '../core/ledger-identity.js';
import { artifactSatisfied } from '../core/flow-query.js';
import { safeResolve } from '../core/path-safety.js';
import { executeStageBundle, type renderStageText } from './stage-bundle.js';
import { executeState } from './state.js';
import { flowStages, nextActionsFor } from './next-actions.js';

/**
 * `xforge stage`: everything one Stage needs, in one reply.
 *
 * Composed out of `stage-bundle`, `state` and `nextActionsFor` -- it computes nothing those three
 * do not already compute, and that is the whole design. What it adds is arrival: the reading plan,
 * the resolved state, the Action that is ready and the Stage's own declarations reach the caller
 * together instead of one turn at a time.
 *
 * The reply is the unit that has to fit, so the budget at the bottom measures the serialized
 * envelope rather than any one part of it.
 */
export async function executeStage(
  project: ProjectContext,
  /* `content` is carried through exactly as the command line gave it, `undefined` included: the
     bundle is asked for `none` when it is absent, and two branches below distinguish an absent
     flag from an explicit `--content none`. Collapsing them here would change what arrives. */
  options: { change: string; content?: string },
): Promise<{
  data: Parameters<typeof renderStageText>[0];
  diagnostics: Diagnostic[];
  nextActions: NextAction[];
}> {
  /*
   * One reply instead of a Stage's worth of questions.
   *
   * Measured over twelve runs of three Stages, 70% of every call was orientation: opening the
   * Change's files, re-listing the directory, and asking `state` again. None of it is optional
   * work — an Agent cannot write the next Artifact without its inputs — but all of it was being
   * paid for one turn at a time, and a turn re-sends the whole conversation while a second read
   * inside one process does not.
   *
   * So this composes what was already computable: the reading plan and its text from
   * `stage-bundle`, the resolved state, and the Action that is ready with everything the author
   * needs to satisfy it. The parts are unchanged; what changes is that they arrive together.
   */
  /*
   * Two different questions, and they were being answered by one value with `undefined` in it.
   *
   * `bundleContent` is what the reading plan is asked for: `none` unless the caller said otherwise,
   * which is this command's default and *not* `stage-bundle`'s (that one defaults to `changed`).
   * `carryDeclaredInputs` is whether a ready work package's declared inputs travel with their text,
   * and it was written as `options.content !== 'none'` — which, with the flag absent, is true. So
   * the plan was fetched as `none` while those inputs arrived with their contents anyway.
   *
   * That is the behaviour, it is deliberate (see the declared-input note below: Apply's Worker
   * cannot write a line without them), and nothing here changes it. What changes is that the rule
   * is now written down instead of falling out of `undefined !== 'none'`, where the next person to
   * normalise the default would have silently reversed it.
   */
  const bundleContent = (options.content ?? 'none') as 'none' | 'changed' | 'full';
  const carryDeclaredInputs = options.content !== 'none';
  const bundle = await executeStageBundle(project, {
    change: options.change,
    /*
     * `none` by default: the reading plan, not the documents.
     *
     * Sending the text was meant to save the Stage from re-opening its own inputs, and measured
     * over one full Solid run it did not: `stage` delivered 75,774 bytes of input text and the
     * Agent then re-opened the same documents 29 times for 220,839 bytes more. Both copies sit in
     * context for the rest of the Stage, so together they were 52% of everything the run paid to
     * re-read -- and the second, larger copy cost 3.3x the first.
     *
     * Every Skill has said "do not open those inputs separately; they arrived" since the day the
     * text was added, and every Stage but Propose opened them anyway. So this is the other design
     * rather than the same design asked for more firmly: the reply names the inputs, gives a
     * digest and the section headings of each, and says which moved since the Stage began. What
     * the Agent needs it opens once; what it does not need is never in context at all.
     */
    content: bundleContent,
  });
  const state = await executeState(project, { change: options.change });
  const actions = await nextActionsFor(project, state.data as Record<string, any>, options.change);
  /* `state`'s payload is untyped at the boundary, but the member this command lives off is not:
     `change` is the `ChangeState` the resolvers built, so every artifact, governance and
     work-package field below is checked rather than asserted. */
  const change = (state.data as { change?: ChangeState | null }).change ?? null;
  /*
   * The Artifact this Stage owes, computed from the Stage rather than borrowed from `nextArtifact`.
   *
   * `nextArtifact` is scoped to the planning Artifacts — everything a Flow produces before `apply`
   * — because that is what it was built for. At Verify that leaves it null while the Stage plainly
   * owes an `assurance`, so the working set answered "no Action" at a Stage that has one, which is
   * worse than the prose it replaced. A Stage-scoped command should answer from the Stage's own
   * `produces`, and that is also the more general rule: it happens to agree with `nextArtifact`
   * everywhere `nextArtifact` applies.
   */
  /* From the receipts state already resolved, not a second walk: `control-plane` computes this
     same set to validate against, and a Change with neither receipts nor commits has none —
     which is itself the answer a ledger author needs. */
  const identities = await knownIdentities(project, options.change, (change?.governance?.approvals ?? []) as never)
    .then((known) => [...known.values].sort())
    .catch(() => []);
  const stageProduces = new Set(flowStages(state.data as Record<string, unknown>, change?.flow).find((entry) => entry.id === bundle.data.stage)?.produces ?? []);
  let ready = actions.find((entry) => entry.type === 'artifact' && entry.status === 'ready') ?? null;
  if (!ready) {
    const owed = (change?.artifacts ?? []).find((artifact) => stageProduces.has(artifact.id) && artifact.status === 'ready');
    if (owed) {
      const sections = String(owed.generates ?? '').includes('*') ? [] : outlineSections(owed.outline ?? '');
      ready = {
        action: 'create-artifact', type: 'artifact', id: owed.id, actor: 'main', status: 'ready',
        inputs: (owed.requires ?? []).flatMap((required: string) => {
          const dependency = (change?.artifacts ?? []).find((artifact) => artifact.id === required);
          if (!dependency) return [];
          if (dependency.outputPaths?.length && change?.path) return dependency.outputPaths.map((output: string) => `${change.path}/${output}`);
          return dependency.writePath ? [dependency.writePath] : [];
        }),
        writes: owed.outputPaths?.length ? owed.outputPaths : [owed.writePath].filter(Boolean),
        ...(sections.length > 0 ? { requiredSections: sections } : {}),
        doneWhen: [`Artifact ${owed.id} exists and satisfies the active Flow instructions.`],
        requiredEvidence: ['xforge state reports the artifact as done for the current Change revision.'],
        reason: `Stage ${bundle.data.stage} produces ${owed.id}, and it is not written yet.`,
      };
    }
  }
  const stageData = {
    change: options.change,
    flow: change?.flow ?? null,
    stage: bundle.data.stage,
    revision: change?.governance?.revision ?? null,
    action: ready,
    /*
     * Every Artifact this Stage still owes, with its shape — not just the one that is ready.
     *
     * The Check Stage produces three, and this described one. The other two are ledgers whose
     * whole content is a YAML shape, and that shape lived only in the Flow file — so all four
     * measurement runs opened `xforge/flows/solid.yaml` right after calling this, each slicing
     * the artifacts section. Reporting `produces: [a, b, c]` without saying what b and c are is
     * a list of names, and a name is not something you can write from.
     *
     * The same mistake one level in from the last one: the ready Action was taken from
     * `nextArtifact`, which stops before `apply`, and was fixed by reading the Stage's own
     * `produces`. This reads all of them rather than the first.
     */
    owes: (change?.artifacts ?? [])
      .filter((artifact) => stageProduces.has(artifact.id) && !artifactSatisfied(artifact.status))
      .map((artifact) => ({
        id: artifact.id,
        status: artifact.status,
        writes: artifact.outputPaths?.length ? artifact.outputPaths : [artifact.writePath].filter(Boolean),
        description: artifact.description ?? null,
        instruction: artifact.instruction ?? null,
        outline: artifact.outline ?? null,
        requiredSections: String(artifact.generates ?? '').includes('*') ? [] : outlineSections(artifact.outline ?? ''),
        missingDependencies: artifact.missingDependencies ?? [],
      })),
    otherActions: actions.filter((entry) => entry !== ready),
    blockedBy: (change?.governance?.readyTransitions ?? []).flatMap((entry) => entry.blockedBy ?? []),
    /*
     * What this Stage declares, so the Flow file does not have to be opened to find out.
     *
     * Twenty recorded runs read `xforge/flows/*.yaml` twelve times for 132KB — 12% of every
     * byte that entered context through a file read — to learn an outline or which Gates a
     * Stage runs. `owes` already carries the outline -- the Action does not, and this comment
     * said it did until an audit read the two against `NextAction`; this carries the rest of
     * what a Stage is, which is the other half of the question those reads were asking.
     */
    stageDeclares: (() => {
      const definition = flowStages(state.data as Record<string, unknown>, change?.flow).find((entry) => entry.id === bundle.data.stage);
      return definition
        ? {
          produces: definition.produces ?? [],
          /* Read as the payload spells them, not as the Flow does: `readState` has already unioned
             `exit.gates` into `gates` and flattened `exit.conditions` to `exitConditions`. Reaching
             for `exit` here is what made this field answer `[]` for every Stage of every Flow. */
          gates: definition.gates ?? [],
          exitConditions: definition.exitConditions ?? [],
          reworkTo: definition.reworkTo ?? [],
          authority: definition.authority ?? null,
        }
        : null;
    })(),
    /*
     * Which names a ledger will accept, said by the only thing that knows.
     *
     * `resolvedBy`, `decidedBy` and `approvedBy` are checked against the approvers on this
     * Change's receipts and its Git authors, and a name outside that set is refused. Nothing
     * reported the set, so all four measurement runs worked it out the same way — `git log
     * --format='%an <%ae>' | sort -u` — reconstructing by hand a list the CLI holds in memory
     * while it validates against it.
     *
     * Reporting it does not widen what is accepted; the check is unchanged. It stops an author
     * having to guess at the bar they are being held to, which is how a ledger ends up naming
     * somebody who is not there.
     */
    /*
     * What this Stage's work actually is, when the work is not an Artifact.
     *
     * `apply` produces nothing in the Flow's sense, so a working set organised around `produces`
     * told it "no Artifact is ready" and stopped — on the Stage that carries the largest share of
     * the work in the whole flow: dispatch, parallel workers, delivery records, integration,
     * done_when evidence. The plan for all of it is `work-packages.yaml`, which appeared in the
     * reading list as one more file with a digest beside it, named as nothing in particular.
     *
     * The CLI already resolves every part of this to answer `state`: which packages are ready,
     * what each one may write, what it must satisfy, which can run at once, and which paths no
     * package accounts for. The same mistake as the last two — reporting a Stage by its Artifacts
     * when the Stage's substance is somewhere else.
     */
    work: change?.workPackages
      ? {
        path: change.workPackages.path,
        baseCommit: change.workPackages.baseCommit,
        ready: change.workPackages.ready ?? [],
        waves: change.workPackages.waves ?? [],
        parallelCandidates: change.workPackages.parallelCandidates ?? [],
        protectedWritePaths: change.workPackages.protectedWritePaths ?? [],
        unattributedPaths: change.workPackages.unattributedPaths ?? [],
        packages: (change.workPackages.packages ?? []).map((entry) => ({
          id: entry.id,
          status: entry.status,
          role: entry.role ?? null,
          goal: entry.goal,
          dependsOn: entry.depends_on ?? [],
          inputs: entry.inputs ?? [],
          writePaths: entry.write_paths ?? [],
          verify: entry.verify ?? [],
          doneWhen: entry.done_when ?? [],
          missingDependencies: entry.missingDependencies ?? [],
          delivered: Boolean(entry.delivery),
          acknowledgements: entry.acknowledgements ?? null,
        })),
      }
      : null,
    ledgerIdentities: identities,
    since: bundle.data.since,
    worktreeClean: bundle.data.worktreeClean,
    read: bundle.data.read,
    vouched: bundle.data.vouched,
    bytes: bundle.data.bytes,
  };
  /*
   * A ready work package's declared `inputs` are read here, whether or not they changed.
   *
   * `stage-bundle` decides what to send by what *moved* since the Stage was entered, which is the
   * right rule for an Artifact and the wrong one at Apply: the delta Spec and the Design were
   * written two Stages ago and have not moved since, so they were vouched for with a digest and a
   * heading list while being exactly the two files the Worker cannot write a line without. All
   * four baseline runs opened them by hand, 3-4 calls each, and the alternative on offer --
   * `--content full` -- also sends the proposal, the check report, and change.yaml, which Apply
   * does not read.
   *
   * The plan already names what this Stage's work needs. Nothing has to be guessed, and it stays
   * scoped to the packages that are actually ready, so a large plan does not send every input for
   * work that has not started.
   */
  if (change?.workPackages) {
    const readyIds = new Set(change.workPackages.ready ?? []);
    const declared = new Set<string>();
    for (const entry of (change.workPackages.packages ?? []) as Array<{ id: string; inputs?: string[] }>) {
      if (!readyIds.has(entry.id)) continue;
      for (const input of entry.inputs ?? []) declared.add(input);
    }
    const carried = new Set(stageData.read.map((entry) => entry.path));
    for (const relative of declared) {
      if (carried.has(relative)) continue;
      try {
        const source = await readFile(await safeResolve(project.root, relative), 'utf8');
        stageData.read.push({ path: relative, reason: 'declared-input', bytes: Buffer.byteLength(source), ...(carryDeclaredInputs ? { text: source } : {}) });
        stageData.bytes.read += Buffer.byteLength(source);
      } catch {
        /* An input the plan names but the tree does not have is the plan's problem, and
           `check` already reports it as one. Saying it twice here would not help. */
        continue;
      }
    }
    stageData.vouched = stageData.vouched.filter((entry) => !declared.has(entry.path));
  }
  const stageDiagnostics = [...bundle.diagnostics, ...state.diagnostics];
  /*
   * The budget is on the reply, because the reply is what has to arrive.
   *
   * It was on the read bytes, which is a different number: 15.7KB of file contents assembles into
   * a 25.8KB reply once the Action, the outlines of everything else the Stage owes, the Stage's
   * declarations and the diagnostics are around it. That passed a content budget and overflowed
   * the host anyway — a measured run spent two calls reading its own spilled output back, which is
   * the failure the guard exists to prevent.
   *
   * The contents give way and nothing else does: everything else here is what a caller cannot
   * reconstruct from disk, while the contents are files it can open. `--content full` is still
   * honoured, because that caller asked.
   */
  const BUDGET = 20_000;
  /*
   * Measured on what is sent, not on `data` alone.
   *
   * The budget existed to keep the reply small enough to arrive, but it sized `stageData` while
   * the envelope also carries the diagnostics and `nextActions` -- about 4.5KB at Apply. So a
   * reply measured at 15.7KB went out at 20.2KB, past the 20KB it had just declared itself under.
   * The comment above says the budget is on the reply; this makes that true.
   */
  const measure = () => JSON.stringify({ data: stageData, diagnostics: stageDiagnostics, nextActions: actions }).length;
  const size = measure();
  if (options.content !== 'full' && size > BUDGET) {
    /*
     * Shed the largest first, and keep whatever still fits.
     *
     * This dropped every text the moment one file pushed the reply over, so a 12KB Design took
     * the 3KB Constitution down with it and the caller opened both. Nothing about the budget
     * requires that: the reply is too big by some amount, and dropping the biggest contributor
     * usually clears it while the small load-bearing files still arrive. The caller opens what
     * the diagnostic names, which is now a shorter list than it was.
     */
    const dropped: string[] = [];
    const order = stageData.read
      .map((entry, index) => ({ index, size: typeof entry.text === 'string' ? entry.text.length : 0 }))
      .filter((entry) => entry.size > 0)
      .sort((left, right) => right.size - left.size);
    /*
     * Re-measured after each drop rather than subtracted.
     *
     * Subtracting the raw text length under-counts what the text costs once it is JSON-escaped --
     * by about 4KB on the Apply reply -- so the loop stopped one file early and the reply went out
     * 231 bytes over the budget it had just announced it was under. The number is also printed,
     * and a printed number that was never measured is the failure this codebase keeps meeting.
     * Serialising a handful of times costs nothing next to being wrong about it.
     */
    let current = size;
    for (const candidate of order) {
      if (current <= BUDGET) break;
      const entry = stageData.read[candidate.index]!;
      dropped.push(entry.path);
      delete (entry as { text?: string }).text;
      current = measure();
    }
    if (dropped.length > 0) stageDiagnostics.push(diagnostic(
      'XFORGE_STAGE_CONTENT_OVER_BUDGET',
      `This reply would be ${size} bytes, past the ${BUDGET} that reliably arrives inline, so the largest contents were left out until it fit -- it is now about ${current}. Everything else under READ still carries its text. Open these, or ask for --content full: ${dropped.join(', ')}.`,
      `${change?.path ?? ''}`,
      'info',
    ));
  }
  return { data: stageData, diagnostics: stageDiagnostics, nextActions: actions };
}
