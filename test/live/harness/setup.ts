// design: live-test §1 §3 — 铺种子、初始化治理、落基线、投影宿主、提交；每次运行一个独立目录。
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { xforge } from './xforge.js';

export interface RunPaths {
  /** 结果目录，在仓库的 test/.tmp 下（summary、转录、快照）。 */
  runDir: string;
  /** 工作目录，在系统临时目录下：模型不能顺着路径摸到本仓库的源码与设计。 */
  workDir: string;
  project: string;
  claudeConfig: string;
  transcripts: string;
  shim: string;
}

export const HARNESS_IDENTITY = { name: 'Live Harness', email: 'harness@example.com' };

export function runPaths(repoRoot: string, engine: string, scenario: string): RunPaths {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 结果目录可以指到主仓库：从 worktree 里并行跑时，summary 仍集中在一处。
  const resultsRoot = process.env['XF_LIVE_RESULTS_ROOT'] ?? join(repoRoot, 'test', '.tmp', 'live');
  const runDir = join(resultsRoot, engine, scenario, stamp);
  const workDir = join(tmpdir(), 'xforge-live', `${engine}-${scenario}-${stamp}`);
  return { runDir, workDir, project: join(workDir, 'project'), claudeConfig: join(workDir, 'claude-config'), transcripts: join(runDir, 'transcripts'), shim: join(workDir, 'bin') };
}

export interface SetupOptions {
  repoRoot: string;
  scenarioDir: string;
  flow: 'quick' | 'solid' | 'major';
  language: 'zh-CN' | 'en';
  request: string;
  engine: 'claude' | 'gateway';
  /** pack：把本仓库打包装进工作目录（live 运行）；repo：shim 直接指向本仓库的 bin（合并门里的冒烟，不碰 npm）。 */
  cli?: 'pack' | 'repo';
  /** 治理组合：规格 / 接口两条开关。缺省 TT。 */
  governance?: Governance;
  /** 审批由谁给：human = harness 扮演的人；mcp = 清单里配一个假 MCP 审批者（D14），人不批。 */
  approver?: 'human' | 'mcp';
  /** mcp 模式下假 MCP 把收到的请求记到这里。 */
  mcpLog?: string;
}

export type Governance = 'TT' | 'TF' | 'FT' | 'FF';
export function governanceFlags(g: Governance): { spec: boolean; interface: boolean } {
  return { spec: g[0] === 'T', interface: g[1] === 'T' };
}

export async function setupProject(paths: RunPaths, opts: SetupOptions): Promise<void> {
  mkdirSync(paths.project, { recursive: true });
  mkdirSync(paths.claudeConfig, { recursive: true });
  mkdirSync(paths.transcripts, { recursive: true });
  mkdirSync(paths.shim, { recursive: true });
  // 把本仓库打成 tarball 装进工作目录：模型看到的是一份安装好的包，不是这个仓库的路径。
  let installedBin = join(opts.repoRoot, 'bin');
  if ((opts.cli ?? 'pack') === 'pack') {
    const pkgDir = join(paths.workDir, 'pkg');
    mkdirSync(pkgDir, { recursive: true });
    const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', pkgDir], { cwd: opts.repoRoot, encoding: 'utf8' }).trim().split('\n').at(-1)!;
    execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline', '--prefix', pkgDir, join(pkgDir, packed)], { stdio: 'ignore' });
    installedBin = join(pkgDir, 'node_modules', '@xforge', 'cli', 'bin');
  }
  for (const name of ['xforge', 'xforge-enforce']) {
    const shim = join(paths.shim, name);
    writeFileSync(shim, `#!/bin/sh\nexec node "${join(installedBin, `${name}.js`)}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  cpSync(join(opts.scenarioDir, 'seed'), paths.project, { recursive: true, filter: (src) => !src.includes('xforge-seed') });
  writeFileSync(join(paths.project, 'TEST_REQUEST.md'), opts.request);
  writeFileSync(join(paths.project, '.gitignore'), 'invoicely.json\n__pycache__/\n*.pyc\n');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: paths.project, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', HARNESS_IDENTITY.name);
  git('config', 'user.email', HARNESS_IDENTITY.email);
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');

  await xforge(paths.project, ['init', '--flow', opts.flow, '--platform', 'claude', '--language', opts.language]);
  // 人打开两条基线的治理，声明模块；落种子基线与章程。
  const manifestPath = join(paths.project, 'xforge', 'manifest.yaml');
  const manifest = parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['governance'] = governanceFlags(opts.governance ?? 'TT');
  manifest['modules'] = [{ id: 'core', paths: ['invoicely/**', 'tests/**'] }];
  if (opts.approver === 'mcp') {
    manifest['mcp_approvers'] = [{ id: 'reviewer', server: { command: process.execPath, args: [join(opts.repoRoot, 'test', 'helpers', 'fake-mcp.mjs')], env: { FAKE_MCP_LOG: opts.mcpLog ?? '' } }, timeout_seconds: 60 }];
  }
  writeFileSync(manifestPath, stringify(manifest));
  const seedGov = join(opts.scenarioDir, 'seed', 'xforge-seed');
  cpSync(join(seedGov, 'constitution.md'), join(paths.project, 'xforge', 'constitution.md'));
  cpSync(join(seedGov, 'specs'), join(paths.project, 'xforge', 'specs'), { recursive: true });
  cpSync(join(seedGov, 'interfaces'), join(paths.project, 'xforge', 'interfaces'), { recursive: true });
  await xforge(paths.project, ['sync']);
  // 项目级设置：非交互跑，禁掉与治理无关的任务工具，避免模型把工作记在别处。
  const settingsPath = join(paths.project, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  settings['permissions'] = { deny: ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'] };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const declared = await xforge(paths.project, ['attest', 'verification', '--command', 'unit-tests=python3 -m unittest discover -s tests']);
  if (declared.exit !== 0) throw new Error(`声明验证命令失败：${JSON.stringify(declared.env)}`);
  git('add', '-A');
  git('commit', '-q', '-m', 'governance');

  // 引擎 claude：本机凭据拷进隔离的配置目录；gateway 不需要。
  if (opts.engine === 'claude') {
    const cred = join(homedir(), '.claude', '.credentials.json');
    if (existsSync(cred)) cpSync(cred, join(paths.claudeConfig, '.credentials.json'));
  }
}
