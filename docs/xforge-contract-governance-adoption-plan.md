# XForge 契约治理 · 落地方案（Adoption Plan）v1 · 对齐 0.8.0

> **本文与设计文档的关系**：`docs/xforge-contract-governance.md`（v2.1，源码核实版）**原文不动**。
> 那份文档回答「这套机制该长什么样、为什么」；本文只回答**「怎么把它加进今天这个仓库」**——
> 切分、顺序、每一步的精确改动面、会因此变红的既有测试，以及需要人拍板的决策。
>
> **复核基线**：仓库 HEAD `9232282`，`@xforge/cli 0.8.0`。设计文档的实现基线是 **0.7.21**，
> 中间隔着 `cb64e18`（rollback 恢复整个升级 + 所有权归一）和 `b1b902e`（0.8.0）两次结构性提交。
> 本文每条断言都给出复核过的文件与行号。

---

## 0. 一句话结论

设计文档的**机制判断在 0.8.0 上依然成立**——抽查 17 处源码引用全部命中（§1.1）。
但有三件事必须在实施前修订：

1. **`xforge/contracts/**` 的守卫落点变了。** 0.8.0 新增 `core/ownership-zones.ts` 作为「XForge 拥有哪些文件」的**唯一表**，
   设计文档 §6.2 那种手写第二份 PermissionPolicy 的做法，在随包形态下已经是错的落点。
2. **设计文档没有 Skill 层，而 0.8.0 会因此报警。** `core/flow-skill-conformance.ts` 的 R2/R3 会被契约方案同时踩中。
   更根本的是：Flow 声明了什么，与 Agent 到那一站真正读到什么，是两件事。
3. **一批「记录型」测试会变红**，它们不是回归，是这个仓库把产品表面写成金标准的方式——每一条都是待办清单的一行。

在此之上，本文把整套东西切成 **5 个可独立发布的里程碑**（M0–M4），每个落地后系统仍自洽，
不出现「schema 加了字段但没人读」的中间态。

---

## 1. 复核：设计文档在 0.8.0 上还对不对

### 1.1 仍然成立（逐条抽查命中）

| 设计文档的断言 | 0.8.0 复核结果 |
| --- | --- |
| `undeclaredRequiredGates` 只数 runs，`spec.required` 确有消费者（§0 ①、§5.2） | ✅ `core/verification.ts:61-62`，`spec?.builtin !== 'declared' \|\| !spec.required` 原样在 |
| `contentInputPaths` 是 per-Change 且只覆盖 Change 目录（§1.1） | ✅ `core/revision.ts:155` 逐字一致，`xforge/contracts/**` 仍不在输入集合内 |
| `selfWrittenPrefixes` 四条，不含 contracts（§P3） | ✅ `core/revision.ts:65` |
| `policySnapshotDigest` 不含 manifest（§6.5、§11.1） | ✅ `core/revision.ts:202` |
| `IMPACT_KEYS` 四值 + `eligibilityProblems` 两分支（§7.4） | ✅ `core/checker.ts:31`、`:79-80`（较文档位移 1 行） |
| **`commands/state.ts` 有第二份独立硬编码 impact 列表** | ✅ **仍在 `:149`，仍不共享常量**；内联类型仍在 `:75` |
| reconcile 六条规则、`ReconciliationRule` 是字面量联合 | ✅ `core/reconcile.ts:115-129`、`core/reconcile/model.ts:19`（`'RC-1' \| … \| 'RC-6'`） |
| `planArchive` 的 syncSpecs 是单行三元（§7.5） | ✅ `core/archiver.ts:175`；事务与回滚仍在 `:184-205`；`data.specs` 污染点仍是 `:216/:233/:254` |
| `protectedWritePaths` 固定基集含 `${specsPath}/**`，并收编任意 `fs.write` deny 策略（§5.3） | ✅ `core/work-packages.ts:226`、`:234`、`:239-242` |
| `loadFlatResource` 的 kind 联合是六种（§7.3） | ✅ `core/resource-loader.ts:35`：`'agents'\|'rules'\|'policies'\|'hooks'\|'gates'\|'mcp-servers'` |
| `resolvedResourceEntries` 写死 7 类、**`mcpServers` 缺席**（S12） | ✅ `core/lockfile.ts:56-58`，缺口原样在——照抄就会掉进同一个坑 |
| `lock.paths` 只有 `{ specs, changes }` 两个键（S11） | ✅ `core/lockfile.ts` 的 `resolvedLock`；`core/project-loader.ts:170-173` 的 `XFORGE_LOCK_PATHS_MISMATCH` 判定同 |
| `assertLogicalPaths(specs, changes)` 是两参（§7.5） | ✅ `core/path-safety.ts:28`，三向互斥 + `GENERATED_ROOTS` 两件事都在 |
| schema 注册只有一处（`SCHEMA_NAMES`） | ✅ `core/validator.ts:20`（文档说 :19，注释多了一行）。数组已增至 20 个名字 |
| `DEFAULT_SPECS_PATH` / `DEFAULT_CHANGES_PATH`，无 contracts | ✅ `src/constants.ts:23-24`；`MAX_GATE_OUTPUT_BYTES` 仍在 `:35` |
| `solid.yaml` v6 的 stage 图与 artifact 列表（§6.4 的 diff 基准） | ✅ `scaffold/payload/xforge/flows/solid.yaml`，`design` 仍 `produces: [design]` 且**无 gates** |
| `quick.eligibleWhen` / `major.requiredWhen.anyImpact`（§7.4） | ✅ `quick.yaml` `{risk:[low], criticalImpacts: forbidden, maxModules: 1}`；`major.yaml:14` 四值 |

