import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import type { ApprovalReceipt, Diagnostic, FileChange, GateEvidence, GateResource, GovernanceRevision, NextAction, ProjectContext } from '../types.js';
import { CLI_NAME, CLI_VERSION, MAX_GATE_OUTPUT_BYTES, PROTOCOL_VERSION } from '../constants.js';
import { atomicWrite } from '../core/files.js';
import { sha256, stableStringify } from '../core/hash.js';
import { normalizeRelative, safeResolve } from '../core/path-safety.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { filterEnvironment } from '../core/env-safety.js';
import { redact } from '../core/redaction.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { runtimeCliIntegrity } from '../core/identity.js';
import { recordAudit } from '../core/audit.js';
import { evaluateCheckFindings } from '../core/check-findings.js';
import { evaluateConstitutionCheck } from '../core/constitution-check.js';
import { ledgerReport } from '../core/ledger.js';
import { knownIdentities } from '../core/ledger-identity.js';
import { VERIFICATION_NOT_DECLARED, VERIFICATION_TOOLCHAIN_UNCOVERED, notDeclaredNextAction, notDeclaredReason, resolveVerificationPlan, suspiciouslyEmpty, uncoveredNextAction, uncoveredReason } from '../core/verification.js';

/**
 * Gate subprocesses never inherit the ambient environment; `filterEnvironment` (core/env-safety.ts)
 * carries the built-in allowlist shared with other XForge-spawned subprocesses, enough for the
 * shipped `npm test` / `npm audit` Gates to work on a developer machine, in CI, and behind a
 * corporate proxy, without becoming a blanket passthrough.
 */
function gateEnvironment(project: ProjectContext, gate: GateResource): NodeJS.ProcessEnv {
  const manifest = project.manifest.gates?.env;
  const { env } = filterEnvironment({
    allow: [...(manifest?.allow ?? []), ...(gate.spec.env?.allow ?? [])],
    allowPrefixes: [...(manifest?.allowPrefixes ?? []), ...(gate.spec.env?.allowPrefixes ?? [])],
  });
  return env;
}

function appendBounded(chunks: Buffer[], currentBytes: number, chunk: Buffer, limit: number): { bytes: number; truncated: boolean } {
  if (currentBytes >= limit) return { bytes: currentBytes, truncated: true };
  const remaining = limit - currentBytes;
  const selected = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(selected);
  return { bytes: currentBytes + selected.byteLength, truncated: chunk.byteLength > remaining };
}

type GateProcessResult = Pick<GateEvidence, 'command' | 'shell' | 'workingDirectory' | 'exitCode' | 'timedOut' | 'outputTruncated' | 'stdout' | 'stderr'>;

/**
 * Why a Gate's command never ran, when that is distinguishable from it running and failing.
 *
 * A required Gate whose executable is missing and a required Gate whose tests failed are both
 * blocking, and must stay blocking — an unrunnable check is not a pass. But they are not the same
 * problem and they do not have the same fix: one is "fix the code", the other is "install the tool
 * or point the Gate at one this project actually has". Reporting both as XFORGE_GATE_FAILED sent
 * every Node-less project chasing a failing test suite that never existed. The shipped `unit-tests`
 * and `security-scan` Gates are `npm`-based, so this is the default experience of any project
 * without a `package.json`.
 *
 * It is carried beside `GateProcessResult` rather than inside it because Evidence is a digested,
 * schema-bound artifact (`types.ts`, `GateEvidence`): adding a field here would change every
 * Evidence digest and the Evidence schema for something that is a property of this run's
 * diagnostics, not of the recorded result. `exitCode` and `stderr` already carry the raw facts.
 */
interface GateCommandUnavailable {
  executable: string;
  reason: 'spawn-failed' | 'exit-127';
  detail: string;
}

interface GateExecution {
  result: GateProcessResult;
  unavailable: GateCommandUnavailable | null;
}

/**
 * Exit status a shell (or a launcher that delegates to one, such as `npm run`) uses for "command
 * not found". No test runner uses 127 to mean "the tests failed", so treating it as a tooling gap
 * is safe in the direction that matters: it never turns a real failure into a pass, it only renames
 * the diagnostic. Both cases still block.
 */
