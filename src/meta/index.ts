// design: cli §6 — 元信息：不需要项目就能回答。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Outcome } from '../cli/envelope.js';
import { CliError } from '../cli/errors.js';
import { loadDiagnostic } from '../model/diagnostics.js';
import { findProjectRoot, governancePaths } from '../model/paths.js';
import { readYaml } from '../model/yaml.js';
import type { Manifest } from '../model/types.js';

export const HELP = `xforge <命令> [选项]

读    state [--orient] [--change <id>] [--field <path>]     我在哪、欠什么、什么挡着
      show <ref>                                           点名取材料：stage:<id> doc:<path>[#h] spec:<id> interface:<id> constitution:<t> gate:<n>[/run] ledger:<ref>|delivery/<pkg> receipts index:<domain>
验    inspect [--all] [--hygiene]                           这份记录合法吗（不写盘，不跑命令）
产    run [--gate <n>,...] [--package <id>] [--force]       跑门，把结果刻下来
证    attest approve (--stage <id>|--archive) --decision approved|rejected [--note <t>]
      attest approve (--stage <id>|--archive) --via <mcp-id>     让清单里配置的 MCP 审批者来批（决定由它给）
      attest entry <ledger-kind> <entry-id>                 登记一条需人署名的台账条目（finding <id> 是 review-findings 的别名）
      attest receipt                                        签署验证收据
      attest verification --command <name>=<cmd>            声明这个项目用什么命令验证自己
进    advance [--no-run] [--workdir <path>]                 出站（默认先跑本站的门）
      advance --rework-to <stage> --reason <t>              返工
      advance package <id> --dispatch [--workdir <path>]    派工
      advance package <id> --deliver                        交付登记（验证门当前且通过就直接集成）
      advance --archive                                     归档
装配  init [--flow <n>] [--platform claude|codex]... [--language zh-CN|en]
      sync [--platform <n>]...
      update                                               暂存：快照、铺开新版、逐文件分类；项目改过的留在 xforge/.upgrade/incoming/
      update --status | --finish | --rollback              在途状态 / 完成（推进版本、写审计、重投宿主）/ 从快照恢复
      doctor [--platform <n>]...                           装配还对不对：投影、钩子、孤儿、版本；不写盘
      repair [--only <code>]... [--dry-run]                 把 doctor 报的、能自动修的修掉：重投出问题的宿主
      remove --confirm <项目目录名>                          拆除：删 xforge/ 与全部宿主投影，不可逆
元    help · version · explain <code>

通用  --text 只改呈现；退出码 0 成功 / 1 不能 / 2 用法 / 3 损坏或治理不可读
`;

export function cliVersion(): string {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };
  return pkg.version;
}

export async function runVersion(cwd: string): Promise<Outcome<{ cli: string; scaffold?: string }>> {
  const result: { cli: string; scaffold?: string } = { cli: cliVersion() };
  const root = await findProjectRoot(cwd);
  if (root) {
    try {
      result.scaffold = (await readYaml<Manifest>(governancePaths(root).manifest, 'manifest')).scaffold.version;
    } catch {
      // 清单坏了不是 version 的事。
    }
  }
  return { result };
}

export async function runExplain(code: string): Promise<Outcome<unknown>> {
  const d = await loadDiagnostic(code);
  if (!d) throw new CliError('XF-STATE-005', `没有诊断码 ${code}`, 1, { command: 'xforge help', text: '码形如 XF-<AREA>-<NNN>' });
  return { result: d };
}
