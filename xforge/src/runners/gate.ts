import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, GateEvidence, GateResource, ProjectContext } from '../types.js';
import { MAX_GATE_OUTPUT_BYTES, PROTOCOL_VERSION } from '../constants.js';
import { atomicWrite } from '../core/files.js';
import { sha256, stableStringify } from '../core/hash.js';
import { normalizeRelative, safeResolve } from '../core/path-safety.js';
import { XForgeError, diagnostic } from '../core/errors.js';

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

async function runCommand(project: ProjectContext, gate: GateResource): Promise<Omit<GateEvidence, 'protocolVersion' | 'gate' | 'change' | 'startedAt' | 'finishedAt' | 'durationMs' | 'digest' | 'status'>> {
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

  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[name]) safeEnvironment[name] = process.env[name];
  }

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
  const startedAt = new Date();
  let result: Omit<GateEvidence, 'protocolVersion' | 'gate' | 'change' | 'startedAt' | 'finishedAt' | 'durationMs' | 'digest' | 'status'>;
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
    gate: gate.metadata.name,
    change: changeId,
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
  return {
    evidence,
    diagnostic: status === 'failed'
      ? diagnostic('XFORGE_GATE_FAILED', `Mandatory Gate failed: ${gate.metadata.name}`, evidencePath, 'error', { exitCode: evidence.exitCode, timedOut: evidence.timedOut })
      : null,
    change: { action, path: evidencePath, digest: sha256(`${JSON.stringify(evidence, null, 2)}\n`), source: `gate:${gate.metadata.name}` },
  };
}
