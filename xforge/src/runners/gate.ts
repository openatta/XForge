import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, GateEvidence, GateResource, ProjectContext } from '../types.js';
import { CLI_NAME, CLI_VERSION, MAX_GATE_OUTPUT_BYTES, PROTOCOL_VERSION } from '../constants.js';
import { atomicWrite } from '../core/files.js';
import { sha256, stableStringify } from '../core/hash.js';
import { normalizeRelative, safeResolve } from '../core/path-safety.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { runtimeCliIntegrity } from '../core/identity.js';
import { recordAudit } from '../core/audit.js';
import { evaluateCheckFindings } from '../core/check-findings.js';
import { evaluateConstitutionCheck } from '../core/constitution-check.js';
import { knownIdentities } from '../core/ledger-identity.js';

/**
 * Gate subprocesses never inherit the ambient environment. This is the built-in allowlist: enough
 * for the shipped `npm test` / `npm audit` Gates to work on a developer machine, in CI, and behind
 * a corporate proxy, without becoming a blanket passthrough.
 */
const DEFAULT_GATE_ENV_ALLOW = [
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'OS',
  'CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/** `npm_config_*` carries registry/cache/proxy settings; credential-shaped names are filtered below. */
const DEFAULT_GATE_ENV_PREFIXES = ['npm_config_', 'NPM_CONFIG_'];

/** Never inherited, from any source: the manifest cannot opt a credential back in. */
const GATE_ENV_DENY = /(?:password|passwd|secret|token|api[_-]?key|auth|credential|cookie|session|private[_-]?key)/i;

function gateEnvironment(project: ProjectContext, gate: GateResource): NodeJS.ProcessEnv {
  const manifest = project.manifest.gates?.env;
  const allow = new Set([...DEFAULT_GATE_ENV_ALLOW, ...(manifest?.allow ?? []), ...(gate.spec.env?.allow ?? [])]);
  const prefixes = [...DEFAULT_GATE_ENV_PREFIXES, ...(manifest?.allowPrefixes ?? []), ...(gate.spec.env?.allowPrefixes ?? [])];
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value === '') continue;
    if (GATE_ENV_DENY.test(name)) continue;
    if (!allow.has(name) && !prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix))) continue;
    environment[name] = value;
  }
  return environment;
}

function redact(input: string): string {
  let output = input.replace(/((?:password|passwd|secret|api[_-]?key|(?:access[_-]?)?token|authorization)\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]');
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(?:password|passwd|secret|api[_-]?key|token)/i.test(key) || !value || value.length < 5) continue;
    output = output.split(value).join('[REDACTED]');
  }
  return output;
}

function appendBounded(chunks: Buffer[], currentBytes: number, chunk: Buffer, limit: number): { bytes: number; truncated: boolean } {
  if (currentBytes >= limit) return { bytes: currentBytes, truncated: true };
  const remaining = limit - currentBytes;
  const selected = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(selected);
  return { bytes: currentBytes + selected.byteLength, truncated: chunk.byteLength > remaining };
}

type GateProcessResult = Pick<GateEvidence, 'command' | 'shell' | 'workingDirectory' | 'exitCode' | 'timedOut' | 'outputTruncated' | 'stdout' | 'stderr'>;

async function runCommand(project: ProjectContext, gate: GateResource): Promise<GateProcessResult> {
  const command = gate.spec.command;
  if (!command?.length) throw new Error(`Gate ${gate.metadata.name} has no command`);
  const workingRelative = normalizeRelative(gate.spec.workingDirectory ?? '.', `Gate ${gate.metadata.name} workingDirectory`);
  const workingDirectory = await safeResolve(project.root, workingRelative);
  const maxBytes = gate.spec.maxOutputBytes ?? MAX_GATE_OUTPUT_BYTES;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;

  const safeEnvironment = gateEnvironment(project, gate);

  const result = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
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
    }, gate.spec.timeoutSeconds * 1000);
    timer.unref();
    child.on('error', (error) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); reject(error); });
    child.on('close', (exitCode) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); resolve({ exitCode }); });
  });

  return {
    command,
    shell: gate.spec.shell === true,
    workingDirectory: workingRelative,
    exitCode: result.exitCode,
    timedOut,
    outputTruncated: truncated,
    stdout: redact(Buffer.concat(stdout).toString('utf8')),
    stderr: redact(Buffer.concat(stderr).toString('utf8')),
  };
}

export interface GateRunResult {
  evidence: GateEvidence;
  diagnostic: Diagnostic | null;
  change: FileChange;
}