**结论：设计文档 §7.1 的 S1–S12 清单、§7.4 的精确改动清单、§7.5 的 archiver 三改动点，可以照用**，
只需把行号当作「±2 行的定位提示」而不是坐标。

### 1.2 必须修订的三条

#### 修订 A —— `xforge/contracts/**` 的守卫落点变了（推翻 §5.3 的落地形态，不推翻其结论）

0.8.0 新增 `xforge/src/core/ownership-zones.ts`：**「哪些文件 XForge 拥有、以什么意义拥有」现在是一张表**
（`OWNERSHIP_ZONES`，`:82`），四个下游全部由它推导：

| 推导出的东西 | 出处 | 消费者 |
| --- | --- | --- |
| `transactionPrefixes` | `:256` | `core/upgrade.ts` 的 `MANAGED_PREFIXES`——升级事务 stage / diff / snapshot / restore 的范围 |
| `guardedPaths` | `:261` | 随包 `protected-files` PermissionPolicy 的 deny 列表 |
| `askPaths` | `:264` | 随包 `protected-manifest` 的 ask 列表 |
| `neverTouchPaths` | `:285` | 升级 merge prompt 的「## Never」清单（`commands/upgrade.ts:19` 直接 import） |

而 `xforge/test/unit/ownership-zones.test.ts` **双向比对表与 payload yaml**，任一侧漏改即红。

→ **随包形态下，`xforge/contracts/` 的正确落点是 `record` zone 的一条新 entry**
（与 `xforge/specs/` 并列）：`{ path: 'xforge/contracts/', kind: 'prefix', agentWrite: 'deny' }`，
zone 属性 `inTransaction: 'none'` / `neverTouch: true`。三条理由：

1. **与 `xforge/specs/` 完全同构**——设计文档 §P3 自己就是这么论证的，只是当时没有这张表可以落。
2. **不需要第二份 PermissionPolicy**。`guardedPaths` 会自动把它喂进 `protected-files`，
   而 `work-packages.ts:239-242` 会把 `protected-files` 的 paths 收进 `governancePaths`——
   §0 ③ 那条「与 `integrator_paths` 互斥」的结论**照样成立、且照样是想要的**。
3. **`neverTouch: true` 是设计文档没想到但必须有的一条。** `cb64e18` 让 rollback 恢复整个升级；
   契约基线若进了升级事务，一次 scaffold 回滚会把项目的接口历史一起回滚回去。
   这与 `xforge/specs/` 和 `xforge/changes/` 被放进 `neverTouch` 是同一个理由。

**代价（要认）**：这把 §6.2 从「P1 零改码」变成「必须改 `src`」。
所以本方案的 M0 里，**项目侧仍写一份自己的 PermissionPolicy**——这是合法的、且 `protectedWritePaths` 会照收——
等 M2a 把 zone 加进随包，项目侧那份就可以删掉。这是一次有意的、一次性的重复。

#### 修订 B —— 设计文档没有 Skill 层，而 0.8.0 会因此报警（**最大的实施缺口**）

