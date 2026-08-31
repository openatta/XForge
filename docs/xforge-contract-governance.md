# XForge 契约治理（Contract Governance）设计与实施说明 v2.1 · 源码核实版

> **用途**：交给编程 Agent 实施。所有字段名、常量、正则、诊断码、行号均**读自源码**，不是从随包文档推断的。
> **实现基线**：`@xforge/cli 0.7.21`（仓库根 `package.json` version 0.7.21）/ Protocol 2 / `xforge.dev/v1alpha2`。
> **依据**：`xforge/schemas/*.json` 七份、`scaffold/payload/xforge/flows/{quick,solid}.yaml`、
> `scaffold/payload/xforge/scaffold/{gates,rules,policies}/*.yaml`，以及 `xforge/src/` 下
> `core/{revision,verification,checker,control-plane,control-plane/conditions,control-plane/graph,control-plane/receipts,flow-resolver,spec-delta,spec-merger,archiver,artifact-markers,validator,resource-loader,project-loader,work-packages,state-reader,ledger,ledger-identity,env-safety,toolchain,governance,diagnostics-catalogue}.ts`、
> `commands/{check,verification,transition,state,explain}.ts`、`types/{flow,manifest,change,resource,work-package,governance}.ts`。
>
> 补读第二轮：`core/{reconcile,reconcile/model,reconcile/rules,reconcile/sources,files,errors,hash,path-safety,lockfile,verification-receipt}.ts`、
> `runners/gate.ts`、`core/work-packages/globs.ts`。
>
> **仍未读到**（实施时需自行确认）：`core/{identity,audit,redaction,approval-receipt,review-acknowledgement,check-findings,constitution-check,language}.ts`、
> `src/cli.ts`、`install/**`、`test/**`。凡依赖它们的结论，本文标注 **【未读】**。

---

## 0. 与 v1 的差异：三条被源码推翻的结论

如果你看过上一版，先读这一节——**v1 的核心机制之一是错的**。

### ① 「`verificationDismissal` 可以表达『本项目不适用』」——**错**

v1 的 P4 原则建立在「Gate 用 `builtin: declared`，项目用 `verificationDismissal` 声明不适用，Gate 就跳过」上。
源码里这条路**不通**，且有三处独立的显式反驳：

```ts
// core/verification.ts:62  —— undeclaredRequiredGates 只数 runs
if (entriesFor(project, gateId).runs.length > 0) continue;
```

```
// core/verification.ts:45-48（doc comment）
a dismissal records a toolchain the Gate deliberately does not cover, which is not a command,
so a Gate holding only dismissals still has nothing to run and still refuses.

// core/verification.ts:212（写进 Gate Evidence 的文本）
a dismissal cannot close this. notApplicable records who decided a marker is out of scope;
it never stands in for a command.
```

`entriesFor`（`core/verification.ts:77`）把 `manifest.verification[gate] ?? []` 按 `Array.isArray(entry.command)`
分成 runs / dismissals，`isRetired`（三字段全齐才算）的先丢弃。四种状态的实际结果：

| `manifest.verification.<gate>` | 结果 |
| --- | --- |
| 键不存在 | `XFORGE_VERIFICATION_NOT_DECLARED`（拒绝） |
| `[]` | 同上（`?? []` 让两者不可区分） |
| **只有 dismissal** | **同上，仍然拒绝** |
| run 全被 retire | 同上（`commands/verification.ts:248-262` 在 retire 时就预警 `XFORGE_VERIFICATION_GATE_LEFT_UNDECLARED`） |

`verificationDismissal` 的**真实用途**是多 toolchain 项目的覆盖率：`isCovered`（`core/verification.ts:109-118`）
三条短路——dismissal 的 `notApplicable` 命中 marker、run 的 `covers` 命中 marker、或
`detectedCount === 1 && runs.length > 0`。**runs 为空时 uncovered 恒为 `[]`**（第 124-125 行注释：
否则会把「这个 Gate 根本没声明」这件唯一重要的事淹没）。

→ **「不适用」必须改由 Flow 层表达。见 §3 P4（重写）。**

### ② 「`xforge brief` 是给审批人看的分层简报」——**它已经被删除了**

`commands/` 下没有 `brief.ts`。`commands/check.ts:528-540` 的注释给出结论：

> Six rules, one to three kilobytes of differences, and the section a field report called the most
> valuable mechanism in the release … They used to print inside `xforge brief`, whose other
> thirty-four kilobytes had to travel through a model's context to reach a person;
> **the document is gone** and this is not part of what made it expensive.

reconciliation 现在活在 `core/reconcile.ts` 的 `reconcileChange()` 里，由 `xforge check` 调用
（`commands/check.ts:541-547`），产出 **`info` 级**诊断 + `nextActions`。
`reconcile.ts:15-39` 的注释给出了完整的取舍，其中一句值得原样引用：

> a field report called it the single most valuable mechanism in the release — **RC-5 forced a Gate to
> be re-run, which is how an unattributable `resolvedBy` was caught instead of archived.** Deleting it
> with the document it happened to be printed in would have thrown away the part that worked.

→ **契约的「声称 vs 实际」应作为第七条 reconciliation 规则 RC-7，不是新开一个命令。见 §7.6。**

（`commands/explain.ts` 是另一个东西：按诊断码查它的全部措辞与 severity，读 `dist/diagnostics.json`。）

### ③ 「契约基线同时进 `integrator_paths` 和 `PermissionPolicy`」——**这两条互斥**

`core/work-packages.ts` 的 `protectedWritePaths`（:226-261）把所有
`capability === 'fs.write'` 且 `effect !== 'allow'` 的 PermissionPolicy 的 `match.paths` 收进
`governancePaths`。而 integrator 包的 `write_paths` 与 `governancePaths` 重叠会被拒：

```ts
// core/work-packages.ts:935-944（integrator 分支）
// 诊断文案原文包含："Reserve nothing for it in integrator_paths either."
diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_SHARED_WRITE', ...));
```

→ **一条路径要么归 PermissionPolicy（运行期护栏，包外提交，无 delivery 记录），
要么归 `integrator_paths`（有 delivery 记录、verify、done_when，但只有事后归因）。不能两者兼得。**
这条约束直接决定了 §5.3 的路径划分，而 v1 的方案两条都用了，会在第一次 `xforge check` 就报 error。

---

## 1. 问题与价值

### 1.1 结构性盲区，不是缺一个功能

`core/revision.ts:153-158` 给出 `contentRevision` 的输入路径集合，**逐字如此**：

```ts
const changeRoot = `${project.changesPath}/${changeId}`;
const paths = new Set<string>([`${changeRoot}/change.yaml`, `xforge/flows/${flow.metadata.name}.yaml`]);
for (const artifact of state.artifacts) for (const output of artifact.outputPaths) paths.add(`${changeRoot}/${output}`);
```

**它是 per-Change 的，且只覆盖 Change 目录内的 Artifact 输出。**
两个 Change 各自完全合规、各自拿到人类审批，却对同一个 `POST /orders` 说了两件不同的事——
控制面没有任何一处会发现，因为跨 Change 的一致性从设计上就不在判定范围内。

而模块接口今天的载体是 `design.md` 的散文，`solid.yaml` 给它声明的两个 marker
（`verification-coverage`、`rejected-alternative`）都与接口无关。

### 1.2 它是并行工作包真正可用的前提

`work-package.schema.json` 对 `integrator_paths` 的描述原文：
"Paths reserved for the Integrator: **shared contracts**, module lists, DI roots and other integration
output that belongs to no single package."

作者已经知道「共享契约」需要独占写入，只是没给它一个持久身份。
`core/work-packages.ts:963-982` 会拒绝两个无依赖关系的包 write_paths 潜在重叠
（`XFORGE_WORK_PACKAGE_PARALLEL_WRITE_CONFLICT`），但它管不了「两个包基于两份不同的接口理解各自实现」。

### 1.3 业界空白位

调研结论（§12 参考）：**没有任何主流 SDD 工具把模块接口作为跨需求持久化的一等产物。**
spec-kit 的 `contracts/` 是 per-feature；Kiro 的 `design.md` 官方描述不承诺产出接口定义；
OpenSpec 的 `specs/` 最接近（就是 `syncSpecs` 那个形状）但无强制；Tessl Registry 治理的是外部依赖库。
「防止 Agent 单方面改契约」这一条，业界找不到任何工具级手段。

### 1.4 什么时候不值得做

价值曲线由 **模块数 × 并发 Change 数 × 参与人数** 决定。单人单模块项目是纯税收——
所以 §3 P4 必须成立，否则这套东西没法被采纳。最大的一次性成本是首次基线抽取（§10 R5）。

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| **契约基线** | `xforge/contracts/**`，跨 Change 存活的模块接口唯一真源 |
| **CEID** | Contract Element Id，`<kind>:<selector>`，协议无关的契约元素地址 |
| **ContractKind** | 一种契约方言的适配器（新的 scaffold 资源类型） |
| **contract-delta** | 一个 Change 对基线的增量，是 Change Artifact |
| **派生物** | 由契约生成的 client / 类型 / migration，禁止手改 |

---

## 3. 五条设计原则（P4 已重写）

### P1 · 不找统一语言，只定统一地址

OpenAPI 是 HTTP 领域的最优选（oasdiff 破坏性检测、Spectral lint、各语言 codegen 都成熟），
但拿它描述数据库表或库导出类型是硬套。**治理层不需要统一的描述语言，只需要统一的地址空间。**
契约本体各用各的方言；delta 的三段式、`blockedBy` 报错、reconciliation、审批签的是什么，全部跑在 CEID 上。

### P2 · `enumerate` 是适配器唯一必需的能力

有了「元素 id + 摘要」清单，XForge 不理解任何方言就能算出真实变更集：

```
ADDED    = 新出现的 id
REMOVED  = 消失的 id
MODIFIED = id 相同、digest 不同
```

于是可以做三件今天做不到的事：
① 校验 `contract-delta` 引用的元素真实存在；
② 把「声称改了什么」和「实际改了什么」摆进 `reconcile.ts` 的差异报告；
③ **在没有任何 breaking-change 工具的语言/领域里，依然强制「接口变更必须被声明」**——
这就是业界「基线快照评审」流派（api-extractor 的 `.api.md`、`cargo-public-api`）的全部机制。

`lint` / `compat` / `drift` 是可选增强。

### P3 · 基线 + delta + archive 合并，与 specs 同构

```
xforge/specs/**      ← delta-specs artifact    → syncSpecs: true      （已有）
xforge/contracts/**  ← contract-delta artifact → syncContracts: true  （新增）
```

**契约增量必须是 Change Artifact，不能直接改基线文件。** 依据是 §1.1 的 `contentInputPaths`：
仓库里的 `xforge/contracts/**` 不在 `contentRevision` 的输入集合内，直接改它**不会**冲掉已有审批。
做成 Artifact 就自动正确。

> 附带的一条源码事实：`core/revision.ts:65-70` 的 `selfWrittenPrefixes` 只排除
> `${changesPath}/${changeId}/`、`xforge/.audit/`、`xforge/manifest.yaml`、`xforge/lock.yaml`。
> `xforge/contracts/**` **不在**排除列表里，所以基线一旦变动，`codeMovedSince`（:91）会把它算进
> `state.mandatoryGateEvidence[].sourceFilesChangedSince`。这是**想要的**行为：契约动了，
> 之前跑的 Gate 就该被标记为「代码已前进」。

### P4 · 「不适用」由 Flow 层表达（重写）

`verificationDismissal` 不能关掉一道 Gate（§0 ①）。可用的开关只有一个：**Flow 里有没有声明这道 Gate。**

这在 XForge 的哲学里是自洽的：

- Flow 是 `xforge/flows/*.yaml`，**项目所有的纯数据**，`init` 之后随便改；
- `refuse` 的语义是「Flow 说需要这道 Gate，但项目没说怎么跑」——一个**未被回答的问题**；
- Flow 里没声明这道 Gate，就**没有问题被提出**，沉默是正确的，不是隐瞒。

**默认 + 定制的落地形态（推荐）**：

| 层 | 做法 |
| --- | --- |
| **默认（开箱不启用）** | 随包 `quick.yaml` / `solid.yaml` / `major.yaml` **一行不改**。既有项目升级后零影响、零 refuse |
| **默认（开箱可用）** | 随包**新增** `solid-contract.yaml` / `major-contract.yaml`（`assuranceLevel` 仍是 `solid` / `major`，只是多了契约 artifact 与 Gate）。`flow.schema.json` 不限制同 assuranceLevel 的 Flow 数量；`metadata.name` 必须与文件名一致 |
| **启用** | `manifest.flow: solid-contract` + `manifest.scaffold.flows` 登记 |
| **定制** | 复制一份改，或直接在自己的 `solid.yaml` 里加那几行 |
| **一个 kind 不适用** | 由项目脚本按 `manifest.scaffold.contractKinds` 决定跑哪些方言；没注册 SQL kind 就不查 SQL |
| **全都不适用** | 不启用 contract Flow。这不需要断言，因为没有未回答的问题 |

> ⚠️ 启用是**改 Flow**，而 `flow` 整份对象进 `policySnapshotDigest`（`core/revision.ts:205`），
> 所以切换 Flow 会让所有在途 Change 的 revision 漂移。**在没有未归档 Change 时做这件事。**

### P5 · 三个消费时刻，三道不同性质的防线

