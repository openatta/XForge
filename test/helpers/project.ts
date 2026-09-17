// design: migration §0 — D4 integration 层：在临时项目上跑真实的 bin/xforge.js。
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Envelope } from '../../src/model/types.js';

const run = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(repoRoot, 'bin', 'xforge.js');
const ENFORCE = join(repoRoot, 'bin', 'xforge-enforce.js');

export interface Result {
  exit: number;
  env: Envelope;
  stderr: string;
}

export class Project {
  constructor(public readonly root: string) {}

  static async create(name = 'proj'): Promise<Project> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `xforge-${name}-`)));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    return new Project(root);
  }

  async write(rel: string, content: string): Promise<void> {
    const path = join(this.root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  commit(message = 'wip'): string {
    execFileSync('git', ['add', '-A'], { cwd: this.root });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: this.root });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, encoding: 'utf8' }).trim();
  }

  head(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, encoding: 'utf8' }).trim();
  }

  async xforge(...args: string[]): Promise<Result> {
    return this.xforgeIn({}, ...args);
  }

  /** 在别的目录 / 环境下调用：worktree 里的方案会话就是 cwd=worktree + XFORGE_ROOT/XFORGE_SCHEME。 */
  async xforgeIn(where: { cwd?: string; env?: Record<string, string> }, ...args: string[]): Promise<Result> {
    try {
      const { stdout, stderr } = await run('node', [BIN, ...args], { cwd: where.cwd ?? this.root, env: { ...process.env, XFORGE_NOW: '2026-09-15T10:00:00.000Z', ...(where.env ?? {}) } });
      return { exit: 0, env: parse(stdout), stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { exit: e.code ?? 1, env: parse(e.stdout ?? ''), stderr: e.stderr ?? '' };
    }
  }

  async enforce(payload: unknown, where: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ decision: string; reason: string }> {
    const child = execFile('node', [ENFORCE, '--host', 'claude'], { cwd: where.cwd ?? this.root, env: { ...process.env, ...(where.env ?? {}) } });
    child.stdin!.end(JSON.stringify(payload));
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise<void>((res) => child.on('close', () => res()));
    const parsed = JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    return { decision: parsed.hookSpecificOutput.permissionDecision, reason: parsed.hookSpecificOutput.permissionDecisionReason };
  }
}

function parse(stdout: string): Envelope {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line) as Envelope;
  } catch {
    return { ok: false, verb: '?', result: { raw: stdout }, diagnostics: [], changed: [], next: [] };
  }
}