`xforge/src/core/flow-skill-conformance.ts:66` 的 `flowSkillConformanceDiagnostics`，
由 `commands/doctor.ts:301` 在 **`usedFlows` 范围**内调用，三条规则中的两条会被契约方案直接踩中：

- **R2（`:112` 起）** —— stage 声明了 `builtin: declared` 的 Gate，而该 stage 的 Skill 从未出现字面
  `verification declare` → `XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED`（warning）。
  契约方案在 **design / check / verify 三个 stage 各挂了 declared Gate**，
  所以 `xforge-design`、`xforge-check`、`xforge-verify` 三份 Skill 全部命中。
- **R3（`:130` 起）** —— stage 的 `exit.conditions` 的 key，Skill 里从未出现该字面串 →
  `XFORGE_FLOW_SKILL_CONDITION_UNNAMED`（warning）。`contractDecisions` 命中 `xforge-check`。

且 `skillVariants`（`:38-46`）**同时读 `SKILL.md` 与 `SKILL_cn.md`**，两份都缺才不算 silent——
所以**六个文件**都要改。这与本仓库既有的「人读的东西才双语」规则一致：Skill 属于人读的那一类。

比 warning 更根本的一点：**Flow 声明了什么，与 Agent 到了那一站真正读到什么，是两件事。**
设计文档 §5.1 的轨道 A 全部写在 Flow 层。不改 Skill，Agent 到了 design 站根本不知道要写 `contract-delta`，
到了 check 站不知道 `contractDecisions.yaml` 是它该写的、而不是它被禁止手写的 Gate Evidence
（R1 存在的原因就是这个混淆真实发生过）。

#### 修订 C —— 一批「记录型」测试会变红，它们是待办不是回归

这个仓库把产品表面写成金标准。以下每一条在实施时都会红，**每一条都是一行待办**：

| 记录 | 什么时候红 | 该怎么改 |
| --- | --- | --- |
| `test/unit/ownership-zones.test.ts` | 表与 payload yaml 任一侧改了另一侧没改 | 两侧同改（修订 A） |
| `test/integration/governed-formats.test.ts` + `fixtures/golden/contracts/governed-formats.txt` | 新增 `contract-kind` schema | 必须同时有 `validateSchema` 调用点，否则被记成「没有任何东西强制的 schema」 |
| `fixtures/golden/flows.json` + `test/unit/flows.test.ts` | 任何 Flow 图改动（新 Flow、quick 加 `contractImpact`） | 重录 |
| `fixtures/golden/public-api.txt` | 新导出类型（`ContractKindResource`、`ContractDelta`…） | 补录 |
| `fixtures/golden/contracts/skill-unmentioned-commands.txt` | 新增 `xforge contract *` 子命令而 Skill 未提及 | 要么写进 Skill，要么记进清单 |
| `fixtures/golden/contracts/skill-commands.txt` / `skill-evidence-paths.txt` | Skill 正文改动（修订 B） | 重录 |
| `fixtures/golden/diagnostics/**` + `diagnostics-catalogue.test.ts` | 新增 `XFORGE_CONTRACT_*` 诊断码 | build 时自动扫描收录，金标准重录 |
| `fixtures/golden/projection/**` | 新增 Rule / Policy 会改变对 5 个目标的投影 | 重录 |
| `fixtures/golden/reachability/**` | Flow 可达性矩阵 | 重录 |
| `scaffold/files.sha256` | 任何 `scaffold/payload/**` 改动 | `node xforge/scripts/scaffold-integrity.mjs scaffold --write` |
| `scaffold/payload/xforge/lock.yaml` | 任何 payload 资源或 `dist/` 改动 | `npm run relock`（详见 §5） |

### 1.3 一条对方案有利的新发现

设计文档担心的「四份手写清单会漂移」，在 0.8.0 已经由 `ownership-zones.ts` + 它的单元测试解决了。
所以**修订 A 的改动不可能被静默漏掉**——这比 §6.2 手写两份 yaml 的形态更安全。
把 `xforge/contracts/` 放进这张表，等于一次性买到了：deny 列表、升级事务范围、merge prompt 的 Never 清单，
三者永远一致，且有测试盯着。

---

## 2. 里程碑切分

**切分原则**：每个里程碑落地后系统仍自洽——不出现「schema 加了字段但没人读」「Flow 挂了 Gate 但没人告诉 Agent」的中间态。

