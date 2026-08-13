import { access, readFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fg from 'fast-glob';
import { MAX_GATE_OUTPUT_BYTES, WORK_PACKAGE_VERIFY_TIMEOUT_SECONDS } from '../constants.js';
import type {
  ChangeConfig,
  Diagnostic,
  GateResource,
  ProjectContext,
  WorkPackage,
  WorkPackageAckReceipt,
  WorkPackageDelivery,
  WorkPackageDispatchReceipt,
  WorkPackagePlan,
  WorkPackagePlanState,
  WorkPackageState,
} from '../types.js';
import type { SelectedResources } from './resource-loader.js';
import { XForgeError, diagnostic } from './errors.js';
import { normalizeRelative, pathsOverlap, safeResolve } from './path-safety.js';
import { validateSchema } from './validator.js';
import { loadYaml } from './yaml.js';
import { normalizeRule } from './governance.js';
import { sha256, stableStringify } from './hash.js';
import { readAuditEvents } from './audit.js';

const GLOB_MAGIC = /[*?{}[\]]/;
const UNSUPPORTED_GLOB_MAGIC = /[?{}[\]]/;

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function appendErrorDiagnostics(diagnostics: Diagnostic[], error: unknown): void {
  if (error instanceof XForgeError) diagnostics.push(...error.diagnostics);
  else throw error;
}

function hasMagic(pattern: string): boolean {
  return GLOB_MAGIC.test(pattern);
}

function staticPrefix(pattern: string): string {
  const segments = pattern.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/') || '.';
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (character === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    source += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
    index += 1;
  }
  return new RegExp(`${source}$`);
}

function matchesPattern(filePath: string, pattern: string): boolean {
  return globRegex(pattern).test(filePath);
}

function patternWithinScope(pattern: string, scope: string): boolean {
  if (pattern === scope) return true;
  if (!hasMagic(scope)) {
    return !hasMagic(pattern) && (pattern === scope || pattern.startsWith(`${scope}/`));
  }
  if (!scope.endsWith('/**')) return false;
  const scopeRoot = scope.slice(0, -3).replace(/\/$/, '') || '.';
  const candidate = staticPrefix(pattern);
  return candidate === scopeRoot || candidate.startsWith(`${scopeRoot}/`);
}

function patternsPotentiallyOverlap(left: string, right: string): boolean {
  if (!hasMagic(left) && !hasMagic(right)) return pathsOverlap(left, right);
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  if (leftPrefix === '.' || rightPrefix === '.') return true;
  return pathsOverlap(leftPrefix, rightPrefix);
}

function dependsTransitively(packages: Map<string, WorkPackage>, start: string, target: string, seen = new Set<string>()): boolean {
  if (seen.has(start)) return false;
  seen.add(start);
  for (const dependency of packages.get(start)?.depends_on ?? []) {
    if (dependency === target || dependsTransitively(packages, dependency, target, seen)) return true;
  }
  return false;
}

function executionWaves(packages: WorkPackage[]): Array<{ index: number; packages: string[] }> {
  const remaining = new Map(packages.map((item) => [item.id, new Set(item.depends_on)]));
  const completed = new Set<string>();
  const waves: Array<{ index: number; packages: string[] }> = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => [...dependencies].every((dependency) => completed.has(dependency)))
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) break;
    waves.push({ index: waves.length + 1, packages: ready });
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return waves;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(root: string, args: string[]): Promise<GitResult> {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', root, ...args], {
      shell: false,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_GATE_OUTPUT_BYTES) return;
      const selected = chunk.subarray(0, MAX_GATE_OUTPUT_BYTES - stdoutBytes);
      stdout.push(selected);
      stdoutBytes += selected.byteLength;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_GATE_OUTPUT_BYTES) return;
      const selected = chunk.subarray(0, MAX_GATE_OUTPUT_BYTES - stderrBytes);
      stderr.push(selected);
      stderrBytes += selected.byteLength;
    });
    child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: error.message }));
    child.on('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

/**
 * Paths the control plane writes on its own behalf: dispatch receipts and the audit index.
 *
 * These can never count as a worker's output. Citing `evidence/audit/index.json` as proof that a
 * verify command passed is circular — the file exists because XForge dispatched the package, not
 * because anybody did the work.
 */
function isControlPlaneBookkeeping(filePath: string, changeRoot: string): boolean {
  if (!filePath.startsWith(`${changeRoot}/evidence/`)) return false;
  const tail = filePath.slice(`${changeRoot}/evidence/`.length);
  return tail.startsWith('audit/') || /^agents\/[^/]+\/dispatch\//.test(tail);
}

function protectedWritePaths(project: ProjectContext, changeId: string, config: ChangeConfig, resources: SelectedResources): string[] {
  const changeRoot = `${project.changesPath}/${changeId}`;
  const paths = new Set([
    'xforge/manifest.yaml',
    'xforge/lock.yaml',
    'xforge/constitution.md',
    `${project.specsPath}/**`,
    `${changeRoot}/**`,
  ]);
  for (const rule of resources.rules.values()) {
    const normalized = normalizeRule(rule.value);
    if (normalized.legacyWritePolicy !== 'integrator-only') continue;
    if (normalized.modules.length && !normalized.modules.some((module) => config.scope.modules.includes(module))) continue;
    for (const declared of normalized.paths) paths.add(declared);
  }
  for (const policy of resources.policies.values()) {
    if (policy.value.spec.capability !== 'fs.write' || policy.value.spec.effect === 'allow') continue;
    for (const declared of policy.value.spec.match.paths ?? []) paths.add(declared);
  }
  return [...paths].sort();
}

async function loadDeliveries(
  project: ProjectContext,
  changeId: string,
  knownPackages: Set<string>,
): Promise<{ deliveries: Map<string, WorkPackageDelivery[]>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const deliveries = new Map<string, WorkPackageDelivery[]>();
  const changeRoot = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRoot);
  const names = (await fg('evidence/agents/*/*.yaml', {
    cwd: changeDirectory,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
  })).sort();
  const executionKeys = new Set<string>();

  for (const name of names) {
    const projectPath = `${changeRoot}/${name}`;
    let delivery: WorkPackageDelivery;
    try {
      delivery = await loadYaml<WorkPackageDelivery>(await safeResolve(project.root, projectPath), projectPath);
    } catch (error) {
      appendErrorDiagnostics(diagnostics, error);
      continue;
    }
    const schemaDiagnostics = await validateSchema('work-package-delivery', delivery, projectPath);
    diagnostics.push(...schemaDiagnostics);
    if (schemaDiagnostics.some((item) => item.severity === 'error')) continue;

    const parts = name.split('/');
    const directoryId = parts[2]!;
    const fileExecutionId = path.posix.basename(name, '.yaml');
    if (delivery.package_id !== directoryId) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DELIVERY_PATH_MISMATCH', 'Delivery package_id must match its evidence directory.', projectPath));
    }
    if (delivery.execution_id !== fileExecutionId) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DELIVERY_PATH_MISMATCH', 'Delivery execution_id must match its evidence filename.', projectPath));
    }
    if (!knownPackages.has(delivery.package_id)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DELIVERY_UNKNOWN', `Delivery references unknown work package ${delivery.package_id}.`, projectPath));
      continue;
    }
    const executionKey = `${delivery.package_id}:${delivery.execution_id}`;
    if (executionKeys.has(executionKey)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_EXECUTION_DUPLICATE', `Duplicate work package execution ${executionKey}.`, projectPath));
      continue;
    }
    executionKeys.add(executionKey);
    const list = deliveries.get(delivery.package_id) ?? [];
    list.push(delivery);
    deliveries.set(delivery.package_id, list);
  }
  return { deliveries, diagnostics };
}

