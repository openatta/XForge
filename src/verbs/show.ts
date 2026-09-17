// design: cli §2.1a — 读的第二种形式：点名取材料，切片自称完整，省略自报。
import { join } from 'node:path';
import fg from 'fast-glob';
import type { Outcome } from '../cli/envelope.js';
import { CliError } from '../cli/errors.js';
import { exists, readText } from '../fs/transaction.js';
import { latestRun } from '../gates/index.js';
import { constitutionTitles, entriesBlocks, entryBlocks, headings } from '../model/markdown.js';
import type { BaselineEntries, GateRun } from '../model/types.js';
import { readYaml } from '../model/yaml.js';
import { artifactPath, type ChangeCtx } from './context.js';

export interface ShowResult {
  ref: string;
  content: unknown;
  complete: true;
  omitted: string[];
}

function notFound(ref: string, why: string): CliError {
  return new CliError('XF-STATE-005', `${ref}: ${why}`, 1, { command: 'xforge state --orient', text: '从定向里的名字取 ref' });
}

export async function runShow(ctx: ChangeCtx, ref: string): Promise<Outcome<ShowResult>> {
  const colon = ref.indexOf(':');
  const kind = colon === -1 ? ref : ref.slice(0, colon);
  const arg = colon === -1 ? '' : ref.slice(colon + 1);
  const done = (content: unknown, omitted: string[] = []): Outcome<ShowResult> => ({ result: { ref, content, complete: true, omitted }, change: ctx.changeId, scheme: ctx.scheme });

  switch (kind) {
    case 'stage': {
      const stage = ctx.flow.stages.find((s) => s.id === arg);
      if (!stage) throw notFound(ref, '没有这一站');
      return done(stage.produces.map((p) => ({ id: p.id, path: p.path, outline: p.outline ?? [], markers: p.markers ?? [], instructions: p.instructions ?? '' })));
    }
    case 'doc': {
      const [rel, heading] = arg.split('#');
      if (!rel || rel.includes('..')) throw notFound(ref, '路径不合法');
      const text = await readText(artifactPath(ctx.change, rel));
      if (text === null) throw notFound(ref, '文件不存在');
      if (!heading) return done(text);
      const { section, others } = sectionOf(text, heading);
      if (section === null) throw notFound(ref, `没有二级标题「${heading}」；有：${others.join('、')}`);
      return done(section, others);
    }
    case 'spec':
    case 'interface': {
      const found = await findEntry(ctx, kind, arg);
      if (!found) throw notFound(ref, '基线里没有这条');
      return done(found);
    }
    case 'constitution': {
      const text = await readText(ctx.paths.constitution);
      if (text === null) throw notFound(ref, '章程不存在');
      const titles = constitutionTitles(text);
      const { section } = sectionOf(text, arg);
      if (section === null) throw notFound(ref, `没有这条；有：${titles.join('、')}`);
      return done(section, titles.filter((t) => t !== arg));
    }
    case 'gate': {
      const [name, runStr] = arg.split('/');
      if (!name) throw notFound(ref, '缺门名');
      let run: GateRun | null;
      if (runStr) {
        const path = ctx.change.gateRun(name, Number(runStr));
        run = (await exists(path)) ? await readYaml<GateRun>(path, 'gate-run') : null;
      } else run = await latestRun(ctx, name);
      if (!run) throw notFound(ref, '没有这次运行');
      const log = run.log ? await readText(ctx.change.gateLog(name, run.run)) : null;
      return done({ ...run, output: log ?? '' });
    }
    case 'ledger': {
      // ledger:<ref>；交付记录按包点名：ledger:delivery/<pkg>。不合法的 ref 是找不到，不是内部错误。
      const [kind2, pkg] = arg.startsWith('delivery/') ? ['delivery', arg.slice('delivery/'.length)] : [arg, undefined];
      let path: string;
      try {
        path = ctx.change.ledger(kind2!, pkg);
      } catch {
        throw notFound(ref, '不是合法的台账引用；合法的有：review-findings、constitution-reply、verification-receipt、delivery/<包 id>、exit/<名>');
      }
      const text = await readText(path);
      if (text === null) throw notFound(ref, '台账不存在');
      return done(text);
    }
    case 'package': {
      const pkg = ctx.plan?.packages.find((x) => x.id === arg);
      if (!pkg) throw notFound(ref, '计划里没有这个包');
      const state = ctx.packages.get(pkg.id) ?? 'ready';
      const deliveryText = await readText(ctx.change.ledger('delivery', pkg.id));
      const projections = ctx.projections.filter((p) => p.kind === 'package' && p.package === pkg.id);
      return done({ ...pkg, state, delivery: deliveryText, projections: projections.map((p) => ({ execution: p.execution, workdir: p.workdir, in_flight: p.closed_by === null })) });
    }
    case 'receipts':
      return done(ctx.receipts.map((r) => ({ id: r.id, kind: r.kind, from: r.from, to: r.to, at: r.at, subject: r.subject })));
    case 'index': {
      const path = ctx.paths.specsDomainIndex(arg);
      if (!(await exists(path))) throw notFound(ref, '没有这个域');
      return done((await readYaml<BaselineEntries>(path, 'baseline-entries')).entries.map((e) => ({ id: e.id, title: e.title })));
    }
    default:
      throw notFound(ref, '不认识这种 ref');
  }
}

function sectionOf(text: string, heading: string): { section: string | null; others: string[] } {
  const all = headings(text, 2);
  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!/^##\s+/.test(line) || /^###/.test(line)) continue;
    if (start !== -1) {
      end = i;
      break;
    }
    if (line.replace(/^##\s+/, '').trim() === heading) start = i;
  }
  if (start === -1) return { section: null, others: all };
  return { section: lines.slice(start, end).join('\n'), others: all.filter((h) => h !== heading) };
}

async function findEntry(ctx: ChangeCtx, which: 'spec' | 'interface', id: string): Promise<unknown> {
  const root = which === 'spec' ? ctx.paths.specs : ctx.paths.interfaces;
  const groups = await fg('*', { cwd: root, onlyDirectories: true }).catch(() => [] as string[]);
  for (const g of groups) {
    const idxPath = join(root, g, 'index.yaml');
    if (!(await exists(idxPath))) continue;
    const hit = (await readYaml<BaselineEntries>(idxPath, 'baseline-entries')).entries.find((e) => e.id === id);
    if (!hit) continue;
    const text = (await readText(join(root, g, `${hit.capability}.md`))) ?? '';
    const block = entriesBlocks(text).flatMap((b) => entryBlocks(b.body)).find((b) => b.id === id);
    return { ...hit, body: block?.body ?? '' };
  }
  return null;
}