| # | 里程碑 | 改动范围 | 可独立发布 | 验证成本 | 退出判据 |
| --- | --- | --- | --- | --- | --- |
| **M0** | 项目侧试点 | 某个真实项目的 `xforge/**`，**本仓库零改动** | 不涉及发布 | 一次真实 Change | 设计文档 §9 的 P1 清单 13 条全绿 + 一份实测成本数字 |
| **M1** | 随包资源 + Skill 对齐 | `scaffold/payload/**` only | ✅ | 静态套件 + **一次 live run** | doctor 零 conformance warning；`solid-contract` 可选可用 |
| **M2a** | 基线与所有权 | `src/**`（zone / 路径 / lock） | ✅ | CLI 套件 | `xforge/contracts` 是一等路径，受保护，进 lock，不进升级事务 |
| **M2b** | delta 与 archive | `src/**`（delta 解析 / merge / syncContracts） | ✅ | CLI 套件 | 动了契约的 Change 归档后基线与 delta 一致，且是一次原子事务 |
| **M2c** | 资格强制 | `src/**`（moduleContract / contractImpact） | ✅ | CLI 套件 | 三处拦截点全覆盖，transition 硬拦截 |
| **M3** | 适配器与核对 | `src/**` + 新 schema + 新命令 | ✅ | CLI 套件 + 金标准重录 | 新增一种方言只写 YAML + 脚本，不改 CLI |
| **M4** | 跨 Change 仲裁 | —— | **明确不做** | —— | 见 §8 |

**为什么 M0 在最前**：设计文档 §1.4 自己承认「单人单模块项目是纯税收」，
而 §10 R5 说最大的一次性成本是首次基线抽取。这两件事都**只能用真实项目量出来，量不出来就不该改 CLI**。
M0 完全不动本仓库，成本是几个 YAML 加一个脚本，却能否掉或确认整条路线。

**为什么 M1 在 M2 之前**：M1 只动 `scaffold/payload/**`，是随包资源，任何项目升级后**不登记就零影响**
（`resource-loader.ts` 全程不做目录扫描，只按 manifest 的 id 列表驱动——设计文档 §7.3 末尾已核实）。
它让 M0 的试点结论变成随包能力，而不需要先赌 CLI 改动。

---

## 3. 各里程碑的精确改动清单

### M0 · 项目侧试点（零 CLI 改动）

**新增（在试点项目里，不在本仓库）**

```
xforge/scaffold/gates/contract-lint.yaml         照设计文档 §6.1，四份同形
xforge/scaffold/gates/contract-compat.yaml
xforge/scaffold/gates/contract-drift.yaml
xforge/scaffold/gates/module-boundaries.yaml
xforge/scaffold/policies/contracts-are-integrator-only.yaml   §6.2（M2a 后可删，见修订 A）
xforge/scaffold/rules/interfaces-are-contract-governed.yaml   §6.3
xforge/flows/solid-contract.yaml                 从 solid.yaml v6 复制 + §6.4 的 diff
xforge/contracts/**                              首次基线抽取（§10 R5：先冻结现状，不追求正确）
scripts/xforge-contract.mjs                      §6.6 的五个子命令
```

**修改**：`xforge/manifest.yaml` 的 `scaffold.{gates,policies,rules,flows}` 登记 + `flow: solid-contract`
+ 四条 `xforge verification declare`（**不要手编 manifest**，理由见 §6.5 引的真实事故）。

**已知会出现、且是预期的**：`xforge doctor` 报 3 条 conformance warning（修订 B），M1 修。

**验收**：设计文档 §9 的 P1 清单 13 条，逐条跑。**外加一项本方案要求的产出**：
记录「首次基线抽取花了多久」和「一个普通 Change 多付了多少笔」——这两个数字决定 M1 之后还做不做。

---

### M1 · 随包资源 + Skill 对齐（只动 `scaffold/payload/**`）

**新增**

```
scaffold/payload/xforge/scaffold/gates/contract-lint.yaml
scaffold/payload/xforge/scaffold/gates/contract-compat.yaml
scaffold/payload/xforge/scaffold/gates/contract-drift.yaml
scaffold/payload/xforge/scaffold/gates/module-boundaries.yaml
scaffold/payload/xforge/scaffold/rules/interfaces-are-contract-governed.yaml
scaffold/payload/xforge/flows/solid-contract.yaml
scaffold/payload/xforge/flows/major-contract.yaml
```