function latestDelivery(deliveries: WorkPackageDelivery[] | undefined): WorkPackageDelivery | null {
  if (!deliveries?.length) return null;
  return [...deliveries].sort((left, right) => {
    const byTime = Date.parse(left.recorded_at) - Date.parse(right.recorded_at);
    return byTime === 0 ? left.execution_id.localeCompare(right.execution_id) : byTime;
  }).at(-1) ?? null;
}

async function loadDispatches(
  project: ProjectContext,
  changeId: string,
  knownPackages: Set<string>,
): Promise<{ dispatches: Map<string, WorkPackageDispatchReceipt[]>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const dispatches = new Map<string, WorkPackageDispatchReceipt[]>();
  const changeRoot = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRoot);
  const names = (await fg('evidence/agents/*/dispatch/*.json', {
    cwd: changeDirectory,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
  })).sort();
  for (const name of names) {
    const projectPath = `${changeRoot}/${name}`;
    try {
      const dispatch = JSON.parse(await readFile(await safeResolve(project.root, projectPath), 'utf8')) as WorkPackageDispatchReceipt;
      const schemaDiagnostics = await validateSchema('work-package-dispatch', dispatch, projectPath);
      diagnostics.push(...schemaDiagnostics);
      if (schemaDiagnostics.some((item) => item.severity === 'error')) continue;
      const parts = name.split('/');
      const directoryId = parts[2]!;
      const executionId = path.posix.basename(name, '.json');
      const { digest, ...unsigned } = dispatch;
      if (dispatch.change !== changeId || dispatch.packageId !== directoryId || dispatch.executionId !== executionId) {
        diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_PATH_MISMATCH', 'Dispatch identifiers must match their Change and evidence path.', projectPath));
        continue;
      }
      if (digest !== sha256(stableStringify(unsigned))) {
        diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_DIGEST_INVALID', 'Work package dispatch receipt digest is invalid.', projectPath));
        continue;
      }
      if (!knownPackages.has(dispatch.packageId)) {
        diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_UNKNOWN', `Dispatch references unknown work package ${dispatch.packageId}.`, projectPath));
        continue;
      }
      const list = dispatches.get(dispatch.packageId) ?? [];
      list.push(dispatch);
      dispatches.set(dispatch.packageId, list);
    } catch (error) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_INVALID', `Dispatch receipt is invalid: ${(error as Error).message}`, projectPath));
    }
  }
  return { dispatches, diagnostics };
}