export async function runGate(
  project: ProjectContext,
  changeId: string,
  gate: GateResource,
  structurePassed: boolean,
): Promise<GateRunResult> {
  const resolved = await resolveChangeState(project, changeId);
  const resources = await loadSelectedResources(project);
  const control = isStageFlow(resolved.flow) && resolved.flow.governance
    ? await resolveControlPlane(project, changeId, resolved.flow, resolved.state, resources, resolved.config)
    : null;
  const revision = control?.governance.revision ?? {
    contentRevision: sha256(stableStringify({ changeId, flow: resolved.flow.metadata.name })),
    stateRevision: sha256(stableStringify({ changeId, flow: resolved.flow.metadata.name, stage: 'legacy' })),
    policySnapshotDigest: sha256(stableStringify({ legacy: true })), gitBase: 'unknown', gitHead: 'unknown',
  };
  const stage = control?.governance.currentStage ?? 'legacy';
  await recordAudit(project, { eventType: 'gate.before', change: changeId, flow: resolved.flow.metadata.name, stage, revision, refs: { gates: [gate.metadata.name] }, input: { gate: gate.metadata.name }, outcome: 'succeeded' });
  const startedAt = new Date();
  let result: GateProcessResult;
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
    const findings = await evaluateCheckFindings(project, changeId);
    result = {
      command: ['builtin:check-findings'],
      shell: false,
      workingDirectory: '.',
      exitCode: findings.status === 'passed' ? 0 : 1,
      timedOut: false,
      outputTruncated: false,
      stdout: findings.status === 'passed'
        ? `Check findings ledger accepted: ${findings.counts.blocker} blocker(s) all resolved, ${findings.counts.warning} warning(s), ${findings.counts.suggestion} suggestion(s).`
        : '',
      stderr: findings.status === 'passed' ? '' : findings.problems.join('\n'),
    };
  } else if (gate.spec.builtin === 'constitution-check') {
    /* The Constitution is documented as the first governance layer; this is what makes it one. */
    const known = await knownIdentities(project, changeId, control?.governance.approvals ?? []);
    const constitution = await evaluateConstitutionCheck(project, changeId, known);
    result = {
      command: ['builtin:constitution-check'],
      shell: false,
      workingDirectory: '.',
      exitCode: constitution.status === 'passed' ? 0 : 1,
      timedOut: false,
      outputTruncated: false,
      stdout: constitution.status === 'passed'
        ? `Constitution ledger accepted: ${constitution.covered.length}/${constitution.principles.length} principles answered, ${constitution.violations.length} recorded violation(s).`
        : '',
      stderr: constitution.status === 'passed' ? '' : constitution.problems.join('\n'),
    };
  } else {
    try {
      result = await runCommand(project, gate);
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
    flow: resolved.flow.metadata.name,
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
  try {
    const existingSource = await readFile(await safeResolve(project.root, evidencePath), 'utf8');
    const existing = JSON.parse(existingSource) as GateEvidence;
    const { digest: existingDigest, ...existingUnsigned } = existing;
    if (existing.gate !== gate.metadata.name || existing.change !== changeId || existingDigest !== sha256(stableStringify(existingUnsigned))) {
      throw new XForgeError(diagnostic('XFORGE_EVIDENCE_CONFLICT', 'Existing Evidence is not a valid prior XForge result for this Gate and Change.', evidencePath));
    }
    action = 'modify';
  } catch (error) {
    if (error instanceof XForgeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new XForgeError(diagnostic('XFORGE_EVIDENCE_CONFLICT', 'Existing Evidence is not valid JSON.', evidencePath));
      throw error;
    }
  }
  await atomicWrite(project.root, evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await recordAudit(project, { eventType: 'gate.after', change: changeId, flow: resolved.flow.metadata.name, stage, revision, refs: { gates: [gate.metadata.name] }, outcome: status === 'passed' ? 'succeeded' : 'failed', durationMs: evidence.durationMs, input: { gate: gate.metadata.name }, output: { evidence: evidence.digest, status } });
  return {
    evidence,
    diagnostic: status === 'failed'
      ? diagnostic('XFORGE_GATE_FAILED', `Mandatory Gate failed: ${gate.metadata.name}`, evidencePath, 'error', { exitCode: evidence.exitCode, timedOut: evidence.timedOut })
      : null,
    change: { action, path: evidencePath, digest: sha256(`${JSON.stringify(evidence, null, 2)}\n`), source: `gate:${gate.metadata.name}` },
  };
}
