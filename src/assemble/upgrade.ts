// design: cli §5.3 — 升级是三段式：暂存（快照 + 铺开 + 逐文件分类）→ 人合并 → 完成或回滚；在途时磁盘上有哨兵。
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import type { Outcome } from '../cli/envelope.js';
import { CliError } from '../cli/errors.js';
import { appendEvent, readChain } from '../audit/chain.js';
import { gitIdentity } from '../audit/identity.js';
import { readText, Transaction } from '../fs/transaction.js';
import { pruneEmptyDirs } from './hosts.js';
import { computeIntegrity, classifyFile, INTEGRITY_FILE, type FileClass } from '../model/integrity.js';
import { transplantLocalZone } from '../model/markdown.js';
import type { GovernancePaths } from '../model/paths.js';
import type { Integrity, Manifest } from '../model/types.js';
import { readYaml, toYaml } from '../model/yaml.js';

export interface UpgradeStatus {
  from: string;
  to: string;
  started_at: string;
  classified: Record<string, FileClass | 'orphan'>;
  /** 项目改过正文、留在 incoming/ 等人合并的文件。 */
  pending: string[];
}

export interface UpgradeContext {
  root: string;
  paths: GovernancePaths;
  manifest: Manifest;
  env: NodeJS.ProcessEnv;
  now: () => string;
  /** 新版载荷目录（缺省是本 CLI 包里的 scaffold/）。 */
  payloadDir: string;
  targetVersion: string;
}

const statusPath = (paths: GovernancePaths): string => join(paths.upgradeDir, 'status.yaml');
const snapshotDir = (paths: GovernancePaths): string => join(paths.upgradeDir, 'snapshot');
const incomingDir = (paths: GovernancePaths): string => join(paths.upgradeDir, 'incoming');

export function upgradeInFlight(paths: GovernancePaths): boolean {
  return existsSync(statusPath(paths));
}

/** 暂存：快照当前受管树，铺开新版，逐文件分类；能自动合的当场合，其余留给人。 */
export async function upgradeStage(ctx: UpgradeContext): Promise<Outcome<UpgradeStatus & { applied: string[]; transplanted: string[]; added: string[] }>> {
  if (upgradeInFlight(ctx.paths)) throw new CliError('XF-ASSEMBLE-001', '已有一次升级在途', 1, { command: 'xforge update --status', text: '先 --finish 或 --rollback' });
  const from = ctx.manifest.scaffold.version;
  if (from === ctx.targetVersion) throw new CliError('XF-ASSEMBLE-002', `脚手架已经是 ${from}，没有可升级的版本`, 1, { text: '装新版 CLI 后再跑' });
  const recorded: Integrity = existsSync(ctx.paths.integrity) ? await readYaml<Integrity>(ctx.paths.integrity, 'integrity') : { scaffold_version: from, files: {} };

  mkdirSync(ctx.paths.upgradeDir, { recursive: true });
  cpSync(ctx.paths.scaffold, snapshotDir(ctx.paths), { recursive: true });
  cpSync(ctx.payloadDir, incomingDir(ctx.paths), { recursive: true });

  const incomingFiles = (await fg('**/*', { cwd: incomingDir(ctx.paths), onlyFiles: true, dot: false })).filter((f) => f !== INTEGRITY_FILE).sort();
  const currentFiles = (await fg('**/*', { cwd: ctx.paths.scaffold, onlyFiles: true, dot: false })).filter((f) => f !== INTEGRITY_FILE).sort();
  const classified: Record<string, FileClass | 'orphan'> = {};
  const applied: string[] = [];
  const transplanted: string[] = [];
  const added: string[] = [];
  const pending: string[] = [];
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  for (const rel of incomingFiles) {
    const incoming = readFileSync(join(incomingDir(ctx.paths), rel), 'utf8');
    const current = await readText(join(ctx.paths.scaffold, rel));
    const cls = classifyFile(recorded.files[rel], current ?? undefined);
    classified[rel] = cls;
    const target = join(ctx.paths.scaffold, rel);
    switch (cls) {
      case 'unchanged':
        if (incoming !== current) tx.write(target, incoming);
        applied.push(rel);
        break;
      case 'local-zone-only':
        tx.write(target, transplantLocalZone(incoming, current!));
        transplanted.push(rel);
        break;
      case 'new':
        tx.write(target, incoming);
        added.push(rel);
        break;
      case 'modified':
      case 'missing':
        pending.push(rel); // 留在 incoming/，项目自己决定
        break;
    }
  }
  for (const rel of currentFiles) if (!(rel in classified)) classified[rel] = 'orphan'; // 新版没有了，留着，由人决定
  const status: UpgradeStatus = { from, to: ctx.targetVersion, started_at: ctx.now(), classified, pending };
  tx.write(statusPath(ctx.paths), toYaml(status));
  const changed = await tx.commit();
  return {
    result: { ...status, applied, transplanted, added },
    changed,
    next: pending.length
      ? [{ command: 'xforge update --status', why: `${pending.length} 个文件项目改过正文，在 xforge/.upgrade/incoming/ 里等人合并` }, { command: 'xforge update --finish', why: '合并完成后' }, { command: 'xforge update --rollback', why: '放弃这次升级' }]
      : [{ command: 'xforge update --finish', why: '没有需要人合并的文件' }],
  };
}