function latestDispatch(dispatches: WorkPackageDispatchReceipt[] | undefined): WorkPackageDispatchReceipt | null {
  if (!dispatches?.length) return null;
  return [...dispatches].sort((left, right) => {
    const byTime = Date.parse(left.issuedAt) - Date.parse(right.issuedAt);
    return byTime === 0 ? left.executionId.localeCompare(right.executionId) : byTime;
  }).at(-1) ?? null;
}

/**
 * Loads `WorkPackageAckReceipt` files, the Git-tracked counterpart to the (gitignored) local audit
 * chain's `work-package.reviewed`/`work-package.integrated` events.
 *
 * `.audit/` is gitignored project-wide (see `xforge/scaffold/payload/xforge/.audit/.gitignore`), so
 * a fresh `git clone` has no local audit history at all. Without a Git-tracked receipt, every
 * previously reviewed/integrated work package would silently read back as merely `succeeded` on a
 * clone — the review/integration record would be invisibly lost. A receipt here is only trusted once
 * cross-checked against a known delivery for the same package and execution (see `deliveryDigest`
 * below); an unmatched or tampered receipt is diagnosed and excluded, never silently accepted.
 */
async function loadAckReceipts(
  project: ProjectContext,
  changeId: string,
  knownPackages: Set<string>,
  deliveries: Map<string, WorkPackageDelivery[]>,
): Promise<{ receipts: Map<string, WorkPackageAckReceipt[]>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const receipts = new Map<string, WorkPackageAckReceipt[]>();
  const changeRoot = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRoot);
  const names = (await fg('evidence/agents/*/ack/*.json', {
    cwd: changeDirectory,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
  })).sort();
  for (const name of names) {
    const projectPath = `${changeRoot}/${name}`;
    let receipt: WorkPackageAckReceipt;
    try {
      receipt = JSON.parse(await readFile(await safeResolve(project.root, projectPath), 'utf8')) as WorkPackageAckReceipt;
    } catch (error) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_INVALID', `Acknowledgement receipt is not valid JSON: ${(error as Error).message}`, projectPath));
      continue;
    }
    const schemaDiagnostics = await validateSchema('work-package-ack-receipt', receipt, projectPath);
    diagnostics.push(...schemaDiagnostics);
    if (schemaDiagnostics.some((item) => item.severity === 'error')) continue;
    const { digest, ...unsigned } = receipt;
    if (digest !== sha256(stableStringify(unsigned))) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_DIGEST_INVALID', 'Acknowledgement receipt digest is invalid.', projectPath));
      continue;
    }
    const parts = name.split('/');
    const directoryId = parts[2]!;
    const fileName = path.posix.basename(name, '.json');
    if (receipt.change !== changeId || receipt.packageId !== directoryId || fileName !== `${receipt.executionId}-${receipt.as}`) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_PATH_MISMATCH', 'Acknowledgement receipt identifiers must match its Change and evidence path.', projectPath));
      continue;
    }
    if (!knownPackages.has(receipt.packageId)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_UNKNOWN', `Acknowledgement receipt references unknown work package ${receipt.packageId}.`, projectPath));
      continue;
    }
    const matchingDelivery = deliveries.get(receipt.packageId)?.find((item) => item.execution_id === receipt.executionId);
    if (!matchingDelivery || sha256(stableStringify(matchingDelivery)) !== receipt.deliveryDigest) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_ACK_RECEIPT_DELIVERY_MISMATCH',
        `Acknowledgement receipt for ${receipt.packageId} does not match a known delivery for execution ${receipt.executionId}.`,
        projectPath,
      ));
      continue;
    }
    const list = receipts.get(receipt.packageId) ?? [];
    list.push(receipt);
    receipts.set(receipt.packageId, list);
  }
  return { receipts, diagnostics };
}