| 时刻 | 失效模式 | 防线 | 依据 |
| --- | --- | --- | --- |
| **设计** | 重新发明已存在的接口 | 基线进 `nextAction.inputs`；`contract-delta` 是 stage 的 `produces` | `flow-resolver.ts` |
| **生成代码** | 实现与契约慢慢分家 | 派生物进 `integrator_paths`；`drift` = 重新生成后 diff 非空即失败 | `work-packages.ts:925-946` |
| **修 bug** | **走 quick 改了接口，全程无人看见** | ① `eligibleWhen.contractImpact: forbidden`（结构性不合格）② `contract-compat` Gate 作事实核对 | `checker.ts:76-82` |

第三行最关键：`quick.yaml` 只有 `propose / apply / verify` 三个 stage，没有 design、没有 check。
但注意——`eligibleWhen` **纯读自报**（§7.4），所以①必须配②。

---

## 4. 数据模型

### 4.1 CEID

```
CEID := <kind-id> ":" <selector>

<kind-id>   已注册的 ContractKind id，须匹配 flow.schema.json 的 $defs/id：
            ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$
<selector>  由适配器定义，XForge 视为不透明字符串
            建议约束：^\S[^\s]*$，长度 ≤ 512，不含控制字符
```

XForge 只做三件事：校验 kind 已注册、校验它出现在 `enumerate` 输出里、等值比较与排序。

推荐 selector 形态（由适配器决定）：

```
openapi:paths./orders.post
openapi:components.schemas.Order.properties.status
sql:table.orders.column.status
proto:acme.order.v1.OrderService.Create
tsapi:@acme/core#OrderService.create
event:order.created#v2
```

### 4.2 `enumerate` 输出契约

适配器命令以 argv 启动（**不经 shell**，与 `GateResource.command` 同约束），
XForge 追加 `--root <契约根>`，stdout 输出单个 JSON：

```jsonc
{
  "kind": "openapi",
  "elements": [
    { "id": "openapi:paths./orders.post",
      "digest": "sha256:…",              // 规范化后的摘要
      "file": "http/orders.openapi.yaml", // 可选，报错定位
      "label": "POST /orders" }           // 可选，人类可读
  ]
}
```

**规范化要求**：同一份契约在格式化、键序、注释变化后 `digest` 必须不变，否则每次重排 YAML 都产生假 MODIFIED。
建议 `xforge doctor` 加一条检查：连跑两次 `enumerate`，digest 必须一致。

退出码 0 = 成功，非 0 = 枚举失败。

### 4.3 目录布局

```text
xforge/
├── specs/                    Requirement 基线（已有，DEFAULT_SPECS_PATH = 'xforge/specs'）
├── changes/                  （已有，DEFAULT_CHANGES_PATH = 'xforge/changes'）
├── architecture.md           架构决策散文（已有）
└── contracts/                【新】DEFAULT_CONTRACTS_PATH = 'xforge/contracts'
    ├── http/orders.openapi.yaml
    ├── data/schema.sql
    ├── proto/order/v1/service.proto
    └── events/order-created.avsc

xforge/changes/<id>/
└── contracts/<name>.md       【新】contract-delta 输出（glob 形态，见 §6.3 的取舍）

xforge/scaffold/
└── contract-kinds/<id>.yaml  【新】第八类 scaffold 资源
```

一个模块一个契约文件（业界共识：`$ref` 拆分 + 发布时 bundle），从源头消灭并行 YAML 合并冲突。

### 4.4 模块清单：复用已有的 `project.modules`

`manifest.schema.json` 的 `project.modules` **已存在且必填**（`minItems: 1`），
每项 `{ id, path, kind }`，`kind ∈ {application, service, library, module}`。
`project-loader.ts:141-148` 校验 id 唯一（**重复是 `throw`，`XFORGE_MODULE_DUPLICATE`，不是收集诊断**）
并对每个 `module.path` 做 `safeResolve`。

**不需要新建 `modules.yaml`**，只需加两个可选字段：

```yaml
project:
  layout: monorepo
  paths:
    contracts: xforge/contracts        # 新增（S7）
  modules:
    - id: web
      path: src/web
      kind: application
      dependsOn: [api]                 # 新增（S8）
    - id: api
      path: src/server
      kind: service
      dependsOn: [store]
    - id: store
      path: src/store
      kind: library
      dependsOn: []
```

> ⚠️ **副作用**：`core/toolchain.ts:72-77` 用 `project.modules[].path` 作为工具链 marker 的扫描根
> （非递归，17 个 marker 见 §11.6）。**新增模块会增加 detected marker 数量**，
> 而 `isCovered` 的第三条短路是 `detectedCount === 1 && runs.length > 0`——
> 从 1 个 marker 变成 2 个，`unit-tests` 会立刻要求每个 marker 被 `covers` 或 dismissal 点名，
> 否则报 `XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED`。**动 `project.modules` 前先想清楚这一点。**

### 4.5 `contract-delta` 格式

标题必须是**英文字面量**（沿用 `spec-delta.ts` 的形态，见 §11.3——那套正则不支持中文标题），正文可中文：

```markdown
## ADDED Contract Elements

- **openapi:paths./orders/{id}/cancel.post** — 取消订单
  - module: api
  - consumers: [web]

## MODIFIED Contract Elements

- **openapi:components.schemas.Order.properties.status** — 新增枚举值 UNDER_REVIEW
  - module: api
  - breaking: false
  - before: `PENDING | PAID | SHIPPED`
  - after: `PENDING | UNDER_REVIEW | PAID | SHIPPED`

## REMOVED Contract Elements

(none)

## Breaking Changes

- **BREAKING** `sql:table.orders.column.legacy_status` 计划删除
  - expand-contract：本 Change 只做 expand（双写），contract 阶段放到下一个 Change
  - decision: `evidence/conditions/contractDecisions.yaml#cbc-orders-legacy-status`

## Consumer Impact

- web：需要处理 UNDER_REVIEW；不处理会落到 default 分支，不崩
```

空节写 `(none)` 而不是留空——`outputsSatisfyArtifact`（`flow-resolver.ts:309`）要求每个产出文件
`content.trim().length > 0`，且 `(none)` 是一条断言，与 `entries: []` 同理。

---

## 5. 治理机制映射

### 5.1 全景

```text
┌─ 轨道 A：阶段治理 ────────────────────────────────────────────────────┐
│  design   produces: [design, contract-delta]                         │
│           gates:    [contract-lint]                                  │
│  check    gates:    [structure, check-findings, constitution-check,   │
│                      contract-compat]                                │
│           exit.conditions: { contractDecisions: resolved }            │
│           exit.approvals:  [planning-solid]        ← 已有，不动        │
│  verify   gates:    [structure, unit-tests, contract-drift,          │
│                      module-boundaries]                              │
│  archive  syncContracts: true                       ← P2              │
└──────────────────────────────────────────────────────────────────────┘

