// design: live-test §0 — D7：验收套件归档后拷进树跑，跑完删掉。
import { execFile } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface OracleResult {
  ran: number;
  failed: number;
  output: string;
}

export async function runOracle(project: string, oracleFile: string): Promise<OracleResult> {
  const target = join(project, 'tests', 'test_oracle.py');
  copyFileSync(oracleFile, target);
  try {
    const { stdout, stderr } = await run('python3', ['-m', 'unittest', '-v', 'tests.test_oracle'], { cwd: project, env: { ...process.env, PYTHONPATH: project } });
    return { ...counts(stderr + stdout), output: stderr + stdout };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    const text = `${e.stderr ?? ''}${e.stdout ?? ''}`;
    return { ...counts(text), output: text };
  } finally {
    rmSync(target, { force: true });
    rmSync(join(project, 'tests', '__pycache__'), { recursive: true, force: true });
  }
}

function counts(text: string): { ran: number; failed: number } {
  const ran = Number(/Ran (\d+) tests?/.exec(text)?.[1] ?? 0);
  const failures = Number(/failures=(\d+)/.exec(text)?.[1] ?? 0);
  const errors = Number(/errors=(\d+)/.exec(text)?.[1] ?? 0);
  return { ran, failed: /\bOK\b/.test(text) && !/FAILED/.test(text) ? 0 : Math.max(failures + errors, ran === 0 ? 1 : 0) };
}
