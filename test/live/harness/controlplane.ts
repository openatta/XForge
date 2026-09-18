// design: live-test §2.5 D15 — 装配体检段：模型进场前，拿工作目录里那份**装好的包**在真实的树上过一遍装配动词。
// LT-09 非交互 init 的默认值与探测无关；LT-13 双宿主各投影一套；LT-10 doctor 只读、六项全 ok；
// LT-11 手改投影 → doctor 报 → repair 修好；LT-12 update 的分类、在途、旧名与回滚。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import type { XfResult } from './xforge.js';
import { xforge } from './xforge.js';
import type { RunPaths } from './setup.js';

export interface ControlPlaneReport {
  /** LT-09：不给 flag 的 init 写进清单的那两个值 —— 本机环境一份，一个宿主都探测不到的环境里又一份。 */
  defaults: { exit: number; platforms: string[]; language: string; blind: { exit: number; platforms: string[]; language: string }; ok: boolean };
  /** LT-13：两个宿主各自的原生位置。 */
  providers: { claude_hook: boolean; codex_hook: boolean; codex_skills: boolean; agents_entry: boolean; doctor_exit: number; ok: boolean };
  /** LT-10：刚装配完的树。 */
  doctor: { exit: number; results: Record<string, string>; read_only: boolean; ok: boolean };
  /** LT-11：改一个投影文件，看 doctor 说什么、repair 修不修得回来。 */
  repair: { drift_exit: number; drift_codes: string[]; exit: number; repaired: string[]; sync_changed: number; restored: boolean; ok: boolean };
  /** LT-12：新版载荷、在途、旧名、回滚。 */
  update: { exit: number; applied: string[]; added: string[]; laid_down: boolean; in_flight_codes: string[]; alias_codes: string[]; rollback_exit: number; restored: boolean; ok: boolean };
  /** 体检段跑完，项目那棵树是否逐字节回到体检前（体检段只碰项目自己的树与 drill/ 临时目录）。 */
  tree_restored: boolean;
  ok: boolean;
}

const codesOf = (r: XfResult): string[] => (r.env.diagnostics ?? []).map((d) => d.code);
const resultsOf = (r: XfResult): Array<{ id: string; status: string; detail?: string }> => ((r.env.result as { results?: Array<{ id: string; status: string; detail?: string }> }).results ?? []);
const changedOf = (r: XfResult): string[] => r.env.changed ?? [];

