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
  for (const changed of actualPaths) {
    if (!workPackage.write_paths.some((pattern) => matchesPattern(changed, pattern))) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_WRITE_ESCAPE',
        `Work package ${workPackage.id} changed a path outside write_paths: ${changed}`,
        sourcePath,
      ));
    }
  }

  const commands = delivery.validation.map((item) => item.command);
  if (JSON.stringify(commands) !== JSON.stringify(workPackage.verify)) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_VALIDATION_MISMATCH', 'Delivery validation commands must exactly match verify.', sourcePath));
  }
  if (delivery.validation.some((item) => item.exit_code !== 0)) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_VALIDATION_FAILED', 'A succeeded delivery cannot contain a failed validation result.', sourcePath));
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
    const missingDependencies = workPackage.depends_on.filter((dependency) => {
      const dependencyDelivery = latestByPackage.get(dependency);
      return !dependencyDelivery || dependencyDelivery.status !== 'succeeded' || invalidDeliveries.has(dependency);
    });
    let status: WorkPackageState['status'];
    if (delivery?.status === 'succeeded' && !invalidDeliveries.has(workPackage.id)) status = 'succeeded';
    else if (delivery?.status === 'failed' || invalidDeliveries.has(workPackage.id)) status = 'failed';
    else if (delivery?.status === 'blocked') status = 'blocked';
    else status = missingDependencies.length === 0 ? 'ready' : 'blocked';
    return { ...workPackage, status, missingDependencies, delivery };
  });

  if (options.requireDeliveries) {
    for (const workPackage of packageStates) {
      if (workPackage.status !== 'succeeded') {
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
            stage: 'check',
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