┌─ 轨道 B：实时运行时 ──────────────────────────────────────────────────┐
│  PermissionPolicy contracts-are-integrator-only                       │
│    match.paths: [xforge/contracts/**]      ← 只管基线，不管派生物       │
└──────────────────────────────────────────────────────────────────────┘

┌─ 工作包（与轨道 B 互斥的另一半）──────────────────────────────────────┐
│  integrator_paths: [src/generated/**, migrations/**]                  │
│    ← 只管派生物，绝不含 xforge/contracts/**（§0 ③）                     │
└──────────────────────────────────────────────────────────────────────┘

┌─ 资格强制（结构性）───────────────────────────────────────────────────┐
│  quick.eligibleWhen.contractImpact: forbidden          ← P2           │
│  major.requiredWhen.anyImpact: [..., moduleContract]   ← P2           │
└──────────────────────────────────────────────────────────────────────┘

┌─ Rule 横切核实 ───────────────────────────────────────────────────────┐
│  interfaces-are-contract-governed (must)                              │
│    → RuleCoverage.coverage 诚实报告 verified / guarded / uncovered      │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 四道 Gate

| Gate | 挂在 | 判定 | 典型实现 |
| --- | --- | --- | --- |
| `contract-lint` | design.gates | 风格/命名 | `spectral lint`、`buf lint` |
| `contract-compat` | check.gates | 相对合并目标的破坏性变更 + delta 声明与实际变更核对 | `oasdiff breaking`、`buf breaking --against '.git#branch=main'`、`atlas migrate lint --git-base main`、`squawk` |
| `contract-drift` | verify.gates | 实现是否符合契约 | `specmatic`、Pact provider verification、重新 codegen 后 `git diff --exit-code` |
| `module-boundaries` | verify.gates | `dependsOn` 矩阵是否被违反 | `depcruise --output-type err`、`nx lint`、ArchUnit |

**全部用 `builtin: declared`**，`gate.schema.json` 无需任何改动。

> ⚠️ **必须挂 `stage.gates` 而不是 `stage.exit.gates`**：
> `core/flow-resolver.ts:86-98` 的 `flowArchiveOperation` 计算 `mandatoryGates` 时**只读 `verify?.gates`**，
> 不含 `verify.exit.gates`。挂错位置，archive 的 Gate 重跑就不覆盖它。
> （而 `control-plane.ts:336` 的 undeclared 检查两者都读，所以这个错误不会被那条 info 提醒。）

> ⚠️ **`spec.required` 必须为 `true`**。`gate.schema.json` 把它标注为
> `"deprecated": true, "description": "Ignored. Nothing in the CLI reads it."`，
> **但这个描述与源码矛盾**：`core/verification.ts:61` 与 `commands/verification.ts:248` 都读它——
> ```ts
> if (spec?.builtin !== 'declared' || !spec.required) continue;   // verification.ts:61
> ```
> 设成 `false` 会让这道 Gate 从 `undeclaredRequiredGates` 的检查里消失，
> 于是 `XFORGE_VERIFICATION_GATE_UNDECLARED`（info，`control-plane.ts:335-347`）不再提示。
> Gate 调度本身确实不读它——两句话都对，但结论是**照样要写 `true`**。

> ⚠️ **refuse 在 `blockedBy` 里表现为 `gate:<id>:failed`，与真失败不可区分**。
> `gateBlockReason`（`control-plane.ts:369-375`）只有三个返回值：
> ```ts
> if (!evidence) return 'missing';
> if (evidence.status !== 'passed') return 'failed';
> if (evidence.contentRevision !== contentRevision) return 'stale';
> ```
> `GateEvidence.status` 的类型是 `'passed' | 'failed'`（`types/governance.ts:35`），**没有 refused**。
> 一次 refuse 写出来的 Evidence 长这样（`runners/gate.ts:342-351`，逐字）：
>
> | 字段 | 值 |
> | --- | --- |
> | `command` | `["builtin:declared:contract-compat"]` ← 单元素，非真实 argv |
> | `exitCode` | `1` |
> | `stdout` | `""` |
> | `stderr` | `notDeclaredReason(...)` ← **拒绝文本写在 stderr** |
> | `status` | `"failed"` |
>
> 同时另发一条 `XFORGE_VERIFICATION_NOT_DECLARED`（error），**其 `path` 是 `xforge/manifest.yaml`**
> 而不是 Evidence 路径（`gate.ts:494-501`），并附一个 `declare-verification` 的 `NextAction`
> （`actor: 'human'`，`gate.ts:516` 只在 `status === 'failed' && declaredRefusal` 时给）。
> **要在工具里区分 refuse 与 fail，看诊断码，不要看 `blockedBy`。**

### 5.3 关键决策：契约基线归 PermissionPolicy，派生物归 integrator_paths

§0 ③ 的互斥约束逼出这个划分，而它恰好是**更正确**的：

| 路径 | 归谁 | 理由 |
| --- | --- | --- |
| `xforge/contracts/**` | **PermissionPolicy**（`fs.write` deny） | Change 期间**任何人都不该写它**——delta 是 Artifact，基线合并由 CLI 在 archive 时做（`syncContracts`）。这与 `xforge/specs/**` 完全同构：`protectedWritePaths`（`work-packages.ts:226-261`）的固定基集里就有 `${specsPath}/**` |
| `src/generated/**`、`migrations/**` | **`integrator_paths`** | 这些是派生物，需要在 Apply 阶段由一个 integrator 包重新生成，要有 delivery 记录、verify 和 done_when |

于是「冻结契约再并行」变成：**contract-freeze 包重算派生物**，而不是改基线。

`integrator_paths` 的五条代码校验（`core/work-packages.ts`）：

1. 声明了路径却没有 `role: integrator` 包 → `XFORGE_WORK_PACKAGE_INTEGRATOR_UNTRACKED`（:798-806）
2. worker 的 write_path 与之潜在重叠 → `XFORGE_WORK_PACKAGE_SHARED_WRITE`（:947-956），
   判定用 `patternsPotentiallyOverlap`（:45-51）——**任一侧有 glob 就退化成比 `staticPrefix`，宁枉勿纵**
3. integrator 的 write_path 必须 `patternWithinScope` 于某条 `integrator_paths`，否则
   `XFORGE_WORK_PACKAGE_INTEGRATOR_WRITE_UNRESERVED`（:926-934）
   > ⚠️ `patternWithinScope`（:34-43）**只支持以 `/**` 结尾的 glob scope**：
   > ```ts
   > if (!scope.endsWith('/**')) return false;
   > ```
   > 所以 `integrator_paths` 必须写 `src/generated/**`，写 `src/generated/*` 会让所有 integrator write_paths 判定失败
4. 两个 integrator 包必须**有序**（任一方向在 `depends_on` 传递闭包里可达），否则
   `XFORGE_WORK_PACKAGE_INTEGRATOR_CONCURRENT`（:773-783，规则是并发性不是数量）
5. 所有 write_paths 必须落在 `change.yaml` 的 `scope.paths` 内，否则
   `XFORGE_WORK_PACKAGE_OUTSIDE_CHANGE_SCOPE`（:915-917）——**integrator 包同样受此约束**

### 5.4 exit condition：破坏性变更必须有具名人拍板（零改码）

`evaluateExitCondition`（`core/control-plane/conditions.ts:117-198`）是通用台账读取器。
key 须匹配 `CONDITION_KEY_PATTERN`（:24）：

```
/^[A-Za-z0-9][A-Za-z0-9._-]*$/
```

台账路径按 **`yaml` → `yml` → `json`** 顺序找第一个存在的：

```
<changesPath>/<changeId>/evidence/conditions/<key>.yaml
```

所以 `contractDecisions: resolved` **不需要一行代码**：

```yaml
# <change>/evidence/conditions/contractDecisions.yaml
condition: contractDecisions
entries:
  - id: cbc-orders-legacy-status
    question: 删除 orders.legacy_status 会打断哪些消费者？是否走 expand-contract？
    decision: >-
      走 expand-contract：本 Change 只做 expand（新增 status 并双写），
      删除 legacy_status 放到下一个 Change，保留一个发布周期。
    decidedBy: zhang@example.com
    decidedAt: 2026-09-02T09:12:00Z
```

**四个字段名是硬编码的，没有别名**（`entryDecidedReason`，`conditions.ts:47-57`）：

```ts
['question', 'decision', 'decidedBy', 'decidedAt']
```

`resolvedBy` / `approvedBy` 是**别的**台账（`check-findings` / `constitution-check`）的字段，
在这里完全不被读。`decidedAt` 必须 `Date.parse` 可解析；`decidedBy` 必须命中 `KnownIdentities`。

`entries: []` = 「本 Change 没有需要拍板的契约变更」，是一条断言。
`ledger.status` 缺省 `'resolved'`（:195），与 `exit.conditions` 的 value 做**严格字符串相等**比较。

> ⚠️ **两个必须写进 Skill 指引的陷阱**：
>
> 1. **写错 key 是静默的。** `core/ledger.ts` 有一套近似拼写提示（`resolveBy` → `resolvedBy`），
>    但 `conditions.ts` **完全不 import `ledger.ts`**。conditions 台账里的错别字不会得到任何提示。
> 2. **`KnownIdentities` 为空时静默放行且无 warning。** `unknownIdentityReason`
>    （`ledger-identity.ts:115-136`）在 `known.empty` 时对任何非空名字返回 `null`。
>    `unverifiableIdentityWarning`（:102-105）返回的是**裸字符串不是 Diagnostic**，
>    且 `evaluateExitCondition` **从不调用它**。所以全新 Change（无提交、无 receipt）里
>    随便写个名字，condition 直接 `satisfied`，`blockedBy` 里什么都不出现——
>    直到第一次提交建立比对集合后，同样的内容立刻被拒。**一开始就写真实身份。**

### 5.5 Rule 与 coverage

`rule.schema.json` 的 `scope.paths` 有一条容易误用的语义（schema description 原文）：

> `paths` is **NOT** matched against the repository: XForge compares it with the paths a Change
> declares in its own `change.yaml`, and the Rule applies when the two share a root.

同时 Adapter 会把同一份 list 当成宿主的文件匹配器（Claude `paths:` / Copilot `applyTo:` / Cursor `globs:`），
**所以这个 list 必须同时讲得通**。

`enforcement` 必填 `gateRefs` 和 `policyRefs`（`approvalRefs` 可选）。两条加载期校验：

- `severity: must` 且三种覆盖全空 → `XFORGE_RULE_NOT_ENFORCED`（**warning**，`resource-loader.ts:111-121`）
- `gateRefs` 引用未登记 Gate → `XFORGE_RULE_GATE_DISABLED`

按 `types/governance.ts:112-131`，`RuleCoverage.coverage` 的取值是
`instructed | guarded | verified | approved | uncovered | unenforceable`。

---

## 6. P1 落地物（不改 CLI 代码）

字段形状**已逐条对照 schema 与源码核实**。

### 6.1 `xforge/scaffold/gates/contract-compat.yaml`

```yaml
# Runs what this project declared under `manifest.verification.contract-compat`, and refuses when it
# declared nothing. Contract dialects differ per project (OpenAPI, protobuf, SQL, TS API reports),
# and no list of dialects inside the CLI would change that — it would only move the edge.
#
# `required: true` is load bearing despite the schema calling the field ignored: core/verification.ts
# reads it to decide whether an undeclared Gate is worth reporting. Gate scheduling genuinely does
# not read it; the undeclared check does.
apiVersion: xforge.dev/v1alpha1
kind: Gate
metadata:
  name: contract-compat
  version: 1
spec:
  required: true
  builtin: declared
  timeoutSeconds: 600
  maxOutputBytes: 16384
  evidence: contract-compat.json
```

`contract-lint` / `contract-drift` / `module-boundaries` 三份同形，只改 `metadata.name` 与
`spec.evidence`（`contract-lint.json` / `contract-drift.json` / `module-boundaries.json`）。

`evidence` 的 pattern 是 `^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$`，四个名字都合法。
Evidence 落在 `${changesPath}/${changeId}/evidence/${spec.evidence}`（`control-plane.ts:56`）。

### 6.2 `xforge/scaffold/policies/contracts-are-integrator-only.yaml`

```yaml
# An advisory guardrail on an Agent's own tool calls, not a structural boundary — the same caveat
# protected-files carries: the runtime Hook inspects a tool call's structured file-path parameter,
# so a `shell` call writing these paths indirectly (`cat >`, `tee`, `cp`) is not caught. `exceptActors`
# additionally withholds this policy from every static projection; only the XForge runtime Hook bridge
# honours it. The binding check for contracts is the contract-compat Gate.
#
# Deliberately NOT listed: src/generated/**, migrations/**. Those are derived output reserved through
# the work-package plan's integrator_paths. A path cannot be in both — core/work-packages.ts refuses an
# integrator package whose write_paths overlap a governance path (XFORGE_WORK_PACKAGE_SHARED_WRITE),
# and the diagnostic says so: "Reserve nothing for it in integrator_paths either."
apiVersion: xforge.dev/v1alpha2
kind: PermissionPolicy
metadata:
  name: contracts-are-integrator-only
  version: 1
spec:
  capability: fs.write
  effect: deny
  match:
    paths:
      - xforge/contracts/**
  exceptActors: [integrator]
  reason: >-
    The contract baseline has one authorized writer, and during a Change that writer is the CLI: a
    Change declares its interface delta in contract-delta, and archive merges it. A Worker editing the
    baseline leaves every other package implementing against an interface that no longer holds.
```

### 6.3 `xforge/scaffold/rules/interfaces-are-contract-governed.yaml`

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Rule
metadata:
  name: interfaces-are-contract-governed
  version: 1
spec:
  severity: must
  instruction: >-
    Interfaces between modules — HTTP APIs, event schemas, database table structure, and symbols one
    module exports to another — are defined only by the baseline under xforge/contracts/. A Change that
    alters one declares it in its own contract-delta first, and the implementation references the
    contract rather than restating it. Never edit the baseline directly: archive merges the delta.
    When implementation and contract disagree, change the implementation; changing the contract is
    itself a governed decision needing a named person in evidence/conditions/contractDecisions.yaml.
    The contracts-are-integrator-only policy is a guardrail an honest Agent respects, not a boundary —
    the binding check is contract-compat, which diffs against the merge target.
  scope:
    # Matched against a Change's declared change.yaml scope.paths, not the repository — and handed to
    # the host as a native file matcher, so it has to read sensibly as both.
    paths:
      - src/**
      - migrations/**
  enforcement:
    gateRefs:
      - contract-compat
      - contract-drift
      - module-boundaries
    policyRefs:
      - contracts-are-integrator-only
    # approvalRefs left empty on purpose: contract decisions ride the contractDecisions ledger plus the
    # existing planning-solid / implementation-major approvals. Naming only one of those two would
    # report `unenforceable` under the other Flow.
```

### 6.4 Flow：新增 artifact 与 stage 改动

放进 `solid-contract.yaml`（从 `solid.yaml` v6 复制，改 `metadata.name`/`version`/`description`）。

**新增 artifact**：

```yaml
  - id: contract-delta
    generates: contract-delta.md
    description: Declare this Change's delta to the module interface baseline
    instruction: >-
      List every contract element this Change adds, modifies, or removes, addressed by its contract
      element id (kind:selector). For each: the owning module, whether the change is breaking, and the
      before/after shape. For a breaking change, give the expand-contract steps and reference the entry
      in evidence/conditions/contractDecisions.yaml that records who decided it. Never edit
      xforge/contracts/ directly — archive merges this delta. Do not restate Requirements and do not
      describe implementation. Write "(none)" under an empty section: an empty section is an assertion
      that there is nothing there, not an omission.
    outline: |
      ## ADDED Contract Elements
      ## MODIFIED Contract Elements
      ## REMOVED Contract Elements
      ## Breaking Changes
      ## Consumer Impact
```

**P1 应该加一个 marker**（这是白捡的）：

```yaml
    markers:
      - id: contract-breaking
        section: Breaking Changes
        role: declared-gap
        pattern: ['**BREAKING', '**破坏性']
```

> **为什么是 `declared-gap` 而不是新 role**：`$defs/artifactMarker.role` 枚举是
> `["requirement-coverage", "decision-alternative", "declared-gap"]`，加第四个必须改 schema（S2）。
> 而 `declared-gap` 有一个**现成的消费者**——`core/reconcile/rules.ts:130`：
> ```ts
> if (marker.role !== 'declared-gap' || !marker.pattern?.length) continue;
> const scope = sections(source.content).get(marker.section);
> if (!scope) continue;
> for (const occurrence of markerOccurrences(scope, marker)) { … }
> ```
> `reconcileDeclaredGaps(sources, findings)` 拿 `findings.flatMap(f => f.refs)` 做交叉引用，
> 报告「声明了一个 gap，但 check-findings 台账里没有对应条目」。
> **声明这个 marker 就等于免费拿到「破坏性变更必须在 findings 里有账」的核对**，零代码。
>
> ⚠️ **不要设 `minOccurrences`**：`artifact-markers.ts:195-205` 在不满足时报
> `XFORGE_ARTIFACT_MARKER_UNDERPOPULATED`（**error**）。而且有个陷阱——`minOccurrences > 0` 但没有
> `pattern` 时 `markerOccurrences` 恒返回 `[]`，必然报 0 < minimum。
> `section` 找不到只是 `XFORGE_ARTIFACT_MARKER_SECTION_MISSING`（warning）。

> **P1 不设 `validator`**：`$defs/artifactValidator` 枚举是 `["spec-delta", "outline"]`，
> 加第三个值必须改 schema（S1）。另外一个 artifact 的 `validator` **只能是一个值**——
> 不能同时 `outline` 和 `contract-delta`。

> **`generates` 必须用单文件而不是 glob**，因为 `artifact-markers.ts:124` 的短路：
> ```ts
> if ((markers.length === 0 && !enforcesOutline) || artifact.generates.includes('*')) continue;
> ```
> **任何带 `*` 的 artifact 完全跳过 marker 与 outline 校验**（下一行把 `generates` 当单一路径拼接）。
> 用了 glob，上面那个白捡的 RC-4 核对也一起没了。
> 若将来要按契约域拆多文件（`contracts/**/*.md`），这是必须付的代价。

**stage 改动**：

```yaml
  - id: design
    skill: xforge-design
    authority: planning-write
    requires: [propose]
    produces: [design, contract-delta]         # 必须恰好一个 stage 产出它，见下
    gates: [contract-lint]
    reworkTo: [propose]

  - id: check
    skill: xforge-check
    authority: assurance-write
    requires: [design]
    produces: [check-report, check-findings, constitution-check]
    gates: [structure, check-findings, constitution-check, contract-compat]
    reworkTo: [propose, design]
    exit:
      conditions:
        contractDecisions: resolved
      approvals: [planning-solid]

  - id: verify
    skill: xforge-verify
    authority: assurance-write
    requires: [apply]
    produces: [assurance]
    gates: [structure, unit-tests, contract-drift, module-boundaries]
    reworkTo: [apply]
    exit:
      conditions:
        verificationReceipt: passed
```

`stageGraphDiagnostics`（`flow-resolver.ts:103-211`）会校验的相关项：

- artifact 必须被**恰好一个** stage 的 `produces` 列出：0 个 → `XFORGE_FLOW_ARTIFACT_UNPRODUCED`，
  >1 个 → `XFORGE_FLOW_ARTIFACT_MULTIPLE_PRODUCERS`
- `stage.requires` 不能指向数组里更靠后的 stage → `XFORGE_FLOW_STAGE_FORWARD_DEPENDENCY`
- `stage.exit` 存在时必须含 `conditions|gates|approvals|auditEvents` 之一 → 否则 `XFORGE_FLOW_EXIT_UNSTRUCTURED`
- 必须有 `propose` / `apply` / `verify` 三个 stage → `XFORGE_FLOW_STAGE_REQUIRED`

> ⚠️ **`produces` 的顺序有语义**：`flowArtifacts`（`flow-resolver.ts:45-60`）用 `earlierInStage`
> 给同 stage 内后列出的 artifact 自动加上先列出者的依赖。`[design, contract-delta]` 意味着
> contract-delta 依赖 design 先完成。

> ⚠️ **Gate 时序陷阱**：Gate Evidence 绑定运行当刻的 `contentRevision`。必须在**最后一次写入之后、
> 一次性**跑完本 Stage 的全部 Gate。先跑一个 → 改 Artifact → 再跑下一个，会让先跑的变 `stale`，
> 结果是**所有 Gate 都报 passed，Stage 却出不去**。`commands/check.ts:549-566` 现在会在 `check` 时
> 就报告这种情况（而不是等到 transition）。

### 6.5 `manifest.yaml` 增补

```yaml
flow: solid-contract

scaffold:
  flows: [quick, solid, major, solid-contract, major-contract]
  gates: [structure, unit-tests, security-scan, check-findings, constitution-check,
          contract-lint, contract-compat, contract-drift, module-boundaries]
  policies: [protected-files, protected-manifest, contracts-are-integrator-only]
  rules: [..., interfaces-are-contract-governed]

verification:
  contract-compat:
    - command: ["node", "scripts/xforge-contract.mjs", "compat", "--base", "origin/main"]
      timeoutSeconds: 600
      declaredBy: zhang@example.com
      declaredAt: 2026-09-02T10:00:00Z
  contract-lint:
    - command: ["node", "scripts/xforge-contract.mjs", "lint"]
      declaredBy: zhang@example.com
      declaredAt: 2026-09-02T10:00:00Z
  contract-drift:
    - command: ["node", "scripts/xforge-contract.mjs", "drift"]
      declaredBy: zhang@example.com
      declaredAt: 2026-09-02T10:00:00Z
  module-boundaries:
    - command: ["npx", "depcruise", "src", "--config", ".dependency-cruiser.cjs", "--output-type", "err"]
      declaredBy: zhang@example.com
      declaredAt: 2026-09-02T10:00:00Z
```

**用 `xforge verification declare` 写，不要手编**（`commands/verification.ts:20-52` 的注释记录了一次
真实事故：手改少缩进一级，把 `scaffold.mcpServers` 吞进新块，`XFORGE_SCHEMA_INVALID`
→ 治理 dispatcher 拒绝所有工具调用 → 连修复都做不了）。

命令形态（从 `core/verification.ts:164-172` 的提示文案还原）：

```bash
xforge verification declare \
  --gate-name contract-compat \
  --command '["node","scripts/xforge-contract.mjs","compat","--base","origin/main"]' \
  --by "zhang@example.com"
```

`--command` 必须是 JSON 数组（`parseArgv`，:69-85），裸字符串会被
`XFORGE_VERIFICATION_COMMAND_INVALID` 拒绝——注释理由："splitting it would guess where the arguments are"。
写入是**纯 append，不去重不覆盖**（:363），写前对整个 manifest 跑 `validateSchema`，
有 error 就 `XFORGE_VERIFICATION_WRITE_REFUSED`。

> ✅ **一个确认过的好处**：`policySnapshotDigest`（`core/revision.ts:202-209`）的输入是
> ```ts
> { constitution: { version, digest }, flow, rules, policies, hooks, gates }
> ```
> **不含 manifest**。所以调整 `manifest.verification` 里的命令（换 base ref、改 timeout）
> **不会**冲掉在途 Change 的审批。把易变的部分放这里是对的。
> 反过来，Gate 资源本身、Rule、Policy、Flow 整份对象都在 snapshot 里——改它们会。

### 6.6 项目脚本 `scripts/xforge-contract.mjs`

```text
子命令：
  enumerate  [--root <dir>]     → stdout 输出 §4.2 的 JSON
  lint                          → 逐 kind 跑 lint，非 0 即失败
  compat     --base <git-ref>   → ① 取 base 侧契约（git worktree / git show）
                                  ② 双侧 enumerate，算 ADDED/MODIFIED/REMOVED
                                  ③ 与 <change>/contract-delta.md 声明核对，不一致即失败
                                  ④ 逐 kind 跑 compat 工具
  drift                         → 重新 codegen 后 git diff --exit-code；或 specmatic / pact
  freeze-check                  → 供 work-package verify 用，等价于 compat 的 ②③
```

**环境变量约束**（`core/env-safety.ts`，完整读到）：子进程只拿到 `DEFAULT_ENV_ALLOW`（36 个名字，见 §11.5）
加 `npm_config_` / `NPM_CONFIG_` 前缀，再加 Gate 与 manifest 的 allowlist。
然后是**不可覆盖的 denylist**（:23，无锚点、子串匹配、大小写不敏感）：

```js
/(?:password|passwd|secret|token|api[_-]?key|auth|credential|cookie|session|private[_-]?key)/i
```

> ⚠️ 这意味着任何名字里含 `auth` / `token` / `session` 的变量都拿不到——
> `AUTHOR`、`OAUTH_HOST`、`MY_SESSION_DIR` 全被拦。**`atlas migrate lint` 需要 dev database URL 时，
> 变量名要避开这些子串**（比如叫 `ATLAS_DEV_URL` 可以，叫 `ATLAS_DEV_AUTH_URL` 不行）。
> 被 deny 的名字**故意不出现在 `notAllowed` 报告里**（:33-37 注释：否则等于输出一份疑似秘密变量清单）。
> 三层是**并集**（`runners/gate.ts:28-35` 的 `gateEnvironment`）：
> `DEFAULT_ENV_ALLOW` ∪ `manifest.gates.env.allow` ∪ `gate.spec.env.allow`，
> prefixes 同理。顺序无语义（`allow` 进 `Set`，prefixes 用 `some(startsWith)`）。
> `ENV_DENY` 在 allow 判定之前执行，**显式 allow 加不回来**。详见 §11.8。

### 6.7 work-package 计划模板

```yaml
apiVersion: xforge.dev/v1alpha1
kind: WorkPackagePlan
integrator_paths:
  - src/generated/**          # 必须 /** 结尾，见 §5.3 第 3 条
  - migrations/**
packages:
  - id: contract-freeze
    role: integrator
    goal: 按已冻结的契约重算派生物（类型、client、migration），跑通编译
    depends_on: []
    inputs: [xforge/contracts, xforge/changes/<id>/contract-delta.md]
    write_paths: [src/generated/**, migrations/**]
    skills: [xforge-apply]
    verify: [["node", "scripts/xforge-contract.mjs", "freeze-check"]]
    done_when:
      - "派生物已重算，enumerate 输出与 contract-delta 声明一致"
      - "编译通过"

  - id: api-backend
    role: worker
    depends_on: [contract-freeze]
    inputs: [xforge/contracts, src/server]
    write_paths: [src/server/**]
    skills: [xforge-apply]
    verify: [["cargo", "test", "-p", "server"]]
    done_when: ["…"]

  - id: web-frontend
    role: worker
    depends_on: [contract-freeze]
    inputs: [xforge/contracts, src/web]
    write_paths: [src/web/**]
    skills: [xforge-apply]
    verify: [["npm", "--prefix", "web", "test"]]
    done_when: ["…"]
```

**`change.yaml` 的 `scope.paths` 必须涵盖上面所有 write_paths**，否则
`XFORGE_WORK_PACKAGE_OUTSIDE_CHANGE_SCOPE`。

`verify` 必须是 argv 数组；单字符串是废弃形态，含 shell 元字符直接
`XFORGE_WORK_PACKAGE_VERIFY_UNSAFE` 拒绝。

`done_when_evidence` 的匹配规则**不是前缀匹配**（这是随包文档的说法，源码不是）：
`evidenceReference`（`work-packages.ts:155-161`）剥掉可选的 `command:` / `path:` 前缀，
按 ` — ` / ` – ` / ` -- `（**两侧必须有空白**）切出引用，然后与 `delivery.validation[].command`
或 `changed_paths` 做**精确相等**（`Set.has`）。`file.rs:166` 这种带行号的形式有一条 fallback
（`evidenceReferenceWithoutLine`，:176-179，正则 `/^(.*[^/]):(\d+)(?:-(\d+))?$/`）。

---

## 7. P2：需要改代码的部分

### 7.1 Schema 改动清单（10 处）

| # | 文件 | 位置 | 改动 | 备注 |
| --- | --- | --- | --- | --- |
| **S1** | `flow.schema.json` | `$defs.artifactValidator`（第 51 行） | 枚举加 `"contract-delta"` | 被 `legacyArtifact`(:33) 和 `stageArtifact`(:47) 两处 `$ref`，改一处即可 |
| **S2** | `flow.schema.json` | `$defs.artifactMarker.role`（第 63 行） | 枚举加 `"contract-change"` | 同时改 `types/flow.ts:34` 的联合类型。**`role` 确有消费者**：`core/reconcile/rules.ts:39,102`（`requirement-coverage`）和 `:130`（`declared-gap`）。新 role 只有在 `rules.ts` 里被读才生效——见 §7.6 的 RC-7。**若 P1 用 `declared-gap` 已够用，可以不做 S2** |
| **S3** | `flow.schema.json` | v1alpha2 `terminal.archive`（第 213-225 行） | 加 `syncContracts: { type: "boolean" }` | `additionalProperties: false`，必改。**不要加进 `required`**（现 required 是 `["handler","authority","requires","syncSpecs"]`），否则所有存量 Flow 立即失效。v1alpha1 的 `operations.archive`（第 91-100 行）同理 |
| **S4** | `flow.schema.json` | `v1alpha2.policy.eligibleWhen`（第 119-127 行） | 加 `contractImpact: { enum: ["forbidden","allowed"] }` | `additionalProperties: false`，必改；不加进 required |
| **S5** | `flow.schema.json` | `v1alpha2.policy.requiredWhen.anyImpact.items`（第 138 行） | 枚举加 `"moduleContract"` | |
| **S6** | `change.schema.json` | `classification`（第 9-16 行） | 加 `moduleContract: { type: "boolean" }` | `additionalProperties: false`，必改。⚠️ **加进 `required` 会让所有存量 `change.yaml` 立即失效**——建议可选、缺省 falsy，由 `xforge doctor` 提示补全 |
| **S7** | `manifest.schema.json` | `project.paths`（第 44-55 行） | 加 `contracts: { $ref: "#/$defs/path" }` | `additionalProperties: false`，必改 |
| **S8** | `manifest.schema.json` | `project.modules.items.properties`（第 67-83 行） | 加 `dependsOn: { $ref: "#/$defs/idList" }` | `additionalProperties: false`，必改 |
| **S9** | `manifest.schema.json` | `scaffold.properties`（第 100-137 行） | 加 `contractKinds: { $ref: "#/$defs/idList" }` | 照 `policies` / `mcpServers` 的**可选**写法，不加进 required |
| **S10** | 新文件 | `xforge/schemas/contract-kind.schema.json` | 见 §7.3 | |
| **S11** | `lock.schema.json` + `core/lockfile.ts:90` | `paths` | 加 `contracts`。现状是 `paths: { specs, changes }` **只有两个键** | 否则 `project-loader.ts:169-175` 会持续报 `XFORGE_LOCK_PATHS_MISMATCH`（warning） |
| **S12** | `core/lockfile.ts:56-58` | `resolvedResourceEntries` 的 kind 数组 | 加 `['contract-kind', resources.contractKinds]` | 现状写死 7 类：`skill`（单独处理）+ `agent / rule / permission-policy / hook / gate / script`。**`mcpServers` 已经不在里面**——这是既有缺口，照抄就会掉进同一个坑。不加的后果：`checker.ts:133-136` 与 `state-reader.ts:172-174` 的 `XFORGE_LOCK_RESOURCES_MISMATCH`（warning）永远不会因为 ContractKind 被改动而触发 |

> **schema 注册只有一处**：把 `'contract-kind'` 加进 `core/validator.ts:19` 的 `SCHEMA_NAMES` 数组。
> `SchemaName` 类型由数组推导（:26），文件按 `${name}.schema.json` 从 `../../schemas` 读（:48）。
> 该文件 :9-18 的注释专门解释了为什么只留一个添加点。
> ⚠️ `buildValidators` 一次性编译全部（:47-50），**任何一个名字缺文件，第一次 `validateSchema` 调用就整体抛 ENOENT**。

> **诊断码不需要注册**：`core/diagnostics-catalogue.ts` 读的是 `dist/diagnostics.json`，
> 由 `scripts/build-diagnostics.mjs` 在 build 时**扫描源码里的 `diagnostic(...)` 调用点**生成。
> 新增 `XFORGE_CONTRACT_*` 码只要写 `diagnostic('XFORGE_CONTRACT_…', …)` 即可，`xforge explain` 自动认识。

### 7.2 新增 core 模块

| 新文件 | 照着写 | 职责 |
| --- | --- | --- |
| `core/contract-delta.ts` | `core/spec-delta.ts`（358 行） | 解析 `contract-delta.md`，导出 `contractDeltaIsValid` / `isContractDeltaArtifact` / `validateContractDeltaSource` / `parseContractDelta` |
| `core/contract-merger.ts` | `core/spec-merger.ts`（273 行） | 规划基线合并，**纯函数不写盘**，返回 `SpecMutation` 同形的 `{ path, content, change }` |
| `core/contract-kinds.ts` | `core/resource-loader.ts` + `core/toolchain.ts` | 加载 ContractKind，spawn `enumerate` 等命令，缓存元素清单 |

**`spec-delta.ts` 里必须照抄的不变量**（:42-50 的注释明说正则形状要与 merger 保持一致）：

```ts
const SECTION_HEADER = /^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements[ \t]*$/;
const OTHER_SECTION_HEADER = /^## /;
```

契约版对应：

```ts
const SECTION_HEADER = /^## (ADDED|MODIFIED|REMOVED) Contract Elements[ \t]*$/;
```

**不支持中文标题**（全是英文字面量，无 i18n 表）——这是既有约束，照做。

`isContractDeltaArtifact` 照 `isSpecDeltaArtifact`（`spec-delta.ts:341`）写：

```ts
export function isContractDeltaArtifact(artifact: ArtifactDefinition): boolean {
  if (artifact.validator) return artifact.validator === 'contract-delta';
  const generates = artifact.generates.replaceAll('\\', '/');
  return generates.startsWith('contracts/') && generates.endsWith('.md');
}
```

因为 `isSpecDeltaArtifact` 的第一分支是 `if (artifact.validator) return artifact.validator === 'spec-delta';`，
声明 `validator: 'contract-delta'` 的 artifact 会被它正确判为 false，**两者不会互相误判**。

**`spec-merger.ts` 的 `ConflictSink` 双读模式必须照抄**（:29-35）：

```ts
type ConflictSink = (item: Diagnostic) => void;
/** The archive reading: the first conflict ends the plan. */
const THROW_ON_CONFLICT: ConflictSink = (item) => { throw new XForgeError(item); };
```

archive 走 `THROW_ON_CONFLICT`，`check` 走收集模式，**跑的是同一个 merge**——注释明说不允许出现第二套实现。
另外每文件一个 `conflicted` 标志（:197-198），冲突文件不产出任何 mutation。

### 7.3 `contract-kind.schema.json` 与资源加载

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://xforge.dev/schemas/v1alpha2/contract-kind.schema.json",
  "type": "object", "additionalProperties": false,
  "required": ["apiVersion", "kind", "metadata", "spec"],
  "properties": {
    "apiVersion": { "enum": ["xforge.dev/v1alpha2"] },
    "kind": { "const": "ContractKind" },
    "metadata": { "$ref": "#/$defs/metadata" },
    "spec": {
      "type": "object", "additionalProperties": false,
      "required": ["match", "enumerate", "timeoutSeconds"],
      "properties": {
        "match":      { "$ref": "#/$defs/stringList" },
        "enumerate":  { "$ref": "#/$defs/argv" },
        "lint":       { "$ref": "#/$defs/argv" },
        "compat":     { "$ref": "#/$defs/argv" },
        "drift":      { "$ref": "#/$defs/argv" },
        "workingDirectory": { "$ref": "#/$defs/path" },
        "timeoutSeconds":   { "type": "integer", "minimum": 1, "maximum": 3600 },
        "maxOutputBytes":   { "type": "integer", "minimum": 1024, "maximum": 1048576 },
        "env": { /* 与 gate.schema.json 的 env 同形 */ }
      }
    }
  },
  "$defs": {
    "argv": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
    "metadata": { "type": "object", "additionalProperties": false, "required": ["name"],
                  "properties": { "name": { "$ref": "#/$defs/id" }, "version": { "type": ["string","integer"] } } }
  }
}
```

TS 接口照 `types/resource.ts:96-117` 的 `GateResource` 写（四段式 `apiVersion`/`kind`/`metadata`/`spec`，
`types/resource.ts:8-14` 的注释说明这是所有资源共享的形状，"a new kind that does not share it would
have to teach every one of those layers about itself"）。

**`resource-loader.ts` 的改动（8 处，全部机械）**：

1. `SelectedResources`（:21-31）加 `contractKinds: Map<string, { value: ContractKindResource; yamlPath: string }>`
2. `loadFlatResource` 的 `kind` 联合类型（:35）加 `'contract-kinds'`
   —— 目录名 `xforge/scaffold/contract-kinds/<id>.yaml` 由 :40 自动得出，
   `kind.replace(/s$/, '')`（:45）得到 `contract-kind`，报错文案正确，**无需碰 `policies` 特例**
3. `loadSelectedResources` 里 `const contractKinds = new Map<…>()`
4. 加载循环，照 `mcpServers`（:149-153）的可选列表写法：
   ```ts
   for (const id of project.manifest.scaffold.contractKinds ?? []) {
     const loaded = await loadFlatResource<ContractKindResource>(project, 'contract-kinds', id, 'contract-kind');
     diagnostics.push(...loaded.diagnostics);
     if (loaded.value) contractKinds.set(id, { value: loaded.value, yamlPath: loaded.yamlPath });
   }
   ```
5. return 语句（:180）加 `contractKinds`
6. `spec.workingDirectory` 照 gates（:141-144）做 `normalizeRelative` + `safeResolve`
7. argv 安全检查照 `work-packages.ts:834-844`
8. `src/types.ts` 加 re-export【未读，但按现有 import 形式几乎肯定需要】

`loadFlatResource` 自带的五道校验（:39-49）自动生效：`assertResourceId`、`safeResolve`、
文件缺失 → `XFORGE_RESOURCE_MISSING`、`validateSchema` → `XFORGE_SCHEMA_INVALID`、
`metadata.name !== id` → `XFORGE_RESOURCE_NAME_MISMATCH`。

> ⚠️ **「存在于 scaffold/ 但没登记进 manifest」没有任何检查**——`resource-loader.ts` 全程不做目录扫描
> （无 `readdir` / `fg`），只按 manifest 的 id 列表驱动。这是既有行为，不是本方案引入的。

**是否把 ContractKind 加进 `policySnapshotDigest`（`core/revision.ts:202-209`）**：

**建议加。** 理由：ContractKind 的 `compat` / `enumerate` 命令决定了判定标准，改它等于改变了
「什么算破坏性变更」，既有 Gate Evidence 与 Approval 就该失效——与 `gates` 进 snapshot 同理。
代价是改适配器会冲掉在途审批（§10 R3）。这个分层反而更精确：

| 放哪 | 进 snapshot？ | 改它的代价 |
| --- | --- | --- |
| `manifest.verification` 的命令、timeout、base ref | ❌ | 无 |
| ContractKind 的 `enumerate` / `compat` 逻辑 | ✅（建议） | 冲掉在途审批 |
| Gate 资源、Rule、Policy、Flow | ✅（现状） | 冲掉在途审批 |

### 7.4 资格判定：`contractImpact` / `moduleContract`

**先说一条必须写进文档的事实：`eligibleWhen` / `requiredWhen` 纯读 `change.yaml` 的自报值，
不与实际改动或 git diff 做任何核对。**

```ts
// core/checker.ts:32-34
const IMPACT_KEYS = ['security', 'privacy', 'publicApi', 'dataMigration'] as const;
function activeImpacts(classification) { return IMPACT_KEYS.filter((key) => classification[key]); }

// core/checker.ts:79-80（eligibilityProblems 内）
if (eligible.criticalImpacts === 'forbidden' && activeImpacts(config.classification).length > 0)
  problems.push('critical impacts are forbidden');
if (eligible.maxModules !== undefined && config.scope.modules.length > eligible.maxModules)
  problems.push(`module count exceeds ${eligible.maxModules}`);
```

`requiredWhen` 是 **OR**：`required.risk?.includes(risk) || required.anyImpact?.some(…)`（:66-73）。

诊断码两个：`XFORGE_FLOW_TOO_WEAK` / `XFORGE_FLOW_REQUIRED_POLICY`，
**三处拦截点**：`checker.ts:211`（`xforge check`）、`state-reader.ts:237`（`xforge state`）、
`commands/transition.ts:106`（**硬拦截**，:186 `const ready = !diagnostics.some(item => item.severity === 'error')`，
不 ready 就早退不写 receipt）。注释（:103-104）："A Change whose classification outgrew its Flow must
fail here, at the first Stage transition, rather than after all implementation work is done at archive time."

**改动清单（精确到行）**：

新增 `classification.moduleContract`：

1. `schemas/change.schema.json` `classification.properties`（S6）
2. `src/types/change.ts:14-20` — `ChangeConfig['classification']` 接口
3. **`src/core/checker.ts:32`** — 加进 `IMPACT_KEYS`。加进去后 `activeImpacts`、
   `criticalImpacts: forbidden`、`requiredWhen.anyImpact` **三处同时生效，函数体不用改**
4. `schemas/flow.schema.json` 的 `requiredWhen.anyImpact` 枚举（S5）+ `src/types/flow.ts:126` 的联合类型
5. **`src/commands/state.ts:149`** — 这里有**第二份独立的硬编码 impact 列表**
   `(['security','privacy','publicApi','dataMigration'] as const)`，与 `IMPACT_KEYS` **不共享常量**，
   必须手工同步。`state.ts:75` 的 `classification?` 内联类型也要改
6. `core/flow-resolver.ts:402` 是整体透传，**不用改**

新增 `eligibleWhen.contractImpact`：

1. `schemas/flow.schema.json` `eligibleWhen.properties`（S4）
2. `src/types/flow.ts:119-123`
3. **`src/core/checker.ts:76-82` 的 `eligibilityProblems`** —— 唯一读 `eligibleWhen` 的函数，加分支与文案
4. `flowEligibilityDiagnostics`（:89-124）**不用改**（它只拼装 `problems`）
5. `scaffold/payload/xforge/flows/quick.yaml` 的 `policy.eligibleWhen` 加 `contractImpact: forbidden`

> 因为是自报，①必须配②：**quick 的 `verify.gates` 也要挂 `contract-compat`**，
> 让「自报 false 但实际改了契约」表现为 Gate failed，而不是静默通过。

### 7.5 archive：`syncContracts`

`archiver.ts` 的三个阶段：`planArchive`（:110-181）→ `executeArchive`（:207-258）→
`applyArchiveTransaction`（:183-205）。

**改动点一：`planArchive:175`**

```ts
// 现状
const mutations = structure.change?.archive.syncSpecs ? await planSpecMutations(project, changeId) : [];
// 改为
const specMutations = structure.change?.archive.syncSpecs ? await planSpecMutations(project, changeId) : [];
const contractMutations = structure.change?.archive.syncContracts ? await planContractMutations(project, changeId) : [];
const mutations = [...specMutations, ...contractMutations];
```

**必须遵守的三条既有顺序约束**：

1. **早退栅栏在第 168-170 行，syncSpecs 在第 175 行**——即 `planSpecMutations` 只在结构/治理/任务
   全部无 error 时才跑。`planContractMutations` 必须放在同一位置之后，不能提前。
2. **`executeArchive` 会规划两次**（:213 和 :239，同一份 `auditFacts`），
   所以 `planContractMutations` 必须是**幂等的只读函数**——`planSpecMutationsWith` 就是这样
   （只 `readFile` + `exists`）。
3. **所有写盘都在 `rename` 之前**（:189-195）。Change 目录一旦被移走，
   `${changesPath}/${changeId}/contract-delta.md` 就不在原位；任何读 delta 的动作必须在 move 之前。

**改动点二：`applyArchiveTransaction` —— 可以零改**

只要 contract mutation 复用 `SpecMutation` 的 `{ path, content, change }` 形状并拼进 `plan.mutations`，
备份（:184）和回滚（:199-202）自动覆盖，**一行都不用改**：

```ts
const backups = await Promise.all(plan.mutations.map((item) => backup(project, item.path)));
try {
  for (const mutation of plan.mutations) {
    if (mutation.content === null) await rm(await safeResolve(project.root, mutation.path), { force: false });
    else await atomicWrite(project.root, mutation.path, mutation.content);
  }
  await rename(source, target); moved = true;
} catch (error) {
  if (moved) await rename(target, source).catch(() => undefined);
  for (const item of backups.reverse()) { /* 逆序还原 */ }
  throw error;
}
```

**千万不要另写一个事务**——spec 写成功、contract 写失败时 contract 不会被还原。

**改动点三：`data.specs` 的污染**

`executeArchive` 返回的 `data.specs`（:216, 233, 242, 254）是 `plan.mutations.map(item => item.path)`。
混进 contract 后要么接受，要么给 mutation 加个 `kind` 字段并按类型过滤出 `data.contracts`。

**archiver 之外的连带改动**：

| 文件 | 改什么 |
| --- | --- |
| `core/flow-resolver.ts:86-98` | `flowArchiveOperation` 返回类型加 `syncContracts`，从 `flow.terminal.archive.syncContracts` 读；legacy 分支从 `flow.operations.archive` 读 |
| `core/flow-resolver.ts:407-412` | `state.archive` 对象加 `syncContracts` |
| `types/flow.ts:74,142`、`types/change.ts:47` | 加字段 |
| `core/flow-resolver.ts:309-327` | `outputsSatisfyArtifact` 加一条：`if (validateContract && !contractDeltaIsValid(content)) return false;` |
| `core/checker.ts:217,225-226` | 加 `validateChangeContractDeltas(project, changeId)` 与 `if (resolved.state.archive.syncContracts) validateContractMergeFeasibility(...)`，照 spec 的两处调用写 |
| `core/project-loader.ts:135-139,177-190` | 加 `contractsPath` / `contractsPathSource`，`DEFAULT_CONTRACTS_PATH = 'xforge/contracts'` 加进 `src/constants.ts`（照 :23-24） |
| `core/path-safety.ts:28-51` | `assertLogicalPaths(specs, changes)` **现在是两参**，做两件事：① 三向互斥（`left === right \|\| left.startsWith(right+'/') \|\| right.startsWith(left+'/')` → `XFORGE_PATHS_OVERLAP`）；② 都不能落在 `GENERATED_ROOTS` 里（→ `XFORGE_PATH_GENERATED_TARGET`）。加 contracts 要改成三参并做三两两比较——**已导出的 `pathsOverlap(l, r)`（:120-124）就是同一个判定，直接复用** |
| `core/state-reader.ts:311-314` | `project.paths` 输出加 `contracts: { value, source }` |
| `core/state-reader.ts:291-300` | `resourceSummary` 加 `'contract-kinds'`（键名风格照 `'mcp-servers'`）；`StateOptions.kind`（:157）同步 |

### 7.6 reconciliation：契约的「声称 vs 实际」

`xforge brief` 已被删除（§0 ②）。正确的落点是 `core/reconcile.ts` 的 `reconcileChange()`，
由 `commands/check.ts:541-547` 调用：

```ts
if (options.change && control && isStageFlow(control.flow)) {
  const reconciliation = await reconcileChange(project, options.change, control.flow, control);
  diagnostics.push(...reconciliation.diagnostics);
  nextActions.push(...reconciliation.nextActions);
}
```

**现有六条规则**（`reconcile.ts:114-130` 的调用顺序即 RC-1..RC-6 的顺序）：

```ts
const observations: ReconciliationObservation[] = [
  ...reconcileResolvedFindings(findingsResult.findings, requirements, sources),
  ...reconcileRequirementAnchors(requirements, sources),
  ...reconcileCoverageSections(requirements, sources),
  ...reconcileDeclaredGaps(sources, findingsResult.findings),
  ...reconcileConstitutionReferences(principles, requirements, sources, gatePassed,
                                     existingPaths, resolvesOnDisk, declaredGateIds, gateRecorded),
  ...reconcileMaterialDecisions(await readMaterialDecisions(project, changeId), sources),
];
```

**架构**：读取层（`reconcile/sources.ts`，async）与判定层（`reconcile/rules.ts`，**纯同步函数**）
是两个模块，互不 import；`reconcile/model.ts` 放共享的行类型，注释说明这样"lets the reading layer
and the judging layer be separate modules without either importing the other"。

**新增 RC-7 的完整改动清单**：

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `reconcile/model.ts:19` | `type ReconciliationRule = 'RC-1' \| … \| 'RC-6'` → 加 `\| 'RC-7'`。**这是个字面量联合，不加编译不过** |
| 2 | `reconcile/model.ts` | 加一个行类型 `ContractElement { ceid, kind, digest, file?, label? }`，与 `SpecRequirement` / `LedgerFinding` 平级 |
| 3 | `reconcile/sources.ts` | 加 `readContractElements(project, changeId)`：跑 base/head 两侧 `enumerate`，返回 `{ declared, actual, unavailable }`。**必须返回 `unavailable: SourceUnavailable[]`**——`reconcile.ts:54-64` 的注释说明为什么不能静默跳过：否则「两份记录一致」和「其中一份打不开」不可区分 |
| 4 | `reconcile/rules.ts` | 加 `reconcileContractDelta(declared, actual, sources)`，**纯同步**，返回 `ReconciliationObservation[]` |
| 5 | `reconcile.ts:114-130` | 把新规则加进 observations 数组 |

**`ReconciliationObservation` 的形状**（`model.ts:36-44`）：

```ts
{ id: string; rule: 'RC-7'; code: string; provenance: 'computed';
  /** States the difference between two records. Never says whether it is a problem. */
  summary: string; refs: string[]; }
```

`reconcile.ts:132-140` 统一转成诊断：message 是 `` `${observation.rule}: ${observation.summary}` ``，
path 是 `${changesPath}/${changeId}`，**severity 恒为 `'info'`**，details 是 `{ rule, refs }`。

**RC-7 应输出的三组差异**：

```
declared-not-actual   contract-delta 声称改了它，enumerate 双侧对比没看到
actual-not-declared   enumerate 算出它变了，contract-delta 没提  ← 最有价值的一条
kind-unregistered     contract-delta 引用了未注册的 kind
```

> **RC-7 与 `contract:<ceid>:undeclared`（§7.7）的分工**：RC-7 是 `info`，只陈述差异，在 `check` 时就出现；
> `blockedBy` 是硬阻断，在 transition 时生效。两者读同一份数据，但**前者不做判决**——
> 这是 `rules.ts` 写进注释的不变量，不要在 RC-7 里破坏它。

**可复用的既有工具**：`model.ts:12-17` 的 `requirementAnchor` / `ID_SHAPED`：

```ts
const ID_SHAPED = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
export function requirementAnchor(heading: string): string {
  const [first] = heading.trim().split(/\s+/);
  return first && ID_SHAPED.test(first) ? first : heading.trim();
}
```

注释解释了它为什么拒绝非 id 形状的首 token：coverage 规则拿这个串去别的文档里搜，
一个普通英文单词会匹配到毫不相关的散文，**报告一份并不存在的覆盖**。
CEID 本身已经是 id 形状（含 `:`），锚定时直接用全串即可，不需要这层启发。

### 7.7 `blockedBy` 新增词汇

沿用现有前缀风格（完整既有词汇表见 §11.2）：

```
contract:<ceid>:undeclared        实际变更了这个元素，contract-delta 没有声明
contract:<ceid>:unknown           contract-delta 声明了它，enumerate 输出里没有
contract:<kind>:enumerate-failed  适配器枚举失败
contract:kind-missing-<kind>      contract-delta 引用了未注册的 kind
contract:baseline-drift           基线相对合并目标已变，本 Change 的 delta 需重算
```

填充点：`core/control-plane.ts:190-215` 的候选循环，照 `tree:unattributed-paths`（:205）的写法。
若要给 remedy，加进 `blockRemedy`（:391-542），注意它**至多返回一条**（按顺序早退）。

> ⚠️ `work-package` / `tree` 系列的检查**硬编码只在 `current.id === 'apply' && target === 'verify'` 时跑**（:199）。
> 契约检查若也想限定阶段，要照这个写法显式判断。

`contract:<ceid>:undeclared` 是这一整套里最有价值的一条：它对应「Agent 顺手改了个接口但没说」，
**且不需要任何 breaking-change 工具就能判定**。

### 7.8 新增 CLI 命令

```bash
xforge contract list   [--kind <k>]                # 列基线元素（走 enumerate）
xforge contract diff   --change <id> [--base <ref>] # 算真实变更集
xforge contract draft  --change <id>               # 回填 contract-delta 的机器已知部分
```

`contract draft` 值得优先做，且要照 `verification draft-receipt`（`commands/verification.ts:510-532`）
的设计：**只返回数据不写盘**（`changes: []`），且**故意不产出人该填的字段**。
那个命令的注释（:497-509）解释得很清楚——"a CLI that filled it in would be deciding the thing it is
asking about"。对应到契约：机器填元素 id 与 before/after digest，人填 `breaking` 判断、
`Consumer Impact` 和 expand-contract 计划。

---

## 8. P3：跨 Change 仲裁

`xforge contract status` —— 列出所有活跃 Change 对同一契约元素的 pending delta，冲突预警。
这是 Pact Broker `can-i-deploy` / Buf BSR / Apollo launches 那一层，业界共识是**纯 git diff 做不到**。

数据来源现成：`state-reader.ts` 已经能列 `changes`（:325-330，`changesPath` 下排除 `archive/` 和 `.` 开头的目录）
和 `activeChanges`（:331-340，含 `{ id, flow, stage, risk }`）。

**什么时候才值得做**：同时存在 3 个以上活跃 Change 时。串行居多的团队，P1 + P2 就够了。

---

## 9. 验收判据

### P1（不改 CLI）

- [ ] 故意在实现里改一个接口而不写进 `contract-delta` → `xforge check` 的 `contract-compat` 报 failed，
      `blockedBy` 含 `gate:contract-compat:failed`
- [ ] `contract-delta` 声明一个不存在的元素 id → 同上
- [ ] `contractDecisions.yaml` 缺一个 `decidedBy` → `blockedBy` 含 `condition:contractDecisions:undecided-1`，
      并附 `XFORGE_CONDITION_LEDGER_UNDECIDED_REMEDY`（warning）
- [ ] `contractDecisions.yaml` 写 `entries: []` → 该条件 satisfied
- [ ] 台账文件不存在 → `blockedBy` 含 `condition:contractDecisions:ledger-missing-expected-resolved`
- [ ] 不启用 contract Flow 的项目 → `xforge state` 无任何契约相关诊断，零 refuse
- [ ] 启用了但没 `xforge verification declare` → `contract-compat` 报 `XFORGE_VERIFICATION_NOT_DECLARED`，
      且 `state` 里有 `XFORGE_VERIFICATION_GATE_UNDECLARED`（info）
- [ ] `xforge state` 里 `interfaces-are-contract-governed` 的 `coverage` 含 `verified` 与 `guarded`
- [ ] 在 `## Breaking Changes` 写一条 `**BREAKING …` 但 `check-findings.yaml` 里没有对应条目
      → `xforge check` 输出一条 `RC-4` 的 `info` 诊断（验证 `declared-gap` marker 免费拿到的核对）
- [ ] `contract-lint` 声明了两条命令，第一条失败 → 第二条**不执行**，Evidence 的 `command`
      是第一条的 argv、`stdout` 是含 summary 行的 transcript
- [ ] work-package：worker 包声明 `write_paths: [src/generated/**]` → `XFORGE_WORK_PACKAGE_SHARED_WRITE`
- [ ] work-package：声明了 `integrator_paths` 但没有 integrator 包 → `XFORGE_WORK_PACKAGE_INTEGRATOR_UNTRACKED`
- [ ] **反例检查**：把 `xforge/contracts/**` 同时写进 PermissionPolicy 和 `integrator_paths`
      → 必须能重现 `XFORGE_WORK_PACKAGE_SHARED_WRITE`（验证 §0 ③ 的结论）

### P2（改 schema + CLI）

- [ ] 动了契约的 Change 归档后 `xforge/contracts/**` 与 delta 一致，且是**一次原子事务**
      （在 `applyArchiveTransaction` 的 contract 写入处注入异常，验证 spec 与 contract 都被回滚、Change 目录未移动）
- [ ] `classification.moduleContract: true` 的 Change 选 `quick` → `xforge transition` **硬拦截**，
      报 `XFORGE_FLOW_TOO_WEAK`，且不写 transition receipt
- [ ] 同一场景下 `xforge check` 和 `xforge state` 也各报一次（三处拦截点都覆盖）
- [ ] `xforge check` 的 RC-7 能显示「声称改了 3 个元素，实际改了 4 个」，severity 为 `info`
- [ ] `xforge contract draft` 回填的元素清单与 `enumerate` 完全一致，且**不产出 `breaking` 字段**
- [ ] 新增一个 ContractKind（如 GraphQL）**只写一份 YAML + 一个 enumerate 脚本**，不改 CLI 任何一行
- [ ] 改一个 ContractKind 的 `compat` 命令 → 在途 Change 的 Approval 失效（若采纳 policySnapshot 方案）
- [ ] 改 `manifest.verification` 里的命令 → 在途 Change 的 Approval **不**失效
- [ ] `xforge explain XFORGE_CONTRACT_DELTA_UNDECLARED` 能返回该码的全部措辞与 severity
      （验证 build 时的源码扫描生效）

---

## 10. 风险与取舍

| # | 风险 | 缓解 |
| --- | --- | --- |
| **R1** | **抽象层级错位**——业界对 SDD 最锋利的批评：工具聚焦字段级细节，产出「结构正确但与真实意图不符」的代码 | 契约只治理**跨模块**接口，模块内部一律不进。`project.modules[].dependsOn` 的依赖矩阵比 OpenAPI 的字段细节更值钱 |
| **R2** | **台账增殖** | ① `quick` 不引入任何契约机制；② `entries: []` / `(none)` 让「无变更」是便宜的断言；③ `xforge contract draft` 把机器能填的交给机器 |
| **R3** | **改 ContractKind 会冲掉在途审批**（若采纳 policySnapshot 方案） | 把易变的命令/参数放 `manifest.verification`（不进 snapshot），只把判定逻辑放 ContractKind。适配器变更当成一次「发布窗口」，在无未归档 Change 时做 |
| **R4** | **PermissionPolicy 不是结构性边界**——`protected-files.yaml` 自述：Hook 只看结构化 file_path 参数，`cat >` / `tee` / `cp` 这类间接写入不被捕获；`exceptActors` 还让它退出所有静态投影 | 写进 Rule 的 instruction；把 `contract-compat` 当主要防线 |
| **R5** | **首次基线抽取成本**，抽不准会让第一批 Gate 全红 | 用**基线快照流派**起步：先 `enumerate` 一次冻结现状，只卡新增的未声明变更，不追求契约本身正确（对照 `dependency-cruiser --ignore-known` / ArchUnit `FreezingArchRule`） |
| **R6** | **Gate 只证明命令跑过了**——`contract-compat` 通过不代表接口设计对 | 既有边界，不因为「契约」听起来更硬就忘掉。RC-7 是 `info`，不做判决 |
| **R7** | **`enumerate` 的 digest 不稳定**会产生假 MODIFIED | ContractKind 实现约定写死规范化要求；`xforge doctor` 加一条：连跑两次 digest 必须一致 |
| **R8** | **新增 `project.modules` 会增加 toolchain marker**，可能让既有 `unit-tests` 突然报 `TOOLCHAIN_UNCOVERED` | §4.4 已说明。先跑一次 `xforge check` 看 detected 数量再动 modules |
| **R9** | **declared Gate 的输出无总量上限** | `maxOutputBytes` 是**每条命令、每个流**独立的（`gate.ts:102-106`），N 条声明命令拼成的 transcript 在写 Evidence 前**不再限长**，上界是 `N × 2 × maxOutputBytes`。而 Evidence 每次 `check` 都会在 Git 里留一个新 blob。契约工具（oasdiff / depcruise）容易话痨，把 `maxOutputBytes` 设小（建议 8192–16384） |
| **R10** | **成功路径丢 `outputTruncated`** | `gate.ts:395-404` 在全部命令成功时把 `outputTruncated` 硬编码为 `false`，单条命令内部的截断标记被丢弃（只有失败路径靠 `...failure` 保住）。这是既有缺陷，不是本方案引入的，但契约 Gate 输出量大会更容易撞上——不要依赖这个字段判断输出完整性 |

---

## 11. 附录：源码事实速查

### 11.1 revision 四层公式（`core/revision.ts:202-228`，逐字）

```ts
policySnapshotDigest = sha256(stableStringify({
  constitution: { version: project.constitution.version, digest: sha256(project.constitution.content) },
  flow,                                                    // 整份对象
  rules:    [...resources.rules.values()].map((i) => i.value),
  policies: [...resources.policies.values()].map((i) => i.value),
  hooks:    [...resources.hooks.values()].map((i) => i.value),
  gates:    [...resources.gates.values()].map((i) => i.value),
}));

contentRevision   = sha256(stableStringify({ change, flow: flowName, inputs, policySnapshotDigest }));
stateRevision     = sha256(stableStringify({ contentRevision, currentStage, transitionHead }));
governingRevision = sha256(stableStringify({ change, flow, stage: currentStage, inputs: governingInputs, policySnapshotDigest }));
```

`inputs` = `contentInputPaths` 排序后逐个 `{ path, digest: sha256(fileBytes) }`。
`gitHead` **不是** equivalence input（:211-215 的注释解释原因）。
`governingInputs` 只含 `change.yaml` + flow + **截至当前 Stage 产出的** artifact（`governingArtifactPaths`，:137-148）。

`selfWrittenPrefixes`（:65-70）：`${changesPath}/${changeId}/`、`xforge/.audit/`、`xforge/manifest.yaml`、`xforge/lock.yaml`。

### 11.2 `blockedBy` 完整词汇表

**transition 路径**（`control-plane.ts:178-244`）：

```
transition-chain:invalid                        ← 在 isRework 判断之外，返工也拦
artifact:${artifactId}
work-packages:unusable                          ┐
work-package:${id}:${status}                    │ 只在 current.id==='apply' && target==='verify'
tree:unattributed-paths                         ┘
gate:${gateId}:${missing|failed|stale}
condition:${key}:${reason}
approval-policy:${policyId}:missing
approval:${policyId}:rejected
approval:${policyId}:separation-of-duties
approval:${policyId}:missing-${n}
audit:${eventType}:missing
audit:chain-invalid
```

**archive 路径**（`terminalGovernanceBlocks`，:544-639，返回前 `[...new Set(blocks)]` 去重）：
上表去掉 `artifact:` / `work-package*` / `tree:`，加上

```
transition:ready-to-archive
transition:ready-receipt-missing
transition:ready-receipt-stale
audit:untrusted
audit:runtime-coverage-gap
audit:remote-pending
audit:remote-not-configured
```

`work-package:<id>:<status>` 的 status 实际可出现的是 `ready` / `blocked` / `running` / `failed`
（`succeeded` / `integrated` / `reviewed` 被判为通过）。

**`blockRemedy` 的匹配正则**（:391-542，**至多返回一条**）：

```
'transition:ready-receipt-stale'                            (includes)
/^gate:.+:stale$/                                           (some)
/^condition:([A-Za-z0-9][A-Za-z0-9._-]*):stale-(.+)$/       (find)
/^condition:independentReview:unreviewed-(.+)$/             (flatMap)
'condition:independentReview:review-missing'                (includes)
'condition:independentReview:review-stale'                  (includes)
/^work-package:(.+):ready$/                                 (flatMap)
/^work-package:(.+):failed$/                                (flatMap)
```

### 11.3 exit condition reason 完整枚举（`control-plane/conditions.ts:117-198`）

按判定顺序：

| 序 | 条件 | reason |
| --- | --- | --- |
| 1 | key 不匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` | `invalid-key`（不读盘） |
| 2 | 文件读到但解析抛错 | `ledger-unreadable`（**不 fallback 到下个扩展名**） |
| 3 | 三个扩展名都没有 | `ledger-missing-expected-${expected}` |
| 4 | 解析结果为 `null` 或非 object | `ledger-unreadable` |
| 5 | `ledger.condition` 非空且 `!== key` | `ledger-subject-mismatch` |
| 6 | `ledger.entries` 不是数组 | `entries-missing` |
| 7 | 有未决 entry | `undecided-${n}` |
| 8 | 有早于 rework cutoff 的 entry | `stale-${names.join('+')}`，name 取 `entry.id.trim()` 或 `#${index+1}` |
| 9 | `(ledger.status ?? 'resolved') !== expected` | `status-${declared}-expected-${expected}` |
| 10 | 通过 | `satisfied` |

`${expected}` 是 Flow 里 `exit.conditions` 的 **value**（如 `resolved` / `passed`）。

**走特殊路由的 key 只有 2 个**（`evaluateStageCondition`，:298-325）：
`verificationReceipt`（`VERIFICATION_RECEIPT_CONDITION`【未读常量定义，但 Flow 文件与 `verification.ts:461` 佐证其值】）
和 `independentReview`（`conditions.ts:222` 直接可读）。其余全部走通用读取器。

### 11.4 spec-delta 正则（`core/spec-delta.ts:42-50`，contract 版照抄）

```ts
const SECTION_HEADER = /^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements[ \t]*$/;
const OTHER_SECTION_HEADER = /^## /;
const REQUIREMENT_HEADER = /^### Requirement:[ \t]*(.*)$/;
const SCENARIO_HEADER = /^#### Scenario:[ \t]*(.*)$/;
const WHEN_LINE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__|\*|_)?[ \t]*WHEN(?:\*\*|__|\*|_)?[ \t]*:?[ \t]*(\S.*)$/i;
const THEN_LINE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__|\*|_)?[ \t]*THEN(?:\*\*|__|\*|_)?[ \t]*:?[ \t]*(\S.*)$/i;
```

12 个诊断码：`XFORGE_SPEC_DELTA_{FILE_EMPTY, NO_SECTION, SECTION_DUPLICATE, SECTION_EMPTY,
REQUIREMENT_UNNAMED, REQUIREMENT_DUPLICATE, REQUIREMENT_ORPHAN, SCENARIO_MISSING, SCENARIO_UNNAMED,
SCENARIO_DUPLICATE, WHEN_THEN_MISSING, RENAME_UNBALANCED}`。

### 11.5 环境变量（`core/env-safety.ts`，完整）

`DEFAULT_ENV_ALLOW`（:9-17，精确匹配、大小写敏感）：
`PATH, HOME, SHELL, USER, LOGNAME, LANG, LC_ALL, LC_CTYPE, TZ, TERM, TMPDIR, TEMP, TMP, SystemRoot,
COMSPEC, PATHEXT, USERPROFILE, APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles, ProgramFiles(x86),
NUMBER_OF_PROCESSORS, OS, CI, NODE_ENV, FORCE_COLOR, NO_COLOR, HTTP_PROXY, HTTPS_PROXY, NO_PROXY,
http_proxy, https_proxy, no_proxy, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, SSL_CERT_DIR`

`DEFAULT_ENV_ALLOW_PREFIXES`（:20）：`['npm_config_', 'NPM_CONFIG_']`

`ENV_DENY`（:23，**无锚点、子串、大小写不敏感、在所有 allowlist 之后不可覆盖**）：

```js
/(?:password|passwd|secret|token|api[_-]?key|auth|credential|cookie|session|private[_-]?key)/i
```

空值变量直接丢弃且不计入报告；被 deny 的名字**故意不出现在 `notAllowed`** 里。

### 11.6 toolchain markers（`core/toolchain.ts:34-52`，17 条，非递归）

扫描根 = 项目根 + 每个 `project.modules[].path`。

| id | file | unit-tests 建议 | security-scan 建议 |
| --- | --- | --- | --- |
| node | package.json | `npm test` | `npm audit --audit-level=high` |
| rust | Cargo.toml | `cargo test` | `cargo audit` |
| go | go.mod | `go test ./...` | `govulncheck ./...` |
| python-pyproject | pyproject.toml | `pytest` | `pip-audit` |
| python-setup | setup.py | `pytest` | — |
| maven | pom.xml | `mvn -q verify` | — |
| gradle / gradle-kts | build.gradle(.kts) | `gradle test` | — |
| ruby | Gemfile | `bundle exec rspec` | `bundle audit` |
| php | composer.json | `composer test` | — |
| elixir | mix.exs | `mix test` | — |
| swift | Package.swift | `swift test` | — |
| dotnet | global.json | `dotnet test` | — |
| cmake | CMakeLists.txt | `ctest` | — |
| zig | build.zig | `zig build test` | — |
| deno | deno.json | `deno test` | — |
| bazel | MODULE.bazel | `bazel test //...` | — |

`suggestionFor`（:97-99）只认 `unit-tests` 和 `security-scan` 两个 gate 名，其他返回 `null`——
**新增的四道契约 Gate 不会有自动建议**，必须人工 `declare`。

### 11.7 Gate Evidence 字段（`types/governance.ts:10-37`，26 个，全部必填）

```
protocolVersion('2') schemaVersion('1') gate change flow stage
stateRevision contentRevision policySnapshotDigest gitBase gitHead inputDigest
runner{name,version,integrity} command[] shell workingDirectory
startedAt finishedAt durationMs exitCode timedOut outputTruncated stdout stderr
status('passed'|'failed') digest
```

`digest = sha256(stableStringify(evidence 去掉 digest 字段))`。
`readGateEvidence`（`control-plane.ts:53-64`）的三重校验：digest 自洽 **且** `evidence.gate === gateId`
**且** `evidence.change === changeId`，任一不满足返回 `null` → `gateBlockReason` 判为 `missing`。
**篡改过 digest 的 Evidence 与文件根本不存在，在控制面看来完全一样。**

`command` 的字面量联合里**没有 `['builtin:declared']`**——declared Gate 的 Evidence 记的是实际 argv。

### 11.8 declared Gate runner 的执行细节（`runners/gate.ts`）

**三条分支，顺序固定**（`runGate`，:327-406）：

1. `plan.runs.length === 0` → 拒绝 `XFORGE_VERIFICATION_NOT_DECLARED`（:336-351）
2. `plan.uncovered.length > 0` → 拒绝 `XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED`（:352-370，结构对称）
3. 否则**顺序执行、第一条失败即 `break`**（:374-393），注释理由：失败之后的命令会跑在一个被打断的树上

**transcript 行格式**（:382-386，写在该命令 stdout **之前**）：

```
<argv.join(' ')>[ [module <id>]] -> exit <code|none> in <ms>ms (declared by <who>)
```

- `exitCode` 为 `null`（spawn 失败）时打印字面量 **`none`**
- `<ms>` 是 `Date.now()` 差值，含 `runCommand` 全部开销，不只是子进程时间
- **只 push stdout，stderr 不进 transcript**（失败时经 `failure.stderr` 单独保留）
- `suspiciouslyEmpty`（`verification.ts:233-236`）：`exitCode === 0 && durationMs < 100 && outputBytes === 0` 时追加一行提示

**最终 Evidence 组装**（:395-405）：全成功时 `command = ["builtin:declared:<gate>"]`、`exitCode: 0`、
`stdout = transcript.join('\n')`；失败时 `command` / `workingDirectory` / `shell` / `exitCode` /
`timedOut` 都取**最后那条失败命令的**，`stdout` 仍是整段 transcript。

**spawn 参数**：

| 项 | 规则 |
| --- | --- |
| `shell` | `gate.spec.shell === true`，默认 `false`。declared 的每条命令沿用 Gate 资源的值（`CommandOverride` 没有 shell 字段） |
| cwd | **覆盖不合并**：`run.workingDirectory ?? gate.spec.workingDirectory ?? '.'`（:100）。Evidence 里记相对路径 |
| timeout | **覆盖不取小**：`run.timeoutSeconds ?? gate.spec.timeoutSeconds`（:135）。run 级可以**大于** gate 级，不做钳制 |
| kill | `SIGTERM`，**1 秒后 `SIGKILL`**（:130-136）。`timedOut` 在发 SIGTERM 之前置位 |
| stdio | `['ignore','pipe','pipe']`——子进程无 stdin |
| spawn 失败 | **不 reject，走 resolve**：`exitCode: null`，stderr 记 `redact(spawnError.message)` |
| ENOENT / EACCES / exit 127 | 归类为 `unavailable` → 诊断 `XFORGE_GATE_COMMAND_UNAVAILABLE`。**不进 Evidence**（:47-67 注释：加字段会改动每一条 Evidence 的 digest 与 schema） |

诊断优先级（:494-510）：`declaredRefusal` > `unavailable` > `XFORGE_GATE_FAILED`。

**环境变量三层是并集**（`gateEnvironment`，:28-35）：

```ts
filterEnvironment({
  allow:         [...(manifest?.allow ?? []),         ...(gate.spec.env?.allow ?? [])],
  allowPrefixes: [...(manifest?.allowPrefixes ?? []), ...(gate.spec.env?.allowPrefixes ?? [])],
});
```

内部再并上 `DEFAULT_ENV_ALLOW` / `DEFAULT_ENV_ALLOW_PREFIXES`。`allow` 进 `Set`、prefixes 用
`some(startsWith)`，**顺序无语义**。`ENV_DENY` 在 allow 判定**之前**执行——显式 allow 也加不回来。
Gate 侧只取 `env`，丢弃 `filtered` / `notAllowed`，**所以不会输出「N 个变量被过滤」的诊断**。

**`appendBounded`（:37-43）保头丢尾**：`subarray(0, remaining)`，超限的 chunk 整个丢弃。
`maxOutputBytes` 默认 `MAX_GATE_OUTPUT_BYTES = 65_536`（`constants.ts:35`），
是**每次 `runCommand` 内、stdout 与 stderr 各自独立**的上限——见 R9。

### 11.9 `inputDigest` 与文件原语

**`inputDigest`**（`gate.ts:256-264` 与 `:434` 同一公式，注释明说是刻意的单一来源）：

```ts
sha256(stableStringify({ gate, revision, structurePassed }))
```

- **`gate` 是整个 GateResource 对象**——改 command / timeout / env / maxOutputBytes 都会移动 digest
- `revision` 是 `GovernanceRevision`（contentRevision / stateRevision / policySnapshotDigest / gitBase / gitHead）
- **`manifest.verification` 不在里面**。增删一条 run、改 command、改 declaredBy，只要 Gate 资源与
  revision 不动，`inputDigest` 就不变——与 `policySnapshotDigest` 的结论一致（§6.5）
- 未提交改动：**治理 Artifact 的进**（`contentRevision` 对磁盘字节做 sha256），
  **被测源码的不进**（源码只通过 `gitBase` / `gitHead` 两个 commit id 间接出现）

**`stableStringify`**（`core/hash.ts:7-23`）：递归、对象键按 `localeCompare` 排序、
`JSON.stringify(value, null, 2)`（**带缩进**）。循环引用抛 `TypeError`。

**`atomicWrite`**（`core/files.ts:50-59`）：同目录临时文件 + `rename`。
临时名 `.<basename>.xforge-<uuid>.tmp`，权限 **`0o600`**（rename 保留，所以最终文件也是 0600），
`finally` 无条件 `rm(..., { force: true })`。父目录由 `safeResolve(..., { createParent: true })`
递归 mkdir 并复查未经 symlink 逃逸。**没有 `fsync`**——崩溃一致性只到 rename 语义为止。

**`backup`**（:33-39）：ENOENT 返回 `{ path, content: null }`，`null` 是有语义的值（回滚时应删除）；
其他错误抛出。**`exists`**（:16-18）跟随符号链接，所以 dangling symlink 读作「不存在」。

**`diagnostic()`**（`core/errors.ts:21-29`）：

```ts
diagnostic(code, message, path?, severity = 'error', details?)
```

**severity 默认 `'error'`，是第 4 个位置参数**——要传 `details` 就必须显式写出 severity。
`path` 为空时该键不出现；`details` 仅在 `!== undefined` 时出现。
`XForgeError.message` = 所有 diagnostic 的 message 以 `'; '` 连接。

### 11.10 `write_paths` 的 glob 方言（`core/work-packages/globs.ts`，全文 65 行）

**这是与 PermissionPolicy 刻意分开的第三种方言**（文件头注释：失败方向相反——
policy 匹配太少是 fail-open，write boundary 匹配太少是 fail-closed）。

```ts
const GLOB_MAGIC = /[*?{}[\]]/;
export const UNSUPPORTED_GLOB_MAGIC = /[?{}[\]]/;    // 同一集合去掉 *
```

`globRegex`（:31-54）的确切转换：

| 写法 | 正则 | 语义 |
| --- | --- | --- |
| `**/` | `(?:.*/)?` | 跨 `/`，**整段可选**——`**/x.ts` 同时匹配 `x.ts` 和 `a/b/x.ts` |
| `**`（后面不是 `/`） | `.*` | 跨 `/`，可空。`src/**` 匹配 `src/`、`src/a/b/c`，**不匹配 `src`**（`/` 是字面量） |
| `*` | `[^/]*` | **不跨 `/`**，可空 |

全串锚定 `^…$`（**不是前缀匹配**），大小写敏感，每次调用 `new RegExp` 无缓存。

`staticPrefix`（:21-29）：按 `/` 分段，取首个含 magic 的段之前的所有段；全为空返回 `'.'`。
注意末段是文件名时也会被计入（`src/a.ts` → `src/a.ts`）。

> 这解释了 §5.3 第 3 条：`patternWithinScope` 要求 scope 以 `/**` 结尾，
> 而 `src/generated/**` 展开成 `src/generated/.*`——`src/generated/*` 展开成
> `src/generated/[^/]*`，匹配不到任何子目录里的文件。

### 11.11 verification receipt（`core/verification-receipt.ts`）

字面值：

```ts
VERIFICATION_RECEIPT_PATH      = 'evidence/verification-receipt.yaml'   // :40，Change 目录内相对路径
VERIFICATION_RECEIPT_CONDITION = 'verificationReceipt'                  // :43，保留的 exit-condition key
```

`evaluateVerificationReceipt` 的 reason 完整枚举（14 个，其中 2 个是模板串）：

```
path-unsafe · receipt-missing · receipt-empty · receipt-unreadable
subject-mismatch · status-${declared || 'missing'} · content-revision-missing
content-revision-stale · git-head-missing · gates-missing
gate-uncited-${gate} · gate-unverifiable-${gate} · gate-citation-mismatch · satisfied
```

两条与契约设计直接相关的事实：

- 引用**只按 Gate 名匹配，不校验 Evidence digest**（:139-148 的注释理由：`digest` 含时间戳、
  `inputDigest` 含随 Stage 变动的 `stateRevision`，Verify 阶段写的 receipt 活不到 archive）。
  绑定力全靠 `contentRevision`。**契约 Gate 加进 verify 后，receipt 里也只写 Gate 名。**
- `gitHead` 只要求存在，**刻意不做任何比较**（:106-107）。

### 11.12 各类改动的「必改点」速查

| 要做的事 | 必改点 | 陷阱 |
| --- | --- | --- |
| 加一个 schema | `core/validator.ts:19` 的 `SCHEMA_NAMES` **一处** | 缺文件会让**任何** `validateSchema` 调用整体抛 ENOENT |
| 加一个诊断码 | 无 | build 时源码扫描自动收录 |
| 加一类 scaffold 资源 | `resource-loader.ts` 8 处 + `types/resource.ts` + manifest schema/type + `state-reader.ts` 2 处 | `lockfile.ts` 不同步会持续报 `XFORGE_LOCK_RESOURCES_MISMATCH` |
| 加一个 impact | `checker.ts:32` `IMPACT_KEYS` + **`commands/state.ts:149` 第二份硬编码列表** | 两份列表不共享常量 |
| 加一个 exit key | `flow-resolver.ts:101` `STRUCTURED_EXIT_KEYS` + `control-plane.ts:41` `structuredExit` | 两处手工镜像，无编译期绑定 |
| 加一个 artifact validator | `flow.schema.json:51` + `types/flow.ts:63` + 消费者 | `artifact-markers.ts:124` 的短路条件也要相应扩展 |
| 加一个 marker role | `flow.schema.json:63` + `types/flow.ts:34` + **`reconcile/rules.ts` 里的消费者** | 只加前两处不会有行为；现有消费者在 `rules.ts:39,102`（`requirement-coverage`）与 `:130`（`declared-gap`） |
| 加一条 reconciliation 规则 | `reconcile/model.ts:19` 的 `ReconciliationRule` 联合 + `rules.ts` 的纯函数 + `reconcile.ts:114-130` 的数组 | 读取层放 `sources.ts` 并返回 `unavailable`；规则必须是 `info`，不做判决 |
| 加一类资源进 lock | `core/lockfile.ts:56-58` 的 kind 数组 | 现有 7 类，`mcpServers` 已缺席——别照抄那个缺口 |

---

## 12. 参考

**业界工具**（每条都能跑成一条带退出码的命令，即都能做 XForge Gate）

- HTTP：[oasdiff](https://www.oasdiff.com/docs/getting-started) · [规则表](https://www.oasdiff.com/checks) · [Spectral](https://github.com/stoplightio/spectral) · ⚠️ [Optic 已归档 2026-01](https://specshield.io/blog/optic-is-dead-migration-guide)
- protobuf：[buf breaking](https://buf.build/docs/breaking/usage/)（`--against '.git#branch=main'`）
- GraphQL：[GraphQL Inspector](https://the-guild.dev/graphql/inspector/docs/commands/diff) · [Apollo schema checks](https://www.apollographql.com/docs/graphos/platform/schema-management/checks/run)
- 符合性：[Specmatic](https://docs.specmatic.io/contract_driven_development/backward_compatibility) · [Pact can-i-deploy](https://docs.pact.io/pact_broker/can_i_deploy) · [Pending pacts](https://docs.pact.io/pact_broker/advanced_topics/pending_pacts)
- 数据：[Confluent schema evolution](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html) · [ODCS](https://docs.datacontract.com/open-data-contract-standard) · [Data Contract CLI](https://cli.datacontract.com/) · [dbt model contracts](https://docs.getdbt.com/docs/mesh/govern/model-contracts)
- 数据库：[Atlas migrate lint](https://atlasgo.io/versioned/lint)（⚠️ v0.38 起仅 Pro）· [squawk](https://squawkhq.com/docs/cli)
- 边界与基线快照：[dependency-cruiser](https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md) · [Nx module boundaries](https://nx.dev/docs/features/enforce-module-boundaries) · [ArchUnit](https://www.archunit.org/userguide/html/000_Index.html) · [API Extractor](https://api-extractor.com/pages/setup/configure_api_report/) · [cargo-public-api](https://github.com/cargo-public-api/cargo-public-api)
- 规范：[Zalando API Guidelines](https://opensource.zalando.com/restful-api-guidelines/) · [Redocly bundle](https://redocly.com/docs/cli/commands/bundle)

**SDD / Agent 场景（结论：空白位）**

- [spec-kit plan-template](https://github.com/github/spec-kit/blob/main/templates/plan-template.md) · [spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)
- [Kiro Specs Concepts](https://kiro.dev/docs/specs/concepts/) · [Best Practices](https://kiro.dev/docs/specs/best-practices/) · [Steering](https://kiro.dev/docs/steering/) · [Hooks](https://kiro.dev/docs/hooks/)
- [OpenSpec concepts](https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md) · [Tessl Registry](https://tessl.io/blog/tessl-launches-spec-driven-framework-and-registry) · [spec-kitty](https://github.com/Priivacy-ai/spec-kitty)
- [Splitting Work for Parallel AI Agents](https://parallelcode.app/blog/splitting-work-for-parallel-ai-agents/)（freeze before fan out）· [Parallel Agentic Development With Git Worktrees](https://www.mindstudio.ai/blog/parallel-agentic-development-git-worktrees)
- 反面样本：[Subagent-driven development](https://www.oakheartlab.com/p/subagent-driven-development-how-to) · [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) · [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Postman: spec drift, context beats code alone](https://blog.postman.com/api-specification-drift-why-context-beats-code-alone/)
- 批评：[The limits of spec-driven development](https://dev.to/chrisywz/the-limits-of-spec-driven-development-3b16) · [The SDD Triangle](https://www.dbreunig.com/2026/03/04/the-spec-driven-development-triangle.html) · [arXiv 2602.00180](https://arxiv.org/html/2602.00180v1)

**XForge 源码（本文一手依据）**

```text
xforge/schemas/{flow,gate,rule,permission-policy,change,manifest,work-package}.schema.json
scaffold/payload/xforge/flows/{quick,solid}.yaml
scaffold/payload/xforge/scaffold/gates/unit-tests.yaml
scaffold/payload/xforge/scaffold/policies/protected-files.yaml
scaffold/payload/xforge/scaffold/rules/{governance-assets-are-integrator-only,prefer-small-explicit-contracts}.yaml
xforge/src/core/{revision,verification,checker,control-plane,flow-resolver,spec-delta,spec-merger,
                 archiver,artifact-markers,validator,resource-loader,project-loader,work-packages,
                 state-reader,ledger,ledger-identity,env-safety,toolchain,governance,
                 reconcile,files,errors,hash,path-safety,lockfile,verification-receipt}.ts
xforge/src/core/control-plane/{conditions,graph,receipts}.ts
xforge/src/core/reconcile/{model,rules,sources}.ts
xforge/src/core/work-packages/globs.ts
xforge/src/runners/gate.ts
xforge/src/commands/{check,verification,transition,state,explain}.ts
xforge/src/types/{flow,manifest,change,resource,work-package,governance}.ts
```

**仍未读**：`core/{identity,audit,redaction,approval-receipt,review-acknowledgement,check-findings,
constitution-check,language}.ts`、`core/work-packages/{records,verify}.ts`、`src/cli.ts`、
`install/**`、`commands/{approve,doctor,hook,init,upgrade,work-package,findings,review}.ts`、`test/**`。
