// design: rule-files §1 — RF-01：治理根目录的每个路径都由这里生成，代码里不出现字面路径。
import { access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { ID } from './ids.js';
import type { Language } from './types.js';

export const GOVERNANCE_DIR = 'xforge';
export const DEFAULT_SCHEME = 'default';

/**
 * 治理根：环境变量 XFORGE_ROOT 指定的目录优先（worktree 里有自己检出的 xforge/ 副本，不是活的治理根；
 * 给 worktree 会话设 XFORGE_ROOT 指回主检出），否则从 cwd 向上找含 xforge/manifest.yaml 的目录；找不到回 null。
 */
export async function findProjectRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pinned = env['XFORGE_ROOT'];
  if (pinned) {
    try {
      await access(join(resolve(pinned), GOVERNANCE_DIR, 'manifest.yaml'));
      return resolve(pinned);
    } catch {
      return null;
    }
  }
  let dir = resolve(cwd);
  for (;;) {
    try {
      await access(join(dir, GOVERNANCE_DIR, 'manifest.yaml'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

export interface ChangePaths {
  root: string;
  /** 本方案的实现侧目录：默认方案就是 root，具名方案是 root/<scheme>。 */
  impl: string;
  scheme: string;
  /** 项目根相对路径，给门的 inputs 代入：`${change}` 与 `${impl}`。 */
  changeRel: string;
  implRel: string;
  /** 归档标记：Change 级，任一方案归档后写在 Change 根，所有方案据此判 archived。 */
  archiveMarker: string;
  declaration: string;
  proposal: string;
  specDelta: (domain: string, capability: string) => string;
  specDeltaDir: string;
  interfaceDelta: (module: string, file: string) => string;
  interfaceDeltaDir: string;
  scope: string;
  design: string;
  assurance: string;
  workPackages: string;
  ledgersDir: string;
  ledger: (ref: string, pkg?: string) => string;
  evidenceDir: string;
  gateRunsDir: (gate: string) => string;
  gateRun: (gate: string, run: number) => string;
  gateLog: (gate: string, run: number) => string;
  receiptsDir: string;
  receipt: (seq: number, kind: string) => string;
  projectionsDir: string;
  projection: (execution: string) => string;
  auditIndex: string;
}

export interface GovernancePaths {
  projectRoot: string;
  root: string;
  manifest: string;
  constitution: string;
  scaffold: string;
  integrity: string;
  flow: (name: string) => string;
  gate: (name: string) => string;
  policy: (name: string) => string;
  hook: (name: string) => string;
  executor: (name: string) => string;
  skill: (name: string, language: Language) => string;
  skillDir: (name: string) => string;
  specs: string;
  specsIndex: string;
  specsDomainIndex: (domain: string) => string;
  spec: (domain: string, capability: string) => string;
  interfaces: string;
  interfacesIndex: string;
  interfacesModuleIndex: (module: string) => string;
  interfaceFile: (module: string, file: string) => string;
  changes: string;
  change: (id: string, scheme?: string) => ChangePaths;
  auditChain: string;
  auditLock: string;
  upgradeDir: string;
  txDir: string;
}

export function governancePaths(projectRoot: string): GovernancePaths {
  const root = join(projectRoot, GOVERNANCE_DIR);
  const scaffold = join(root, 'scaffold');
  const specs = join(root, 'specs');
  const interfaces = join(root, 'interfaces');
  const changes = join(root, 'changes');
  return {
    projectRoot,
    root,
    manifest: join(root, 'manifest.yaml'),
    constitution: join(root, 'constitution.md'),
    scaffold,
    integrity: join(scaffold, 'integrity.yaml'),
    flow: (name) => join(scaffold, 'flows', `${name}.yaml`),
    gate: (name) => join(scaffold, 'gates', `${name}.yaml`),
    policy: (name) => join(scaffold, 'policies', `${name}.yaml`),
    hook: (name) => join(scaffold, 'hooks', `${name}.yaml`),
    executor: (name) => join(scaffold, 'agents', `${name}.yaml`),
    skillDir: (name) => join(scaffold, 'skills', name),
    skill: (name, language) => join(scaffold, 'skills', name, language === 'zh-CN' ? 'SKILL_cn.md' : 'SKILL.md'),
    specs,
    specsIndex: join(specs, 'index.yaml'),
    specsDomainIndex: (domain) => join(specs, domain, 'index.yaml'),
    spec: (domain, capability) => join(specs, domain, `${capability}.md`),
    interfaces,
    interfacesIndex: join(interfaces, 'index.yaml'),
    interfacesModuleIndex: (module) => join(interfaces, module, 'index.yaml'),
    interfaceFile: (module, file) => join(interfaces, module, `${file}.md`),
    changes,
    change: (id, scheme = DEFAULT_SCHEME) => changePaths(projectRoot, join(changes, id), scheme),
    auditChain: join(root, '.audit', 'chain.jsonl'),
    auditLock: join(root, '.audit', 'chain.lock'),
    upgradeDir: join(root, '.upgrade'),
    txDir: join(root, '.tx'),
  };
}

function changePaths(projectRoot: string, changeRoot: string, scheme: string): ChangePaths {
  // 规格侧一份；实现侧默认方案落在 Change 目录本身，具名方案落在子目录。
  const impl = scheme === DEFAULT_SCHEME ? changeRoot : join(changeRoot, scheme);
  const ledgersDir = join(impl, 'ledgers');
  const evidenceDir = join(impl, 'evidence');
  return {
    root: changeRoot,
    impl,
    scheme,
    changeRel: relative(projectRoot, changeRoot),
    implRel: relative(projectRoot, impl),
    archiveMarker: join(changeRoot, 'archived.yaml'),
    declaration: join(changeRoot, 'change.yaml'),
    proposal: join(changeRoot, 'proposal.md'),
    specDeltaDir: join(changeRoot, 'specs'),
    specDelta: (domain, capability) => join(changeRoot, 'specs', domain, `${capability}.md`),
    interfaceDeltaDir: join(changeRoot, 'interfaces'),
    interfaceDelta: (module, file) => join(changeRoot, 'interfaces', module, `${file}.md`),
    scope: join(impl, 'scope.yaml'),
    design: join(impl, 'design.md'),
    assurance: join(impl, 'assurance.md'),
    workPackages: join(impl, 'work-packages.yaml'),
    ledgersDir,
    ledger: (ref, pkg) => ledgerPath(ledgersDir, ref, pkg),
    evidenceDir,
    gateRunsDir: (gate) => join(evidenceDir, 'gates', gate),
    gateRun: (gate, run) => join(evidenceDir, 'gates', gate, `${run}.yaml`),
    gateLog: (gate, run) => join(evidenceDir, 'gates', gate, `${run}.log`),
    receiptsDir: join(evidenceDir, 'receipts'),
    receipt: (seq, kind) => join(evidenceDir, 'receipts', `${String(seq).padStart(4, '0')}-${kind}.yaml`),
    projectionsDir: join(evidenceDir, 'projections'),
    projection: (execution) => join(evidenceDir, 'projections', `${execution}.yaml`),
    auditIndex: join(evidenceDir, 'audit-index.yaml'),
  };
}

/** 相对 Change 目录的产出路径 → 绝对路径。规格侧四样在 Change 根，其余都是实现侧，落本方案目录。 */
const SPEC_SIDE = /^(change\.yaml|proposal\.md|specs(\/|$)|interfaces(\/|$))/;
export function artifactPathOf(change: ChangePaths, rel: string): string {
  return join(SPEC_SIDE.test(rel) ? change.root : change.impl, rel);
}

/** 台账引用（kind 或 exit/<id>）→ 文件路径；交付记录按包一份。 */
export function ledgerPath(ledgersDir: string, ref: string, pkg?: string): string {
  if (!ID.ledgerRef.test(ref)) throw new Error(`台账引用不合法: ${ref}`);
  if (ref === 'delivery') {
    if (!pkg) throw new Error('交付记录需要包 id');
    return join(ledgersDir, 'deliveries', `${pkg}.yaml`);
  }
  if (ref.startsWith('exit/')) return join(ledgersDir, 'exit', `${ref.slice(5)}.yaml`);
  return join(ledgersDir, `${ref}.yaml`);
}
