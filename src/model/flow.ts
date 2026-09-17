// design: rule-files §3.1 — 流程文件的语义校验（RF-07、RF-08、RF-09 中 schema 表达不了的部分）。
import type { Flow, Manifest, Need, Produce, Stage } from './types.js';

export const READY_TO_ARCHIVE = 'ready-to-archive';
export const ARCHIVED = 'archived';

/** RF-07：站 id 唯一；rework_to 只引用更早的站；exit 引用的门 / 台账在本站声明。 */
export function validateFlow(flow: Flow): string[] {
  const errors: string[] = [];
  const ids = flow.stages.map((s) => s.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const d of new Set(dup)) errors.push(`站 id 重复: ${d}`);
  flow.stages.forEach((stage, index) => {
    for (const target of stage.rework_to) {
      const ti = ids.indexOf(target);
      if (ti === -1) errors.push(`${stage.id}.rework_to 引用不存在的站 ${target}`);
      else if (ti >= index) errors.push(`${stage.id}.rework_to 只能引用更早的站，${target} 不是`);
    }
    for (const cond of stage.exit) {
      if (cond.kind === 'gate' && !stage.gates.includes(cond.ref)) errors.push(`${stage.id}.exit 引用的门 ${cond.ref} 不在本站 gates 里`);
      if ((cond.kind === 'ledger' || cond.kind === 'attested') && !stage.ledgers.includes(cond.ref)) {
        errors.push(`${stage.id}.exit 引用的台账 ${cond.ref} 不在本站 ledgers 里`);
      }
      if (cond.kind === 'approval' && !flow.approval_policies[cond.policy]) errors.push(`${stage.id}.exit 引用的审批策略 ${cond.policy} 未定义`);
    }
    for (const p of stage.produces) errors.push(...validateProduce(stage, p));
  });
  for (const cond of flow.archive.exit) {
    if (cond.kind === 'approval' && !flow.approval_policies[cond.policy]) errors.push(`archive.exit 引用的审批策略 ${cond.policy} 未定义`);
  }
  return errors;
}

/** RF-09：skeleton / mixed 必须给 outline；mixed 必须给 markers。 */
function validateProduce(stage: Stage, p: Produce): string[] {
  const errors: string[] = [];
  if ((p.read === 'skeleton' || p.read === 'mixed') && !p.outline?.length) errors.push(`${stage.id}.produces.${p.id} 是 ${p.read} 却没有 outline`);
  if (p.read === 'mixed' && !p.markers?.length) errors.push(`${stage.id}.produces.${p.id} 是 mixed 却没有 markers`);
  return errors;
}

/** 打开的治理开关；assurance 是派生的（`保证层派生`）。 */
export function openNeeds(manifest: Pick<Manifest, 'governance'>): Set<Need> {
  const open = new Set<Need>();
  if (manifest.governance.spec) open.add('spec');
  if (manifest.governance.interface) open.add('interface');
  if (open.size) open.add('assurance');
  return open;
}

/** 欠不欠：治理依赖全开，且（规格侧只有默认方案欠；实现侧每个方案欠）。 */
export function isOwed(item: { needs?: Need[]; side?: 'spec' | 'impl' }, open: Set<Need>, isDefaultScheme: boolean): boolean {
  for (const n of item.needs ?? []) if (!open.has(n)) return false;
  if (item.side === 'spec' && !isDefaultScheme) return false;
  return true;
}

export function stageIndex(flow: Flow, stageId: string): number {
  return flow.stages.findIndex((s) => s.id === stageId);
}

export function stageById(flow: Flow, stageId: string): Stage | undefined {
  return flow.stages.find((s) => s.id === stageId);
}

/** 主文档《人的介入点》：主体需要人的站不隔离。 */
export function isIsolated(stage: Pick<Stage, 'human'>): boolean {
  return stage.human !== 'body';
}
