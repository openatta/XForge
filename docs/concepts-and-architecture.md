# XForge 概念与架构

> 面向要在项目里使用 XForge 的程序员。这份文档讲**概念与机制**——XForge 是什么、
> 它按什么逻辑运转、你脑子里要装哪几个模型才能顺畅地用它工作。
> 它不是命令手册；命令与参数见 [CLI 用法](cli-tool-usage.md)，最终以 `xforge help --text` 为准。
>
> 对应实现：`@xforge/cli 0.7.18`、File Protocol 2、`xforge.dev/v1alpha2`。

**相关文档**

- [治理模型](governance-model.md)——七类治理资源各自能证明什么，以及为什么不许互相冒充
- [扩展指南](extension-guide.md)——新增 Skill / Flow / Gate / Rule / Policy / Hook / Approval / Agent / MCP
- [仓库与文件布局](repository-layout.md)——每个中间产物落在哪、归谁写、谁校验
- [子 Agent 设计](sub-agent-design.md)——并行工作包与 Worker / Integrator / Reviewer
- [CLI 用法](cli-tool-usage.md)——命令、参数、退出码与常见诊断码

---

## 1. 定位

XForge 是一个 **Git 原生的治理控制面（control plane）**，用于有治理的 AI 辅助软件开发。

它把规格、工作流状态、工程规则、质量证据、审批与审计历史，变成**版本化的项目事实**，
再把相应的 Skills、Agent 定义、权限策略与 Hook **投影**到团队已经在用的 AI 编程工具里。

明确不是什么：

- **不是 Agent 运行时**——不托管模型、不执行推理、不创建模型进程；
- **不是编程工具的替代品**——探索、设计、写代码仍由 Codex / Claude Code / Cursor / OpenCode / Copilot 完成；
- **不是发布系统**——`archive` 关闭的是一个 Change，不部署、不发版、不跑迁移、不授予生产权限。

一句话概括分工：

> **模型负责「怎么做」，XForge 负责「什么是真的、哪一步是合法的、推进前必须拿出什么证据」。**

### 1.1 六条设计目标

1. **项目事实留在 Git 里。** Constitution、Specs、Changes、Flows、Rules、策略、本地化的 Agent 资产
   都与代码同仓库，没有服务账号或托管控制面也能读懂。
2. **跨 Agent 工具可移植。** 一份规范项目模型可以投影到五个目标，能力有差异时**如实报告降级**，
   而不是假装各平台等价。
3. **指导、许可、证明三者分离。** Rule 可以指导 Agent，PermissionPolicy 可以守卫一个动作，
   Gate 可以证明一个结果。XForge 从不让其中一个顶替另一个。
4. **治理强度与风险成比例。** 小的可回滚变更走 Quick；常规产品工作走 Solid；
   高风险或跨系统工作走 Major。
5. **在受管边界上失败即关闭。** 写操作要求精确的 CLI/协议身份。生成物冲突、陈旧 receipt、
   失败的 Gate、不完整的审计历史、不安全路径——一律中止操作，而不是静默忽略。
6. **是控制面，不是执行垄断。** XForge 协调状态、证据与策略，但不托管模型、不替代编程工具、
   不授予生产部署权限。

---

## 2. 第一个模型：两个物件，一个方向

XForge 在你的仓库里其实只有两样东西。分清它们能解释掉后面大部分规则。

```text
  @xforge/cli  (npm，精确版本固定)
  └── 内含经过校验的 Scaffold 载荷
                    │
                    │  xforge init          ── 每个项目一次
                    ▼
  xforge/                                     ← 规范源，项目所有，进 Git
  ├── manifest.yaml · lock.yaml
  ├── constitution.md · XFORGE.md · architecture.md(可选)
  ├── specs/ · changes/ · flows/
  └── scaffold/  skills · agents · rules · policies · hooks · gates · mcp-servers
                    │
                    │  xforge install / sync / update
                    ▼
  .claude/ · .agents/ · .codex/ · .cursor/ · .opencode/ · .github/
                                              ← 生成的投影，不是源

  Agent 读的是投影。            CLI 读的是 xforge/，
  它跟着 Skill 走。             并回答 state / Gate / receipt / approval / audit。
```

**Scaffold 是 Agent 读的东西；CLI 是说真话的东西。**

