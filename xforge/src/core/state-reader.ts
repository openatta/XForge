import { readFile, readdir } from 'node:fs/promises';
import fg from 'fast-glob';
import type { TargetId } from '../constants.js';
import { TARGETS } from '../constants.js';
import { capabilityMatrix } from '../adapters/index.js';
import type { ChangeState, Diagnostic, Flow, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { flowEligibilityDiagnostics } from './checker.js';
import { flowApplyOperation, flowArchiveOperation, flowArtifacts, isStageFlow, loadFlows, resolveChangeState } from './flow-resolver.js';
import { safeResolve } from './path-safety.js';
import { loadSelectedResources, type SelectedResources } from './resource-loader.js';
import { resolvedResourceEntries } from './lockfile.js';
import { stableStringify } from './hash.js';
import { codeMovedSince, gitRevisions } from './revision.js';
import { resolveWorkPackages } from './work-packages.js';
import { installationSummary, readOwnership } from '../install/ownership.js';
import { loadTransitionReceipts, resolveControlPlane } from './control-plane.js';
import { normalizeRule, ruleApplies } from './governance.js';
import { exists } from './files.js';

async function directoriesAt(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * What each mandatory Gate's Evidence says actually executed.
 *
 * A Gate's `status` answers "did it pass" and nothing else, so a Gate that ran no check and a Gate
 * that ran a real suite were indistinguishable everywhere a reader looks — State, transitions,
 * archive readiness — and the difference was visible only by opening the Evidence JSON and reading
 * its stdout. That is how a live run reached Verify twice on Gates whose own output said "passing
 * WITHOUT asserting anything".
 *
 * This reports the recorded facts and draws no conclusion: the command the runner executed, the
 * Evidence path (which is not named after the Gate — `unit-tests` writes `tests.json`), and whether
 * the Evidence is bound to the current content revision. What those facts mean is the reader's call;
 * having to guess where to find them was the problem.
 */
async function mandatoryGateEvidence(
  project: ProjectContext,
  changeId: string,
  gates: readonly string[],
  resources: SelectedResources,
  contentRevision: string | null,
): Promise<NonNullable<ChangeState['mandatoryGateEvidence']>> {
  const summaries: NonNullable<ChangeState['mandatoryGateEvidence']> = [];
  /*
   * `state` is what every Skill polls, so the drift lookup is memoised per commit rather than run
   * once per Gate. In practice all three mandatory Gates carry the same `gitHead` -- they are run
   * back to back by one `check` -- so this is one `git diff` per State read, not three.
   */
  const driftByHead = new Map<string, number | null>();
  const { head: currentGitHead } = await gitRevisions(project.root);
  const driftFor = async (gitHead: string | null): Promise<number | null> => {
    if (!gitHead) return null;
    if (!driftByHead.has(gitHead)) {
      driftByHead.set(gitHead, await codeMovedSince(project, changeId, gitHead, currentGitHead === 'unknown' ? undefined : currentGitHead));
    }
    return driftByHead.get(gitHead) ?? null;
  };
  for (const gate of gates) {
    const resource = resources.gates.get(gate);
    if (!resource) {
      summaries.push({ gate, status: null, command: null, evidencePath: null, currentContentRevision: null, gitHead: null, sourceFilesChangedSince: null });
      continue;
    }
    const relative = `${project.changesPath}/${changeId}/evidence/${resource.value.spec.evidence}`;
    try {
      const evidence = JSON.parse(await readFile(await safeResolve(project.root, relative), 'utf8')) as {
        status?: string; command?: string[]; contentRevision?: string; gitHead?: string;
      };
      const gitHead = evidence.gitHead ?? null;
      summaries.push({
        gate,
        status: evidence.status ?? null,
        command: evidence.command ?? null,
        evidencePath: relative,
        /* Content-bound staleness: `gateBlockReason` already refuses to advance on it, and this
           makes the same fact visible before somebody plans around it. */
        currentContentRevision: contentRevision === null ? null : evidence.contentRevision === contentRevision,
        gitHead,
        /* Code-bound staleness, which the line above structurally cannot see. */
        sourceFilesChangedSince: await driftFor(gitHead),
      });
    } catch {
      /* Not yet run, or unreadable. Both are "no Evidence", which the Gate machinery reports far
         more precisely than this summary could. */
      summaries.push({ gate, status: null, command: null, evidencePath: relative, currentContentRevision: null, gitHead: null, sourceFilesChangedSince: null });
    }
  }
  return summaries;
}

interface ActiveChangeSummary {
  id: string;
  flow: string | null;
  stage: string | null;
  risk: string | null;
}

/**
 * One line per un-archived Change: which Flow it runs and the Stage it currently sits at.
 *
 * `changes` alone answers "what exists". Once Changes run in parallel the question becomes "what is
 * in flight and where is each one stuck", and answering that used to cost one
 * `state --change <id>` process per Change — so nobody asked it.
 *
 * Stage comes from the last Transition receipt (the same derivation `resolveControlPlane` uses at
 * `control-plane.ts:489`) rather than from a full control-plane resolve: a listing needs each
 * Change's position, not its governance verdict, and computing revisions for every Change to print
 * one column would make the common call the expensive one.
 *
 * A Change whose config or Flow will not resolve is still listed, with nulls — dropping it would
 * hide exactly the Change most likely to need attention.
 */
async function activeChangeSummaries(
  project: ProjectContext,
  changeIds: readonly string[],
  flows: Map<string, Flow>,
): Promise<ActiveChangeSummary[]> {
  return Promise.all(changeIds.map(async (id): Promise<ActiveChangeSummary> => {
    try {
      const resolved = await resolveChangeState(project, id, flows);
      const flow = resolved.flow.metadata.name;
      const risk = resolved.config.classification?.risk ?? null;
      if (!isStageFlow(resolved.flow)) return { id, flow, stage: null, risk };
      const transitions = await loadTransitionReceipts(project, id, resolved.flow);
      return { id, flow, stage: transitions.receipts.at(-1)?.to ?? resolved.flow.stages[0]?.id ?? null, risk };
    } catch {
      return { id, flow: null, stage: null, risk: null };
    }
  }));
}

/**
 * Sections `state` leaves out until they are asked for.
 *
 * Each one is a fact about the project rather than about the turn: the Flow definitions, the
 * runtime capability matrix, the lockfile digests, the Constitution's text, the Transition receipt
 * chain. None of them change between two consecutive reads, and a measured solid run makes
 * thirty-two `state` calls, so each was being re-sent thirty-two times to be read at most once.
 *
 * They are omitted, not summarised away: every one is still addressable, and the payload names the
 * option that returns it rather than leaving a caller to discover that a key stopped existing.
 */
export const STATE_SECTIONS = ['flows', 'targets', 'lockedResources', 'constitution', 'transitions'] as const;
export type StateSection = (typeof STATE_SECTIONS)[number];

interface StateOptions {
  change?: string;
  kind?: 'skills' | 'agents' | 'rules' | 'policies' | 'hooks' | 'gates' | 'scripts' | 'mcp-servers';
  target?: TargetId;
  /** Sections to restore to the payload. `all` is expanded by the caller, not here. */
  include?: readonly StateSection[];
}

export async function readState(project: ProjectContext, options: StateOptions): Promise<{
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
}> {
  const diagnostics = [...project.diagnostics];
  const flowResult = await loadFlows(project);
  diagnostics.push(...flowResult.diagnostics);
  const resources = await loadSelectedResources(project);
  diagnostics.push(...resources.diagnostics);
  if (stableStringify(project.lock?.resources ?? []) !== stableStringify(await resolvedResourceEntries(project, resources))) {
    diagnostics.push(diagnostic('XFORGE_LOCK_RESOURCES_MISMATCH', 'Lockfile resource identities or content digests differ from selected project assets.', 'xforge/lock.yaml', 'warning'));
  }

  if (options.target && !TARGETS.includes(options.target)) {
    diagnostics.push(diagnostic('XFORGE_TARGET_UNKNOWN', `Unknown target: ${options.target}`));
  }

  const specsAbsolute = await safeResolve(project.root, project.specsPath);
  const changesAbsolute = await safeResolve(project.root, project.changesPath);
  const specs = await exists(specsAbsolute)
    ? (await fg('**/*.md', { cwd: specsAbsolute, onlyFiles: true, followSymbolicLinks: false })).sort()
    : [];
  const changes = await directoriesAt(changesAbsolute);
  const activeChanges = await activeChangeSummaries(project, changes, flowResult.flows);
  const wanted = new Set(options.include ?? []);
  const flowDetail = (flow: Flow) => {
    const apply = flowApplyOperation(flow);
    const archive = flowArchiveOperation(flow);
    return {
      id: flow.metadata.name,
      version: flow.metadata.version,
      apiVersion: flow.apiVersion,
      description: flow.metadata.description,
      policy: isStageFlow(flow) ? flow.policy : null,
      stages: isStageFlow(flow) ? flow.stages.map((stage) => ({
        id: stage.id,
        skill: stage.skill,
        /*
         * Reported exactly as the Flow declares it, and descriptive only: `authority` names the
         * write scope a Stage is documented to have so an Agent can keep inside it, but nothing in
         * XForge compares it against an operation. What actually refuses a write is the effective
         * PermissionPolicy, the Gates, and the Approvals — the Skill text says the same thing, and
         * this field must not be read as a capability the CLI enforces.
         */
        authority: stage.authority,
        requires: stage.requires,
        produces: stage.produces,
      })) : null,
      artifacts: flowArtifacts(flow).map((artifact) => ({ id: artifact.id, generates: artifact.generates, requires: artifact.requires })),
      applyRequires: apply.requires,
      archiveRequires: archive.requires,
      mandatoryGates: archive.mandatoryGates,
    };
  };
  /* Name, version and description only. Enough to answer "which Flows does this project have" and
     to pick one, which is the whole of what the catalogue was ever read for. */
  const flowCatalogue = (flow: Flow) => ({
    id: flow.metadata.name,
    version: flow.metadata.version,
    description: flow.metadata.description,
    /* `policy` stays. Choosing a Flow is what this listing is for, and `eligibleWhen`/`requiredWhen`
       are what the choice is made against -- `xforge-propose` reads them by name. */
    policy: isStageFlow(flow) ? flow.policy : null,
    stages: isStageFlow(flow) ? flow.stages.map((stage) => stage.id) : null,
  });

  let selectedChange: ChangeState | null = null;
  let context: Record<string, unknown> | null = null;
  let selectedFlow: Flow | null = null;
  if (options.change) {
    const resolved = await resolveChangeState(project, options.change, flowResult.flows);
    selectedChange = resolved.state;
    selectedFlow = resolved.flow;
    diagnostics.push(...resolved.diagnostics);
    // Surface a mismatched Flow on the very first read, not only at transition or archive.
    diagnostics.push(...flowEligibilityDiagnostics(
      resolved.flow,
      resolved.config,
      flowResult.flows.values(),
      `${project.changesPath}/${options.change}/change.yaml`,
    ));
    const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
    diagnostics.push(...workPackages.diagnostics);
    selectedChange.workPackages = workPackages.state;
    let contentRevision: string | null = null;
    if (isStageFlow(resolved.flow) && resolved.flow.governance) {
      const control = await resolveControlPlane(project, options.change, resolved.flow, selectedChange, resources, resolved.config, { workPackages });
      diagnostics.push(...control.diagnostics);
      /*
       * The chain is trimmed here and nowhere earlier. `resolveControlPlane` decides against the
       * whole of it -- `control-plane.ts:539` reads the last receipt, `:590` walks back to a rework
       * cutoff -- so this is a presentation cut over a value that has already done its work.
       *
       * It is the one section that grows: a receipt is appended per Stage and never removed, so a
       * Major Change re-sent its entire history on every one of the thirty-two `state` calls a run
       * makes, and the read was always of the last entry. What stays is that entry, the count, and
       * the route taken -- enough to answer "where has this been" without carrying the receipts.
       */
      selectedChange.governance = { ...control.governance, transitions: wanted.has('transitions')
        ? control.governance.transitions
        : {
          count: control.governance.transitions.length,
          route: control.governance.transitions.map((receipt) => receipt.to),
          latest: control.governance.transitions.at(-1) ?? null,
          omitted: 'Run state --include transitions for the full receipt chain.',
        } as never };
      contentRevision = control.governance.revision.contentRevision;
    }
    selectedChange.mandatoryGateEvidence = await mandatoryGateEvidence(project, options.change, selectedChange.archive.mandatoryGates, resources, contentRevision);
    const relevantRules = [...resources.rules.values()]
      .map((rule) => normalizeRule(rule.value))
      .filter((rule) => ruleApplies(rule, resolved.config, selectedChange?.governance?.currentStage))
      .map((rule) => ({ id: rule.id, severity: rule.severity, instruction: rule.instruction, gateRefs: rule.gateRefs, policyRefs: rule.policyRefs, approvalRefs: rule.approvalRefs }));
    context = {
      /*
       * The Constitution's text, not a reference to it, was returned here on every read. Three
       * copies reached one session: `XFORGE.md` has the Agent read the file at bootstrap,
       * `stage-bundle` lists it as always-read at every Stage, and this sent the whole of it again
       * per call. The first two are deliberate -- the document nobody skips. This one was the
       * duplicate, so it names the file the other two already read.
       */
      constitution: wanted.has('constitution')
        ? project.constitution
        : { version: project.constitution.version, ratified: project.constitution.ratified, lastAmended: project.constitution.lastAmended, path: project.constitution.path, content: undefined, omitted: 'Read the file at `path`, or run state --include constitution.' },
      rules: relevantRules,
      relatedSpecs: specs,
      nextArtifact: selectedChange.nextArtifact,
      workPackages: selectedChange.workPackages,
    };
  }

  const resourceSummary: Record<string, unknown> = {
    skills: [...resources.skills.keys()],
    agents: [...resources.agents.keys()],
    rules: [...resources.rules.keys()],
    policies: [...resources.policies.keys()],
    hooks: [...resources.hooks.entries()].map(([id, hook]) => ({ id, enabled: hook.value.spec.enabled !== false })),
    gates: [...resources.gates.keys()],
    scripts: [...resources.scripts.keys()],
    'mcp-servers': [...resources.mcpServers.keys()],
  };
  const filteredResources = options.kind ? { [options.kind]: resourceSummary[options.kind] } : resourceSummary;
  const targetList = options.target ? [options.target] : project.manifest.targets;
  const installation = installationSummary(await readOwnership(project));

  return {
    data: {
      project: {
        name: project.manifest.metadata.name,
        layout: project.manifest.project.layout,
        modules: project.manifest.project.modules,
        paths: {
          specs: { value: project.specsPath, source: project.specsPathSource },
          changes: { value: project.changesPath, source: project.changesPathSource },
        },
        compatibility: project.compatibility,
      },
      scaffold: {
        version: project.manifest.scaffold.version,
        source: project.manifest.scaffold.source,
        language: project.manifest.scaffold.language,
        /* A digest per installed asset. Nothing an Agent does is decided from it -- a drift in it
           is reported as XFORGE_LOCK_RESOURCES_MISMATCH above, which is the actionable form. */
        ...(wanted.has('lockedResources')
          ? { lockedResources: project.lock?.resources ?? [] }
          : { lockedResources: null, lockedResourceCount: (project.lock?.resources ?? []).length }),
      },
      xforge: {
        declaration: project.manifest.xforge,
        integrity: project.lock?.xforge?.integrity ?? null,
      },
      specs,
      changes,
      activeChanges,
      /*
       * One Change runs one Flow. Returning all three in full on a `--change` read sent two Flow
       * definitions that could not apply to the Change being asked about; `flowStages` in cli.ts
       * looks up exactly one by id, which is the only read this ever had.
       */
      flows: wanted.has('flows')
        ? [...flowResult.flows.values()].map(flowDetail)
        : selectedFlow
          ? [flowDetail(selectedFlow)]
          : [...flowResult.flows.values()].map(flowCatalogue),
      resources: filteredResources,
      /* Per-target capability matrix. Read once, when Apply decides whether parallel Workers are
         available -- and `xforge-apply` is told to check the runtime's own list regardless. */
      targets: wanted.has('targets') ? capabilityMatrix(targetList) : null,
      installation,
      change: selectedChange,
      context,
    },
    diagnostics,
  };
}
