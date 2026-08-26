import type { StageFlow } from '../../types.js';

/**
 * The Flow graph, read on its own.
 *
 * Its own module because two layers need it and neither should depend on the other: the receipt
 * reader checks that a recorded transition was legal from where it claims to have started, and the
 * resolver offers the same set as this Change's candidates. They were one function in the resolver,
 * which made the reader import the resolver -- the package's first import cycle, and one that says
 * something true about the design: this is neither reading nor resolving, it is the graph.
 */
/**
 * The Stages a Change may move to from `from`, as the Flow graph declares them.
 *
 * One source of truth for two readers that used to disagree by omission. `resolveControlPlane`
 * offers exactly these as transition candidates, but the receipt chain never consulted the graph at
 * all: it checked `sequence`, `previousReceiptDigest` and `from`, and took `to` on the receipt's
 * word. A hand-written receipt could therefore claim `design -> ready-to-archive`, skipping Check,
 * Apply and Verify — and `terminalGovernanceBlocks` would then re-check the Gates of whatever
 * `from` that receipt named, which is exactly the Stage the skip was designed to leave behind.
 */
export function legalTransitionTargets(flow: StageFlow, from: string): string[] {
  const index = flow.stages.findIndex((stage) => stage.id === from);
  if (index < 0) return [];
  const stage = flow.stages[index]!;
  const targets: string[] = [];
  targets.push(index < flow.stages.length - 1 ? flow.stages[index + 1]!.id : 'ready-to-archive');
  for (const rework of stage.reworkTo ?? []) if (rework !== stage.id && !targets.includes(rework)) targets.push(rework);
  return targets;
}