由此派生三条最常让新人意外的规则：

- **投影是单向、可重算的。** `xforge/scaffold/**` 是源，工具目录是输出。改源之后跑 `xforge sync`。
  手改生成物会被**拒绝**而不是合并——因为下一次投影会静默覆盖它。
- **npm 包是唯一受支持的输入。** Scaffold 随固定版本的 CLI 一起发布，写入前对照校验和清单验证。
  Git checkout、本地 tarball、独立压缩包都不是安装输入，所以一个项目永远能说清自己跑的是哪些字节。
- **你的定制在升级中存活。** `xforge/scaffold/**` 初始化之后归你所有；CLI 做的是**调和**而不是替换，
  分不清哪个改动是谁的时候就拒绝。

与你共有的文件（`AGENTS.md`、`CLAUDE.md`）通过标记块合并：
`<!-- XFORGE:BEGIN -->` … `<!-- XFORGE:END -->` 之外的内容逐字节保留，
重新安装会**就地替换**该块，而不是追加第二个。

> ⚠️ **`xforge update` 不升级 Scaffold。** 它把你**现有的** Scaffold 重新投影一遍。
> 真正换掉 Scaffold 本身的是 `xforge upgrade-scaffold`，而且它**从不替你合并**——
> 它只做暂存、快照和分类，把决定权留给人，并且在有未归档 Change 时直接拒绝。

---

## 3. 第二个模型：什么算「事实」

XForge 的状态**不是从文件存在与否推断出来的**，而是从一条经过校验的
transition receipt 链**重建**出来的。绑定这一切的是四层哈希。

### 3.1 四层 revision

```text
policySnapshotDigest = hash(constitution + flow + rules + policies + hooks + gates)

contentRevision      = hash(changeId + flowName
                            + digest(change.yaml, flow.yaml, 全部 Artifact 输出)
                            + policySnapshotDigest)

stateRevision        = hash(contentRevision + currentStage + transitionHead)

governingRevision    = hash(changeId + flowName + currentStage
                            + digest(change.yaml, flow.yaml,
                                     截至当前 Stage 为止产出的 Artifact)
                            + policySnapshotDigest)
```

**注意 `contentRevision` 不包含 Git HEAD。** 这是有意的：把 HEAD 折进去意味着任何一次提交
——包括提交 Gate 刚刚产出的 Evidence——都会让这个 Change 的全部 Gate 结果与审批失效，
那与 Git 原生的工作方式不相容。`gitHead` 是审计元数据，不是等价性输入。

**`governingRevision` 是审批专用的、更窄的绑定。** 它只覆盖「截至当前 Stage 为止产出的
Artifact」，所以后续 Stage 写自己的 Evidence 不会冲掉更早给出的审批，
但改动审批人真正读过的那份 Artifact 仍然会让它失效。

### 3.2 三条推论（会直接影响日常操作）

1. **任何对治理产物、Flow、Rule、Policy、Gate、Hook 或 Constitution 的改动**，都会让
   已有的 Gate Evidence 与 Approval 变陈旧。这不是缺陷，是「审批要为它当时读到的规则负责」的代价。
   → 因此**治理资产的变更属于发布窗口，不属于一个进行中的 Change**。
2. **不要把 Gate 的 digest 粘进 Artifact 正文。** 粘贴这个动作本身就改变了 `contentRevision`，
   Evidence 随即失效，重跑又产出不同的 digest——这里不存在不动点。
   正确做法是**按名字引用 Gate**，让台账去承载绑定关系。
3. **Flow YAML 按原始字节摘要。** 改注释和改逻辑等价，都会让所有正在使用它的活跃 Change 的
   revision 漂移。

### 3.3 Managed 与 Portable

| 模式 | 条件 | 能做什么 |
| --- | --- | --- |
| **Managed** | 声明的 CLI identity、Protocol、Lock 完整性全部匹配 | 投影、跑 Gate、受治理的 transition、审批、派工、审计写入与投递、归档 |
| **Portable** | 不匹配（`XFORGE_CLI_IDENTITY_MISMATCH`） | 仓库仍可读、文件仍是有效指导，但**不声称**确定性强制执行发生过 |

