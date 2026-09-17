// design: cli §2.2 — 验：这份记录合法吗。不写盘，不执行任何项目命令。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import type { Outcome } from '../cli/envelope.js';
import { CliError } from '../cli/errors.js';
import { exists, readText } from '../fs/transaction.js';
import { readReceipts } from '../machines/receipts.js';
import { AUDIT_HMAC_ENV, findSigningEvent, verifyAuditChain } from '../model/audit.js';
import { ledgerDigest } from '../model/digest.js';
import { classifyFile } from '../model/integrity.js';
import { auditKindFor, entriesNeedingSignature } from '../model/ledger.js';
import { entriesBlocks, entryBlocks, headings, localZone } from '../model/markdown.js';
import type { BaselineEntries, EnvelopeDiagnostic, Flow, Integrity, Ledger } from '../model/types.js';
import { parseYaml, readYaml } from '../model/yaml.js';
import { loadFlow, type ChangeCtx, type Project } from './context.js';

const SKILL_HEADINGS = ['判断', '边界', '停下', '本项目'];

export interface InspectResult {
  checks: number;
  problems: number;
}

export async function runInspect(ctx: ChangeCtx | Project, opts: { hygiene: boolean }): Promise<Outcome<InspectResult>> {
  const diagnostics: EnvelopeDiagnostic[] = [];
  let checks = 0;
  const push = (code: string, message: string, severity: EnvelopeDiagnostic['severity'] = 'blocking', remedy?: EnvelopeDiagnostic['remedy']): void => {
    const d: EnvelopeDiagnostic = { code, severity, message };
    if (remedy) d.remedy = remedy;
    diagnostics.push(d);
  };

  // 1 receipt 链
  if ('change' in ctx) {
    checks += 1;
    try {
      await readReceipts(ctx.change);
    } catch (error) {
      if (error instanceof CliError) push(error.code, error.message + (error.details.length ? `：${error.details.join('；')}` : ''));
      else throw error;
    }
    // 2 记录级文件 schema；3 署名匹配；7 引用悬空
    checks += 3;
    for (const file of await fg('ledgers/**/*.yaml', { cwd: ctx.change.impl, onlyFiles: true })) {
      const path = join(ctx.change.impl, file);
      const text = (await readText(path)) ?? '';
      let ledger: Ledger;
      try {
        ledger = parseYaml<Ledger>(text, 'ledger', file);
      } catch (error) {
        push('XF-INSPECT-002', `${file}: ${(error as Error).message}`);
        continue;
      }
      const kind = auditKindFor(ledger.kind);
      if (kind) {
        for (const e of entriesNeedingSignature(ledger)) {
          if (!e.signer) continue; // 还没人签：是待办，不是损坏；由出口条件 attested 报 attest-missing
          if (findSigningEvent(e, ctx.events, kind, ledgerDigest(text))) continue;
          // 有这条的事件但对不上（署名或摘要变了）是损坏；一个事件都没有只是还没登记。
          const candidates = ctx.events.filter((ev) => ev.kind === kind && ev.subject['ledger'] === ledger.kind && (ev.subject['entry'] === undefined || ev.subject['entry'] === e.id));
          if (candidates.length) push('XF-INSPECT-003', `${file}#${e.id}: 署名「${e.signer}」或台账内容与审计链里的登记不一致`);
          else push('XF-INSPECT-003', `${file}#${e.id}: 署名「${e.signer}」尚未登记（xforge attest）`, 'warning');
        }
      }
      for (const e of ledger.entries) {
        for (const ref of e.refs) {
          if (!/^[\w./-]+\.(md|yaml|log)(#.*)?$/.test(ref)) continue;
          const target = join(ctx.change.impl, ref.split('#')[0]!);
          if (!(await exists(target)) && !(await exists(join(ctx.root, ref.split('#')[0]!)))) push('XF-INSPECT-007', `${file}#${e.id}: 引用 ${ref} 不存在`);
        }
      }
    }
    // 8 投影引用的 receipt
    checks += 1;
    const receiptIds = new Set(ctx.receipts.map((r) => r.id));
    for (const p of ctx.projections) {
      if (!receiptIds.has(p.opened_by)) push('XF-INSPECT-008', `投影 ${p.execution} 的 opened_by ${p.opened_by} 不在链上`);
      if (p.closed_by && !receiptIds.has(p.closed_by)) push('XF-INSPECT-008', `投影 ${p.execution} 的 closed_by ${p.closed_by} 不在链上`);
    }
  }

  // 4 审计链
  checks += 1;
  const chain = 'chain' in ctx ? ctx.chain : (await import('../audit/chain.js')).readChain(ctx.paths);
  for (const p of verifyAuditChain(await chain, ctx.env[AUDIT_HMAC_ENV])) push('XF-INSPECT-004', p.message, p.severity === 'info' ? 'info' : 'blocking');

  // 5 索引与基线
  checks += 1;
  for (const which of ['spec', 'interface'] as const) {
    const root = which === 'spec' ? ctx.paths.specs : ctx.paths.interfaces;
    for (const group of await fg('*', { cwd: root, onlyDirectories: true }).catch(() => [] as string[])) {
      const idxPath = join(root, group, 'index.yaml');
      if (!(await exists(idxPath))) {
        push('XF-INSPECT-005', `${which}/${group} 没有条目层索引`);
        continue;
      }
      const indexed = new Set((await readYaml<BaselineEntries>(idxPath, 'baseline-entries')).entries.map((e) => e.id));
      const onDisk = new Set<string>();
      for (const f of await fg('*.md', { cwd: join(root, group), onlyFiles: true })) {
        const text = (await readText(join(root, group, f))) ?? '';
        for (const b of entriesBlocks(text).flatMap((x) => entryBlocks(x.body))) onDisk.add(b.id);
      }
      for (const id of indexed) if (!onDisk.has(id)) push('XF-INSPECT-005', `${which}/${group}: 索引有 ${id}，文件里没有`);
      for (const id of onDisk) if (!indexed.has(id)) push('XF-INSPECT-005', `${which}/${group}: 文件有 ${id}，索引里没有`);
    }
  }

  // 6 事务残留
  checks += 1;
  try {
    const residue = (await readdir(ctx.paths.txDir)).filter((f) => f.endsWith('.json'));
    if (residue.length) push('XF-INSPECT-006', `写入事务残留：${residue.join('、')}`, 'blocking', { text: '确认没有别的 xforge 进程在跑，删除 xforge/.tx/ 后重跑' });
  } catch {
    // 没有事务目录就是干净。
  }

  // 10 Skill 存在性（每条选用流程的每一站）
  checks += 1;
  const flows: Flow[] = [];
  for (const name of ctx.manifest.selected.flows) {
    try {
      flows.push(await loadFlow(ctx, name));
    } catch (error) {
      if (error instanceof CliError) push(error.code, error.message);
      else throw error;
    }
  }
  const referencedSkills = new Set<string>(['xforge']);
  const referencedGates = new Set<string>();
  for (const flow of flows) {
    for (const s of flow.stages) {
      referencedSkills.add(s.skill);
      for (const g of s.gates) referencedGates.add(g);
      for (const lang of ['zh-CN', 'en'] as const) {
        const path = ctx.paths.skill(s.skill, lang);
        const text = await readText(path);
        if (text === null) {
          push('XF-INSPECT-010', `Skill ${s.skill} 缺 ${lang} 文件`, 'warning');
          continue;
        }
        const got = headings(text, 2);
        if (got.join('|') !== SKILL_HEADINGS.join('|')) push('XF-INSPECT-010', `Skill ${s.skill}（${lang}）的二级标题应为 [${SKILL_HEADINGS.join('、')}]，实际 [${got.join('、')}]`, 'warning');
        try {
          if (!localZone(text)) push('XF-INSPECT-010', `Skill ${s.skill}（${lang}）没有本地化区标记`, 'warning');
        } catch (error) {
          push('XF-INSPECT-010', `Skill ${s.skill}（${lang}）：${(error as Error).message}`, 'warning');
        }
      }
    }
  }

  // 9 卫生
  if (opts.hygiene) {
    checks += 1;
    for (const g of ctx.manifest.selected.gates) if (!referencedGates.has(g)) push('XF-INSPECT-009', `门 ${g} 被选用但没有任何流程引用`, 'warning');
    const skillDirs = await fg('*', { cwd: join(ctx.paths.scaffold, 'skills'), onlyDirectories: true }).catch(() => [] as string[]);
    for (const d of skillDirs) if (!referencedSkills.has(d)) push('XF-INSPECT-009', `Skill ${d} 存在但没有流程引用`, 'warning');
    if (await exists(ctx.paths.integrity)) {
      const integrity = await readYaml<Integrity>(ctx.paths.integrity, 'integrity');
      for (const [file, checksum] of Object.entries(integrity.files)) {
        const text = await readText(join(ctx.paths.scaffold, file));
        const cls = classifyFile(checksum, text ?? undefined);
        if (cls === 'missing') push('XF-INSPECT-009', `受管文件 ${file} 不存在`, 'warning');
        if (cls === 'modified') push('XF-INSPECT-009', `受管文件 ${file} 在本地化区之外被改过`, 'warning');
      }
    }
  }

  const blocking = diagnostics.filter((d) => d.severity === 'blocking').length;
  const problems = diagnostics.filter((d) => d.severity !== 'info').length;
  const outcome: Outcome<InspectResult> = { result: { checks, problems }, diagnostics };
  if ('changeId' in ctx) {
    outcome.change = ctx.changeId;
    outcome.scheme = ctx.scheme;
  }
  if (blocking) outcome.exit = 3;
  return outcome;
}
