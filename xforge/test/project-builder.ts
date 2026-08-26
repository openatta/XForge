import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { CHECK_FINDINGS_PATH } from '../src/core/check-findings.js';
import { CONSTITUTION_CHECK_PATH, constitutionPrinciples } from '../src/core/constitution-check.js';
import { VERIFICATION_RECEIPT_PATH } from '../src/core/verification-receipt.js';
import { approveCurrentRevision, fixture, runCli, updateYaml, write } from './helpers.js';

/**
 * A Change built to order, driven by the Flow rather than by a copy of it.
 *
 * The suite's fixtures were three hard-coded functions -- `createCompleteSolidChange`,
 * `advanceSolidToApply`, `advanceSolidToReadyToArchive` -- which is why almost every test in it runs
 * one Flow, at one Stage, with one work package. Two whole classes of defect live outside that
 * point and were invisible from it: `latestDispatchFor` was correct with one package and wrong with
 * thirteen, and a merge conflict that can only surface after an approval could not be reached at
 * all.
 *
 * Two rules this builder keeps, both learned from the fixtures it replaces.
 *
 * **It reads the Flow instead of restating it.** Artifacts are generated from each Stage's declared
 * `outline`, Gates from what the Stage declares, approvals from `exit.approvals`. A hard-coded
 * fixture goes stale silently when a Flow changes -- it keeps passing while testing the shape the
 * product used to have -- and the three it replaces had already drifted that way once.
 *
 * **It never writes a receipt.** Every transition and every approval goes through the real CLI, and
 * the approval through the real terminal dialogue. A fixture that hand-writes a receipt is a fixture
 * that can set up a state the product cannot reach, and the tests built on it then assert about a
 * world that does not exist.
 */

export type FlowName = 'quick' | 'solid' | 'major';

export interface BuiltProject {
  root: string;
  change: string;
  /** The Stage the Change was left at; `ready-to-archive` when the walk ran to the end. */
  stage: string;
}

interface FlowArtifact {
  id: string;
  generates: string;
  outline?: string;
}

interface FlowDefinition {
  artifacts: FlowArtifact[];
  stages: Array<{ id: string; produces?: string[]; gates?: string[]; exit?: { approvals?: string[]; conditions?: Record<string, string> } }>;
  terminal: { archive: { approvals?: string[] } };
}

export class ProjectBuilder {
  private flowName: FlowName = 'solid';
  private changeId = 'add-feature';
  private scopePaths = ['src/**'];
  private packageCount = 0;
  private findingEntries: string[] = [];
  private target: string | null = null;

  flow(name: FlowName): this { this.flowName = name; return this; }
  change(id: string): this { this.changeId = id; return this; }
  /** The paths this Change declares — what Rule scope is compared against, not what exists on disk. */
  scope(paths: string[]): this { this.scopePaths = paths; return this; }
  /** How many work packages the plan declares. The number is the variable two defects hid behind. */
  packages(count: number): this { this.packageCount = count; return this; }
  findings(entries: string[]): this { this.findingEntries = entries; return this; }
  /** Walk to this Stage, or to `ready-to-archive`. Omitted leaves the Change at the first Stage. */
  atStage(stage: string): this { this.target = stage; return this; }

  async build(): Promise<BuiltProject> {
    const root = await fixture();
    const flow = await readFlow(root, this.flowName);
    await this.writeChange(root, flow);
    await this.writeConditionLedgers(root, flow);
    if (this.packageCount > 0) {
      await this.writePlan(root);
      /* A plan's deliveries are measured from commits, so the product refuses one outside a
         worktree. The fixture is a real repository for the same reason the CLI insists on it. */
      await initializeGit(root);
    }
    const stage = this.target ? await this.walkTo(root, flow, this.target) : flow.stages[0]!.id;
    return { root, change: this.changeId, stage };
  }

