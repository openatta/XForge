// design: cli §5.4 — doctor：这个项目的装配现在还对不对。不写盘，changed 恒空，随时可调。
import type { Outcome } from '../cli/envelope.js';
import { readText } from '../fs/transaction.js';
import { cliVersion } from '../meta/index.js';
import type { GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, Manifest } from '../model/types.js';
import { BLOCK_BEGIN, BLOCK_END, detect, hookCommandFor, hookRunnable, knownProviderIds, providerFor } from '../providers/index.js';
import { footprintOf, ledgerUnreadable, projectedFiles, readLedger, rel } from './hosts.js';
import { backfillable, scaffoldIssues } from './scaffold.js';
import { upgradeInFlight } from './upgrade.js';

export interface ProviderReport {
  id: string;
  installed: boolean;
  version?: string;
  /** 有执法能力且钩子在位 available；有能力但钩子不在 unavailable；没有这个能力 not-supported。 */
  enforcement: 'available' | 'unavailable' | 'not-supported';
  isolation: boolean;
  projected: number;
  issues: string[];
}

export interface DoctorResult {
  checks: number;
  problems: number;
  scaffold: { version: string; cli: string };
  providers: ProviderReport[];
}

/** 一条发现：能自动修的（repair 认这个 code）与只能人处理的，都在这里产出。 */
export interface Finding extends EnvelopeDiagnostic {
  /** 这条发现指的对象：项目根相对路径，或 provider id。 */
  subject: string;
  /** 哪个 provider 的事；不归任何 provider 的（版本、哨兵）没有这一项。 */
  provider?: string;
}

export interface DoctorReport {
  findings: Finding[];
  result: DoctorResult;
}