**修改（修订 B —— 这是 M1 真正的工作量）**

| 文件 | 必须出现的字面串 | 还要说清的事 |
| --- | --- | --- |
| `skills/xforge-design/SKILL.md` + `SKILL_cn.md` | `verification declare` | design 站要产出 `contract-delta`；**永远不要直接改 `xforge/contracts/`** |
| `skills/xforge-check/SKILL.md` + `SKILL_cn.md` | `verification declare`、`contractDecisions` | `evidence/conditions/contractDecisions.yaml` 是 **Agent 该写的 Artifact，不是 Gate Evidence**（照 `xforge-check` 已经为自己两份台账写的那段 Authority 的形态）；四个字段名硬编码无别名；**写错 key 是静默的**；`decidedBy` 必须是真实身份（§5.4 的两个陷阱） |
| `skills/xforge-verify/SKILL.md` + `SKILL_cn.md` | `verification declare` | verify 站多了 `contract-drift` / `module-boundaries` |

**不修改（有意）**：`scaffold/payload/xforge/manifest.yaml`。

> **这是 M1 唯一需要拍板的地方**（决策 ①，见 §7）。资源随包但**不登记**，则：
> 新项目零影响、零 refuse，符合设计文档 §P4「开箱不启用」；
> 而一旦登记进 `scaffold.flows` 却不选为 `flow:`，`commands/doctor.ts:307` 会在项目有任何 Change 目录时
> 报 `XFORGE_DOCTOR_UNUSED_FLOW`——**这是「开箱可用」这条路的实际代价**，设计文档没算到。

**会红的记录**：`skill-commands.txt`、`skill-evidence-paths.txt`、`skill-unmentioned-*.txt`、
`projection/**`、`flows.json`（若登记 Flow）、`scaffold/files.sha256`、`lock.yaml`。

**验证**：`scaffold/payload/**` 属于「静态套件决定不了」的那一类——**owes 一次 live run**，
跑 design→check→verify 这条受影响的场景，不是整个矩阵。

---

### M2a · 基线与所有权（`src/**`）

| 文件 | 改动 |
| --- | --- |
| `core/ownership-zones.ts:82` | `record` zone 加 `{ path: 'xforge/contracts/', kind: 'prefix', agentWrite: 'deny' }`，并在该 zone 的注释里说明理由（这张表的注释是它的一半价值） |
| `scaffold/payload/xforge/scaffold/policies/protected-files.yaml` | 同步加 `xforge/contracts/**`（yaml 副本仍要在——host 不跑 CLI 也要能读） |
| `src/constants.ts:24` 后 | `DEFAULT_CONTRACTS_PATH = 'xforge/contracts'` |
| `core/path-safety.ts:28` | `assertLogicalPaths` 两参 → 三参，三两两互斥；**复用已导出的 `pathsOverlap`** |
| `core/project-loader.ts:135-139` | `contractsPath` + `safeResolve`；`:183-186` 加 `contractsPath` / `contractsPathSource` |
| `schemas/manifest.schema.json` | **S7**：`project.paths` 加 `contracts`（`additionalProperties: false`，必改） |
| `schemas/lock.schema.json` + `core/lockfile.ts` | **S11**：`paths` 加 `contracts`，否则 `project-loader.ts:170-173` 持续报 `XFORGE_LOCK_PATHS_MISMATCH` |
| `core/state-reader.ts` | `project.paths` 输出加 `contracts: { value, source }` |
| `types/manifest.ts` | 对应字段 |

**先写会红的测试**（red-first 门要求，见 §5）：
`test/unit/ownership-zones.test.ts` 加一条断言 contracts 在 `record` 且 `neverTouch`；
`test/unit/path-safety.test.ts` 加三两两互斥用例；`test/integration/archive.test.ts` 的重定位路径用例扩到 contracts。

**此时系统状态**：`xforge/contracts` 是一等路径、Agent 写不进去、进 lock、**不进升级事务**。
还没有 delta，也还没有 merge——**这本身就是一个有价值的可发布状态**：
它让 M0 试点里手写的那份 PermissionPolicy 可以删掉。

---

