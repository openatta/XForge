// design: rule-files §3.7 — 完整性清单：受管文件的校验和，本地化区之外的内容计算（RF-16）。
import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { sha256 } from './digest.js';
import { localZone, stripLocalZone } from './markdown.js';
import type { Integrity } from './types.js';

export const INTEGRITY_FILE = 'integrity.yaml';

export function fileChecksum(text: string): string {
  return `sha256:${sha256(stripLocalZone(text))}`;
}

/**
 * 算不出校验和的文件（本地化区标记不成对之类）。**不抛** —— 调用它的是 `doctor`，
 * 一个受管文件被写坏不该让「验」整个倒下，那正是它要报出来的东西。
 */
export function checksumOrNull(text: string): string | null {
  try {
    return fileChecksum(text);
  } catch {
    return null;
  }
}

/** 对 scaffold 目录下全部文件（不含清单自身）计算校验和；键是相对 scaffold 的 posix 路径，按字典序。 */
export async function computeIntegrity(scaffoldDir: string, scaffoldVersion: string): Promise<Integrity> {
  const files = (await fg('**/*', { cwd: scaffoldDir, dot: false, onlyFiles: true })).filter((f) => f !== INTEGRITY_FILE).sort();
  const out: Record<string, string> = {};
  for (const f of files) out[f] = fileChecksum(await readFile(`${scaffoldDir}/${f}`, 'utf8'));
  return { scaffold_version: scaffoldVersion, files: out };
}

export type FileClass = 'unchanged' | 'local-zone-only' | 'modified' | 'new' | 'missing' | 'unreadable';

/** 升级事务的逐文件分类（命令行设计 §5.3）。 */
export function classifyFile(recorded: string | undefined, currentText: string | undefined): FileClass {
  if (recorded === undefined) return 'new';
  if (currentText === undefined) return 'missing';
  const checksum = checksumOrNull(currentText);
  // 标记被写坏了：既不是「没改」也不是「改过」，是「读不出来」—— 分开说，别装成别的。
  if (checksum === null) return 'unreadable';
  if (checksum !== recorded) return 'modified';
  // 本地化区里有内容才算「项目填过」；出厂的空区域不算。
  let zone: string | null = null;
  try {
    zone = localZone(currentText)?.zone ?? null;
  } catch {
    zone = null;
  }
  return zone && zone.trim().length ? 'local-zone-only' : 'unchanged';
}