async function validateSuccessfulDelivery(
  project: ProjectContext,
  changeId: string,
  workPackage: WorkPackage,
  delivery: WorkPackageDelivery,
  sourcePath: string,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  if (project.manifest.apiVersion === 'xforge.dev/v1alpha2') {
    if (!delivery.state_revision || !delivery.policy_snapshot_digest || !delivery.audit_correlation_id) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_BINDING_REQUIRED', 'Protocol 2 delivery requires state_revision, policy_snapshot_digest, and audit_correlation_id.', sourcePath));
    } else {
      const dispatchPath = `${project.changesPath}/${changeId}/evidence/agents/${workPackage.id}/dispatch/${delivery.execution_id}.json`;
      try {
        const dispatch = JSON.parse(await readFile(await safeResolve(project.root, dispatchPath), 'utf8')) as WorkPackageDispatchReceipt;
        const schemaDiagnostics = await validateSchema('work-package-dispatch', dispatch, dispatchPath);
        diagnostics.push(...schemaDiagnostics);
        const { digest, ...unsigned } = dispatch;
        if (digest !== sha256(stableStringify(unsigned))) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_DIGEST_INVALID', 'Work package dispatch receipt digest is invalid.', dispatchPath));
        if (dispatch.change !== changeId || dispatch.packageId !== workPackage.id || dispatch.executionId !== delivery.execution_id ||
          dispatch.stateRevision !== delivery.state_revision || dispatch.policySnapshotDigest !== delivery.policy_snapshot_digest || dispatch.auditCorrelationId !== delivery.audit_correlation_id) {
          diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_MISMATCH', 'Delivery does not match its dispatch receipt.', sourcePath));
        }
        /*
         * `base_commit` must be a commit that already contains the dispatch receipt.
         *
         * Dispatching writes the receipt and the audit index, and those writes are committed after
         * `xforge work-package dispatch` returns. A worker that takes `base_commit` from the HEAD
         * the dispatch receipt recorded therefore starts one commit too early, and the control
         * plane's own bookkeeping lands inside `base..head` — where it is indistinguishable from
         * the worker's output and trips the write_paths check for a reason the worker did not
         * cause. Requiring the receipt to be present at `base_commit` pins the start of the work
         * to the commit that dispatched it.
         */
        if (delivery.base_commit && delivery.head_commit) {
          const atHead = await git(project.root, ['cat-file', '-e', `${delivery.head_commit}:${dispatchPath}`]);
          const atBase = await git(project.root, ['cat-file', '-e', `${delivery.base_commit}:${dispatchPath}`]);
          /* An untracked receipt cannot land in the diff, so only the committed-after-base case is wrong. */
          if (atHead.code === 0 && atBase.code !== 0) {
            diagnostics.push(diagnostic(
              'XFORGE_WORK_PACKAGE_BASE_PRECEDES_DISPATCH',
              `base_commit ${delivery.base_commit} predates the commit that introduced the dispatch receipt, so the control plane's own writes fall inside the delivery diff. Start the work package from the commit that contains the receipt.`,
              sourcePath,
              'error',
              { baseCommit: delivery.base_commit, dispatchPath },
            ));
          }
        }
      } catch (error) {
        diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_MISSING', `Dispatch receipt is missing or invalid: ${(error as Error).message}`, dispatchPath));
      }
    }
  }
  if (!delivery.head_commit) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_HEAD_REQUIRED', 'A succeeded delivery requires head_commit.', sourcePath));
    return diagnostics;
  }
  if (delivery.changed_paths.length === 0) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_EMPTY_DELIVERY', 'A succeeded write package must contain at least one changed path.', sourcePath));
  }

  const ancestry = await git(project.root, ['merge-base', '--is-ancestor', delivery.base_commit, delivery.head_commit]);
  if (ancestry.code !== 0) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_COMMIT_ANCESTRY', 'head_commit must descend from base_commit.', sourcePath, 'error', { stderr: ancestry.stderr.trim() }));
    return diagnostics;
  }
  const diff = await git(project.root, ['diff', '--name-only', '--no-renames', '-z', `${delivery.base_commit}...${delivery.head_commit}`, '--']);
  if (diff.code !== 0) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_GIT_DIFF_FAILED', 'Unable to resolve the delivery commit diff.', sourcePath, 'error', { stderr: diff.stderr.trim() }));
    return diagnostics;
  }
  const actualPaths = diff.stdout.split('\0').filter(Boolean).map((item) => normalizeRelative(item, 'Git changed path')).sort();
  const declaredPaths = [...delivery.changed_paths].map((item) => normalizeRelative(item, 'Delivery changed path')).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_CHANGED_PATHS_MISMATCH',
      'Delivery changed_paths does not match the Git diff.',
      sourcePath,
      'error',
      { declared: declaredPaths, actual: actualPaths },
    ));
  }
  const changeRoot = `${project.changesPath}/${changeId}`;
  for (const changed of actualPaths) {
    /*
     * A control-plane bookkeeping path (dispatch receipts, the audit index) can land inside
     * `base..head` for reasons that have nothing to do with what the Worker wrote — e.g. a
     * concurrent `xforge` invocation appending to the audit index mid-delivery. The
     * `base_commit`-precedes-dispatch check above only catches the case where XForge's own
     * dispatch commit is the cause; it doesn't help when some other bookkeeping write is swept
     * into the range. Since these paths are never attributable to the Worker either way, they're
     * exempted from write_paths here too, on the same reasoning.
     */
    if (isControlPlaneBookkeeping(changed, changeRoot)) continue;
    if (!workPackage.write_paths.some((pattern) => matchesPattern(changed, pattern))) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_WRITE_ESCAPE',
        `Work package ${workPackage.id} changed a path outside write_paths: ${changed}`,
        sourcePath,
      ));
    }
  }
  /*
   * A delivery whose entire diff is the control plane's own bookkeeping delivered nothing. The
   * write_paths check alone did not catch it: bookkeeping that happens to sit under a declared
   * write path would have passed, and every remaining check on a delivery is self-reported.
   */
  if (actualPaths.length > 0 && actualPaths.every((item) => isControlPlaneBookkeeping(item, changeRoot))) {
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_NO_WORK_DELIVERED',
      `Work package ${workPackage.id} reports success but changed only XForge's own dispatch and audit bookkeeping. A succeeded delivery must change something the package was asked to write.`,
      sourcePath,
      'error',
      { changedPaths: actualPaths },
    ));
  }

  const commands = delivery.validation.map((item) => item.command);
  if (JSON.stringify(commands) !== JSON.stringify(workPackage.verify)) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_VALIDATION_MISMATCH', 'Delivery validation commands must exactly match verify.', sourcePath));
  }
  if (delivery.validation.some((item) => item.exit_code !== 0)) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_VALIDATION_FAILED', 'A succeeded delivery cannot contain a failed validation result.', sourcePath));
  }
  const mappings = delivery.done_when_evidence ?? [];
  const mapped = new Map<string, number>();
  for (const mapping of mappings) mapped.set(mapping.criterion, (mapped.get(mapping.criterion) ?? 0) + 1);
  for (const criterion of workPackage.done_when) {
    const count = mapped.get(criterion) ?? 0;
    if (count === 0) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_MISSING', `No evidence mapping was supplied for done_when criterion: ${criterion}`, sourcePath));
    if (count > 1) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_DUPLICATE', `done_when criterion is mapped more than once: ${criterion}`, sourcePath));
  }
  /*
   * Evidence used to be counted, never judged. A live run mapped every criterion to the dispatch
   * receipt and the audit index — files XForge wrote itself — and the mapping was accepted, so
   * "npm test exits 0" was evidenced by the fact that the package had been dispatched. An entry
   * now has to be either a command the package actually ran or a path the delivery actually
   * changed; the control plane's own writes count as neither.
   */
  const ranCommands = new Set(delivery.validation.map((item) => item.command));
  const changedSet = new Set(actualPaths);
  for (const mapping of mappings) {
    const relevant = (mapping.evidence ?? []).filter((item) => {
      if (ranCommands.has(item)) return true;
      let normalized: string;
      try { normalized = normalizeRelative(item, 'Evidence path'); } catch { return false; }
      return changedSet.has(normalized) && !isControlPlaneBookkeeping(normalized, changeRoot);
    });
    if (relevant.length === 0) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_IRRELEVANT',
        `No evidence for done_when criterion "${mapping.criterion}" names a verify command this delivery ran or a path it changed.`,
        sourcePath,
        'error',
        { criterion: mapping.criterion, evidence: mapping.evidence ?? [] },
      ));
    }
  }
  for (const mapping of mappings) {
    if (!workPackage.done_when.includes(mapping.criterion)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_UNKNOWN', `Evidence maps an unknown done_when criterion: ${mapping.criterion}`, sourcePath));
    }
  }
  return diagnostics;
}