const COMMAND_NOT_FOUND_EXIT = 127;

/**
 * What to execute, when it does not come from the Gate resource itself.
 *
 * A `builtin: declared` Gate runs commands the project wrote in `manifest.verification`, and they
 * go through this same function rather than a parallel implementation. Output bounding, redaction,
 * the timeout and its SIGKILL escalation, the environment allowlist, and above all the
 * missing-executable detection are properties a declared command needs exactly as much as a Gate
 * command does — a second spawner would drift from all six.
 */
interface CommandOverride {
  command: string[];
  workingDirectory?: string;
  timeoutSeconds?: number;
}

async function runCommand(project: ProjectContext, gate: GateResource, override?: CommandOverride): Promise<GateExecution> {
  const command = override?.command ?? gate.spec.command;
  if (!command?.length) throw new Error(`Gate ${gate.metadata.name} has no command`);
  const workingRelative = normalizeRelative(override?.workingDirectory ?? gate.spec.workingDirectory ?? '.', `Gate ${gate.metadata.name} workingDirectory`);
  const workingDirectory = await safeResolve(project.root, workingRelative);
  const maxBytes = gate.spec.maxOutputBytes ?? MAX_GATE_OUTPUT_BYTES;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;

  const safeEnvironment = gateEnvironment(project, gate);

  const result = await new Promise<{ exitCode: number | null; spawnError: NodeJS.ErrnoException | null }>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: workingDirectory,
      shell: gate.spec.shell === true,
      env: safeEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendBounded(stdout, stdoutBytes, chunk, maxBytes);
      stdoutBytes = next.bytes;
      truncated ||= next.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendBounded(stderr, stderrBytes, chunk, maxBytes);
      stderrBytes = next.bytes;
      truncated ||= next.truncated;
    });
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceTimer.unref();
    }, (override?.timeoutSeconds ?? gate.spec.timeoutSeconds) * 1000);
    timer.unref();
    /*
     * A spawn failure resolves rather than rejects: "the executable is missing" is a result this
     * runner has to report precisely (see GateCommandUnavailable), not an exception to be flattened
     * into a generic failure by the caller. `close` may still follow `error`; the first settle wins.
     */
    child.on('error', (error) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); resolve({ exitCode: null, spawnError: error }); });
    child.on('close', (exitCode) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); resolve({ exitCode, spawnError: null }); });
  });

  const executable = command[0]!;
  let unavailable: GateCommandUnavailable | null = null;
  if (result.spawnError && (result.spawnError.code === 'ENOENT' || result.spawnError.code === 'EACCES')) {
    /* ENOENT: nothing on PATH by that name. EACCES: the file is there but is not executable —
       equally "this Gate cannot run here", and equally not a statement about the code under test. */
    unavailable = { executable, reason: 'spawn-failed', detail: result.spawnError.message };
  } else if (!result.spawnError && result.exitCode === COMMAND_NOT_FOUND_EXIT && !timedOut) {
    unavailable = { executable, reason: 'exit-127', detail: `${executable} exited ${COMMAND_NOT_FOUND_EXIT}` };
  }

  return {
    result: {
      command,
      shell: gate.spec.shell === true,
      workingDirectory: workingRelative,
      exitCode: result.exitCode,
      timedOut,
      outputTruncated: truncated,
      stdout: redact(Buffer.concat(stdout).toString('utf8')),
      /* A spawn failure produces no child output at all, so the error is the only evidence of what
         happened; it goes through `redact` like any other captured text because it echoes the
         command line, which can carry a credential a project put in a Gate argument. */
      stderr: redact(result.spawnError ? result.spawnError.message : Buffer.concat(stderr).toString('utf8')),
    },
    unavailable,
  };
}

interface GateRunResult {
  evidence: GateEvidence;
  diagnostic: Diagnostic | null;
  /** Human decisions this Gate is waiting on. Empty for every outcome the CLI can resolve alone. */
  nextActions: NextAction[];
  change: FileChange;
}