  private async writeChange(root: string, flow: FlowDefinition): Promise<void> {
    const base = `xforge/changes/${this.changeId}`;
    await write(root, `${base}/change.yaml`, stringify({
      flow: this.flowName,
      classification: {
        risk: this.flowName === 'quick' ? 'low' : this.flowName === 'major' ? 'high' : 'medium',
        security: false, privacy: false, publicApi: false, dataMigration: false,
      },
      scope: { modules: ['root'], paths: this.scopePaths },
    }, { sortMapEntries: true }));

    /* Every Artifact the Flow declares, at once. A Stage refuses to be left without the ones it
       produces, and writing them up front costs nothing while writing them per Stage would encode
       the Stage order here — the thing this builder exists not to encode. */
    for (const artifact of flow.artifacts) {
      const body = await this.artifactBody(root, artifact);
      if (body === null) continue;
      const relative = artifact.generates.includes('*') ? 'specs/widget/spec.md' : artifact.generates;
      await write(root, `${base}/${relative}`, body);
    }
  }

  /** Content that satisfies an Artifact's declared outline, or a ledger's schema. */
  private async artifactBody(root: string, artifact: FlowArtifact): Promise<string | null> {
    if (artifact.generates.endsWith(CHECK_FINDINGS_PATH.split('/').pop()!)) {
      return this.findingEntries.length > 0 ? `findings:\n${this.findingEntries.join('\n')}\n` : 'findings: []\n';
    }
    if (artifact.generates.endsWith(CONSTITUTION_CHECK_PATH.split('/').pop()!)) {
      const source = await readFile(path.join(root, 'xforge', 'constitution.md'), 'utf8');
      return `principles:\n${constitutionPrinciples(source)
        .map((name) => `  - principle: ${JSON.stringify(name)}\n    status: compliant\n    references: [proposal.md]\n`)
        .join('')}`;
    }
    if (artifact.generates.includes('*')) {
      /* A delta Spec's outline is a repeating template rather than a section set, so it is written
         from the shape the merger accepts instead of from the headings. */
      return '## ADDED Requirements\n\n### Requirement: REQ-001 Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n';
    }
    const headings = (artifact.outline ?? '').split('\n').filter((line) => line.startsWith('## '));
    if (headings.length === 0) return null;
    /* Each declared heading, with a line under it: a marker the Flow declares in a section that is
       empty reports as missing, which is a warning the fixture should not be generating. */
    return `${headings.map((heading) => `${heading}\n\nRecorded for the fixture.\n`).join('\n')}`;
  }

  /**
   * A ledger for every exit condition a Stage declares, other than the two that are decided from
   * elsewhere.
   *
   * `verificationReceipt` is written from the Gate Evidence that actually ran, and
   * `independentReview` is satisfied by an acknowledgement receipt rather than a ledger. Everything
   * else is a project's own condition, answered in `evidence/conditions/<key>.yaml`, where an entry
   * that names no decision-maker the repository records does not count as decided.
   */
  private async writeConditionLedgers(root: string, flow: FlowDefinition): Promise<void> {
    const keys = new Set<string>();
    for (const stage of flow.stages) {
      for (const key of Object.keys(stage.exit?.conditions ?? {})) {
        if (key === 'verificationReceipt' || key === 'independentReview') continue;
        keys.add(key);
      }
    }
    for (const key of keys) {
      await write(root, `xforge/changes/${this.changeId}/evidence/conditions/${key}.yaml`, stringify({
        condition: key,
        /* An explicit empty list is an assertion -- "this Change raised none" -- and the same one
           `findings: []` makes. A fixture that invented entries would be asserting decisions
           nobody made. */
        entries: [],
      }, { sortMapEntries: true }));
    }
  }

  private async writePlan(root: string): Promise<void> {
    const packages = Array.from({ length: this.packageCount }, (_, index) => {
      const id = `wp-${String(index + 1).padStart(3, '0')}`;
      return {
        id,
        goal: `Implement ${id}`,
        depends_on: [],
        inputs: [`xforge/changes/${this.changeId}/design.md`],
        write_paths: [`src/${id}/**`],
        skills: ['xforge-apply'],
        verify: [[process.execPath, '-e', 'process.exit(0)']],
        done_when: [`${id} is covered by an automated check`],
      };
    });
    await write(root, `xforge/changes/${this.changeId}/work-packages.yaml`,
      stringify({ apiVersion: 'xforge.dev/v1alpha1', kind: 'WorkPackagePlan', packages }, { lineWidth: 120 }));
  }