export interface ResolveWorkPackagesOptions {
  requireDeliveries?: boolean;
}

export async function resolveWorkPackages(
  project: ProjectContext,
  changeId: string,
  config: ChangeConfig,
  resources: SelectedResources,
  options: ResolveWorkPackagesOptions = {},
): Promise<{ state: WorkPackagePlanState | null; diagnostics: Diagnostic[] }> {
  const planPath = `${project.changesPath}/${changeId}/work-packages.yaml`;
  const absolutePlanPath = await safeResolve(project.root, planPath);
  if (!await exists(absolutePlanPath)) return { state: null, diagnostics: [] };

  let plan: WorkPackagePlan;
  try {
    plan = await loadYaml<WorkPackagePlan>(absolutePlanPath, planPath);
  } catch (error) {
    const diagnostics: Diagnostic[] = [];
    appendErrorDiagnostics(diagnostics, error);
    return { state: null, diagnostics };
  }
  const diagnostics = await validateSchema('work-package', plan, planPath);
  if (diagnostics.some((item) => item.severity === 'error')) return { state: null, diagnostics };

  const ids = plan.packages.map((item) => item.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DUPLICATE', 'Work package IDs must be unique.', planPath));
  const byId = new Map(plan.packages.map((item) => [item.id, item]));

  for (const workPackage of plan.packages) {
    for (const dependency of workPackage.depends_on) {
      if (!uniqueIds.has(dependency)) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DEPENDENCY_UNKNOWN', `Work package ${workPackage.id} depends on unknown package ${dependency}.`, planPath));
      if (dependency === workPackage.id) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DEPENDENCY_CYCLE', `Work package ${workPackage.id} depends on itself.`, planPath));
    }
  }
  for (const id of ids) {
    if (dependsTransitively(byId, id, id)) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DEPENDENCY_CYCLE', `Work package DAG contains a cycle at ${id}.`, planPath));
  }

  const protectedPaths = protectedWritePaths(project, changeId, config, resources);
  for (const rule of resources.rules.values()) {
    if (rule.value.spec.writePolicy === 'integrator-only' && !rule.value.spec.paths?.length) {
      diagnostics.push(diagnostic('XFORGE_RULE_WRITE_POLICY_PATHS_REQUIRED', 'An integrator-only Rule must declare paths.', rule.yamlPath));
    }
  }

  for (const workPackage of plan.packages) {
    for (const input of workPackage.inputs) {
      try {
        const normalized = normalizeRelative(input, `Work package ${workPackage.id} input`);
        const absolute = await safeResolve(project.root, normalized);
        if (!await exists(absolute) || !(await stat(absolute)).isFile()) {
          diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_INPUT_MISSING', `Required input is missing or is not a file: ${normalized}`, planPath));
        }
      } catch (error) {
        appendErrorDiagnostics(diagnostics, error);
      }
    }
    for (const skill of workPackage.skills) {
      if (!resources.skills.has(skill)) diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_SKILL_MISSING', `Work package ${workPackage.id} requires unavailable Skill ${skill}.`, planPath));
    }
    for (const patternInput of workPackage.write_paths) {
      try {
        const pattern = normalizeRelative(patternInput, `Work package ${workPackage.id} write path`);
        if (UNSUPPORTED_GLOB_MAGIC.test(pattern)) {
          diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_GLOB_UNSUPPORTED', 'write_paths supports literal paths, * and ** only.', planPath, 'error', { pattern }));
          continue;
        }
        const prefix = staticPrefix(pattern);
        if (prefix === '.') {
          diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_WRITE_TOO_BROAD', `Work package ${workPackage.id} write path is too broad: ${pattern}`, planPath));
          continue;
        }
        await safeResolve(project.root, prefix);
        if (!config.scope.paths.some((scope) => patternWithinScope(pattern, normalizeRelative(scope, 'Change scope path')))) {
          diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_OUTSIDE_CHANGE_SCOPE', `Work package ${workPackage.id} write path is outside Change scope: ${pattern}`, planPath));
        }
        for (const protectedPath of protectedPaths) {
          const normalizedProtected = normalizeRelative(protectedPath, 'Protected write path');
          if (patternsPotentiallyOverlap(pattern, normalizedProtected)) {
            diagnostics.push(diagnostic(
              'XFORGE_WORK_PACKAGE_SHARED_WRITE',
              `Work package ${workPackage.id} write path overlaps an Integrator-only path: ${protectedPath}`,
              planPath,
            ));
          }
        }
      } catch (error) {
        appendErrorDiagnostics(diagnostics, error);
      }
    }
  }

  for (let leftIndex = 0; leftIndex < plan.packages.length; leftIndex += 1) {
    const left = plan.packages[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < plan.packages.length; rightIndex += 1) {
      const right = plan.packages[rightIndex]!;
      if (dependsTransitively(byId, left.id, right.id) || dependsTransitively(byId, right.id, left.id)) continue;
      for (const leftPath of left.write_paths) {
        for (const rightPath of right.write_paths) {
          if (patternsPotentiallyOverlap(leftPath, rightPath)) {
            diagnostics.push(diagnostic(
              'XFORGE_WORK_PACKAGE_PARALLEL_WRITE_CONFLICT',
              `Dependency-independent work packages ${left.id} and ${right.id} have potentially overlapping write paths.`,
              planPath,
              'error',
              { left: leftPath, right: rightPath },
            ));
          }
        }
      }
    }
  }

  const gitRoot = await git(project.root, ['rev-parse', '--show-toplevel']);
  let baseCommit: string | null = null;
  const resolvedGitRoot = gitRoot.code === 0 ? await realpath(gitRoot.stdout.trim()).catch(() => '') : '';
  const resolvedProjectRoot = await realpath(project.root).catch(() => path.resolve(project.root));
  if (gitRoot.code !== 0 || resolvedGitRoot !== resolvedProjectRoot) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_GIT_REQUIRED', 'Work package execution requires the XForge project root to be a Git worktree.', planPath));
  } else {
    const head = await git(project.root, ['rev-parse', 'HEAD']);
    if (head.code === 0 && /^[0-9a-fA-F]{40}$/.test(head.stdout.trim())) baseCommit = head.stdout.trim();
    else diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_GIT_REQUIRED', 'Work package execution requires a valid Git HEAD commit.', planPath));
  }

  const loadedDeliveries = await loadDeliveries(project, changeId, uniqueIds);
  diagnostics.push(...loadedDeliveries.diagnostics);
  const loadedDispatches = await loadDispatches(project, changeId, uniqueIds);
  diagnostics.push(...loadedDispatches.diagnostics);
  const loadedAckReceipts = await loadAckReceipts(project, changeId, uniqueIds, loadedDeliveries.deliveries);
  diagnostics.push(...loadedAckReceipts.diagnostics);
  const auditEvents = (await readAuditEvents(project)).filter((event) => event.change === changeId && event.outcome === 'succeeded');
  const latestByPackage = new Map<string, WorkPackageDelivery | null>();
  const invalidDeliveries = new Set<string>();
  for (const workPackage of plan.packages) {
    const latest = latestDelivery(loadedDeliveries.deliveries.get(workPackage.id));
    latestByPackage.set(workPackage.id, latest);
    if (!latest || latest.status !== 'succeeded') continue;
    const deliveryPath = `${project.changesPath}/${changeId}/evidence/agents/${workPackage.id}/${latest.execution_id}.yaml`;
    const deliveryDiagnostics = await validateSuccessfulDelivery(project, changeId, workPackage, latest, deliveryPath);
    diagnostics.push(...deliveryDiagnostics);
    if (deliveryDiagnostics.some((item) => item.severity === 'error')) invalidDeliveries.add(workPackage.id);
  }

  for (const workPackage of plan.packages) {
    const delivery = latestByPackage.get(workPackage.id);
    if (!delivery || delivery.status !== 'succeeded' || invalidDeliveries.has(workPackage.id)) continue;
    for (const dependency of workPackage.depends_on) {
      const dependencyDelivery = latestByPackage.get(dependency);
      if (!dependencyDelivery || dependencyDelivery.status !== 'succeeded' || !dependencyDelivery.head_commit) continue;
      const ancestry = await git(project.root, ['merge-base', '--is-ancestor', dependencyDelivery.head_commit, delivery.base_commit]);
      if (ancestry.code !== 0) {
        const deliveryPath = `${project.changesPath}/${changeId}/evidence/agents/${workPackage.id}/${delivery.execution_id}.yaml`;
        diagnostics.push(diagnostic(
          'XFORGE_WORK_PACKAGE_DEPENDENCY_COMMIT_MISSING',
          `Work package ${workPackage.id} base_commit does not contain dependency ${dependency}.`,
          deliveryPath,
        ));
        invalidDeliveries.add(workPackage.id);
      }
    }
  }

  const packageStates: WorkPackageState[] = plan.packages.map((workPackage) => {
    const delivery = latestByPackage.get(workPackage.id) ?? null;
    const dispatch = latestDispatch(loadedDispatches.dispatches.get(workPackage.id));
    const missingDependencies = workPackage.depends_on.filter((dependency) => {
      const dependencyDelivery = latestByPackage.get(dependency);
      return !dependencyDelivery || dependencyDelivery.status !== 'succeeded' || invalidDeliveries.has(dependency);
    });
    let status: WorkPackageState['status'];
    if (delivery?.status === 'succeeded' && !invalidDeliveries.has(workPackage.id)) {
      const lifecycle = auditEvents.filter((event) => event.workPackage === workPackage.id
        && (!delivery.audit_correlation_id || event.correlationId === delivery.audit_correlation_id));
      /*
       * A Git-tracked ack receipt for the currently latest delivery is authoritative on its own — a
       * fresh clone with no local `.audit/` history still shows the correct lifecycle status from the
       * committed receipt. When both the receipt and a matching local audit event exist (the normal
       * case for an ack recorded by this fix), they agree and either would do. When only the audit
       * event exists (an ack recorded before this fix shipped, so no receipt file was ever written),
       * this falls back to that event so pre-existing history is not broken.
       */
      const receiptsForExecution = (loadedAckReceipts.receipts.get(workPackage.id) ?? [])
        .filter((receipt) => receipt.executionId === delivery.execution_id);
      const reviewed = lifecycle.some((event) => event.eventType === 'work-package.reviewed')
        || receiptsForExecution.some((receipt) => receipt.status === 'reviewed');
      const integrated = lifecycle.some((event) => event.eventType === 'work-package.integrated')
        || receiptsForExecution.some((receipt) => receipt.status === 'integrated');
      if (reviewed) status = 'reviewed';
      else if (integrated) status = 'integrated';
      else status = 'succeeded';
    }
    else if (delivery?.status === 'failed' || invalidDeliveries.has(workPackage.id)) status = 'failed';
    else if (delivery?.status === 'blocked') status = 'blocked';
    else if (dispatch) status = 'running';
    else status = missingDependencies.length === 0 ? 'ready' : 'blocked';
    return { ...workPackage, status, missingDependencies, delivery };
  });

  if (options.requireDeliveries) {
    for (const workPackage of packageStates) {
      if (!['succeeded', 'integrated', 'reviewed'].includes(workPackage.status)) {
        diagnostics.push(diagnostic(
          'XFORGE_WORK_PACKAGE_INCOMPLETE',
          `Work package ${workPackage.id} is ${workPackage.status}; a valid succeeded delivery is required.`,
          planPath,
        ));
      }
    }
  }

  return {
    state: {
      path: planPath,
      baseCommit,
      ready: packageStates.filter((item) => item.status === 'ready').map((item) => item.id),
      waves: executionWaves(plan.packages),
      parallelCandidates: packageStates.filter((item) => item.status === 'ready').map((item) => item.id),
      protectedWritePaths: protectedPaths,
      packages: packageStates,
    },
    diagnostics,
  };
}

export interface WorkPackageVerificationGate {
  packageId: string;
  command: string;
  gate: GateResource;
}

export function workPackageVerificationGates(state: WorkPackagePlanState): WorkPackageVerificationGate[] {
  const result: WorkPackageVerificationGate[] = [];
  for (const workPackage of state.packages) {
    for (let index = 0; index < workPackage.verify.length; index += 1) {
      const command = workPackage.verify[index]!;
      const slug = workPackage.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'package';
      result.push({
        packageId: workPackage.id,
        command,
        gate: {
          apiVersion: 'xforge.dev/v1alpha1',
          kind: 'Gate',
          metadata: { name: `work-package-${slug}-${index + 1}`, version: 1 },
          spec: {
            required: true,
            command: [command],
            shell: true,
            workingDirectory: '.',
            timeoutSeconds: WORK_PACKAGE_VERIFY_TIMEOUT_SECONDS,
            maxOutputBytes: MAX_GATE_OUTPUT_BYTES,
            evidence: `agents/${workPackage.id}/verify-${index + 1}.json`,
          },
        },
      });
    }
  }
  return result;
}