### M2b · delta 与 archive（`src/**`）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `core/contract-delta.ts`（新） | 照 `core/spec-delta.ts`（358 行）。`SECTION_HEADER = /^## (ADDED\|MODIFIED\|REMOVED) Contract Elements[ \t]*$/`。**英文字面量，无 i18n 表**——既有约束，照做 |
| 2 | `core/contract-merger.ts`（新） | 照 `core/spec-merger.ts`。**必须照抄 `ConflictSink` 双读模式**：archive 走 throw、check 走收集，跑同一个 merge |
| 3 | `schemas/flow.schema.json` | **S1** `artifactValidator` 加 `"contract-delta"`；**S3** v1alpha2 `terminal.archive` 与 v1alpha1 `operations.archive` 各加 `syncContracts`，**不要加进 `required`** |
| 4 | `types/flow.ts` / `types/change.ts` | 对应字段 |
| 5 | `core/flow-resolver.ts` | `flowArchiveOperation` 返回 `syncContracts`（两个分支）；`state.archive` 加字段；`outputsSatisfyArtifact` 加一条 |
| 6 | `core/archiver.ts:175` | 拆成 `specMutations` + `contractMutations` 后拼接。**三条顺序约束必须遵守**：早退栅栏之后、`planContractMutations` 必须幂等只读（`executeArchive` 规划两次）、所有写盘在 `rename` 之前 |
| 7 | `core/archiver.ts:184-205` | **零改动**——复用 `SpecMutation` 的 `{ path, content, change }` 形状，备份与回滚自动覆盖。**千万不要另写一个事务** |
| 8 | `core/archiver.ts:216/233/254` | `data.specs` 的污染：要么接受，要么给 mutation 加 `kind` 字段拆出 `data.contracts`（推荐后者，`data.specs` 是外部可见的输出契约） |
| 9 | `core/checker.ts:217,225-226` | 加 `validateChangeContractDeltas` 与 `validateContractMergeFeasibility`，照 spec 的两处调用写 |

**先写会红的测试**：`test/integration/archive.test.ts` —— **在 contract 写入处注入异常，断言 spec 与 contract 都被回滚、且 Change 目录未移动**。这是整个 M2b 唯一一条真正危险的路径，也是设计文档 §9 P2 第一条点名的验收。

---

### M2c · 资格强制（`src/**`）

照设计文档 §7.4 的清单，**两条各 5 个改动点**，其中两个是容易漏的：

- `core/checker.ts:31` 的 `IMPACT_KEYS` 加 `moduleContract` 后，`activeImpacts` / `criticalImpacts: forbidden` /
  `requiredWhen.anyImpact` **三处同时生效，函数体不用改**。
- **`commands/state.ts:149` 的第二份硬编码列表必须手工同步**（`:75` 的内联类型也是）。
  已复核：0.8.0 里这两份仍不共享常量。

`quick.yaml` 的 `policy.eligibleWhen` 加 `contractImpact: forbidden`，
**并且 quick 的 `verify.gates` 也要挂 `contract-compat`**——因为 `eligibleWhen` 纯读自报（§7.4 开头那条事实），
①必须配②，否则「自报 false 但实际改了契约」会静默通过。

> ⚠️ 给 quick 挂 declared Gate，会让**每一个用 quick 的项目**都撞上 `XFORGE_VERIFICATION_NOT_DECLARED`。
> 这是决策 ②（§7）：这一步是全局影响的，不像前面几步可选。

---

### M3 · 适配器与核对（可选增强）

三块，**可以再拆、也可以只做前两块**：

1. **ContractKind 成为一等资源**：`schemas/contract-kind.schema.json`（S10）+
   `core/validator.ts:20` 的 `SCHEMA_NAMES` 加名字 + `core/resource-loader.ts` 8 处机械改动 +
   `core/lockfile.ts:56-58` 加 `['contract-kind', resources.contractKinds]`（**别照抄 mcpServers 的缺口**）+
   `manifest.schema.json` 的 `scaffold.contractKinds`（S9）+ `state-reader` 的 `resourceSummary`。
   → 同时必须更新 `governed-formats.txt`，否则新 schema 会被记成「没有任何东西强制的 schema」。
2. **RC-7**：`reconcile/model.ts:19` 的联合加 `'RC-7'`（字面量联合，不加编译不过）+ `sources.ts` 的读取层
   （**必须返回 `unavailable`**）+ `rules.ts` 的纯同步判定 + `reconcile.ts:115-129` 的数组。
   **RC-7 恒为 `info`，只陈述差异不做判决**——这是 `rules.ts` 写进注释的不变量。