版本是被**强制**而不是被假定的：CLI 每次运行都会与 `xforge/manifest.yaml` 比对，
不一致时拒绝写入。遇到这个诊断应如实报告，而不是设法绕过去
（`xforge version` 会同时给出版本与 `executablePath`，那是区分陈旧全局安装与项目本地安装的关键）。

---

## 4. Flow：风险分级的生命周期

### 4.1 Flow 是纯数据

Flow 是 `xforge/flows/*.yaml`，按 `flow.schema.json`（`v1alpha2`）校验。
没有任何 TypeScript 枚举挡着——扔一个 `hotfix.yaml` 进去，只要过 schema，
它就会和内置三档一样被加载。

一份 Flow 声明五类东西：

```yaml
policy:      # 资格：什么样的 Change 可以 / 必须走这条 Flow
artifacts:   # 要求产出哪些文档，每份怎么写（instruction / outline / markers）
governance:  # 审批策略 + 审计策略
stages:      # stage graph：归哪个 Skill、需要哪些 Gate、出口条件、能返工到哪
terminal:    # 归档：需要哪些审批、审计策略、是否 syncSpecs
```

### 4.2 三档内置 Flow 的真实 stage graph

| Flow | 适用 | stage graph |
| --- | --- | --- |
| `quick` | 低风险、单模块、有边界、可回滚 | propose → apply → verify → *archive* |
| `solid` | 常规产品与工程变更（manifest 默认） | propose → design → **check** → apply → verify → *archive* |
| `major` | 高风险 / 关键影响 / 跨系统 | propose → **clarify** → design → **check** → apply → verify → *archive* |

> `archive` 不是 stage graph 里的一项，它是 `terminal.archive`。
> Change 在离开 Verify 之后进入一个**合成 Stage `ready-to-archive`**，
> 它不在 `flow.stages` 里——见 §4.6。

**资格是结构性强制的，不靠 Agent 自觉：**

```yaml
# quick
eligibleWhen: { risk: [low], criticalImpacts: forbidden, maxModules: 1 }
# solid
eligibleWhen: { risk: [low, medium], criticalImpacts: forbidden }
# major
eligibleWhen: { risk: [low, medium, high], criticalImpacts: allowed }
requiredWhen: { risk: [high], anyImpact: [security, privacy, publicApi, dataMigration] }
```

`quick` 会**拒绝**跨模块或非低风险的工作；触及安全 / 隐私 / 公开 API / 数据迁移的高风险变更
**必须**走 `major`。把一个真正需要台账的 Change 塞进 Quick，等于声明一份与事实不符的 classification。

### 4.3 一个 stage 长什么样

```yaml
- id: check
  skill: xforge-check          # 这个阶段归哪个 Skill
  authority: assurance-write   # 允许写什么类别的东西
  requires: [design]           # 前置阶段
  produces: [check-report, check-findings, constitution-check]
  gates: [structure, check-findings, constitution-check]
  reworkTo: [propose, clarify, design]
  exit:
    approvals: [implementation-major]
```

`authority` 有五档：`read-only` / `planning-write` / `assurance-write` /
`implementation-write` / `archive-write`。它是 Skill 权限边界的上界。

`exit` 有四种**结构化**字段，控制面逐个读取，未满足就在
`state.governance.readyTransitions[].blockedBy` 里报告并拒绝推进：

| 字段 | 判定 |
| --- | --- |
| `exit.conditions` | 结构化台账（见 §4.5） |
| `exit.gates` | 额外的 Gate（与 `stage.gates` 分开声明） |
| `exit.approvals` | 审批策略 |
| `exit.auditEvents` | 必需的审计事件类型 |

> ⚠️ 裸的 `<key>: <expected>` 映射是结构化之前的旧形态，现在会被
> `XFORGE_FLOW_EXIT_UNSTRUCTURED` 直接拒绝——因为那曾经是**一道没人看的门**。

### 4.4 人工审批点：当前布局

| Flow | 实现前审批 | 归档审批 | 每点人数 | 职责分离 |
| --- | --- | --- | --- | --- |
| `quick` | — | `quick-close` | 1 | ❌ |
| `solid` | `planning-solid` @ **check 出口** | `closing-solid` | 1 | ❌ |
| `major` | `implementation-major` @ **check 出口** | `closing-major` | 1 | ✅ |

两条设计要点：

