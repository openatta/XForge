// design: live-test §3 — LT-03：harness 自己的每一次 xforge 调用都记进 xforge-commands.log。
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Envelope } from '../../../src/model/types.js';

const run = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BIN = join(repoRoot, 'bin', 'xforge.js');

let logPath: string | null = null;
let binPath = BIN;
export function logXforgeTo(path: string): void {
  logPath = path;
}
/** 让 harness 自己也用工作目录里安装的那份包。 */
export function useInstalledBin(path: string): void {
  binPath = path;
}

export interface XfResult {
  exit: number;
  env: Envelope;
  stderr: string;
}

export async function xforge(cwd: string, args: string[]): Promise<XfResult> {
  let result: XfResult;
  try {
    const { stdout, stderr } = await run('node', [binPath, ...args], { cwd, env: { ...process.env }, maxBuffer: 64 * 1024 * 1024 });
    result = { exit: 0, env: parse(stdout), stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    result = { exit: typeof e.code === 'number' ? e.code : 1, env: parse(e.stdout ?? ''), stderr: e.stderr ?? '' };
  }
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), args, exit: result.exit, env: result.env, stderr: result.stderr.trim() || undefined })}\n`);
  return result;
}

function parse(stdout: string): Envelope {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line) as Envelope;
  } catch {
    return { ok: false, verb: '?', result: { raw: stdout }, diagnostics: [], changed: [], next: [] };
  }
}