3. **`blockedBy` 词汇 + `xforge contract` 命令**：`cli.ts:38/:110/:112/:224` 四处登记
   （`CommandName` 联合、`GROUP_COMMANDS`、`COMMANDS`、`HELP`）。
   `contract draft` **只返回数据不写盘、且故意不产出人该填的字段**，照 `verification draft-receipt` 的设计。

---

## 4. 会变红的既有测试与记录（施工清单）

按里程碑归位，施工时当 checklist 用：

- **M1**：`skill-commands.txt`、`skill-evidence-paths.txt`、`skill-unmentioned-commands.txt`、
  `skill-unmentioned-flags.txt`、`projection/**`、`flows.json`（若登记 Flow）、
  `scaffold/files.sha256`、`payload/xforge/lock.yaml`、`flow-skill-conformance.test.ts`、`doctor.test.ts`
- **M2a**：`ownership-zones.test.ts`、`path-safety.test.ts`、`path-semantics.test.ts`（若新增 glob 形状）、
  `install-ownership-safety.test.ts`、`upgrade.test.ts`（`MANAGED_PREFIXES` 由表推导，确认 contracts **不**在内）
- **M2b**：`archive.test.ts`、`spec-merger.test.ts`（对照新 merger）、`flows.json`、`control-plane.test.ts`
- **M2c**：`flows.json`、`governance.test.ts`、`control-plane.test.ts`、`cli-protocol.test.ts`（`state` 输出）
- **M3**：`governed-formats.txt` + `governed-formats.test.ts`、`public-api.txt`、
  `diagnostics/**` + `diagnostics-catalogue.test.ts`、`cli-claimed-namespaces.txt`、
  `explain.test.ts`、`reachability/**`

---

## 5. 构建与验证纪律

**这个仓库有三条会咬人的既有事实**，实施时必须遵守：

1. **`scaffold/`（仓库根）是源，`xforge/scaffold/` 是构建拷贝且被 `.gitignore:97` 忽略。**
   永远改根目录那份。改完跑 `node xforge/scripts/scaffold-integrity.mjs scaffold --write`，
   否则 `check:scaffold` 与 `tests/product-validation.test.ts` 双双失败。
2. **测试跑的是 `dist/`，不是 `src/`。** `build` 的 clean 步骤会 `rm -rf dist`——
   **build / test / relock / check:red-first 必须串行**，不能并行或与后台任务并跑。
   任何 `src/**` 改动之后跑 `npm run relock`；vitest 从 `xforge/` 目录跑，不从仓库根跑。
3. **red-first 门**：`npm run check:red-first` 会把新增测试拿到父提交上跑，**必须红**。
   退出码 2（父提交构建不起来）与 3（没加测试）是两回事，别混。
   实践含义：**每个里程碑先写会红的测试，再写实现**。

**按 blast radius 选验证**（不要每次都打全套）：

| 改动落在 | 跑什么 |
| --- | --- |
| `xforge/src/**`（M2a/b/c、M3） | `npm run relock` + CLI 套件（`npx vitest run test`，从 `xforge/`，约 2.5 分钟） |
| `scaffold/payload/**`（M1） | 静态套件**决定不了**——owes 一次受影响场景的 live run（`--cli-source local`，否则装的是已发布版本，本地改动一行都测不到） |
| 试点项目（M0） | 不涉及本仓库验证 |
| 里程碑合并前 | `npm run verify`（一次，不是每次编辑后） |

**版本与 live run 的顺序**：live 结果绑定 commit hash。**先定版本、再跑 live**，
否则后面一次 version bump 提交会把 live 结论全部作废。

---

## 6. 补充风险（承接设计文档 R1–R10）