interface GateContext {
  flow: string;
  revision: GovernanceRevision;
  stage: string;
  approvals: ApprovalReceipt[];
}

/**
 * The Flow, governance revision, Stage, and Approvals a Gate run for this Change is bound to.
 *
 * Single source of truth on purpose: `inputDigest` is derived from `revision`, and `check` predicts
 * that digest to decide whether it may reuse Evidence instead of re-running the Gate. A second,
 * hand-copied derivation would silently drift the moment this one changes.
 */
async function resolveGateContext(project: ProjectContext, changeId: string): Promise<GateContext> {
  const resolved = await resolveChangeState(project, changeId);
  const resources = await loadSelectedResources(project);
  const control = isStageFlow(resolved.flow) && resolved.flow.governance
    ? await resolveControlPlane(project, changeId, resolved.flow, resolved.state, resources, resolved.config)
    : null;
  const flow = resolved.flow.metadata.name;
  const revision = control?.governance.revision ?? {
    contentRevision: sha256(stableStringify({ changeId, flow })),
    stateRevision: sha256(stableStringify({ changeId, flow, stage: 'legacy' })),
    policySnapshotDigest: sha256(stableStringify({ legacy: true })), gitBase: 'unknown', gitHead: 'unknown',
  };
  return { flow, revision, stage: control?.governance.currentStage ?? 'legacy', approvals: control?.governance.approvals ?? [] };
}

/**
 * The `inputDigest` a Gate run for this Change would record right now, without running the Gate.
 *
 * It covers the Gate definition, the governance revision (Change content, policy snapshot, and the
 * committed Git base/head), and the structural pre-check. It says nothing about uncommitted files:
 * every input is either a governance Artifact or a commit id, so a caller reusing Evidence on the
 * strength of a matching digest must establish working-tree equality separately.
 */
/**
 * Runs one command and reports how it exited, with no Evidence, audit event, or Gate semantics.
 *
 * For `work-package draft`, which needs the exit code of each declared `verify` entry and nothing
 * else. It goes through `runCommand` rather than its own `spawn` for the reason stated above that
 * function: the output bound, the timeout and its escalation, the environment allowlist, and the
 * never-a-shell rule are properties this needs exactly as much as a Gate does, and a work package's
 * `verify` is the one command list in XForge that arrives from a file the Change itself can write.
 */
/**
 * Runs one work package's declared verify command, and hands back what it said.
 *
 * The output used to be dropped here and only the exit code kept, so `work-package draft` could
 * report that a package's suite failed without reporting a single line of why — a field report ran
 * the suite a second time by hand to find out which case was red. The bytes were already captured;
 * nothing was being protected by discarding them.
 *
 * `outputTruncated` travels with them because of which end survives: `appendBounded` keeps the head
 * of each stream, and a test runner usually prints its failures last. A caller quoting the tail of a
 * truncated capture is quoting the tail of the *kept* part, which may be setup noise rather than the
 * failure, and it has to be able to say so.
 */
export async function runVerifyCommand(
  project: ProjectContext,
  gate: GateResource,
): Promise<{ exitCode: number | null; timedOut: boolean; unavailable: string | null; stdout: string; stderr: string; outputTruncated: boolean }> {
  const execution = await runCommand(project, gate);
  return {
    exitCode: execution.result.exitCode,
    timedOut: execution.result.timedOut,
    unavailable: execution.unavailable ? `${execution.unavailable.executable}: ${execution.unavailable.detail}` : null,
    stdout: execution.result.stdout,
    stderr: execution.result.stderr,
    outputTruncated: execution.result.outputTruncated,
  };
}

export async function gateInputDigest(
  project: ProjectContext,
  changeId: string,
  gate: GateResource,
  structurePassed: boolean,
): Promise<string> {
  const { revision } = await resolveGateContext(project, changeId);
  return sha256(stableStringify({ gate, revision, structurePassed }));
}