export async function upgradeStatusReport(ctx: UpgradeContext): Promise<Outcome<UpgradeStatus | { in_flight: false }>> {
  if (!upgradeInFlight(ctx.paths)) return { result: { in_flight: false }, next: [{ command: 'xforge update', why: '没有在途的升级' }] };
  const status = await readYaml<UpgradeStatus>(statusPath(ctx.paths), 'upgrade-status');
  return { result: status, next: [{ command: 'xforge update --finish', why: '合并完成后' }, { command: 'xforge update --rollback', why: '放弃' }] };
}

/** 完成：推进版本锚点，重算完整性清单，写审计事件（记下人实际保留了什么），删哨兵。 */
export async function upgradeFinish(ctx: UpgradeContext): Promise<Outcome<{ from: string; to: string; kept: string[]; event: string }>> {
  if (!upgradeInFlight(ctx.paths)) throw new CliError('XF-ASSEMBLE-003', '没有在途的升级', 1, { command: 'xforge update', text: '先暂存' });
  const status = await readYaml<UpgradeStatus>(statusPath(ctx.paths), 'upgrade-status');
  const actor = (await gitIdentity(ctx.root)) ?? { name: 'xforge', email: 'xforge@local' };
  // kept：留给人的文件里，最终没有采用新版正文的那些（项目里的内容仍与新版不同）。
  const kept: string[] = [];
  for (const rel of status.pending) {
    const incoming = await readText(join(incomingDir(ctx.paths), rel));
    const current = await readText(join(ctx.paths.scaffold, rel));
    if (incoming !== null && current !== incoming) kept.push(rel);
  }
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const manifest: Manifest = { ...ctx.manifest, scaffold: { version: status.to } };
  tx.write(ctx.paths.manifest, toYaml(manifest));
  const integrity = await computeIntegrity(ctx.paths.scaffold, status.to);
  tx.write(ctx.paths.integrity, toYaml(integrity));
  const chain = await readChain(ctx.paths);
  const event = await appendEvent(tx, ctx.paths, chain, { kind: 'scaffold.upgraded', subject: { from: status.from, to: status.to, kept, pending: status.pending }, actor }, ctx.env, ctx.now());
  tx.removeDir(ctx.paths.upgradeDir);
  const changed = await tx.commit();
  return { result: { from: status.from, to: status.to, kept, event: event.hash }, changed, next: [{ command: 'xforge sync', why: '把新脚手架投影到宿主' }] };
}

/**
 * 回滚：从快照整树恢复，删哨兵。
 *
 * **走受治理写入**（§1.2）。先 `rm -rf scaffold` 再 `cp` 的话，中途死一次脚手架就没了 ——
 * 一个以「可回退」为全部卖点的命令，它自己的回退不可回退。这里逐文件写 + 逐文件删，
 * 全在一个事务里，失败整体回滚。
 */
export async function upgradeRollback(ctx: UpgradeContext): Promise<Outcome<{ restored: number }>> {
  if (!upgradeInFlight(ctx.paths)) throw new CliError('XF-ASSEMBLE-003', '没有在途的升级', 1, { command: 'xforge update', text: '先暂存' });
  const snapshot = snapshotDir(ctx.paths);
  const files = await fg('**/*', { cwd: snapshot, onlyFiles: true, dot: false });
  const current = await fg('**/*', { cwd: ctx.paths.scaffold, onlyFiles: true, dot: false });
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  for (const f of files) {
    const text = await readText(join(snapshot, f));
    if (text !== null && text !== (await readText(join(ctx.paths.scaffold, f)))) tx.write(join(ctx.paths.scaffold, f), text);
  }
  // 快照之后新冒出来的文件要去掉：回滚是「回到那一刻」，不是「把那一刻叠上来」。
  const keep = new Set(files);
  for (const f of current) if (!keep.has(f)) tx.removeFile(join(ctx.paths.scaffold, f));
  tx.removeDir(ctx.paths.upgradeDir);
  const changed = await tx.commit();
  await pruneEmptyDirs(ctx.paths.scaffold, current.filter((f) => !keep.has(f)));
  return { result: { restored: files.length }, changed, next: [] };
}