- **两个 Flow 的实现前审批都收在 check 出口**，也就是实现开始前的最后一刻，
  且是两个台账（`check-findings`、`constitution-check`）都已写完之后。
  收得更早意味着审批人在决定「规划是否成立」的证据存在之前就签了字，
  `xforge brief` 的 reconciliation 段落会因为无可比对而渲染成 "(no differences found)"
  ——那读起来和一次干净的评审一模一样。
- **`separationOfDuties` 不比较角色。** 它要求审批人**不是本 Change 的 implementer**
  （implementer 取自 Change 目录与各 work-package delivery 区间的 Git author）。
  `roles` 是资格过滤器——谁有资格审批——与职责分离是两件事。

### 4.5 出口条件：三个内置 + 一个通用机制

`exit.conditions` 里的键值对 `<key>: <expected>`，判定分两类：

| key | 由什么判定 |
| --- | --- |
| `verificationReceipt` | `evidence/verification-receipt.yaml` + 当前 `contentRevision` + 实际通过的 Gate 集合 |
| `independentReview` | work-package 的 `acknowledgements.reviewedBy`；无计划时读 `evidence/review/` 下的 ack receipt |
| **其它任意 key** | **通用台账读取器**：`evidence/conditions/<key>.{yaml,yml,json}` |

通用台账的契约（这是**不写代码就能加一道「必须有具名人拍板」的门**的机制）：

```yaml
condition: <key>          # 若存在，必须等于 key
entries:                  # 必须存在；显式的 [] 是一条被接受的断言
  - question:  <非空>
    decision:  <非空>
    decidedBy: <非空，且必须命中本 Change 已知的身份集合>
    decidedAt: <非空，且 Date.parse 能解析>
status: <默认 resolved>   # 必须等于 expected
```

判定失败的 reason 依次是：`invalid-key` → `ledger-missing-expected-<x>` →
`ledger-unreadable` → `ledger-subject-mismatch` → `entries-missing` →
`undecided-<n>` → `status-<实际>-expected-<期望>`。

> **为什么必须是结构化台账：** 之前的实现是拿正则去搜 Agent 自己写的 markdown 里有没有
> `<key>: <expected>` 这一行——于是 Agent 在自己写的文件里敲一行就能清掉一道治理条件。
> 那正是「自报出口」，是这套设计要消灭的东西。

**身份集合（`decidedBy` / `resolvedBy` / `approvedBy` 都用它）：**

```text
KnownIdentities = { 本 Change 全部 receipt 上的 approver.id }
                ∪ { Change 目录的 Git author email 与显示名 }
```

集合为空时（全新 Change、无提交、无 receipt），任何非空名字都通过——否则新仓库的第一个
Change 会被自己的空历史卡死。但这个通过是**暂时的**：Change 的第一次提交建立了这个集合，
此后同样的名字对不上就会让刚刚还是绿色的 Gate 失败。Gate 会附一条 warning 明说这一点。
**一开始就写真实身份，不要写一个打算以后再改的。**

### 4.6 `ready-to-archive`：一个合成 Stage

离开 Verify 之后，Change 进入 `ready-to-archive`。它**不在 `flow.stages` 里**，
因此 `xforge state` 报不出任何合法目标，既没有前进也没有 rework transition。

> **这不是卡死，而是 Stage 层面已无可走。**

此时若仍需修改 Artifact，出路是 `xforge transition repair --change <id> --receipt <receiptId>`：
它丢弃收尾那一张回执，把 Change 退回该转换离开的 Stage。**它不是 `--force`**——
只允许丢弃**叶子**回执，丢弃了什么会记入审计链，并且归档审批会随之失效
（审批绑定的是它被给予时的内容）。

### 4.7 归档

Archive 在 **plan 和 execution 两次**检查终态治理：

1. Stage 必须是 `ready-to-archive`；
2. ready transition receipt 的 content / policy / Git 仍当前；
3. Transition 引用的 Gates 仍有效，并在 execution 阶段针对 ready-state revision **重跑**强制 Gate；
4. Closing Approval 当前；必需的审计事件类型齐全、链有效、无被禁止的 coverage / remote gap；
5. Specs merge 与 move 无路径 / 目标冲突。

Gate 重跑后**重新 plan**，再执行原子事务。任何中间错误都保持 Change 未归档。