export async function doctorReport(root: string, paths: GovernancePaths, manifest: Manifest, env: NodeJS.ProcessEnv, only: readonly string[] | undefined): Promise<DoctorReport> {
  const findings: Finding[] = [];
  let checks = 1;
  if (upgradeInFlight(paths)) {
    findings.push({ subject: 'xforge/.upgrade', code: 'XF-ASSEMBLE-001', severity: 'blocking', message: '一次脚手架升级在途：半升级的树没有「对不对」可言', remedy: { command: 'xforge update --status', text: '先完成或回滚' } });
    return { findings, result: { checks, problems: 1, scaffold: { version: manifest.scaffold.version, cli: cliVersion() }, providers: [] } };
  }

  checks += 1;
  if (manifest.scaffold.version !== cliVersion()) {
    findings.push({ subject: 'xforge/manifest.yaml', code: 'XF-ASSEMBLE-009', severity: 'warning', message: `脚手架 ${manifest.scaffold.version}，CLI ${cliVersion()}：项目跑在旧脚手架上`, remedy: { command: 'xforge update', text: '三段式升级' } });
  }

  // 骨架：受管文件与完整性清单对不对得上，以及清单语言对应的 Skill 源在不在（sync 少投影它是静默的）。
  checks += 1;
  for (const issue of await scaffoldIssues(paths, manifest)) {
    findings.push({
      subject: issue.subject,
      code: 'XF-ASSEMBLE-015',
      severity: 'blocking',
      message: issue.message,
      remedy: backfillable(issue) ? { command: 'xforge repair', text: '从本 CLI 自带的载荷补回来（校验和对得上才补）' } : { command: 'xforge update', text: '被改过的正文要合并，不是修复；缺 Skill 源就把它放回脚手架' },
    });
  }

  const declared = only ?? manifest.platforms;
  const known = declared.filter((id) => providerFor(id));
  for (const id of declared) {
    if (providerFor(id)) continue;
    findings.push({ subject: id, code: 'XF-ASSEMBLE-005', severity: 'blocking', message: `清单里的 ${id} 不是这个版本认得的 provider`, remedy: { text: `认得的是：${knownProviderIds().join('、')}；改清单或升级 CLI` } });
  }

  const { ledger, unreadable } = await readLedger(paths);
  if (unreadable) findings.push({ subject: 'xforge/hosts.yaml', ...ledgerUnreadable() });
  const reports: ProviderReport[] = [];
  for (const p of await projectedFiles(root, paths, manifest, known)) {
    const issues = new Set<string>();
    const expected = new Map(p.files.map((f) => [rel(root, f.path), f]));

    // 1 投影：该有的在不在、内容对不对。
    checks += 1;
    for (const [path, file] of expected) {
      const current = await readText(file.path);
      if (current === null) {
        issues.add('XF-ASSEMBLE-006');
        findings.push({ subject: path, provider: p.provider.id, code: 'XF-ASSEMBLE-006', severity: 'blocking', message: `${path} 该投而不在`, remedy: { command: 'xforge repair', text: '重投一次' } });
        continue;
      }
      if (file.shared) {
        const broken = markerBroken(current);
        if (broken) {
          issues.add('XF-ASSEMBLE-010');
          findings.push({ subject: path, provider: p.provider.id, code: 'XF-ASSEMBLE-010', severity: 'blocking', message: `${path} 的 XFORGE 标记块${broken}`, remedy: { text: '人把一对标记补回去，或整块删掉再 sync' } });
          continue;
        }
        const mine = blockOf(current);
        const want = blockOf(file.content);
        if (want === null) continue; // 这个共用文件不靠标记块认（如 settings.json），钩子那一项去查
        if (mine === null) {
          // 块被整块拿掉了。边界还是清楚的（与 010 不同），重投一次就对 —— 但绝不能判成健康：
          // 「doctor 说没问题、紧接着 sync 就改写这个文件」比报错更坏。
          issues.add('XF-ASSEMBLE-006');
          findings.push({ subject: path, provider: p.provider.id, code: 'XF-ASSEMBLE-006', severity: 'blocking', message: `${path} 里 ${p.provider.id} 的 XFORGE 块被整块拿掉了`, remedy: { command: 'xforge repair', text: '把那一块补回去；块外的内容不动' } });
          continue;
        }
        if (mine !== want) {
          issues.add('XF-ASSEMBLE-006');
          findings.push({ subject: path, provider: p.provider.id, code: 'XF-ASSEMBLE-006', severity: 'blocking', message: `${path} 的 XFORGE 块被改过，与脚手架不符`, remedy: { command: 'xforge repair', text: '重投那一块；块外的内容不动' } });
        }
        continue;
      }
      if (current !== file.content) {
        issues.add('XF-ASSEMBLE-006');
        findings.push({ subject: path, provider: p.provider.id, code: 'XF-ASSEMBLE-006', severity: 'blocking', message: `${path} 是生成物，但内容与脚手架不符（被手改过）`, remedy: { command: 'xforge repair', text: '要保留的改动写进 xforge/scaffold/ 的本地化区，再重投' } });
      }
    }

    // 2 孤儿：我投过、这一版不该再有的（台账说了算；台账没得可说时按已知布局兜底）。
    checks += 1;
    for (const record of await footprintOf(root, ledger, p.provider)) {
      if (expected.has(record.path)) continue;
      issues.add('XF-ASSEMBLE-007');
      findings.push({ subject: record.path, provider: p.provider.id, code: 'XF-ASSEMBLE-007', severity: 'warning', message: `${record.path} 是 ${p.provider.id} 留下的孤儿`, remedy: { command: 'xforge repair', text: record.kind === 'owned' ? '删掉它' : '摘掉里面 XFORGE 的那块' } });
    }

    // 3 执法钩子：该有的在不在、装没装得进去、跑不跑得起来。三件事缺一不可（D8）。
    checks += 1;
    const hookCommand = await hookCommandFor(paths, p.provider);
    let enforcement: ProviderReport['enforcement'] = 'not-supported';
    if (p.provider.capabilities.enforcement) {
      const installed = await p.provider.hookInstalled(root, hookCommand);
      const runnable = hookRunnable(hookCommand, env);
      enforcement = installed && runnable ? 'available' : 'unavailable';
      if (p.hookBlocked) {
        // 装不进去的原因比「不在」更具体：那份文件不是我们的，修它是人的事。
        issues.add('XF-ASSEMBLE-013');
        findings.push({ subject: p.hookBlocked, provider: p.provider.id, code: 'XF-ASSEMBLE-013', severity: 'blocking', message: `${p.hookBlocked} 解析不成 JSON 对象：控制面不动别人写的文件，${p.provider.id} 的执法钩子装不进去`, remedy: { text: '人把它改回合法的 JSON 对象，再 xforge sync' } });
      } else if (!installed) {
        issues.add('XF-ASSEMBLE-008');
        findings.push({
          subject: p.provider.id,
          provider: p.provider.id,
          code: 'XF-ASSEMBLE-008',
          severity: 'blocking',
          message: p.hookMissing ? `${p.provider.id} 能执法，但脚手架里没有钩子声明可投` : `${p.provider.id} 的执法钩子不在宿主原生位置里：写入范围此刻没有人拦`,
          remedy: p.hookMissing ? { text: '把 scaffold/hooks/enforce.yaml 放回去，再 xforge repair' } : { command: 'xforge repair', text: '补回钩子' },
        });
      } else if (!runnable) {
        // 装上了 ≠ 跑得起来：宿主起不了这个进程，就拿不到决策然后继续执行。
        issues.add('XF-ASSEMBLE-014');
        findings.push({ subject: p.provider.id, provider: p.provider.id, code: 'XF-ASSEMBLE-014', severity: 'blocking', message: `${p.provider.id} 的钩子装上了，但 ${hookCommand?.trim().split(/\s+/)[0]} 在本机 PATH 上解析不到：宿主起不了它，写入范围此刻没有人拦`, remedy: { text: '把 CLI 装到宿主进程也看得见的 PATH 上（npm i -g @xforge/cli），或把钩子声明里的命令改成绝对路径' } });
      }
    }

    const found = detect(p.provider, env);
    const report: ProviderReport = { id: p.provider.id, installed: found.installed, enforcement, isolation: p.provider.capabilities.isolation, projected: p.files.length, issues: [...issues].sort() };
    if (found.version !== undefined) report.version = found.version;
    reports.push(report);
    findings.push({
      subject: p.provider.id,
      provider: p.provider.id,
      code: 'XF-ASSEMBLE-012',
      severity: 'info',
      message: `${p.provider.displayName}：本机${found.installed ? `已装${found.version ? ` ${found.version}` : ''}` : '未探测到'}，执法 ${enforcement}，隔离 ${p.provider.capabilities.isolation ? '有' : '无'}，投影 ${p.files.length} 个文件`,
      remedy: { text: found.installed ? '这条只是事实' : '装它，或从清单 platforms 里去掉；投影本身不需要它在场' },
    });
  }

  const problems = findings.filter((f) => f.severity !== 'info').length;
  return { findings, result: { checks, problems, scaffold: { version: manifest.scaffold.version, cli: cliVersion() }, providers: reports } };
}

