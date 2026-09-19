// design: cli §5.4 §5.5 — 骨架完整性：受管文件与自己的完整性清单对不对得上；缺的能从载荷补回，改过的不动。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transaction } from '../fs/transaction.js';
import { exists, readText } from '../fs/transaction.js';
import { classifyFile, fileChecksum } from '../model/integrity.js';
import type { GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, Integrity, Manifest } from '../model/types.js';
import { parseYaml } from '../model/yaml.js';

/** 一条骨架发现。`missing` 能从载荷补回来，其余只能人处理。 */
export interface ScaffoldIssue {
  /** 项目根相对路径，给信封的 `subject`。 */
  subject: string;
  /** 相对 scaffold/ 的路径；`missing` 的那些按它去载荷里取。 */
  rel: string | null;
  kind: 'missing' | 'modified' | 'unreadable' | 'no-integrity' | 'skill-source';
  message: string;
}

const CAN_BACKFILL = new Set<ScaffoldIssue['kind']>(['missing']);
export const backfillable = (i: ScaffoldIssue): boolean => CAN_BACKFILL.has(i.kind);

async function readIntegrity(paths: GovernancePaths, tx?: Transaction): Promise<Integrity | null> {
  // 同一轮里刚补进事务的那一份也算数：不然补回清单之后还要再跑一次才看得见。
  const staged = tx?.pending().get(paths.integrity);
  const text = staged ?? (await readText(paths.integrity));
  if (text === null) return null;
  try {
    return parseYaml<Integrity>(text, 'integrity', paths.integrity);
  } catch {
    return null;
  }
}

/**
 * 骨架与它自己的完整性清单对不对得上，外加一条 `sync` 自己不会喊的：
 * 清单语言对应的 `SKILL*.md` 缺了，`sync` 只是**静默**少投影那个 Skill —— 静默失效必须有人说。
 */
export async function scaffoldIssues(paths: GovernancePaths, manifest: Manifest, tx?: Transaction): Promise<ScaffoldIssue[]> {
  const out: ScaffoldIssue[] = [];
  const rel = (p: string): string => `xforge/scaffold/${p}`;
  const integrity = await readIntegrity(paths, tx);
  if (!integrity) {
    out.push({ subject: rel('integrity.yaml'), rel: 'integrity.yaml', kind: 'no-integrity', message: 'xforge/scaffold/integrity.yaml 不在或读不出：受管文件没法核对' });
  } else {
    for (const [file, recorded] of Object.entries(integrity.files)) {
      const path = join(paths.scaffold, file);
      const current = tx?.pending().get(path) ?? (await readText(path));
      const cls = classifyFile(recorded, current ?? undefined);
      if (cls === 'missing') out.push({ subject: rel(file), rel: file, kind: 'missing', message: `受管文件 ${rel(file)} 不在` });
      else if (cls === 'unreadable') out.push({ subject: rel(file), rel: file, kind: 'unreadable', message: `受管文件 ${rel(file)} 的本地化区标记不成对，校验和算不出来` });
      else if (cls === 'modified') out.push({ subject: rel(file), rel: file, kind: 'modified', message: `受管文件 ${rel(file)} 在本地化区之外被改过` });
    }
  }

  const wanted = manifest.language === 'zh-CN' ? 'SKILL_cn.md' : 'SKILL.md';
  for (const name of await skillNames(paths)) {
    if (await exists(paths.skill(name, manifest.language))) continue;
    out.push({ subject: rel(`skills/${name}/${wanted}`), rel: `skills/${name}/${wanted}`, kind: 'skill-source', message: `Skill ${name} 缺 ${wanted}（清单语言 ${manifest.language}）：sync 会静默地不投影它` });
  }
  return out;
}

async function skillNames(paths: GovernancePaths): Promise<string[]> {
  try {
    return (await readdir(join(paths.scaffold, 'skills'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

export interface Backfill {
  /** 补回来的（相对 scaffold/）。 */
  restored: string[];
  /** 补不回来的，各带一句为什么。 */
  refused: EnvelopeDiagnostic[];
}

/**
 * 从本 CLI 自带的载荷补回**缺失**的受管文件，写进给定事务。
 * **校验和对得上才补**：对不上说明这份载荷不是清单记的那一版（多半是脚手架还停在旧版本），
 * 拿它覆盖就是把一份错的正文写进去 —— 那是 `update` 的活，不是 `repair` 的。
 */
export async function backfillScaffold(paths: GovernancePaths, payloadDir: string, issues: readonly ScaffoldIssue[], tx: Transaction): Promise<Backfill> {
  const restored: string[] = [];
  const refused: EnvelopeDiagnostic[] = [];
  const refuse = (subject: string, why: string): void => {
    refused.push({ code: 'XF-ASSEMBLE-015', severity: 'blocking', message: `${subject} 补不回来：${why}`, remedy: { command: 'xforge update', text: '用新版载荷对齐骨架，再 repair' } });
  };

  const missingIntegrity = issues.find((i) => i.kind === 'no-integrity');
  if (missingIntegrity) {
    // 清单自己不在：先补它 —— 没有它，「该有什么」就没有依据。
    const text = await readText(join(payloadDir, 'integrity.yaml'));
    if (text === null) refuse(missingIntegrity.subject, '载荷里没有副本');
    else {
      tx.write(paths.integrity, text);
      restored.push('integrity.yaml');
    }
  }

  for (const issue of issues) {
    if (!backfillable(issue) || issue.rel === null) continue;
    const text = await readText(join(payloadDir, issue.rel));
    if (text === null) {
      refuse(issue.subject, '载荷里没有副本');
      continue;
    }
    const recorded = (await readIntegrity(paths, tx))?.files[issue.rel];
    if (recorded !== undefined && fileChecksum(text) !== recorded) {
      refuse(issue.subject, '载荷里那份与完整性清单对不上（载荷版本与脚手架不同？）');
      continue;
    }
    tx.write(join(paths.scaffold, issue.rel), text);
    restored.push(issue.rel);
  }
  return { restored, refused };
}