/** 工作树的摘要：相对路径 + 内容哈希，按路径排序。`.git/` 不在里面（git 自己会写索引，那不是这次运行改的东西）。 */
export function treeDigest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (dir === root && entry === '.git') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(`${relative(root, path)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(root);
  return createHash('sha256').update(files.join('\n')).digest('hex');
}

export interface ControlPlaneOptions {
  /** 装好的包里的 `scaffold/`：`update --payload` 拿它复制一份当「新版」。 */
  payload: string;
}

export async function runControlPlane(paths: RunPaths, opts: ControlPlaneOptions): Promise<ControlPlaneReport> {
  // 与模型同一个环境：`xforge-enforce` 在 PATH 上（doctor 的能力检查要解析钩子命令的第一个词）。
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${paths.shim}:${process.env['PATH'] ?? ''}` };
  delete env['XFORGE_ROOT']; // 体检的是这棵树，不是环境变量里指的那棵
  const drill = join(paths.workDir, 'drill');
  const treeBefore = treeDigest(paths.project);

  const defaults = await defaultsDrill(join(drill, 'defaults'), env);
  const providers = await providersDrill(join(drill, 'providers'), env);
  const doctorAndRepair = await doctorDrill(paths.project, treeBefore, env);
  const update = await updateDrill(paths.project, join(drill, 'payload'), opts.payload, env);

  const treeRestored = treeDigest(paths.project) === treeBefore;
  const report: ControlPlaneReport = { defaults, providers, doctor: doctorAndRepair.doctor, repair: doctorAndRepair.repair, update, tree_restored: treeRestored, ok: defaults.ok && providers.ok && doctorAndRepair.ok && update.ok && treeRestored };
  writeFileSync(join(paths.runDir, 'control-plane.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

/**
 * LT-09：`init --flow quick` 不给宿主与语言时，写进清单的是哪两个值。
 * 只在本机环境跑一遍是判不出事的 —— 本机的探测结果恰好也是 claude；所以再摆一个**什么都探测不到**的环境
 * （空 `HOME`、`PATH` 上只有 `node`、会话变量一个不留）：两份清单必须相同，探测才是线索不是判决。
 */
async function defaultsDrill(dir: string, env: NodeJS.ProcessEnv): Promise<ControlPlaneReport['defaults']> {
  const fresh = (sub: string): string => {
    const project = join(dir, sub);
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    return project;
  };
  const machine = fresh('machine');
  const machineInit = await xforge(machine, ['init', '--flow', 'quick'], env);
  const onMachine = manifestOf(machine);
  const blind = fresh('blind');
  const blindInit = await xforge(blind, ['init', '--flow', 'quick'], blindEnv(dir));
  const inBlind = manifestOf(blind);
  const same = onMachine.platforms.join(',') === inBlind.platforms.join(',') && onMachine.language === inBlind.language;
  return {
    exit: machineInit.exit,
    ...onMachine,
    blind: { exit: blindInit.exit, ...inBlind },
    ok: machineInit.exit === 0 && blindInit.exit === 0 && onMachine.platforms.join(',') === 'claude' && onMachine.language === 'zh-CN' && same,
  };
}

function manifestOf(project: string): { platforms: string[]; language: string } {
  const manifest = parse(readFileSync(join(project, 'xforge', 'manifest.yaml'), 'utf8')) as { platforms?: string[]; language?: string };
  return { platforms: manifest.platforms ?? [], language: manifest.language ?? '' };
}

/** 「一个宿主都探测不到」的环境：空 HOME、PATH 上只有 node、会话变量一个不留。 */
function blindEnv(dir: string): NodeJS.ProcessEnv {
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const node = join(bin, 'node');
  if (!existsSync(node)) symlinkSync(process.execPath, node);
  return { PATH: bin, HOME: home };
}

/** LT-13：两个宿主各投影一套；同一张检查表在这棵树上跑一遍（宿主在场取决于本机，见 LT-13）。 */
async function providersDrill(dir: string, env: NodeJS.ProcessEnv): Promise<ControlPlaneReport['providers']> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const init = await xforge(dir, ['init', '--flow', 'quick', '--platform', 'claude', '--platform', 'codex', '--language', 'zh-CN'], env);
  const settings = existsSync(join(dir, '.claude', 'settings.json')) ? readFileSync(join(dir, '.claude', 'settings.json'), 'utf8') : '';
  const hooks = existsSync(join(dir, '.codex', 'hooks.json')) ? readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8') : '';
  const agents = existsSync(join(dir, 'AGENTS.md')) ? readFileSync(join(dir, 'AGENTS.md'), 'utf8') : '';
  const doctor = await xforge(dir, ['doctor'], env);
  const found = resultsOf(doctor);
  // 「宿主在场」是本机的事实（LT-13）：其余五项必须全 ok，报错了说明的是投影，不是机器。
  const rest = found.filter((r) => r.id !== 'host');
  const host = found.find((r) => r.id === 'host');
  const hostFine = host === undefined || host.status === 'ok' || codesOf(doctor).includes('XF-DOCTOR-001');
  const ok = init.exit === 0 && settings.includes('xforge-enforce --host claude') && hooks.includes('xforge-enforce --host codex') && agents.includes('<!-- XFORGE:BEGIN -->') && rest.length > 0 && rest.every((r) => r.status === 'ok') && hostFine;
  return {
    claude_hook: settings.includes('xforge-enforce --host claude'),
    codex_hook: hooks.includes('xforge-enforce --host codex'),
    codex_skills: existsSync(join(dir, '.codex', 'skills', 'xforge', 'SKILL.md')),
    agents_entry: agents.includes('<!-- XFORGE:BEGIN -->') && agents.includes('.codex/skills/xforge/SKILL.md'),
    doctor_exit: doctor.exit,
    ok,
  };
}

/** LT-10 + LT-11：刚装配完的树体检干净且只读；改一个投影文件，doctor 报、repair 修回逐字节原样。 */
async function doctorDrill(project: string, treeBefore: string, env: NodeJS.ProcessEnv): Promise<{ doctor: ControlPlaneReport['doctor']; repair: ControlPlaneReport['repair']; ok: boolean }> {
  const before = await xforge(project, ['doctor'], env);
  const results = Object.fromEntries(resultsOf(before).map((r) => [r.id, r.status]));
  const readOnly = treeDigest(project) === treeBefore;
  const doctor = { exit: before.exit, results, read_only: readOnly, ok: before.exit === 0 && Object.values(results).every((s) => s === 'ok') };

  // 手改一个投影文件：下一次 sync 会覆盖它 —— 这正是 repair 只该修的那一类。
  const projected = join(project, '.claude', 'skills', 'xforge', 'SKILL.md');
  appendFileSync(projected, '\n<!-- live drill -->\n');
  const drift = await xforge(project, ['doctor'], env);
  const repair = await xforge(project, ['repair'], env);
  const repaired = ((repair.env.result as { repaired?: string[] }).repaired ?? []);
  // repair 说修好了，得由盘上作证：紧接着的 sync 一个字节都不该再写。
  const sync = await xforge(project, ['sync'], env);
  const restored = treeDigest(project) === treeBefore;
  const repairReport = { drift_exit: drift.exit, drift_codes: codesOf(drift), exit: repair.exit, repaired, sync_changed: changedOf(sync).length, restored, ok: drift.exit === 1 && codesOf(drift).includes('XF-DOCTOR-002') && repair.exit === 0 && repaired.includes('projection') && changedOf(sync).length === 0 && restored };
  return { doctor, repair: repairReport, ok: doctor.ok && repairReport.ok };
}

/** LT-12：复制装好的载荷当新版（改一个受管文件、加一个新文件），暂存 → 在途 → 旧名 → 回滚。 */
async function updateDrill(project: string, payload: string, installedScaffold: string, env: NodeJS.ProcessEnv): Promise<ControlPlaneReport['update']> {
  const before = treeDigest(project);
  rmSync(payload, { recursive: true, force: true });
  cpSync(installedScaffold, payload, { recursive: true });
  appendFileSync(join(payload, 'gates', 'ledgers.yaml'), '\n# live drill\n');
  writeFileSync(join(payload, 'gates', 'live-drill.yaml'), '# live drill\n');
  const staged = await xforge(project, ['update', '--payload', payload, '--to', '9.9.9'], env);
  const result = staged.env.result as { applied?: string[]; added?: string[] };
  // `applied` 里列的是分类为 unchanged 的全部文件（不是「写过的」），所以拿盘上作证：新版正文真铺下来了。
  const stagedFile = join(project, 'xforge', 'scaffold', 'gates', 'ledgers.yaml');
  const laidDown = existsSync(stagedFile) && readFileSync(stagedFile, 'utf8').includes('# live drill');
  // 升级在途：doctor 只读，照跑（哨兵名单里有它）；旧名 upgrade 照跑但信封末尾带 deprecation。
  const inFlight = await xforge(project, ['doctor'], env);
  const alias = await xforge(project, ['upgrade', '--status'], env);
  const rollback = await xforge(project, ['update', '--rollback'], env);
  const restored = treeDigest(project) === before;
  const applied = result.applied ?? [];
  const added = result.added ?? [];
  return {
    exit: staged.exit,
    applied,
    added,
    laid_down: laidDown,
    in_flight_codes: codesOf(inFlight),
    alias_codes: codesOf(alias),
    rollback_exit: rollback.exit,
    restored,
    ok: staged.exit === 0 && applied.includes('gates/ledgers.yaml') && added.includes('gates/live-drill.yaml') && laidDown && codesOf(inFlight).includes('XF-DOCTOR-005') && codesOf(alias).includes('XF-ASSEMBLE-005') && rollback.exit === 0 && restored,
  };
}
