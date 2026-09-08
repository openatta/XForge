import type { ChangeState, Diagnostic, FileChange, NextAction, ProjectContext } from '../types.js';
import { diagnostic } from '../core/errors.js';
import { executeCheck } from './check.js';
import { executeState } from './state.js';
import { executeTransition } from './transition.js';
import { nextActionsFor, withPostState } from './next-actions.js';

/**
 * `xforge advance`: this Stage's Gates, then the Transition, as one call.
 *
 * Composed entirely out of the two commands it runs, which is the property that makes it safe --
 * the Gate Evidence and the Transition receipt are written and audited separately, exactly as when
 * a person runs `check` and `transition` by hand. See the note inside for why the records are not
 * merged.
 */
export async function executeAdvance(
  project: ProjectContext,
  options: { change: string; to?: string; dryRun: boolean },
): Promise<{
  ok?: boolean;
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
  changes?: FileChange[];
  nextActions: NextAction[];
}> {
  /*
   * The two calls every Stage ends with, made one.
   *
   * Across twelve measured Stages the count of governance calls that actually move the Change was
   * fixed -- two at Propose, three at Check and Verify -- and `check` immediately followed by
   * `transition` was in every one of them. That pairing is not a habit an instruction created; it
   * is what the Flow requires, because Gate Evidence binds to the content revision and a
   * Transition refuses without it.
   *
   * What this deliberately does not do is merge the records. The Gate run writes its Evidence and
   * the Transition writes its receipt, separately, with the same digests and the same audit
   * entries as when a person runs both by hand. Collapsing them into one record would make "the
   * Gate passed" and "the Stage moved" indistinguishable, which is the one thing a governance
   * chain must never lose. A Gate that fails refuses the Transition and names itself.
   */
  const gates = await executeCheck(project, { change: options.change });
  const refusing = gates.diagnostics.filter((entry) => entry.severity === 'error');
  const state = await executeState(project, { change: options.change });
  /* Both reads below are typed at their source: `check` returns a `CheckData`, and `state`'s
     `change` member is the `ChangeState` the resolvers built. Neither needed asserting. */
  const change = (state.data as { change?: ChangeState | null }).change ?? null;
  const governance = change?.governance;
  const ready = (governance?.readyTransitions ?? []).filter((entry) => entry.ready);
  const target = options.to ?? (ready.length === 1 ? ready[0]!.to : undefined);

  if (refusing.length > 0) {
    return {
      ok: false,
      data: { change: options.change, stage: governance?.currentStage ?? null, transitioned: null, gates: gates.data.gates },
      diagnostics: [...gates.diagnostics, diagnostic(
        'XFORGE_ADVANCE_GATES_REFUSED',
        `Gates refused, so no Transition was attempted and no receipt was written: ${refusing.map((entry) => entry.code).join(', ')}. Fix what they name and run advance again.`,
        change?.path ?? '',
      )],
      nextActions: gates.nextActions,
    };
  }
  if (!target) {
    const blocked = (governance?.readyTransitions ?? []).flatMap((entry) => entry.blockedBy ?? []);
    return {
      data: { change: options.change, stage: governance?.currentStage ?? null, transitioned: null, gates: gates.data.gates, blockedBy: blocked },
      diagnostics: [...gates.diagnostics, diagnostic(
        'XFORGE_ADVANCE_NO_READY_TRANSITION',
        ready.length > 1
          ? `Gates passed and more than one Transition is ready (${ready.map((entry) => entry.to).join(', ')}); name one with --to. Choosing between a forward move and a rework route is not a default this can pick.`
          : `Gates passed and no Transition is ready${blocked.length ? `: ${blocked.join(', ')}` : ''}. Nothing was written.`,
        change?.path ?? '',
        'info',
      )],
      nextActions: await nextActionsFor(project, state.data as Record<string, any>, options.change),
    };
  }
  const moved = await executeTransition(project, { change: options.change, to: target, dryRun: options.dryRun });
  const after = await withPostState(project, options.change, moved, options.dryRun);
  /*
   * `transitioned` reports what happened, not what was attempted.
   *
   * It was set to the target unconditionally, so a Transition the CLI had just refused came back
   * as `transitioned: "design"` with the refusal sitting in the diagnostics beside it. The refusal
   * itself was correct -- `executeTransition` blocks on missing Artifacts exactly as it does when
   * run by hand -- but a caller reading the field it was given would have believed the Change
   * moved. A merged command that misreports its own outcome is worse than the two calls it saves.
   */
  const refused = (moved.diagnostics ?? []).some((entry) => entry.severity === 'error');
  return {
    data: { change: options.change, transitioned: refused ? null : target, gates: gates.data.gates, transition: after.data },
    diagnostics: [...gates.diagnostics, ...(after.diagnostics ?? [])],
    changes: after.changes,
    nextActions: after.nextActions,
  };
}
