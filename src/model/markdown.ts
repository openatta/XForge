// design: rule-files §3.1 — 骨架级与混装的读取：标题、条目区标记、本地化区、章程标题、条目块、delta 操作块。
import { ModelError } from './errors.js';

export const MARK = {
  constitution: '<!-- xforge:constitution -->',
  entriesBegin: /^<!--\s*xforge:entries:begin\s+kind=([a-z][a-z0-9-]*)\s*-->\s*$/,
  entriesEnd: /^<!--\s*xforge:entries:end\s*-->\s*$/,
  localBegin: '<!-- xforge:local:begin -->',
  localEnd: '<!-- xforge:local:end -->',
} as const;

/** RF-29：某一级标题的有序列表，精确匹配（只去首尾空白）。 */
export function headings(text: string, level = 2): string[] {
  const prefix = '#'.repeat(level) + ' ';
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    if (line.startsWith(prefix) && !line.startsWith(prefix + '#')) out.push(line.slice(prefix.length).trim());
  }
  return out;
}

/** RF-06：章程标题 = 二级标题的有序列表；重复是 XF-MODEL-003。 */
export function constitutionTitles(text: string): string[] {
  const titles = headings(text, 2);
  const seen = new Set<string>();
  for (const t of titles) {
    if (seen.has(t)) throw new ModelError('XF-MODEL-003', `章程标题重复: ${t}`);
    seen.add(t);
  }
  return titles;
}

export interface EntriesBlock {
  kind: string;
  body: string;
}

/** 条目区：标记必须成对；不成对是 XF-MODEL-001。 */
export function entriesBlocks(text: string): EntriesBlock[] {
  const out: EntriesBlock[] = [];
  let open: { kind: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const begin = MARK.entriesBegin.exec(line.trim());
    if (begin) {
      if (open) throw new ModelError('XF-MODEL-001', `条目区嵌套: ${begin[1]} 在 ${open.kind} 内`);
      open = { kind: begin[1]!, lines: [] };
      continue;
    }
    if (MARK.entriesEnd.test(line.trim())) {
      if (!open) throw new ModelError('XF-MODEL-001', '条目区结束标记没有开始');
      out.push({ kind: open.kind, body: open.lines.join('\n') });
      open = null;
      continue;
    }
    if (open) open.lines.push(line);
  }
  if (open) throw new ModelError('XF-MODEL-001', `条目区 ${open.kind} 没有结束标记`);
  return out;
}

export interface LocalZone {
  before: string;
  zone: string;
  after: string;
}

/** 本地化区：恰好一对标记；没有回 null；不成对是 XF-MODEL-001。 */
export function localZone(text: string): LocalZone | null {
  const b = text.indexOf(MARK.localBegin);
  const e = text.indexOf(MARK.localEnd);
  if (b === -1 && e === -1) return null;
  if (b === -1 || e === -1 || e < b) throw new ModelError('XF-MODEL-001', '本地化区标记不成对');
  if (text.indexOf(MARK.localBegin, b + 1) !== -1 || text.indexOf(MARK.localEnd, e + 1) !== -1) {
    throw new ModelError('XF-MODEL-001', '本地化区标记出现不止一对');
  }
  const zoneStart = b + MARK.localBegin.length;
  return { before: text.slice(0, b), zone: text.slice(zoneStart, e), after: text.slice(e + MARK.localEnd.length) };
}

/** RF-16：去掉本地化区内容后的文本（标记保留），用于完整性校验和与升级移植。 */
export function stripLocalZone(text: string): string {
  const z = localZone(text);
  if (!z) return text;
  return `${z.before}${MARK.localBegin}${MARK.localEnd}${z.after}`;
}

/** 升级移植：把旧文件的本地化区放进新版同一位置。 */
export function transplantLocalZone(incoming: string, current: string): string {
  const cur = localZone(current);
  const inc = localZone(incoming);
  if (!cur || !inc) return incoming;
  return `${inc.before}${MARK.localBegin}${cur.zone}${MARK.localEnd}${inc.after}`;
}

export interface EntryBlock {
  id: string;
  title: string;
  body: string;
  summary?: string;
  breaking?: boolean;
}

// id 可以含空格（`cli:invoice list`、`endpoint:POST /orders`）：id 是到「 · 」为止的全部。
const BLOCK_HEAD = /^###\s+(Requirement|Element):\s+(.+?)(?:\s+·\s+(.*))?\s*$/;

/** `### Requirement: ID · 标题` / `### Element: kind:selector · 标题` 块。 */
export function entryBlocks(body: string): EntryBlock[] {
  const out: EntryBlock[] = [];
  let cur: EntryBlock | null = null;
  const lines: string[] = [];
  const flush = (): void => {
    if (!cur) return;
    const text = lines.join('\n').trim();
    const summary = /^summary:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const breaking = /^breaking:\s*(true|false)\s*$/m.exec(text)?.[1];
    cur.body = text;
    if (summary !== undefined) cur.summary = summary;
    if (breaking !== undefined) cur.breaking = breaking === 'true';
    out.push(cur);
    lines.length = 0;
  };
  for (const line of body.split('\n')) {
    const m = BLOCK_HEAD.exec(line);
    if (m) {
      flush();
      cur = { id: m[2]!, title: (m[3] ?? '').trim(), body: '' };
      continue;
    }
    if (cur) lines.push(line);
  }
  flush();
  return out;
}

export interface DeltaOps {
  added: EntryBlock[];
  modified: EntryBlock[];
  removed: EntryBlock[];
}

function isEntriesMarker(line: string): boolean {
  const l = line.trim();
  return MARK.entriesBegin.test(l) || MARK.entriesEnd.test(l);
}

/**
 * delta 文件：`## ADDED` / `## MODIFIED` / `## REMOVED` 三个操作块，每块里是条目块。
 * 块里出现条目区标记（照着基线文件写很自然）一律容忍并剥掉，不让它进条目正文。
 */
export function deltaOps(text: string): DeltaOps {
  const sections: Record<string, string[]> = { ADDED: [], MODIFIED: [], REMOVED: [] };
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^##\s+(ADDED|MODIFIED|REMOVED)\s*$/.exec(line.trim());
    if (m) {
      current = m[1]!;
      continue;
    }
    if (/^##\s+/.test(line)) current = null;
    if (current && !isEntriesMarker(line)) sections[current]!.push(line);
  }
  return {
    added: entryBlocks(sections['ADDED']!.join('\n')),
    modified: entryBlocks(sections['MODIFIED']!.join('\n')),
    removed: entryBlocks(sections['REMOVED']!.join('\n')),
  };
}