export async function runGate(
  project: ProjectContext,
  changeId: string,
  gate: GateResource,
  structurePassed: boolean,
): Promise<GateRunResult> {
  const { flow, revision, stage, approvals } = await resolveGateContext(project, changeId);
  await recordAudit(project, { eventType: 'gate.before', change: changeId, flow, stage, revision, refs: { gates: [gate.metadata.name] }, input: { gate: gate.metadata.name }, outcome: 'succeeded' });
  const startedAt = new Date();
  let result: GateProcessResult;
  let unavailable: GateCommandUnavailable | null = null;
  /* Set when a `declared` Gate refused for want of an answer rather than because a check failed.
     The two need different diagnostics because they need different actions from the reader. */
  let declaredRefusal: { code: string; message: string; nextAction: NextAction } | null = null;
  if (gate.spec.builtin === 'structure') {
    result = {
      command: ['builtin:structure'],
      shell: false,
      workingDirectory: '.',
      exitCode: structurePassed ? 0 : 1,
      timedOut: false,
      outputTruncated: false,
      stdout: structurePassed ? 'Structural validation passed.' : '',
      stderr: structurePassed ? '' : 'Structural validation failed.',
    };
  } else if (gate.spec.builtin === 'check-findings') {
    /* Turns the Check Stage from "the Agent says it reviewed things" into a decidable result. */
    /* The approvals this Change has, on the same terms as `constitution-check` below. This Gate is
       re-run after the Check Stage — it is one of the archive path's mandatory Gates — and by then
       a `resolvedBy` naming the person who signed the planning approval is naming somebody the
       Change records. Omitting them here meant the ledger was held to Git authors alone whatever
       Stage it ran at, while the refusal it produced said "approver or Git author". */
    const findings = await evaluateCheckFindings(project, changeId, await knownIdentities(project, changeId, approvals));
    result = {
      command: ['builtin:check-findings'],
      shell: false,
      workingDirectory: '.',
      exitCode: findings.status === 'passed' ? 0 : 1,
      timedOut: false,
      outputTruncated: false,
      ...ledgerReport(
        `Check findings ledger accepted: ${findings.counts.blocker} blocker(s) all resolved, ${findings.counts.warning} warning(s), ${findings.counts.suggestion} suggestion(s).`,
        findings,
      ),
    };
  } else if (gate.spec.builtin === 'constitution-check') {
    /* The Constitution is documented as the first governance layer; this is what makes it one. */
    const known = await knownIdentities(project, changeId, approvals);
    const constitution = await evaluateConstitutionCheck(project, changeId, known, { approvals });
    result = {
      command: ['builtin:constitution-check'],
      shell: false,
      workingDirectory: '.',
      exitCode: constitution.status === 'passed' ? 0 : 1,
      timedOut: false,
      outputTruncated: false,
      ...ledgerReport(
        `Constitution ledger accepted: ${constitution.covered.length}/${constitution.principles.length} principles answered, ${constitution.violations.length} recorded violation(s).`,
        constitution,
      ),
    };
  } else if (gate.spec.builtin === 'declared') {
    /*
     * The Gate runs what this project said it runs, and refuses when it said nothing.
     *
     * `passed` here always means a command executed and succeeded. There is no path through this
     * branch that reports success without having run something — that path is what made every
     * non-npm project's `unit-tests` Gate a decoration.
     */
    const plan = await resolveVerificationPlan(project, gate.metadata.name);
    if (plan.runs.length === 0) {
      declaredRefusal = {
        code: VERIFICATION_NOT_DECLARED,
        message: `Gate ${gate.metadata.name} has no command declared under manifest.verification.${gate.metadata.name}. This is an unanswered question, not a failing check — XForge does not know how this project runs its tests and refuses to report success for something it never ran. Ask the user and record the answer.`,
        nextAction: notDeclaredNextAction(gate.metadata.name, plan.detected),
      };
      result = {
        command: [`builtin:declared:${gate.metadata.name}`],
        shell: false,
        workingDirectory: '.',
        exitCode: 1,
        timedOut: false,
        outputTruncated: false,
        stdout: '',
        stderr: notDeclaredReason(gate.metadata.name, plan.detected),
      };
    } else if (plan.uncovered.length > 0) {
      /* Declared, but something in this repository is outside everything it declared. Refusing is
         the point: an unverified module that ships under a green Gate is the original defect with
         a smaller blast radius, not a different one. A dismissal closes it permanently. */
      declaredRefusal = {
        code: VERIFICATION_TOOLCHAIN_UNCOVERED,
        message: `Gate ${gate.metadata.name} declares commands, but ${plan.uncovered.map((marker) => marker.marker).join(', ')} ${plan.uncovered.length === 1 ? 'is' : 'are'} covered by none of them. Declare a command for it, or record it as notApplicable with a justification — either answer closes the question for good.`,
        nextAction: uncoveredNextAction(gate.metadata.name, plan.uncovered),
      };
      result = {
        command: [`builtin:declared:${gate.metadata.name}`],
        shell: false,
        workingDirectory: '.',
        exitCode: 1,
        timedOut: false,
        outputTruncated: false,
        stdout: '',
        stderr: uncoveredReason(gate.metadata.name, plan.uncovered),
      };
    } else {
      const transcript: string[] = [];
      let failure: GateProcessResult | null = null;
      for (const run of plan.runs) {
        const started = Date.now();
        const execution = await runCommand(project, gate, {
          command: run.command,
          workingDirectory: run.workingDirectory,
          timeoutSeconds: run.timeoutSeconds,
        });
        const elapsed = Date.now() - started;
        const label = `${run.command.join(' ')}${run.module ? ` [module ${run.module}]` : ''}`;
        transcript.push(`${label} -> exit ${execution.result.exitCode ?? 'none'} in ${elapsed}ms (declared by ${run.declaredBy})`);
        if (execution.result.stdout) transcript.push(execution.result.stdout);
        const empty = suspiciouslyEmpty(elapsed, execution.result.stdout.length + execution.result.stderr.length, execution.result.exitCode);
        if (empty) transcript.push(`${gate.metadata.name}: ${empty}`);
        if (execution.result.exitCode !== 0 || execution.result.timedOut) {
          unavailable = execution.unavailable;
          failure = { ...execution.result, stderr: [`${label} failed.`, execution.result.stderr].filter(Boolean).join('\n') };
          /* Stop at the first failure: the Gate has its answer, and the commands after it would
             report against a tree the failing one may have left mid-change. */
          break;
        }
      }
      result = failure ?? {
        command: [`builtin:declared:${gate.metadata.name}`],
        shell: false,
        workingDirectory: '.',
        exitCode: 0,
        timedOut: false,
        outputTruncated: false,
        stdout: transcript.join('\n'),
        stderr: '',
      };
      if (failure) result = { ...failure, stdout: transcript.join('\n') };
    }
  } else {
    try {
      const execution = await runCommand(project, gate);
      result = execution.result;
      unavailable = execution.unavailable;
    } catch (error) {
      result = {
        command: gate.spec.command ?? [], shell: gate.spec.shell === true,
        workingDirectory: gate.spec.workingDirectory ?? '.', exitCode: null, timedOut: false,
        outputTruncated: false, stdout: '', stderr: redact((error as Error).message),
      };
    }
  }
  const finishedAt = new Date();
  const status = result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed';
  const withoutDigest = {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: '1' as const,
    gate: gate.metadata.name,
    change: changeId,
    flow,
    stage,
    stateRevision: revision.stateRevision,
    contentRevision: revision.contentRevision,
    policySnapshotDigest: revision.policySnapshotDigest,
    gitBase: revision.gitBase,
    gitHead: revision.gitHead,
    inputDigest: sha256(stableStringify({ gate, revision, structurePassed })),
    runner: { name: CLI_NAME, version: CLI_VERSION, integrity: runtimeCliIntegrity() },
    ...result,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status,
  } as const;
  const evidence: GateEvidence = { ...withoutDigest, digest: sha256(stableStringify(withoutDigest)) };
  const evidencePath = `${project.changesPath}/${changeId}/evidence/${gate.spec.evidence}`;
  let action: FileChange['action'] = 'create';
  /* The bytes this run is about to overwrite, kept only when they passed the conflict check below. */
  let priorEvidence: Buffer | null = null;
  try {
    const existingBytes = await readFile(await safeResolve(project.root, evidencePath));
    const existing = JSON.parse(existingBytes.toString('utf8')) as GateEvidence;
    const { digest: existingDigest, ...existingUnsigned } = existing;
    if (existing.gate !== gate.metadata.name || existing.change !== changeId || existingDigest !== sha256(stableStringify(existingUnsigned))) {
      throw new XForgeError(diagnostic('XFORGE_EVIDENCE_CONFLICT', 'Existing Evidence is not a valid prior XForge result for this Gate and Change.', evidencePath));
    }
    action = 'modify';
    priorEvidence = existingBytes;
  } catch (error) {
    if (error instanceof XForgeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new XForgeError(diagnostic('XFORGE_EVIDENCE_CONFLICT', 'Existing Evidence is not valid JSON.', evidencePath));
      throw error;
    }
  }
  await atomicWrite(project.root, evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  try {
    await recordAudit(project, { eventType: 'gate.after', change: changeId, flow, stage, revision, refs: { gates: [gate.metadata.name] }, outcome: status === 'passed' ? 'succeeded' : 'failed', durationMs: evidence.durationMs, input: { gate: gate.metadata.name }, output: { evidence: evidence.digest, status } });
  } catch (error) {
    /*
     * Evidence with no attesting `gate.after` event is a transition-unblocking artifact:
     * `gateBlockReason` (core/control-plane.ts) decides on the Evidence file alone and never
     * cross-checks it against the audit chain. Leaving the file behind on the assumption that a
     * retry self-heals is wrong — the retry may never come (CI aborts, the machine dies) and until
     * it does, the unattested file counts as a pass.
     *
     * Unlike the create-only receipt sites (transition.ts, approve.ts, work-package.ts), an Evidence
     * path is stable and this write is usually an *overwrite*: deleting it here would destroy the
     * previous, properly attested Evidence over a transient audit failure. So restore the prior
     * bytes when there were any, and only delete when this run created the file.
     */
    try {
      if (priorEvidence) await atomicWrite(project.root, evidencePath, priorEvidence);
      else await rm(await safeResolve(project.root, evidencePath), { force: true });
    } catch { /* The audit failure below is the actionable one; report it, not a cleanup failure. */ }
    throw error;
  }
  /*
   * An unrunnable Gate still fails — Evidence records `failed`, so every transition it guards stays
   * blocked and no caller can read it as a pass. Only the diagnostic differs, because the two
   * outcomes need different actions from the reader and XFORGE_GATE_FAILED describes only one of
   * them. Note that `blockRemedy` (core/control-plane.ts) offers its re-run advice for `stale`
   * Evidence only, so nothing here was telling a Node-less project what to do about a `npm test`
   * Gate it can never satisfy.
   */
  const failureDiagnostic = declaredRefusal
    ? diagnostic(
      declaredRefusal.code,
      declaredRefusal.message,
      'xforge/manifest.yaml',
      'error',
      { gate: gate.metadata.name },
    )
    : unavailable
    ? diagnostic(
      'XFORGE_GATE_COMMAND_UNAVAILABLE',
      `Gate ${gate.metadata.name} could not be executed: ${unavailable.executable} is not available here (${unavailable.detail}). This is a missing tool, not a failing check — install it, or change the Gate's command in its Gate resource so it runs something this project has.`,
      evidencePath,
      'error',
      { gate: gate.metadata.name, executable: unavailable.executable, reason: unavailable.reason, exitCode: evidence.exitCode },
    )
    : diagnostic('XFORGE_GATE_FAILED', `Mandatory Gate failed: ${gate.metadata.name}`, evidencePath, 'error', { exitCode: evidence.exitCode, timedOut: evidence.timedOut });
  return {
    evidence,
    diagnostic: status === 'failed' ? failureDiagnostic : null,
    /* The refusal is only actionable if the reader is told what to ask and where to write the
       answer, and `nextActions` is the channel the protocol reserves for a human decision. */
    nextActions: status === 'failed' && declaredRefusal ? [declaredRefusal.nextAction] : [],
    change: { action, path: evidencePath, digest: sha256(`${JSON.stringify(evidence, null, 2)}\n`), source: `gate:${gate.metadata.name}` },
  };
}