export async function runDoctor(root: string, paths: GovernancePaths, manifest: Manifest, env: NodeJS.ProcessEnv, only: readonly string[] | undefined): Promise<Outcome<DoctorResult>> {
  const { findings, result } = await doctorReport(root, paths, manifest, env, only);
  const diagnostics: EnvelopeDiagnostic[] = findings.map(({ subject: _subject, provider: _provider, ...d }) => d);
  const fixable = findings.some((f) => f.severity !== 'info' && REPAIRABLE.has(f.code));
  const outcome: Outcome<DoctorResult> = { result, changed: [], diagnostics, next: fixable ? [{ command: 'xforge repair', why: '能自动修的都修掉' }] : [] };
  return outcome;
}

/** repair 认得的发现：其余的只能人处理。 */
export const REPAIRABLE = new Set(['XF-ASSEMBLE-006', 'XF-ASSEMBLE-007', 'XF-ASSEMBLE-008']);

/** 骨架发现单独一条路：它不归任何 provider，修法是从载荷补回而不是重投。 */
export const SCAFFOLD_CODE = 'XF-ASSEMBLE-015';

function markerBroken(text: string): string | null {
  const b = text.indexOf(BLOCK_BEGIN);
  const e = text.indexOf(BLOCK_END);
  if (b === -1 && e === -1) return null;
  if (b === -1) return '只有结束标记';
  if (e === -1) return '只有开始标记';
  if (e < b) return '标记顺序反了';
  return null;
}

function blockOf(text: string): string | null {
  const b = text.indexOf(BLOCK_BEGIN);
  const e = text.indexOf(BLOCK_END);
  if (b === -1 || e === -1 || e < b) return null;
  return text.slice(b + BLOCK_BEGIN.length, e);
}