`syncSpecs: true` 时 delta Specs 合并回主 Specs——**这是需求能跨 Change 存活的机制**。
架构决策没有这条路，所以才有 `xforge/architecture.md` 这个独立的持久记录
（上限 50 行、6 条决策，唯一写者是 `xforge-architect`）。

---

## 5. Skill：Agent 的执行接口

### 5.1 结构

一个 Skill 是一个目录 + 一份 `SKILL.md`（本地化时另配 `SKILL_cn.md`），固定五个章节、顺序不变：

| 章节 | 内容 |
| --- | --- |
| **Invariants** | 行动前必须读取 / 必须成立的前提 |
| **Authority** | 明确列出能写哪些路径，以及**明确列出不能碰的东西** |
| **Execution** | 编号步骤 |
| **Evidence** | 要报告什么、对照哪个 `doneWhen` / `requiredEvidence` |
| **Stop and rework** | 什么时候必须停下、由哪个 Skill 负责修 |

内置 12 个，分三类：

- **生命周期**：`xforge-propose` / `clarify` / `design` / `check` / `apply` / `verify`
- **治理工具**：`xforge-revise`、`xforge-scaffold`、`xforge-architect`、`xforge-upgrade-scaffold`
- **只读报告**：`xforge-status`、`xforge-kanban`（不读也不需要任何 Change，随时可跑）

> 调查代码、Specs 与选项**不需要专门的 Skill**——阅读与检索是每个被投影目标的原生能力。
> 把一个模糊想法收敛成可提案的范围，是 `xforge-propose` 的第 0 步。

### 5.2 驱动循环：跟着 Action 走，不跟着 Flow 名字走

```text
        ┌──────────────────────────────────────────┐
        │  xforge state --change <id>              │
        │    → governance.currentStage             │
        │    → revision.{content,state,governing}  │
        │    → nextActions[]  (typed)              │
        │    → readyTransitions[].blockedBy        │
        └───────────────┬──────────────────────────┘
                        │  取出当前 ready 的 Action
                        ▼
        ┌──────────────────────────────────────────┐
        │  Action 自带 instruction / outline /      │
        │  inputs / writes / doneWhen /             │
        │  requiredEvidence / command(argv)         │
        │  → Skill 严格照它执行                      │
        └───────────────┬──────────────────────────┘
                        │  产出 artifacts
                        ▼
        ┌──────────────────────────────────────────┐
        │  xforge check   → Gate Evidence           │
        │  xforge transition --to <next>            │
        │    ↑ 被 exit.{conditions,gates,           │
        │        approvals,auditEvents} 守着         │
        └───────────────┬──────────────────────────┘
                        │  不满足 → blockedBy，或按 reworkTo 退回
                        ▼
                  ready-to-archive → archive ✓
```

**`state.nextActions` 是权威。** 不要背命令序列——一条 Flow 可能要求返工、额外 Gate、
外部审批 receipt 或远端审计投递，才允许下一次 transition。

审批命令尤其要从 `nextActions[].command` 里原样取，不要照 usage 字符串自己拼：
`--for` 填的是该审批**所解锁的那次 transition**（目标 Stage id，或字面量 `archive`），
填错会把一次真实的人类签字消耗在一份不会被计数的 receipt 上。
`XFORGE_APPROVAL_TRANSITION_UNKNOWN` / `_UNAPPROVABLE` 表示参数错了**且什么都没写入**
——改参数，不要重跑，更不要再请人签一次。`xforge approve --dry-run` 不需要终端、
也不惊动审批人，就能先校验一遍。

### 5.3 Flow 差异该放在哪一层

当两条 Flow 需要同一个环节表现不同，**按优先级**有三个地方：

1. **stage graph 里有没有这个阶段。** 不需要就别声明。`quick` 没有 `design` 阶段，
   于是 `xforge-design` 的 Action 在 quick 下永远不会 ready ——
   **没有任何 Skill 里写着「如果是 quick 就跳过 design」。**
2. **artifact 的 `instruction` / `outline`。** 同一个 Skill 服务多条 Flow 时用这个：
   `design.md` 在 solid 与 major 下深度不同，差异全部放在各自 Flow YAML 里，
   Skill 只说「严格按当前 Action 的 instruction 和 outline 执行」。
