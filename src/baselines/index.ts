// design: rule-files §4 — 基线只由归档合并推进；delta 按 id 合并，两层索引与基线文件同一事务落盘。
import { join } from 'node:path';
import fg from 'fast-glob';
import { exists, readText, type Transaction } from '../fs/transaction.js';
import { deltaOps, entriesBlocks, entryBlocks, type EntryBlock } from '../model/markdown.js';
import type { GovernancePaths } from '../model/paths.js';
import type { BaselineDomains, BaselineEntries } from '../model/types.js';
import { readYaml, toYaml } from '../model/yaml.js';

export type Baseline = 'spec' | 'interface';

interface Layout {
  root: string;
  index: string;
  groupIndex: (g: string) => string;
  file: (g: string, f: string) => string;
  entriesKind: 'requirements' | 'elements';
  head: 'Requirement' | 'Element';
}

function layout(paths: GovernancePaths, which: Baseline): Layout {
  return which === 'spec'
    ? { root: paths.specs, index: paths.specsIndex, groupIndex: paths.specsDomainIndex, file: paths.spec, entriesKind: 'requirements', head: 'Requirement' }
    : { root: paths.interfaces, index: paths.interfacesIndex, groupIndex: paths.interfacesModuleIndex, file: paths.interfaceFile, entriesKind: 'elements', head: 'Element' };
}

export interface MergeResult {
  files: string[];
  groups: string[];
}

/** 把一个 Change 的 delta 目录合进基线：改基线文件，重建条目层与域层索引；全部通过事务写。 */
export async function mergeDeltas(tx: Transaction, paths: GovernancePaths, which: Baseline, deltaDir: string): Promise<MergeResult> {
  const lay = layout(paths, which);
  const deltaFiles = (await fg('**/*.md', { cwd: deltaDir, onlyFiles: true }).catch(() => [] as string[])).sort();
  const touchedGroups = new Set<string>();
  const written: string[] = [];
  for (const rel of deltaFiles) {
    const [group, fileMd] = rel.split('/');
    if (!group || !fileMd) continue;
    const file = fileMd.replace(/\.md$/, '');
    const ops = deltaOps((await readText(join(deltaDir, rel))) ?? '');
    const target = lay.file(group, file);
    const current = await readText(target);
    const title = (current ?? `# ${file}\n`).split('\n')[0] ?? `# ${file}`;
    const blocks = current ? entriesBlocks(current).flatMap((b) => entryBlocks(b.body)) : [];
    const byId = new Map(blocks.map((b) => [b.id, b] as const));
    for (const b of ops.removed) byId.delete(b.id);
    for (const b of ops.modified) byId.set(b.id, b);
    for (const b of ops.added) byId.set(b.id, b);
    tx.write(target, renderFile(title, lay, [...byId.values()]));
    written.push(target);
    touchedGroups.add(group);
  }
  // 重建每个触碰过的组的条目层索引，再重建域层索引。
  for (const group of touchedGroups) tx.write(lay.groupIndex(group), toYaml(await groupEntries(lay, group, tx)));
  tx.write(lay.index, toYaml(await domainIndex(lay, touchedGroups, tx)));
  return { files: written, groups: [...touchedGroups] };
}

function renderFile(title: string, lay: Layout, blocks: readonly EntryBlock[]): string {
  const body = blocks
    .map((b) => `### ${lay.head}: ${b.id}${b.title ? ` · ${b.title}` : ''}\n${b.body}`.trimEnd())
    .join('\n\n');
  return `${title}\n\n<!-- xforge:entries:begin kind=${lay.entriesKind} -->\n${body}\n<!-- xforge:entries:end -->\n`;
}

/** 组内条目层：扫描该组下全部 md（含本事务将写入的内容）。 */
async function groupEntries(lay: Layout, group: string, tx: Transaction): Promise<BaselineEntries> {
  const dir = join(lay.root, group);
  const files = (await fg('*.md', { cwd: dir, onlyFiles: true }).catch(() => [] as string[])).sort();
  const pending = pendingWrites(tx);
  const names = new Set([...files, ...[...pending.keys()].filter((p) => p.startsWith(dir + '/') && p.endsWith('.md')).map((p) => p.slice(dir.length + 1))]);
  const entries: BaselineEntries['entries'] = [];
  for (const f of [...names].sort()) {
    const path = join(dir, f);
    const text = pending.get(path) ?? (await readText(path)) ?? '';
    const capability = f.replace(/\.md$/, '');
    for (const block of entriesBlocks(text).flatMap((b) => entryBlocks(b.body))) {
      const e: BaselineEntries['entries'][number] = { id: block.id, capability, title: block.title };
      if (block.summary !== undefined) e.summary = block.summary;
      if (block.breaking !== undefined) e.breaking = block.breaking;
      entries.push(e);
    }
  }
  return { entries };
}

async function domainIndex(lay: Layout, touched: Set<string>, tx: Transaction): Promise<BaselineDomains> {
  const existing: BaselineDomains = (await exists(lay.index)) ? await readYaml<BaselineDomains>(lay.index, 'baseline-domains') : { domains: [] };
  const byId = new Map(existing.domains.map((d) => [d.id, d] as const));
  const pending = pendingWrites(tx);
  for (const group of touched) {
    const dir = join(lay.root, group);
    const files = (await fg('*.md', { cwd: dir, onlyFiles: true }).catch(() => [] as string[]));
    const names = new Set([...files, ...[...pending.keys()].filter((p) => p.startsWith(dir + '/') && p.endsWith('.md')).map((p) => p.slice(dir.length + 1))]);
    const caps = [...names].sort().map((f) => ({ id: f.replace(/\.md$/, ''), path: `${group}/${f}` }));
    const prev = byId.get(group);
    byId.set(group, { id: group, title: prev?.title ?? group, capabilities: caps });
  }
  return { domains: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

function pendingWrites(tx: Transaction): Map<string, string> {
  return tx.pending();
}
