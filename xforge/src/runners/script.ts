import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ProjectContext } from '../types.js';
import { MAX_GATE_OUTPUT_BYTES } from '../constants.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { normalizeRelative, safeResolve } from '../core/path-safety.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolvedResourceEntries } from '../core/lockfile.js';
import { stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { redact } from '../core/redaction.js';

export interface ScriptRunResult {
  id: string;
  runtime: 'node' | 'python';
  command: string[];
  workingDirectory: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[name]) result[name] = process.env[name];
  }
  return result;
}

function bounded(chunks: Buffer[], bytes: number, chunk: Buffer): { bytes: number; truncated: boolean } {
  if (bytes >= MAX_GATE_OUTPUT_BYTES) return { bytes, truncated: true };
  const selected = chunk.subarray(0, MAX_GATE_OUTPUT_BYTES - bytes);
  chunks.push(selected);
  return { bytes: bytes + selected.byteLength, truncated: selected.byteLength < chunk.byteLength };
}

export async function runProjectScript(project: ProjectContext, id: string, extraArguments: string[] = [], options: { stdin?: string } = {}): Promise<ScriptRunResult> {
  assertManaged(project, 'project Script execution');
  const resources = await loadSelectedResources(project);
  const errors = resources.diagnostics.filter((item) => item.severity === 'error');
  if (errors.length > 0) throw new XForgeError(errors, { root: project.root });
  if (stableStringify(project.lock?.resources ?? []) !== stableStringify(await resolvedResourceEntries(project, resources))) {
    throw new XForgeError(diagnostic('XFORGE_LOCK_STALE', 'Run xforge install before executing a changed project Script.', 'xforge/lock.yaml'), { root: project.root });
  }
  const script = resources.scripts.get(id);
  if (!script) throw new XForgeError(diagnostic('XFORGE_SCRIPT_NOT_FOUND', `Selected project Script not found: ${id}`, 'xforge/manifest.yaml'), { root: project.root });

  const workingRelative = normalizeRelative(script.value.spec.workingDirectory, `Script ${id} workingDirectory`);
  const workingDirectory = await safeResolve(project.root, workingRelative);
  const entry = await safeResolve(project.root, script.entryPath);
  let command: string[];
  if (script.value.spec.runtime === 'node' && entry.endsWith('.ts')) {
    const source = await readFile(entry, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, sourceMap: false },
      fileName: path.basename(entry),
      reportDiagnostics: true,
    });
    const compileErrors = (compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
    if (compileErrors.length > 0) throw new XForgeError(diagnostic(
      'XFORGE_SCRIPT_COMPILE_FAILED',
      ts.formatDiagnostics(compileErrors, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => workingDirectory, getNewLine: () => '\n' }),
      script.entryPath,
    ));
    command = [process.execPath, '--input-type=module', '--eval', compiled.outputText, '--', ...script.value.spec.arguments, ...extraArguments];
  } else if (script.value.spec.runtime === 'node') {
    command = [process.execPath, entry, ...script.value.spec.arguments, ...extraArguments];
  } else {
    const python = process.env.XFORGE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    command = [python, entry, ...script.value.spec.arguments, ...extraArguments];
  }

  const started = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: workingDirectory, env: safeEnvironment(), shell: false,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.stdin !== undefined) child.stdin!.end(options.stdin);
    child.stdout!.on('data', (chunk: Buffer) => {
      const result = bounded(stdout, stdoutBytes, chunk); stdoutBytes = result.bytes; outputTruncated ||= result.truncated;
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      const result = bounded(stderr, stderrBytes, chunk); stderrBytes = result.bytes; outputTruncated ||= result.truncated;
    });
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceTimer.unref();
    }, script.value.spec.timeoutSeconds * 1000);
    timer.unref();
    child.on('error', (error) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); resolve(code); });
  });
  return {
    id,
    runtime: script.value.spec.runtime,
    command: script.value.spec.runtime === 'node' && entry.endsWith('.ts') ? [process.execPath, '<transpiled-typescript>', ...script.value.spec.arguments, ...extraArguments] : command,
    workingDirectory: workingRelative,
    exitCode,
    timedOut,
    outputTruncated,
    /*
     * Redacted on the same terms as Gate output (`core/redaction.ts`). A project Script is a
     * project-defined subprocess with a filtered-but-populated environment, exactly like a Gate, and
     * this result is a public return value: today `runScriptHooks` reads only the parsed decision
     * out of it, but nothing in the type says so, and the first consumer that logs or records
     * `stdout` would have shipped whatever a Script echoed. Applying it at the source makes that
     * consumer safe by construction instead of by review.
     */
    stdout: redact(Buffer.concat(stdout).toString('utf8')),
    stderr: redact(Buffer.concat(stderr).toString('utf8')),
    durationMs: Date.now() - started,
  };
}