3. **结构化 `exit` 字段（最后手段）。** 只有当差异是**代码必须据此行动**的东西时才用；
   用完要确认它**真的出现在 `blockedBy` 里**——一道从不出现在那里的门，与不存在没有区别。

**反模式：** 在 Skill 散文里按 Flow 名字分支（「Solid 时…… Major 时……」）。
新增一个自定义 Flow 会被静默处理错，因为这个 Skill 从没「听说过」它。

### 5.4 `outline` 由谁检查：没有人

`outline` 是**写作指引**。没有任何 Gate、`check` 或归档步骤校验 Artifact 是否包含
`outline` 声明的小节——一份缺了某个小节的 Proposal 从 Propose 一路到归档都不会产生诊断。

真正被强制的只有 `artifacts[].markers`：

| 情形 | 严重级别 | 理由 |
| --- | --- | --- |
| marker 指向 Artifact 不存在的小节 | **warning** | outline 一向是指导；升级为错误会让 markers 出现之前就已合法的 Change 失败 |
| `minOccurrences` 未达标 | **error** | 这是 Flow 明确要求某小节至少承载 N 个条目，只有主动声明的项目才会走到 |

`markers` 的作用是告诉工具「某个小节**意味着什么**」，正是这一点让 `xforge brief`
能够算出答案，而不必请人读完散文再为它背书：

- `role: requirement-coverage` —— 该小节是记录 Requirement 覆盖的地方
- `role: decision-alternative` —— 匹配 `pattern` 的条目是被否决的替代方案，逐字引用进简报
- `role: declared-gap` —— 匹配 `pattern` 的条目把问题推给后续 Stage

`pattern` 是**列表**，因为一条 Flow 单一来源、而它治理的散文是本地化的：
同一个 Flow 同时治理用英文和用中文写作的项目，只写一种语言的标记会在另一种语言下静默失效。

**如果你需要某个小节是必需的，给它一个带 `minOccurrences` 的 marker。那是唯一会让 Change 失败的机制。**

---

## 6. `xforge brief`：给签字的人看的东西

三个 Skill（design / check / verify）在**人类审批之前**都要求运行它，并把输出**逐字**交给用户。

它的设计目标是：**让读者不必信任措辞，就能分辨一行字是被校验过的还是被断言的。**
六个分层永远分块打印、绝不交错：

```text
WHAT IS BEING DECIDED   这次签的是什么：策略、还差几人、角色、职责分离开关
                        + 未解决的 blocking finding
                        + 等你回答的条目（连原文一起印，不只印 id）

COMPUTED                从结构化数据算出来的。同一 revision 重跑结果完全一致。

RECONCILIATION          某份记录声称的 与 文件里实际的 之间的差异。
                        「这些陈述一处差异。它们没有说那是缺陷。」

EXTRACTED               逐字取自 Artifact，靠 Flow 声明的 markers 定位小节。

TRIAGE                  人或模型写的。不是事实。方括号里标注依据。

UNAVAILABLE             这份简报做不出来的部分，以及原因码。

NOT COVERED             签了这份简报，不代表你审查过什么。
```

> **不得转述、重排或概括。** 简报把「CLI 算出的事实」与「原文引用」分开呈现，
> 用自己的话复述会毁掉读者区分二者的唯一依据。

这也是 `markers` 存在的真正理由。

---

## 7. 架构分层

```text
┌─────────────────────────────────────────────────────────────┐
│  Agent 工具（Codex / Claude Code / Cursor / OpenCode /      │
│              GitHub Copilot）                                │
│  读投影出来的 Skills、Agent 定义、权限配置、Hook 桥接         │
└───────────────┬─────────────────────────────────────────────┘
                │  xforge <command>            ▲  hook dispatch
                ▼                              │
┌─────────────────────────────────────────────────────────────┐
│  XForge CLI —— 无常驻服务的控制面                             │
│                                                              │
│  1. 解析 Manifest / Lock / Flow / Change 与当前 revision      │
│  2. 投影 canonical Skills / Agents / Rules / Policies / Hooks │
│  3. 执行 Machine Gate、Transition 与 Archive                  │
│  4. 验证 Approval、work-package delivery 与 receipt chain     │
│  5. 写规范化 Audit、远端投递 receipt 与可提交索引              │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Git 仓库 —— xforge/ 下的项目事实                             │
└─────────────────────────────────────────────────────────────┘
```