| # | 风险 | 缓解 |
| --- | --- | --- |
| **R11** | **Skill 与 Flow 的漂移**——M1 改了六份 Skill，下一次 Flow 调整很容易只改 Flow | `flow-skill-conformance` 的 R2/R3 已经能抓 declared Gate 与 exit condition 两类。但**「stage 产出 `contract-delta`」不在任何一条规则的覆盖内**（R1 只管 `evidence/` 下的 artifact）。这是已知的、接受的缺口——不要为它新加一条会猜的规则，那正是 `flow-skill-conformance.ts` 注释里拒绝做的事 |
| **R12** | **M2c 给 quick 挂 declared Gate 是全局影响**——所有 quick 项目立即撞 `XFORGE_VERIFICATION_NOT_DECLARED` | 见决策 ②。备选：quick 只加 `eligibleWhen.contractImpact`（结构性），**不**挂 Gate，接受「自报 false 就过」的漏洞，把事实核对留给 solid-contract。这削弱了设计文档 §P5 第三行，但把全局爆炸半径降到零 |
| **R13** | **重复的守卫**——M0 的项目侧 PermissionPolicy 与 M2a 的 zone 落点会共存一段时间 | 是有意的。M2a 落地后发一条迁移说明：删掉项目侧那份。两份共存不报错（都只是往 `governancePaths` 里加同一条路径），只是冗余 |
| **R14** | **`contract-delta` 的 `generates` 不能用 glob**（§6.4）——将来按契约域拆多文件时要付的代价 | 现在就定成单文件 `contract-delta.md`，并在 Flow 的注释里写明「用 glob 会让 marker 与 outline 校验整个跳过」（`artifact-markers.ts:124` 的短路）。这是一条**不会自己冒出来提醒你**的约束 |
| **R15** | **M3 的 ContractKind 进 `policySnapshotDigest` 会冲掉在途审批** | 见决策 ③。若采纳，把易变的命令/参数留在 `manifest.verification`（已复核不进 snapshot），只把判定逻辑放 ContractKind，并把适配器变更当作一次「发布窗口」 |

---

## 7. 需要拍板的五个决策

| # | 决策 | 选项 | 本文倾向 |
| --- | --- | --- | --- |
| ① | **M1 的随包 Flow 要不要登记进 payload manifest** | (a) 随包但不登记——零影响，用户手动登记后启用；(b) 登记进 `scaffold.flows` 但不选 `flow:`——开箱可用，代价是 `XFORGE_DOCTOR_UNUSED_FLOW` | **(a)**。符合 §P4「开箱不启用」，且 doctor 的 unused-Flow 注释已经说明为什么「一个没人选的 Flow 的 finding 没人会去处理」 |
| ② | **M2c 要不要给 quick 挂 `contract-compat`** | (a) 挂——补上自报的漏洞；(b) 不挂——只加结构性 `contractImpact` | **(b) 先，(a) 待定**。见 R12：(a) 的爆炸半径是所有 quick 项目 |
| ③ | **ContractKind 进不进 `policySnapshotDigest`** | (a) 进（设计文档建议）；(b) 不进 | **(a)**，理由设计文档 §7.3 已论证充分；但把它推到 M3，届时再单独确认 |
| ④ | **`xforge/contracts/` 的 zone 归属** | (a) `record` + `neverTouch: true`（与 specs 同）；(b) `project-owned` | **(a)**。契约基线是「实际发生过什么」的一部分，一次 scaffold 回滚绝不该把它带回去 |
| ⑤ | **M3 做不做** | (a) 做完整 M3；(b) 只做 RC-7 与 `contract draft`，ContractKind 永远由项目脚本承担 | **(b) 起步**。M0 的实测数字应该能回答「有几种方言」——只有一两种时，一等资源化是纯开销 |

---

## 8. 明确不做的事

- **M4（跨 Change 仲裁 / `xforge contract status`）**——设计文档 §8 自己给了触发条件：
  **同时存在 3 个以上活跃 Change**。在那之前它是无人使用的代码。
- **新的 marker role `contract-change`（S2）**——`declared-gap` 已经够用，且**有现成消费者**
  （`reconcile/rules.ts:130` 的 RC-4），白捡一条「破坏性变更必须在 findings 台账里有账」的核对。
  加第四个 role 要改 schema + 类型 + 消费者三处，只加前两处不会有任何行为。
- **给 `contract-delta` marker 设 `minOccurrences`**——不满足会报 **error**，
  且 `minOccurrences > 0` 而没有 `pattern` 时必然报 0 < minimum。
- **修 `gate.ts:395-404` 成功路径丢 `outputTruncated`（R10）与 `mcpServers` 不进 lock（S12 备注）**——
  都是既有缺陷，不是本方案引入的。顺手修会让本方案的 diff 混进两个无关的行为变更，
  应当各自单开一个 Change。