  /**
   * Walks the Flow's own Stage list, doing at each Stage exactly what that Stage declares it needs.
   *
   * No Stage name appears here except the synthetic `ready-to-archive`, which is the one the Flow
   * genuinely does not declare.
   */
  private async walkTo(root: string, flow: FlowDefinition, target: string): Promise<string> {
    const ids = flow.stages.map((stage) => stage.id);
    const stop = target === 'ready-to-archive' ? ids.length : ids.indexOf(target);
    if (stop < 0) throw new Error(`Flow ${this.flowName} declares no Stage ${target}; it has ${ids.join(', ')}.`);

    for (let index = 0; index < stop; index += 1) {
      const stage = flow.stages[index]!;
      const next = ids[index + 1] ?? 'ready-to-archive';
      if ((stage.gates ?? []).length > 0) await this.cli(root, ['check', '--change', this.changeId]);
      if (stage.exit?.conditions?.verificationReceipt !== undefined) await this.writeReceipt(root);
      for (const policy of stage.exit?.approvals ?? []) {
        await approveCurrentRevision(root, this.changeId, next, policy);
      }
      await this.cli(root, ['transition', '--change', this.changeId, '--to', next]);
    }
    if (target === 'ready-to-archive') {
      for (const policy of flow.terminal.archive.approvals ?? []) {
        await approveCurrentRevision(root, this.changeId, 'archive', policy);
      }
    }
    return target;
  }

  /**
   * The receipt, from what actually ran.
   *
   * Cites only this Stage's Gates at the current content revision, which is the same rule
   * `evaluate()` applies — a receipt naming an earlier Stage's Evidence is refused as unverifiable,
   * and one naming a superseded revision is refused as stale.
   */
  private async writeReceipt(root: string): Promise<void> {
    const state = await this.cli(root, ['state', '--change', this.changeId]);
    const governance = state.data.change.governance;
    const flow = await readFlow(root, this.flowName);
    const stage = flow.stages.find((item) => item.id === governance.currentStage);
    const stageGates = new Set(stage?.gates ?? []);
    const evidenceRoot = path.join(root, state.data.change.path, 'evidence');
    const gates: Array<{ gate: string; status: string }> = [];
    let gitHead = '';
    const { readdir } = await import('node:fs/promises');
    for (const name of (await readdir(evidenceRoot)).filter((item) => item.endsWith('.json')).sort()) {
      const evidence = JSON.parse(await readFile(path.join(evidenceRoot, name), 'utf8'));
      if (!stageGates.has(evidence.gate) || evidence.status !== 'passed') continue;
      if (evidence.contentRevision !== governance.revision.contentRevision) continue;
      gates.push({ gate: evidence.gate, status: 'passed' });
      gitHead ||= evidence.gitHead;
    }
    await write(root, `${state.data.change.path}/${VERIFICATION_RECEIPT_PATH}`, stringify({
      status: 'passed', contentRevision: governance.revision.contentRevision, gitHead, gates,
    }));
  }

  private async cli(root: string, args: string[]): Promise<any> {
    const result = await runCli(root, args);
    if (result.code !== 0) {
      throw new Error(`${args.join(' ')} failed:\n${JSON.stringify(result.json?.diagnostics ?? result.stderr, null, 2)}`);
    }
    return result.json;
  }
}

export function project(): ProjectBuilder {
  return new ProjectBuilder();
}

async function initializeGit(root: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const args of [['init', '-q'], ['config', 'user.name', 'XForge Test'], ['config', 'user.email', 'test@example.test'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    await run('git', ['-C', root, ...args]);
  }
}

async function readFlow(root: string, name: FlowName): Promise<FlowDefinition> {
  return parse(await readFile(path.join(root, 'xforge', 'flows', `${name}.yaml`), 'utf8')) as FlowDefinition;
}

/** Declares a `builtin: declared` Gate's command, so a fixture stands for a configured project. */
export async function declareVerification(root: string, gate: string): Promise<void> {
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    manifest.verification = manifest.verification ?? {};
    manifest.verification[gate] = [{
      command: ['node', '-e', 'console.log("fixture verification ok")'],
      declaredBy: 'owner@example.test',
      declaredAt: '2026-01-01T00:00:00Z',
    }];
  });
}