所有写命令遵循同一条流水线：

```text
load exact root and npm identity
→ resolve canonical resources / current state
→ compute content / state / policy revisions
→ produce plan and diagnostics
→ enforce authority / guards
→ atomic write
→ append audit and update change index
→ return envelope
```

**Skill 与 Agent 解释意图、生成规划或 assurance 内容，但不能把自然语言结论升级为
Gate、Approval、Transition 或 Audit 完整性事实。**

### 7.1 投影目标与能力差异

| Target | 治理输出 |
| --- | --- |
| Claude Code | `.claude/settings.json` permissions + 分组 hooks |
| Codex | `.codex/agents/*.toml` + `.codex/rules/*.rules` + `.codex/hooks.json` 桥接 |
| Cursor | `.cursor/hooks.json` v1 |
| GitHub Copilot | `.github/hooks/xforge.json` v1 |
| OpenCode | 有序 `opencode.json` permissions + 受管 TypeScript 插件桥接 |

Adapter 报告 `guidance`、`permissionPolicy`、`runtimeHook.*`、`auditDelivery`、`subagent`
的能力级别（`native` / `degraded` / `unsupported`）。目标不暴露的事件、云端临时日志或
工具 opt-out **必须进入 coverage gap**。

**Workflow 控制面始终可独立运行——Runtime Hook 不可用不会让 Flow 失效。**

---

## 8. 输出协议

所有普通命令返回**恰好一个** Protocol 2 信封：

```json
{
  "protocolVersion": "2",
  "ok": true,
  "command": "state",
  "root": "/project",
  "data": {},
  "diagnostics": [],
  "changes": [],
  "nextActions": []
}
```

加 `--text` 得到人类可读视图，**不改变语义与退出状态**。
唯一的例外是内部 hook dispatcher——它要往 stdout 写目标平台要求的 Hook 响应 JSON。

`data.change` 的关键字段：

```ts
{
  id, path, flow, classification, scope,
  artifacts: ArtifactState[],       // status / outputPaths / writePath / missingDependencies
  nextArtifact,
  apply:   { ready, requires, tracks },
  archive: { ready, requires, mandatoryGates, syncSpecs },
  workPackages: WorkPackagePlanState | null,
  governance: GovernanceState,
  mandatoryGateEvidence: [{
    gate, status, command, evidencePath,
    currentContentRevision,       // 证据是否绑定当前**内容**修订
    gitHead, sourceFilesChangedSince,  // 证据跑在哪个 commit，之后又动了几个源文件
  }],
}
```

`mandatoryGateEvidence` 的存在理由是让「Gate 通过了」和「Gate 什么都没断言」
在不打开 Evidence JSON 的情况下可区分——**只记事实，不下判断**。

后三个字段回答的是两个**互相独立**的陈旧性问题，必须分开读：

- `currentContentRevision` 比对的是**内容修订**（Artifact、Flow、policy 快照）。
  它此前叫 `currentRevision`，那个名字被读成「对当前状态有效」，而它从来只
  管内容这一半：一个 Change 退回 apply、合并两个工作包、再回到 verify，全程
  没碰任何受治理 Artifact，于是三个 Gate 一路报 `true`，而它们跑过的代码已经
  落后两次合并。
- `sourceFilesChangedSince` 比对的是**代码树**：从 `gitHead` 到当前 HEAD 之间，
  有多少个 XForge 自己没写过的文件变了。排除自身写入的路径，是为了让「提交
  Gate 刚产出的 Evidence」这个动作读作 0——把 commit 折进内容修订的做法正是
  因此被放弃的，它会让每个 Gate 在自己的输出被提交的瞬间失效。
  `null` 表示无法判定（rebase、shallow clone、无 Git），**不是** 0。

两者都只报告，不拦截：archive 依旧只以内容修订为准，这里做的是把差异摆到
签字的人面前。

`ArtifactState` 里有个容易踩的区别：`generates` 相对 **Change 目录**，
`writePath` 才是**从项目根算起**的路径；`nextAction.writes` 由后者构建，
所以目的地是**被陈述的**，不是被推断的。

