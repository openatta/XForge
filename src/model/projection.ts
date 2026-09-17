// design: rule-files §3.4 — 投影策略：在途判定只看 closed_by；同一工作目录取交集。
import { relative, resolve, sep } from 'node:path';
import type { Projection } from './types.js';

/** RF-14：在途 = closed_by 为 null。 */
export function isInFlight(p: Pick<Projection, 'closed_by'>): boolean {
  return p.closed_by === null;
}

/** workdir 等于 cwd，或是 cwd 的祖先。 */
export function coversCwd(workdir: string, cwd: string): boolean {
  const rel = relative(resolve(workdir), resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

export function inFlightFor(projections: readonly Projection[], cwd: string): Projection[] {
  return projections.filter((p) => isInFlight(p) && coversCwd(p.workdir, cwd));
}

/**
 * 交集：一条路径要被每一份在途投影的 allow 命中才放行。
 * 返回一个判定函数而不是合并后的 glob 列表 —— glob 的交集没有闭合形式。
 */
export function intersectAllow(projections: readonly Projection[], matches: (glob: string, path: string) => boolean): (path: string) => boolean {
  if (!projections.length) return () => true;
  return (path) => projections.every((p) => p.allow.some((g) => matches(g, path)));
}

/** RF-15 / RF-19：包路径必须落在作用域内。glob 之间的包含关系按目录前缀判（`a/**` 覆盖 `a/b/**` 与 `a/x.ts`）。 */
export function globCoveredBy(scopeGlobs: readonly string[], pathGlob: string): boolean {
  return scopeGlobs.some((scope) => {
    if (scope === pathGlob) return true;
    if (scope.endsWith('/**')) {
      const prefix = scope.slice(0, -2);
      return pathGlob.startsWith(prefix);
    }
    if (scope === '**') return true;
    return false;
  });
}
