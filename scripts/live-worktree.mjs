// design: live-test §3 — 在一个独立 worktree 里构建并跑 live 场景，主仓库继续开发不受影响；多个 worktree 可并行。
// 用法：node scripts/live-worktree.mjs [--ref <commit-ish>] [--keep] -- XF_LIVE_SCENARIO=quick [XF_LIVE_GOVERNANCE=FF ...]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const opts = sep === -1 ? args : args.slice(0, sep);
const envPairs = sep === -1 ? [] : args.slice(sep + 1);
const ref = opts.includes('--ref') ? opts[opts.indexOf('--ref') + 1] : 'HEAD';
const keep = opts.includes('--keep');
const sha = execFileSync('git', ['rev-parse', '--short', ref], { cwd: repoRoot, encoding: 'utf8' }).trim();
const env = Object.fromEntries(envPairs.map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const label = [env.XF_LIVE_SCENARIO ?? 'all', env.XF_LIVE_GOVERNANCE ?? 'TT', env.XF_LIVE_LANGUAGE ?? 'zh-CN', env.XF_LIVE_DRIVER ?? 'orchestrated', env.XF_LIVE_APPROVER ?? 'human'].join('-');
const wt = join(tmpdir(), 'xforge-wt', `${sha}-${label}-${Date.now().toString(36)}`);

mkdirSync(join(tmpdir(), 'xforge-wt'), { recursive: true });
execFileSync('git', ['worktree', 'add', '--detach', wt, sha], { cwd: repoRoot, stdio: 'inherit' });
try {
  // .env 不进 git：网关引擎需要它；claude 引擎不需要。
  if (existsSync(join(repoRoot, '.env'))) execFileSync('cp', [join(repoRoot, '.env'), join(wt, '.env')]);
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--silent'], { cwd: wt, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: wt, stdio: 'inherit' });
  const code = await new Promise((res) => {
    const child = spawn('npm', ['run', 'test:live'], { cwd: wt, stdio: 'inherit', env: { ...process.env, ...env, XF_LIVE_RESULTS_ROOT: join(repoRoot, 'test', '.tmp', 'live') } });
    child.on('close', res);
  });
  process.exitCode = code ?? 1;
} finally {
  if (!keep) {
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, stdio: 'ignore' });
    rmSync(wt, { recursive: true, force: true });
  }
}
