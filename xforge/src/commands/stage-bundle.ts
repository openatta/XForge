import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import type { Diagnostic, NextAction, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';
import { documentSections } from '../core/artifact-markers.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { git } from '../core/work-packages.js';

/**
 * What a Stage actually has to be re-read, and what it can take on a digest.
 *
 * Every Stage's Skill tells an Agent to read the Change's Artifacts from disk — the Proposal, the
 * Specs, the Clarifications, the Design, the Check report — because chat memory is not a source of
 * truth. That instruction is right and it is expensive: a field report measured sixty kilobytes of
 * governance text per Change and six Stages that each re-read all of it, roughly 360KB into a model
 * for a Change whose product code was 4,684 lines. Most of those bytes had not changed since the
 * previous Stage read them.
 *
 * XForge already knows which ones did. A Transition receipt records the `gitHead` the Stage was
 * entered at, so `git diff <that head>..HEAD` over the Change directory *is* the set of Artifacts
 * that moved. Nothing new has to be persisted to answer this — the report proposing it assumed a
 * per-Artifact digest chain would be needed, and there isn't one: `revision.ts` computes per-file
 * digests and immediately collapses them into a single rollup. The receipt is the cheaper route and
 * it was already there.
 *
 * Three rules make this a reading plan rather than a shortcut around the evidence:
 *
 * - **The current Stage's own outputs are always read in full.** They are what this Stage is
 *   writing; a digest of them proves nothing about work in progress.
 * - **The Constitution is always read in full.** It is the one document whose whole point is that
 *   nobody gets to skip it, and it is small.
 * - **A dirty working tree voids every voucher.** `git diff` compares commits. An uncommitted edit
 *   is invisible to it, so a voucher issued over one would say "unchanged" about a file that
 *   changed — the failure mode that turns a slow instruction into a wrong one. When the tree is
 *   dirty this reports everything as `read`, which is exactly what the Skills did before.
 */
interface StageBundleResult {
  data: {
    change: string;
    stage: string;
    /** The receipt this Stage was entered by, and the commit it recorded. `null` at the first Stage. */
    since: { receiptId: string; from: string; to: string; gitHead: string } | null;
    worktreeClean: boolean;
    /** Read these in full. */
    read: Array<{ path: string; reason: 'changed-since-stage-entered' | 'written-by-this-stage' | 'always' | 'no-baseline' | 'worktree-dirty' }>;
    /** Unchanged since this Stage was entered, with what stands in for reading them. */
    vouched: Array<{ path: string; digest: string; sections: string[] }>;
    bytes: { read: number; vouched: number };
  };
  diagnostics: Diagnostic[];
  nextActions: NextAction[];
}

/** Markdown and YAML under the Change, which is what a Skill is told to read. */
async function changeDocuments(project: ProjectContext, changeId: string): Promise<string[]> {
  const root = `${project.changesPath}/${changeId}`;
  const absolute = await safeResolve(project.root, root);
  const found = await fg(['**/*.md', '**/*.yaml'], { cwd: absolute, onlyFiles: true, followSymbolicLinks: false });
  /* Evidence is machine-written and read by the CLI, not by a Skill following its instructions. */
  return found.filter((relative) => !relative.startsWith('evidence/')).map((relative) => `${root}/${relative}`).sort();
}

export async function executeStageBundle(
  project: ProjectContext,
  options: { change: string },
): Promise<StageBundleResult> {
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) {
    throw new XForgeError(diagnostic(
      'XFORGE_GOVERNANCE_FLOW_REQUIRED',
      'stage-bundle requires a Protocol 2 governed Flow: without Stages there is no "since the last Stage" to compute.',
    ));
  }
  const resources = await loadSelectedResources(project);
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  const stage = control.governance.currentStage;
  const diagnostics: Diagnostic[] = [];
  const changeRoot = `${project.changesPath}/${options.change}`;

  const receipt = control.governance.transitions.at(-1) ?? null;
  const since = receipt ? { receiptId: receipt.receiptId, from: receipt.from, to: receipt.to, gitHead: receipt.gitHead } : null;

  /*
   * Uncommitted work anywhere under the Change voids the comparison, not just uncommitted work in
   * the file being vouched for: `git diff` answers about commits, and a tree with staged or unstaged
   * edits is a tree this cannot speak for.
   */
  const status = await git(project.root, ['status', '--porcelain', '--', changeRoot]);
  const worktreeClean = status.code === 0 && status.stdout.trim().length === 0;
  if (status.code !== 0) {
    diagnostics.push(diagnostic('XFORGE_STAGE_BUNDLE_GIT_UNAVAILABLE', `Git could not report the Change's status, so nothing can be vouched for: ${status.stderr.trim()}`, changeRoot, 'warning'));
  }

  let changed = new Set<string>();
  if (since && worktreeClean) {
    const diff = await git(project.root, ['diff', '--name-only', '--no-renames', '-z', `${since.gitHead}..HEAD`, '--', changeRoot]);
    if (diff.code !== 0) {
      diagnostics.push(diagnostic('XFORGE_STAGE_BUNDLE_GIT_UNAVAILABLE', `Git could not compare ${since.gitHead} with HEAD, so nothing can be vouched for: ${diff.stderr.trim()}`, changeRoot, 'warning'));
    } else {
      changed = new Set(diff.stdout.split('\0').filter(Boolean));
    }
  }

  const stageDefinition = resolved.flow.stages.find((entry) => entry.id === stage);
  const producedHere = new Set<string>();
  for (const artifactId of stageDefinition?.produces ?? []) {
    const artifact = resolved.flow.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) continue;
    /* `generates` is a path or a glob relative to the Change. A glob is matched rather than compared,
       because a delta Spec declares one and the files it produces are named by the author. */
    producedHere.add(`${changeRoot}/${artifact.generates}`);
  }

  const read: StageBundleResult['data']['read'] = [];
  const vouched: StageBundleResult['data']['vouched'] = [];
  let readBytes = 0;
  let vouchedBytes = 0;

  for (const relative of await changeDocuments(project, options.change)) {
    const content = await readFile(await safeResolve(project.root, relative), 'utf8');
    const size = Buffer.byteLength(content);
    const written = [...producedHere].some((pattern) => (pattern.includes('*')
      ? fg.sync(pattern, { cwd: project.root, onlyFiles: true, followSymbolicLinks: false }).includes(relative)
      : pattern === relative));
    const reason = written ? 'written-by-this-stage'
      : !worktreeClean ? 'worktree-dirty'
        : !since ? 'no-baseline'
          : changed.has(relative) ? 'changed-since-stage-entered'
            : null;
    if (reason) {
      read.push({ path: relative, reason });
      readBytes += size;
      continue;
    }
    vouched.push({
      path: relative,
      digest: sha256(content),
      /* The `## ` headings, which say what the document covers without saying what it says. Enough
         to decide whether it needs opening; not enough to stand in for having opened it. */
      sections: [...documentSections(content).keys()],
    });
    vouchedBytes += size;
  }

  /* The Constitution is always read, and is not under the Change. */
  read.push({ path: project.constitution.path, reason: 'always' });
  readBytes += Buffer.byteLength(project.constitution.content);

  if (!worktreeClean) {
    diagnostics.push(diagnostic(
      'XFORGE_STAGE_BUNDLE_TREE_DIRTY',
      `The Change directory has uncommitted edits, so every Artifact is listed to be read in full. A digest voucher compares commits, and an uncommitted change is invisible to that comparison — vouching over one would report "unchanged" about a file that changed, which is worse than the re-reading this command exists to avoid. Commit the Change directory and run this again to get the short list.`,
      changeRoot,
      'info',
    ));
  } else if (!since) {
    diagnostics.push(diagnostic(
      'XFORGE_STAGE_BUNDLE_NO_BASELINE',
      `This Change has recorded no Transition yet, so there is no earlier Stage to compare against and everything is listed to be read. From the next Stage on, the receipt this transition writes becomes the baseline.`,
      changeRoot,
      'info',
    ));
  }

  return {
    data: { change: options.change, stage, since, worktreeClean, read, vouched, bytes: { read: readBytes, vouched: vouchedBytes } },
    diagnostics,
    nextActions: [],
  };
}

/** The readable form: a reading plan, which is the whole output. */
export function renderStageBundleText(data: StageBundleResult['data']): string {
  const lines: string[] = [];
  lines.push(`Stage bundle — ${data.change} @ ${data.stage}`);
  lines.push(data.since
    ? `  Unchanged since ${data.since.from} -> ${data.since.to} at ${data.since.gitHead.slice(0, 8)}`
    : '  No earlier Stage to compare against.');
  lines.push('');
  lines.push(`READ IN FULL (${data.read.length}, ${data.bytes.read} bytes)`);
  for (const entry of data.read) lines.push(`    ${entry.path}  [${entry.reason}]`);
  lines.push('');
  lines.push(`UNCHANGED — digest stands in for re-reading (${data.vouched.length}, ${data.bytes.vouched} bytes)`);
  for (const entry of data.vouched) {
    lines.push(`    ${entry.path}  ${entry.digest.slice(0, 12)}`);
    if (entry.sections.length > 0) lines.push(`      covers: ${entry.sections.join(', ')}`);
  }
  lines.push('');
  lines.push('Open any of the unchanged files anyway when you need to check its wording; the digest');
  lines.push('says it is the same text the previous Stage read, not that reading it is forbidden.');
  return `${lines.join('\n')}\n`;
}