`blockedBy` 的完整词汇表见 [治理模型 §6](governance-model.md#6-排障blockedby-词汇表)。

---

## 9. 日常怎么工作

1. **不要背 CLI 命令序列。** 读 `state.nextActions`，它是权威。
   `xforge-status` 会告诉你一个 Change 站在哪、下一个合法动作是什么，且不替你做。
2. **Flow 选最弱但仍安全的那一档。** 治理强度与风险成比例是设计目标，不是走过场；
   选错时 `quick` 会直接拒绝。
3. **被 `blockedBy` 挡住时，读它说的那一条**，而不是绕开。
   **Gate refuse ≠ Gate fail**：refuse 是「你还没告诉我这个项目怎么验证自己」。
4. **Gate 必须在最后一次写入之后、一次性运行。** 先跑一个 Gate、再改 Artifact、再跑下一个，
   会让先跑的变陈旧——所有 Gate 都报 `passed`，Stage 却仍然出不去。
5. **想让一条标准真的生效，别只写 Rule。** 给它接上 Gate / Policy / Approval，
   否则 `state` 会诚实地把它标成 `uncovered` 或 `unenforceable`。
6. **改治理资产不属于一个进行中的 Change**——它会让所有活跃 Change 的 revision 漂移。
7. **要定制，改 `xforge/scaffold/**` 并 `xforge sync`**，永远不要手改 `.claude/` 等生成目录；
   同时记得去 `manifest.yaml` 里登记，否则文件写了也不会被投影。

---

## 10. 常见误解速查

| 误解 | 实际 |
| --- | --- |
| Gate / Rule / Policy / Approval 在每个 Stage 依次检查 | 两条独立轨道 + Rule 横切核实，见[治理模型](governance-model.md) |
| Skill 里应该判断当前是什么 Flow | Skill 只消费当前 ready Action；差异放在 stage graph / instruction / exit 三层 |
| `outline` 会被校验 | 没有任何环节校验它；只有 `markers` + `minOccurrences` 会让 Change 失败 |
| 把文件放进 `scaffold/` 就启用了 | 必须登记进 `manifest.yaml` |
| `xforge update` 会升级 Scaffold | 不会，那是 `xforge upgrade-scaffold`，而且它不替你合并 |
| `separationOfDuties` 是「两个不同角色」 | 是「审批人 ≠ implementer」；`roles` 只是资格过滤器 |
| Reviewer 说 PASS 就算过 | 那是 assurance，不是 Approval，也不是 Gate Evidence |
| Gate 通过就说明需求实现对了 | 只说明配置好的命令针对该 revision 跑过了 |
| Agent 可以代人审批 | local 审批要求真实 TTY 现场对话；无匹配审计事件的 receipt 无效 |
| `ready-to-archive` 卡住了 | Stage 层面已无可走，用 `transition repair` |
| `archive` 等于上线 | 只关闭一个 Change，不部署、不发版、不授权生产 |

---

## 11. 术语对照

| 术语 | 一句话 |
| --- | --- |
| **Change** | 一次受治理的变更，`xforge/changes/<id>/` 下的一整套事实 |
| **Flow** | Change 走过的 stage graph + 绑在上面的治理规则（纯 YAML 数据） |
| **Stage** | Flow 里的一个阶段，归一个 Skill 管，有 produces / gates / exit / reworkTo |
| **Artifact** | Flow 声明的、某个 Stage 必须产出的文档或台账 |
| **Skill** | 面向 Agent 的执行指令，固定五章节 |
| **Rule** | 声明性指导 + 它声称的强制来源，产出 coverage |
| **Gate** | 确定性检查，产出与 revision 绑定的 Evidence |
| **PermissionPolicy** | 针对某个 capability 的实时 allow / ask / deny |
| **Hook** | 编程工具原生事件到 XForge 逻辑的接线 |
| **Approval** | 人或外部系统的决定，绑定当前 `governingRevision` 的 receipt |
| **Evidence** | 机器产出的证据，只有 Gate runner 能写 |
| **Receipt** | transition / dispatch / approval / ack 的凭据，构成可校验的链 |
| **Projection** | 从 `xforge/scaffold/**` 到 `.claude/` 等工具目录的单向生成 |
| **Managed / Portable** | CLI 身份是否匹配，决定能否执行受治理的写操作 |
