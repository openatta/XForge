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
    /**
     * Read these in full — and, unless `content: 'none'`, their text, so that reading them is not a
     * second round trip.
     *
     * Listing the paths was half an answer. Twelve measured Stages spent 58-81% of their calls on
     * orientation, and the largest single bucket was opening the files a command had just named:
     * `Read` and shell `cat`/`ls` together outnumbered every governance call three to one. A turn
     * re-sends the whole conversation; a second file read inside one process does not. So the text
     * travels with the plan.
     */
    read: Array<{ path: string; reason: 'changed-since-stage-entered' | 'written-by-this-stage' | 'always' | 'no-baseline' | 'worktree-dirty' | 'comparison-unavailable' | 'declared-input'; text?: string }>;
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
  options: { change: string; content?: 'none' | 'changed' | 'full' },
): Promise<StageBundleResult> {
  /*
   * How much of the plan arrives as text, named by intent rather than by field.
   *
   * `changed` is the default and the honest one: the Stage's own outputs, whatever moved since the
   * Stage was entered, and the Constitution — the set this command already computed — with their
   * contents. `full` gives up the digest vouchers and reads everything, for when a voucher is not
   * enough. `none` is the plan alone, for a cheap re-poll.
   *
   * Deliberately not a list of paths or fields to include. A caller enumerating what it wants has
   * to already know what it needs, which is the question it is asking; and a wrong guess costs the
   * whole reply, the way a mistyped `--field` does.
   */
  const content = options.content ?? 'changed';
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

  /*
   * `null` means the comparison could not be made, which is not the same as "nothing changed".
   *
   * It was a plain empty Set, and every path that failed to fill it -- a `git diff` that exited
   * non-zero on a shallow clone or a pruned baseline commit -- fell through to the same place a
   * successful empty diff does, so the command vouched for every Artifact one line after saying
   * "nothing can be vouched for". A warning that the code contradicts is worse than no warning.
   */
  let changed: Set<string> | null = null;
  if (since && worktreeClean) {
    /*
     * Git names files from the repository root; this command compares them with paths relative to
     * the project root, and those are the same string only when the project *is* the repository.
     * In a monorepo (`/r` the repository, `/r/app` the project) every diffed path arrives as
     * `app/xforge/changes/...` and matches nothing, so a document that changed is reported as
     * unchanged -- with a digest offered as the text the previous Stage read.
     *
     * `--show-prefix` is that offset, and stripping it puts both sides in the project's own terms.
     * `check.ts:140` refuses outright in this situation; refusing here would take the command away
     * from every monorepo, and the offset is knowable, so it is used instead.
     */
    const prefix = await git(project.root, ['rev-parse', '--show-prefix']);
    const diff = await git(project.root, ['diff', '--name-only', '--no-renames', '-z', `${since.gitHead}..HEAD`, '--', changeRoot]);
    if (prefix.code !== 0 || diff.code !== 0) {
      diagnostics.push(diagnostic('XFORGE_STAGE_BUNDLE_GIT_UNAVAILABLE', `Git could not compare ${since.gitHead} with HEAD, so nothing can be vouched for and every Artifact is listed to be read: ${(diff.code !== 0 ? diff.stderr : prefix.stderr).trim()}`, changeRoot, 'warning'));
    } else {
      const offset = prefix.stdout.trim();
      changed = new Set(diff.stdout.split('\0').filter(Boolean)
        .map((repositoryPath) => (offset && repositoryPath.startsWith(offset) ? repositoryPath.slice(offset.length) : repositoryPath)));
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
    const source = await readFile(await safeResolve(project.root, relative), 'utf8');
    const size = Buffer.byteLength(source);
    const written = [...producedHere].some((pattern) => (pattern.includes('*')
      ? fg.sync(pattern, { cwd: project.root, onlyFiles: true, followSymbolicLinks: false }).includes(relative)
      : pattern === relative));
    const reason = written ? 'written-by-this-stage'
      : content === 'full' ? 'always'
        : !worktreeClean ? 'worktree-dirty'
          : !since ? 'no-baseline'
            : changed === null ? 'comparison-unavailable'
              : changed.has(relative) ? 'changed-since-stage-entered'
                : null;
    if (reason) {
      read.push({ path: relative, reason, ...(content === 'none' ? {} : { text: source }) });
      readBytes += size;
      continue;
    }
    vouched.push({
      path: relative,
      digest: sha256(source),
      /* The `## ` headings, which say what the document covers without saying what it says. Enough
         to decide whether it needs opening; not enough to stand in for having opened it. */
      sections: [...documentSections(source).keys()],
    });
    vouchedBytes += size;
  }

  /* The Constitution is always read, and is not under the Change. */
  read.push({ path: project.constitution.path, reason: 'always', ...(content === 'none' ? {} : { text: project.constitution.content }) });

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


/**
 * The working set as something a person, or a model deciding what to do, actually reads.
 *
 * `--text` had no renderer for `stage`, so it fell through to "the JSON with a heading" and came out
 * *larger* than the JSON it was meant to condense — 29KB against 25.8KB. A measured run reached for
 * it unprompted, which is the right instinct: asked to work out where a Change stands without being
 * told what to open, the first thing wanted is a summary, not a document set.
 *
 * It printed the plan and left the text out, on the reasoning that the contents are what the JSON
 * form is for and this is the form for deciding whether you need them. Twelve measured runs
 * falsified the premise: every one of them called `--text`, none ever dropped it, and each then
 * opened the same files by hand. A form nobody uses is not where the contents should live, and
 * shipping a declared input into the JSON form alone was work that reached no caller at all.
 *
 * So READ now carries what it says it carries, in whichever form is asked for. The budget upstream
 * has already decided which files that is; anything it shed is listed without a body and named in
 * its diagnostic, which is the one case where a path alone is the honest answer.
 */
export function renderStageText(data: {
  change: string; flow: string | null; stage: string;
  action: { id?: string; writes?: string[]; requiredSections?: string[]; inputs?: string[] } | null;
  owes?: Array<{ id: string; status: string; writes: string[]; requiredSections: string[]; outline: string | null }>;
  work?: {
    path: string; baseCommit: string | null; ready: string[]; parallelCandidates: string[];
    waves: Array<{ index: number; packages: string[] }>; unattributedPaths: string[];
    packages: Array<{ id: string; status: string; role: string | null; goal: string; dependsOn: string[]; writePaths: string[]; verify: unknown[]; doneWhen: string[]; delivered: boolean }>;
  } | null;
  ledgerIdentities?: string[];
  stageDeclares: { produces: string[]; gates: string[]; exitConditions: string[]; reworkTo: string[]; authority: string | null } | null;
  blockedBy: string[]; worktreeClean: boolean;
  read: Array<{ path: string; reason: string; text?: string }>;
  vouched: Array<{ path: string; sections: string[] }>;
  bytes: { read: number; vouched: number };
}): string {
  const lines = [`Stage ${data.stage} — ${data.change} on ${data.flow ?? 'an unknown Flow'}`];
  if (data.stageDeclares) {
    const d = data.stageDeclares;
    lines.push(`  produces ${d.produces.join(', ') || '(nothing)'}`);
    if (d.gates.length) lines.push(`  gates ${d.gates.join(', ')}`);
    if (d.exitConditions.length) lines.push(`  cannot exit without ${d.exitConditions.join(', ')}`);
    if (d.reworkTo.length) lines.push(`  a blocker sends it back to ${d.reworkTo.join(' or ')}`);
  }
  lines.push('');
  if (data.action) {
    lines.push(`NEXT  write ${data.action.id} -> ${(data.action.writes ?? []).join(', ')}`);
    if (data.action.requiredSections?.length) lines.push(`      sections: ${data.action.requiredSections.join(' | ')}`);
    if (data.action.inputs?.length) lines.push(`      from: ${data.action.inputs.join(', ')}`);
  } else {
    lines.push('NEXT  no Artifact is ready; see the blockers below.');
  }
  /* Every Artifact still owed, not only the ready one: a Stage that produces three and describes
     one sends the reader to the Flow file for the other two, which is what four measured runs did. */
  const rest = (data.owes ?? []).filter((entry) => entry.id !== data.action?.id);
  if (rest.length) {
    lines.push('', 'ALSO OWED BY THIS STAGE');
    for (const entry of rest) {
      lines.push(`    ${entry.id} (${entry.status}) -> ${entry.writes.join(', ')}`);
      if (entry.requiredSections.length) lines.push(`      sections: ${entry.requiredSections.join(' | ')}`);
      else if (entry.outline) lines.push(`      shape: ${entry.outline.split(/\r?\n/)[0]} …  (full outline in the JSON form)`);
    }
  }
  /* On a Stage whose substance is delivery rather than an Artifact, this is the plan. Reporting
     "no Artifact is ready" and stopping is how `apply` came back empty. */
  if (data.work) {
    const w = data.work;
    lines.push('', `WORK  ${w.path}${w.baseCommit ? `  base ${w.baseCommit.slice(0, 12)}` : ''}`);
    if (w.ready.length) lines.push(`    ready now: ${w.ready.join(', ')}`);
    if (w.parallelCandidates.length > 1) lines.push(`    can run at once: ${w.parallelCandidates.join(', ')}`);
    for (const entry of w.packages) {
      const marks = [entry.status, entry.role, entry.delivered ? 'delivered' : null].filter(Boolean).join(', ');
      lines.push(`    ${entry.id} (${marks})  ${entry.goal.slice(0, 90)}`);
      if (entry.writePaths.length) lines.push(`      writes ${entry.writePaths.join(', ')}`);
      if (entry.dependsOn.length) lines.push(`      after ${entry.dependsOn.join(', ')}`);
      if (entry.doneWhen.length) lines.push(`      done when: ${entry.doneWhen.map((d) => d.slice(0, 80)).join(' | ')}`);
    }
    if (w.unattributedPaths.length) lines.push(`    NOT ACCOUNTED FOR BY ANY PACKAGE: ${w.unattributedPaths.join(', ')}`);
  }
  if (data.ledgerIdentities?.length) {
    lines.push('', `NAMES A LEDGER ACCEPTS  ${data.ledgerIdentities.join(', ')}`);
  }
  if (data.blockedBy.length) lines.push('', `BLOCKED BY  ${[...new Set(data.blockedBy)].join(', ')}`);
  /*
   * What this view can say about the contents, which is only where they are.
   *
   * The first draft printed "3 sent with this reply" here, copied from the JSON form where it is
   * true. In the text form it is not: this renderer prints the plan and drops every `text`. A
   * measured run read that line, went looking for contents that were not there, and fell back to
   * opening each file by hand — 25 calls against 18 for the run that did not. Two forms of one
   * reply, and a sentence that was only true in the other one.
   */
  const carried = data.read.filter((entry) => typeof entry.text === 'string').length;
  const withheld = data.read.length - carried;
  lines.push('', `READ (${data.read.length}, ${data.bytes.read} bytes) — ${carried} sent below${withheld ? `, ${withheld} too large to send and listed by path` : ''}`);
  for (const entry of data.read) lines.push(`    ${entry.path}  [${entry.reason}]${typeof entry.text === 'string' ? '' : '  — not in this reply, open it'}`);
  for (const entry of data.read) {
    if (typeof entry.text !== 'string') continue;
    lines.push('', `--- ${entry.path} ---`, entry.text.replace(/\n+$/, ''), `--- end ${entry.path} ---`);
  }
  if (data.vouched.length) {
    lines.push('', `UNCHANGED — a digest stands in (${data.vouched.length}, ${data.bytes.vouched} bytes)`);
    for (const entry of data.vouched) lines.push(`    ${entry.path}${entry.sections.length ? `  covers: ${entry.sections.join(', ')}` : ''}`);
  }
  if (!data.worktreeClean) lines.push('', 'The Change directory has uncommitted edits, so nothing could be vouched for.');
  lines.push('', carried
    ? 'Everything printed under READ arrived with this reply and does not need opening again. Files marked otherwise, and the UNCHANGED list, are the ones still on disk.'
    : 'No contents came with this reply; READ names what to open.');
  return `${lines.join('\n')}\n`;
}
