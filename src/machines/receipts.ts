// design: cli §1.3 — 位置从 receipt 链推导；链坏了是退出码 3。
import { readdir } from 'node:fs/promises';
import { CliError } from '../cli/errors.js';
import { ARCHIVED, READY_TO_ARCHIVE } from '../model/flow.js';
import type { ChangePaths } from '../model/paths.js';
import { sealReceipt, verifyReceiptChain } from '../model/receipt.js';
import type { Flow, Receipt, ReceiptInputs, ReceiptKind, WorkPackages } from '../model/types.js';
import { readYaml, toYaml } from '../model/yaml.js';
import type { Transaction } from '../fs/transaction.js';

export async function readReceipts(change: ChangePaths): Promise<Receipt[]> {
  let files: string[];
  try {
    files = (await readdir(change.receiptsDir)).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    return [];
  }
  const receipts: Receipt[] = [];
  for (const f of files) receipts.push(await readYaml<Receipt>(`${change.receiptsDir}/${f}`, 'receipt'));
  const problems = verifyReceiptChain(receipts);
  if (problems.length) {
    throw new CliError('XF-INSPECT-001', 'receipt 链损坏', 3, { text: '不要手改任何一环；找人定位' }, problems.map((p) => `#${p.seq} ${p.message}`));
  }
  return receipts.sort((a, b) => a.seq - b.seq);
}

export type PositionStatus = 'no-change' | 'in-stage' | 'ready-to-archive' | 'archived';
export interface Position {
  stage: string | null;
  status: PositionStatus;
}

export function stagePosition(flow: Flow, receipts: readonly Receipt[]): Position {
  const stageMoves = receipts.filter((r) => r.kind === 'stage-transition' || r.kind === 'rework' || r.kind === 'archive');
  const last = stageMoves.at(-1);
  if (!last) return { stage: flow.stages[0]!.id, status: 'in-stage' };
  if (last.to === ARCHIVED) return { stage: null, status: 'archived' };
  if (last.to === READY_TO_ARCHIVE) return { stage: null, status: 'ready-to-archive' };
  return { stage: last.to, status: 'in-stage' };
}

export type PackageState = 'ready' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'integrated' | 'reviewed';

export function packageStates(plan: WorkPackages | null, receipts: readonly Receipt[]): Map<string, PackageState> {
  const out = new Map<string, PackageState>();
  for (const p of plan?.packages ?? []) out.set(p.id, 'ready');
  for (const r of receipts) {
    if (!r.kind.startsWith('package-')) continue;
    const pkg = r.subject['package'];
    if (typeof pkg === 'string') out.set(pkg, r.to as PackageState);
  }
  return out;
}

/** 某个包最近一次派工的执行 id 与工作目录。 */
export function lastDispatch(receipts: readonly Receipt[], pkg: string): Receipt | undefined {
  return [...receipts].reverse().find((r) => r.kind === 'package-dispatch' && r.subject['package'] === pkg);
}

export interface NewReceipt {
  kind: ReceiptKind;
  from: string;
  to: string;
  subject: Record<string, unknown>;
  execution?: string;
  workdir?: string;
  inputs?: ReceiptInputs;
  revision?: string;
}

export function writeReceipt(
  tx: Transaction,
  change: ChangePaths,
  receipts: readonly Receipt[],
  ids: { change: string; scheme: string },
  now: string,
  body: NewReceipt,
): Receipt {
  const last = receipts.at(-1);
  const base: Omit<Receipt, 'hash' | 'id'> = {
    seq: (last?.seq ?? 0) + 1,
    kind: body.kind,
    at: now,
    change: ids.change,
    scheme: ids.scheme,
    prev: last?.hash ?? null,
    from: body.from,
    to: body.to,
    subject: body.subject,
  };
  if (body.execution) base.execution = body.execution;
  if (body.workdir) base.workdir = body.workdir;
  if (body.inputs) base.inputs = body.inputs;
  if (body.revision) base.revision = body.revision;
  const sealed = sealReceipt(base);
  tx.write(change.receipt(sealed.seq, sealed.kind), toYaml(sealed));
  return sealed;
}
