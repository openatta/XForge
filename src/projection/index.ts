// design: rule-files §3.4 — 投影：进站时按方案作用域、派工时按包路径；由工作目录承载身份。
import { readdir } from 'node:fs/promises';
import type { ChangePaths } from '../model/paths.js';
import type { Projection } from '../model/types.js';
import { readYaml, toYaml } from '../model/yaml.js';
import type { Transaction } from '../fs/transaction.js';

export async function readProjections(change: ChangePaths): Promise<Projection[]> {
  let files: string[];
  try {
    files = (await readdir(change.projectionsDir)).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    return [];
  }
  const out: Projection[] = [];
  for (const f of files) out.push(await readYaml<Projection>(`${change.projectionsDir}/${f}`, 'projection'));
  return out;
}

export function openProjection(tx: Transaction, change: ChangePaths, p: Projection): void {
  tx.write(change.projection(p.execution), toYaml(p));
}

/** 关闭满足条件的在途投影；返回关闭了哪些执行 id。 */
export function closeProjections(tx: Transaction, change: ChangePaths, projections: readonly Projection[], match: (p: Projection) => boolean, closedBy: string): string[] {
  const closed: string[] = [];
  for (const p of projections) {
    if (p.closed_by !== null || !match(p)) continue;
    tx.write(change.projection(p.execution), toYaml({ ...p, closed_by: closedBy }));
    closed.push(p.execution);
  }
  return closed;
}
