// design: rule-files §5.3 — RF-26：身份只从 git 读，命令行没有参数能覆盖它。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuditActor } from '../model/types.js';

const run = promisify(execFile);

export async function gitIdentity(cwd: string): Promise<AuditActor | null> {
  try {
    const name = (await run('git', ['config', 'user.name'], { cwd })).stdout.trim();
    const email = (await run('git', ['config', 'user.email'], { cwd })).stdout.trim();
    if (!name || !email) return null;
    return { name, email };
  } catch {
    return null;
  }
}

/** 项目的 git 远程地址（origin）；没有远程就是 null。给 MCP 审批请求说明「来自哪里」。 */
export async function gitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const out = (await run('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

export async function gitHead(cwd: string): Promise<string | null> {
  try {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** 相对某个提交改动过的路径（含未提交的工作树改动），相对仓库根。 */
export async function gitChangedPaths(cwd: string, since: string): Promise<string[]> {
  const out = new Set<string>();
  try {
    const diff = (await run('git', ['diff', '--name-only', since], { cwd })).stdout;
    for (const line of diff.split('\n')) if (line.trim()) out.add(line.trim());
    const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], { cwd })).stdout;
    for (const line of untracked.split('\n')) if (line.trim()) out.add(line.trim());
  } catch {
    // 不是 git 仓库：没有可比对的基线，视为没有改动。
  }
  return [...out].sort();
}

/** 某段路径上的提交作者集合，用于 separation_of_duties。 */
export async function gitAuthorsSince(cwd: string, since: string, paths: readonly string[]): Promise<string[]> {
  try {
    const args = ['log', '--format=%an <%ae>', `${since}..HEAD`, '--', ...paths];
    const out = (await run('git', args, { cwd })).stdout;
    return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}
