# XForge Flows 与 Skills 设计

> 状态：vNext 实现基线
>
> 模型能力基线：Claude Opus 4.6～4.8 档、GPT‑5.5 及以上
>
> 更新日期：2026-08-08
>
> 本文定义官方 Scaffold 的目标设计；实现按文末迁移顺序逐步落地

## 1. 设计结论

XForge 面向强模型时，不需要把通用分析、规划和编码过程展开成大量持久阶段。Flow 只保留真正有治理价值的产物和质量边界；执行计划由 Apply 根据当前状态即时形成。

三个官方 Flow：

```text
quick:
propose -> apply -> verify

solid:
propose -> design -> apply -> verify

major:
propose -> clarify -> design -> check -> apply -> verify
```

`prime` 正式更名为 `major`。

三者名称直接表达交付侧重点：

- **Quick 强调快速**：在低风险、边界清楚、易回滚的前提下减少持久治理开销，缩短交付路径；
- **Solid 强调稳定**：通过持久 Design 和完整 Verify 保证常规变更可维护、可验证、可恢复；
- **Major 强调重大**：对重大影响、高风险或跨系统变更增加 Clarify、Check 与高保障证据边界。

三个 Flow 都必须完成 Archive 才算关闭 Change，但 Archive 不再作为用户必须单独理解的 canonical Skill：

```text
verify satisfied -> archive action -> change closed
```

`xforge-verify` 可以在明确授权时执行 Verify + Archive；如果用户只要求验证，则停在 `verified-active`，不会隐式归档。

Skills 分为两组：

### 核心生命周期 Skills

- `xforge-explore`
- `xforge-propose`
- `xforge-clarify`
- `xforge-design`
- `xforge-check`
- `xforge-apply`
- `xforge-verify`

### 辅助工作 Skills

- `xforge-status`：查询 Change/Requirement 的开发状态；
- `xforge-continue`：从当前 State 恢复并执行下一合法 Action；
- `xforge-revise`：修改已有规划 artifacts 并保持一致；
- `xforge-scaffold`：定制当前项目的 agents、skills、rules、hooks 等本地脚手架资产，再通过 `xforge install` 投影到 Agent 工具目录。

`xforge state` 始终是机器协议和唯一状态事实源，不需要用户直接输入，也不需要把实时状态预先注入固定提示词。`xforge-status` 是它的自然语言查询与解释层。

## 2. 核心原则

### 2.1 强模型负责语义，协议负责治理

目标模型已经能够理解代码库、综合约束、形成即时计划、多文件实现和做语义审查。Skill 不需要重复通用工程教程。

Skill 只提供：

- 当前意图和权限边界；
- Flow 编译出的可执行 Action；
- 项目 Constitution、Rules、Specs 和路径；
- 进入、完成、回退和停止条件；
- Approval、Gate、Evidence 与 Archive 规则。

设计公式：

> **Skill = 意图入口 + 权限边界 + 最短执行循环**
>
> **Flow = Stage 图 + Artifact 契约 + 质量策略**
>
> **State = Flow 编译后的可执行 Actions**
>
> **Gate/Evidence = 完成声明的机器证明**

### 2.2 省略阶段不等于省略能力

Quick 没有 Design，Solid 没有 Clarify/Check，三个 Flow 都没有独立 Plan。这只表示不要求对应的持久 artifact 和正式质量门：

- 模型仍需在材料歧义时请求决定；
- Apply 仍需形成可执行顺序；
- Quick 仍需做必要的局部技术判断；
- Solid 仍需在 Design 中覆盖验证策略；
- 所有 Flow 都必须 Verify，并最终 Archive。

如果省略的治理信息成为安全交付所必需，应升级 Flow：

```text
quick -> solid -> major
```

### 2.3 状态按需查询

实时 State 不进入固定 system/project prompt：

- 状态容易过期；
- 多 Change 时会产生噪声；
- 固定注入浪费上下文；
- 所有写入 Skill 本来就必须在行动前刷新状态。

因此：

- CLI `xforge state` 提供机器 JSON；
- 每个核心/辅助 Skill 在需要时主动调用；
- `xforge-status` 将 JSON 解释为用户可读进度；
- 完成 Action 后重新查询 State，不依赖模型记忆推进阶段。

## 3. Flow 选择

| Flow | 适用范围 | 持久质量边界 |
| --- | --- | --- |
| `quick` | 强调快速；低风险、单模块、小范围、行为和修复路径清楚 | Propose + Verify |
| `solid` | 强调稳定；普通产品功能和常规工程变更 | Propose + Design + Verify |
| `major` | 强调重大；高风险、跨系统、关键影响或复杂交付 | Propose + Clarify + Design + Check + Verify |

规则：

- Quick 以速度为目标，但只接受明确低风险、易回滚且无关键影响的 Change；
- Solid 以稳定和可维护性为目标，接受普通低/中风险变更；
- Major 以重大影响治理为目标，用于高风险、跨系统、跨团队、安全、隐私、公共 API、数据迁移、难回滚或复杂 rollout；
- Major 表示治理量级，不只是代码量；
- 模型依据项目事实填写 classification 并解释选择；
- CLI 根据 Flow policy 验证是否合法，不自行猜业务风险；
- 无法确认时升级一档或返回用户决策。

Checker 不应硬编码 Flow 名称，而应解释 `eligibleWhen/requiredWhen` policy，使自定义 Flow 可以复用相同 Stage 和 Skill。

## 4. 工作流阶段

### 4.1 Propose

Propose 是三个 Flow 的共同入口，负责建立一个可实施、可验证的规格，不再生成 Design 或长期 Plan。

职责：

- 创建或选择 Change；
- 写入 `change.yaml`，声明 Flow、classification、modules 和 path scope；
- 描述 Why、Scope、Non-goals、Actors、Success criteria；
- 生成 requirements、scenarios 和 delta Specs；
- 覆盖成功、失败、边界和兼容性行为；
- 解释 Flow 选择并接受 CLI policy 校验。

建议产物：

```text
change.yaml
proposal.md
specs/**/*.md
```

Propose 不负责详细技术设计、固定任务计划、产品代码或替用户决定材料性歧义。

### 4.2 Clarify

Clarify 只在 Major 中形成正式阶段，用于消除会影响范围、设计、兼容性、风险或验收的关键歧义。

职责：

- 从 Proposal、Specs、Rules 和代码事实中识别关键未知；
- 优先自行调查，不询问可以从项目查明的问题；
- 只向用户提出会改变结果的少量问题；
- 记录问题、影响、决定、来源和状态；
- 将确认结果回写 Proposal/delta Specs；
- 未解决的 material ambiguity 保持阻塞。

建议产物：

```text
clarifications.md
```

Clarify 对 Proposal/Specs 的回写与 clarifications 作为一次原子修订提交。之后发生的材料性上游修改会使 Clarify 和所有下游 Evidence 失效。

Quick/Solid 没有独立 Clarify artifact，但任何阶段遇到材料歧义仍必须返回 `request-decision`。

### 4.3 Design

Design 存在于 Solid 和 Major。

共同职责：

- 建立当前系统、目标行为和集成点模型；
- 记录主要技术决策、替代方案和拒绝理由；
- 覆盖接口、数据、失败模式、兼容性、迁移和回滚；
- 映射 Constitution、Rules 和现有架构约束；
- 保持在技术决策层，不退化为逐文件任务列表。

建议产物：

```text
design.md
```

Major 没有独立 Plan，因此其 Design 额外覆盖 trust boundaries、风险与缓解、测试策略、rollout、monitoring、stop signals、rollback、owner 和并行边界。

Solid Design 至少包含 implementation approach 和 verification notes，使 Apply 可以安全建立即时计划。

### 4.4 Check

Check 只存在于 Major，是实现前的跨 artifact 质量门。

它检查：

- Proposal/Specs 是否完整、明确、可测试；
- Clarifications 是否解决关键歧义；
- Design 是否覆盖需求、约束、风险、失败场景和兼容性；
- 测试、rollout 和 rollback 策略是否与风险匹配；
- 范围、路径、依赖、owner 和并行边界是否可实施；
- 是否存在遗漏、矛盾、范围漂移或过度设计。

Check 默认只读 governing artifacts，只允许写 `check-report.md` 和由 CLI 生成的检查证据。发现问题时返回 Propose/Clarify/Design rework。

Check 不检查长期任务计划，因为计划属于 Apply 的即时执行行为。

#### `xforge-check` 与 `xforge check`

- `xforge-check`：Agent Skill，做实现前语义性跨 artifact 审查；
- `xforge check`：确定性 CLI，执行 schema、路径、Gate 和 Evidence 校验。

CLI 结果是 Check 的证据输入，不能替代语义判断。

### 4.5 Apply

Apply 负责即时执行规划与实现，不依赖独立 Plan stage。

开始实现前，模型必须：

- 从 Proposal/Specs、可选 Design 和 Check report 提取约束；
- 建立依赖顺序和最小交付单元；
- 判断安全并行和必须串行的共享资源；
- 为每个单元确定验证方式和完成条件。

计划按需持久化：

- Quick 默认只保留内部短计划；
- Solid 在复杂度需要时生成任务记录；
- Major、多 Agent、长任务或需要恢复时生成 `work-packages.yaml`、delivery records 或精简 task tracker；
- 它们是 Apply 的执行资产，不是新的治理 Stage；
- CLI 校验 work-package DAG、写入范围、依赖和验证命令。

Apply 只写 Change scope 内代码、测试、执行跟踪和经验证的 delivery records。不得写主 Specs、Gate Evidence、Archive 路径或范围外文件。

现实推翻上游假设时返回 Propose/Clarify/Design rework，而不是静默改写治理事实。

### 4.6 Verify 与 Archive

Verify 是实现后的正式质量门：

- 将 requirement/scenario 映射到实现和自动化测试；
- 核对 Design、Constitution、Rules 和 scope；
- 验证 work-package deliveries 和 Git 边界；
- 运行 Flow mandatory Gates；
- 区分 blocker、warning 和 suggestion；
- 生成 assurance report、Gate Evidence 和 verification receipt。

Verify 默认不修产品代码。失败时产生 `apply:rework` Action；实现变化会使旧 receipt 失效。

Archive 在协议层保持独立，因为它会同步主 Specs 和移动 Change，权限高于验证。但在 Skill/UI 层由 `xforge-verify` 统一处理：

| 模式 | 用户意图 | 结果 |
| --- | --- | --- |
| `verify-only` | 检查、验收、判断 readiness | 停在 verified-active |
| `verify-and-archive` | 验证并归档/关闭 Change | 成功后 dry-run，再执行 Archive |
| `archive-current` | 已验证 Change 明确要求归档 | receipt 当前则归档，否则先重新 Verify |

Archive 必须绑定当前 Change digest、Git HEAD 和 Flow/Gate versions，先 dry-run，拒绝 stale Evidence/冲突，原子同步 Specs 和移动 Change。它不推导 deploy/release 权限。

## 5. 三个官方 Flow

### 5.1 Quick

```text
propose -> apply -> verify -> [archive action]
```

| 项目 | 设计 |
| --- | --- |
| 适用 | 低风险、单模块、小范围、易回滚 |
| 持久规划 | Proposal + delta Specs |
| Apply | 直接执行，内部短计划 |
| Verify | requirements mapping、structure、unit-tests |
| Archive | Verify 明确授权后执行 |

### 5.2 Solid

```text
propose -> design -> apply -> verify -> [archive action]
```

| 项目 | 设计 |
| --- | --- |
| 适用 | 常规产品功能和工程变更 |
| 持久规划 | Proposal + delta Specs + Design |
| Apply | 自适应即时规划；必要时持久 tasks/work packages |
| Verify | requirements/design mapping、项目 Gates |
| Archive | Verify 明确授权后执行 |

复杂到需要正式 Clarification、跨 artifact Check、跨团队风险控制或复杂 rollout 时升级 Major。

### 5.3 Major

```text
propose -> clarify -> design -> check -> apply -> verify -> [archive action]
```

| 项目 | 设计 |
| --- | --- |
| 适用 | 高风险、跨系统、关键影响或复杂交付 |
| 持久规划 | Proposal + delta Specs + Clarifications + enhanced Design + Check report |
| Apply | 即时规划；多 Agent/长任务时持久 work packages |
| Verify | requirements/design/risk mapping、独立 review、security/项目 Gates |
| Archive | Verify 明确授权后执行 |

Major 不包含长期 Plan 或统一 implementation approval：

- 执行计划由 Apply 即时形成；
- 用户明确要求实现即构成普通实施授权；
- 数据删除、不可逆迁移、生产/外部写入、权限扩大等动作仍需 Action 级即时确认；
- Check 和 Verify 是质量门，不是重复授权门。

## 6. Skills 系统

### 6.1 核心生命周期 Skills

| Skill | 权限 | 适用 Flow |
| --- | --- | --- |
| `xforge-explore` | read-only | Flow 外/全部 |
| `xforge-propose` | planning-write | Quick/Solid/Major |
| `xforge-clarify` | planning-write + decisions | Major |
| `xforge-design` | planning-write | Solid/Major |
| `xforge-check` | assurance-write | Major |
| `xforge-apply` | implementation-write | Quick/Solid/Major |
| `xforge-verify` | assurance-write；显式时 archive-write | Quick/Solid/Major |

当前 `xforge-archive` 可以保留一个迁移周期作为 shim：只查询 State，并转向 `xforge-verify` 的 `archive-current` 模式。

### 6.2 `xforge-explore`

Explore 是只读调查与决策准备，不只是代码状态查询。

它可以：

- 查看代码、架构、依赖和运行行为；
- 查看当前 Specs、Rules、Flows 和 active Changes；
- 诊断 Bug、失败或技术债根因；
- 比较方案、风险、兼容性和影响范围；
- 判断现有 Change 是否覆盖新问题；
- 推荐 Quick、Solid 或 Major；
- 把模糊想法收敛成可 Propose 的范围。

Explore 不创建 Change、不写代码、不安装资产，也不声称 Gate 已通过。用户要求记录或实施时转入 Propose/Apply。

### 6.3 `xforge-status`

Status 是只读的自然语言状态入口，调用 `xforge state`，不维护第二份状态。

触发：

- “这个需求做到哪了？”
- “REQ-123 当前状态是什么？”
- “这个 Change 为什么被阻塞？”
- “还有哪些任务或工作包？”
- “可以 Verify/Archive 了吗？”

固定输出：

- Change/Requirement ID；
- Flow 和当前 Stage；
- 已完成、未完成和 invalidated Stages；
- blockers/diagnostics；
- tasks/work packages/deliveries；
- Evidence 是否当前；
- Verify/Archive readiness；
- 下一合法 Action 和推荐 Skill。

Status 严格只读，不“顺便继续”或修复问题。

### 6.4 `xforge-continue`

Continue 是通用恢复和状态驱动推进入口，对应“继续这个 Change/执行下一步”。它取代预设的 `xforge-deliver` 和单独 fast-forward Skill。

执行：

```text
xforge state
    -> 解析 ready Actions
    -> 选择与用户授权一致的下一 Action
    -> 调用/遵守推荐 Stage Skill
    -> 执行
    -> 刷新 State
```

约束：

- 多 Change 时必须解析唯一 ID；
- 不硬编码 Quick/Solid/Major 序列；
- 不跳过 Major Clarify/Check；
- 遇材料歧义、失败 Gate、范围扩大或外部副作用停止；
- 可按用户意图执行一个 Action 或连续推进；
- 默认最多推进到 Verify satisfied；
- Archive 始终需要明确授权。

`xforge-continue` 解决新会话、压缩上下文、Agent 更换和工作包合并后的恢复问题。

### 6.5 `xforge-revise`

Revise 专门维护已有 Change planning artifacts 的一致性，不修改产品代码。

触发：

- 需求或范围发生变化；
- 新决定需要同步到 Proposal/Specs/Design；
- Check 发现规划问题；
- Apply 发现上游假设错误；
- 需要重构已有 Change，而不是新建 Change。

行为：

- 查询 State 和依赖图；
- 找到最早受影响的 governing artifact；
- 修改 Proposal/Specs/Clarifications/Design 中获授权的部分；
- 重建跨 artifact 一致性；
- 刷新 State，让 digest 自动失效 Check、Apply 或 Verify receipt；
- 报告哪些 Stage 需要重新执行。

Revise 不修改 Check report、Gate Evidence、代码或 archive。后续实现调整交给 Apply。

### 6.6 `xforge-scaffold`

Scaffold 用于定制当前项目本地的 Agent 能力资产，不涉及 XForge 上游仓库：

```text
<project>/xforge/scaffold/
├── agents/
├── skills/
├── rules/
├── hooks/
└── gates/
```

它可以：

- 新增或调整项目 Agent；
- 创建、拆分或修改项目 Skill；
- 编写 Rules 和 Hooks；
- 调整 Agent 与 Skill、Rule 与 Gate 的引用；
- 检查目标 Adapter 的能力降级；
- 将本地 canonical assets 安装到项目启用的 Agent 工具目录。

工作流：

```text
(vNext) xforge state --kind <resource>
    -> 读取现有本地资产、Manifest 选择和目标能力
    -> 修改 xforge/scaffold/**
    -> 必要时最小更新 xforge/manifest.yaml 的 scaffold 选择列表
    -> xforge check
    -> xforge install --dry-run
    -> 展示跨目标 diff、冲突和能力降级
    -> 用户确认敏感变化
    -> xforge install
    -> 再次查询 State 验证安装结果
```

仅在新增、删除、启用或停用资源时允许修改 `xforge/manifest.yaml` 的这些列表：

```yaml
scaffold:
  skills: []
  agents: []
  rules: []
  hooks: []
  gates: []
```

不建议自动发现并启用 `xforge/scaffold/` 下全部文件，否则未完成 Skill、新 Hook 或权限扩大的 Agent 可能被意外安装。

Scaffold 不得直接修改生成目录：

```text
.agents/
.claude/
.cursor/
.opencode/
.github/
```

这些目录只能由 `xforge install` 根据 Adapter、ownership 和 conflict policy 投影。

Hooks、网络访问、Secrets、工具权限扩大和破坏性命令必须在 install 前明确展示并请求确认。Scaffold 不修改产品代码、Specs、Changes 或 Flow 业务状态。

不新增专用 CLI 是更小的设计：

- `xforge state` 负责盘点；
- `xforge check` 负责验证；
- `xforge install --dry-run` 负责预览；
- `xforge install` 负责投影。

未来只有在需要确定性模板生成时，再考虑 `xforge scaffold init <kind> <id>`。

### 6.7 Skill 正文结构

每个 Skill 保持短小：

```markdown
# Invariants
- 使用 XForge State，不猜测 Flow、路径、Evidence 或权限。

# Authority
- 只接受本 Skill 对应的 ready Actions。
- 声明允许和禁止的写入。

# Execute
1. 查询 State。
2. 读取 Action inputs。
3. 完成语义工作或调用确定性执行器。
4. 刷新 State，直到 satisfied、rework 或 blocked。

# Evidence
- 按 doneWhen 和 requiredEvidence 声明完成。

# Stop/Rework
- 处理歧义、范围变化、失败 Gate 和权限扩大。
```

Skill 不硬编码 Flow 序列、artifact 文件名、Gate 列表、work-package 策略或客户端目录。

## 7. OpenSpec 辅助能力取舍

| OpenSpec 能力 | XForge 决策 | 原因/归属 |
| --- | --- | --- |
| Onboard | 暂不作为核心 Skill | Bootstrap、根 AGENTS 和各 Skill preconditions 已覆盖；以后可做可选教程 |
| New Change | 不新增 | 已由 `xforge-propose` 创建 Change |
| Continue Change | 新增 `xforge-continue` | 提供统一恢复和下一步执行入口 |
| Fast Forward | 不新增 | Continue 可连续推进且不会绕过 Clarify/Check |
| One-step Propose | 不新增 | 会破坏 Solid/Major 的 Design/Check 边界 |
| Update Change | 新增 `xforge-revise` | 专门维护 planning artifacts 一致性 |
| Apply Change | 保留 `xforge-apply` | 即时规划、实施和进度跟踪 |
| Sync Specs | 不新增 | Specs 同步绑定 Archive，避免未完成 Change 污染主 Specs |
| Archive | 并入 Verify Skill 的显式模式 | 协议权限仍独立，单独 Skill 仅保留迁移 shim |
| Bulk Archive | 暂缓 | 需要冲突图、逐项 dry-run 和明确批量授权，有真实需求后做 CLI 能力 |
| Verify Change | 保留 `xforge-verify` | 实现后符合性、Gates、Evidence 和 Archive readiness |

原则：新增 Skill 必须对应独立、高频、权限不同或恢复价值明确的用户意图；不能只因为 OpenSpec 有同名能力就复制。

## 8. Flow Schema 方向

Flow vNext 以 Stage 为主轴：

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Flow

metadata:
  name: major
  version: 2
  description: High-assurance flow for risky or cross-system changes

policy:
  assuranceLevel: major
  eligibleWhen:
    risk: [low, medium, high]
    criticalImpacts: allowed
  requiredWhen:
    risk: [high]
    anyImpact: [security, privacy, publicApi, dataMigration]
  onUncertain: escalate

stages:
  - id: propose
    skill: xforge-propose
    authority: planning-write
    requires: []
    produces: [proposal, delta-specs]
    gates: [structure]
    reworkTo: [propose]

  - id: clarify
    skill: xforge-clarify
    authority: planning-write
    requires: [propose]
    produces: [clarifications]
    revises: [proposal, delta-specs]
    exit: { materialQuestions: resolved }

  - id: design
    skill: xforge-design
    authority: planning-write
    requires: [clarify]
    produces: [design]

  - id: check
    skill: xforge-check
    authority: assurance-write
    requires: [design]
    produces: [check-report]
    gates: [structure, planning-consistency]

  - id: apply
    skill: xforge-apply
    authority: implementation-write
    requires: [check]
    execution:
      planning: just-in-time
      workPackages: adaptive

  - id: verify
    skill: xforge-verify
    authority: assurance-write
    requires: [apply]
    produces: [assurance, verification-receipt]
    gates: [structure, unit-tests, security-scan]

terminal:
  archive:
    handler: xforge-verify
    authority: archive-write
    requires: [verify]
    syncSpecs: true
    evidencePolicy: current-revision
```

Quick/Solid 使用同一 Schema 裁剪 `stages`。正式 schema 必须可静态校验，不引入任意表达式或嵌入式脚本。

辅助 Skills 不写进某个 Flow 的 Stage 图：

- Explore/Status 是只读旁路；
- Continue 消费 Stage Actions；
- Revise 通过 rework/invalidation 作用于 planning graph；
- Scaffold 管理项目 Agent assets，与业务 Change lifecycle 分离。

## 9. State、Requirement ID 与 Action 协议

### 9.1 State 输出

`xforge state --change <id>` 返回 Stage 状态和 ready Actions：

```json
{
  "revision": "sha256:state-revision",
  "flow": { "id": "solid", "version": 2 },
  "stages": [
    { "id": "propose", "status": "satisfied" },
    { "id": "design", "status": "satisfied" },
    { "id": "apply", "status": "ready" },
    { "id": "verify", "status": "unavailable" }
  ],
  "nextActions": [
    {
      "id": "apply:change",
      "stage": "apply",
      "skill": "xforge-apply",
      "actor": "agent",
      "authority": "implementation-write",
      "inputs": [
        { "path": ".../spec.md", "reason": "defines changed behavior" },
        { "path": ".../design.md", "reason": "governs implementation" }
      ],
      "writes": ["resolved/change/scope/**"],
      "doneWhen": ["requirements implemented", "targeted checks pass"],
      "requiredEvidence": ["tests", "delivery-record"],
      "reworkTo": ["propose", "design", "apply"],
      "stateRevision": "sha256:state-revision",
      "blockingDiagnostics": []
    }
  ]
}
```

### 9.2 Requirement ID 索引

可靠查询 Requirement ID 需要稳定 ID 和确定性索引，不能让 Status Skill 搜索 Markdown 猜测。

目标关系：

```text
Requirement ID
  -> owning Spec
  -> active Change(s)
  -> Flow/Stage
  -> implementation references
  -> tests
  -> current Evidence
```

建议扩展：

```text
xforge state --change <change-id>
xforge state --requirement <requirement-id>
```

在索引实现前，`xforge-status` 对 Change ID 提供强保证；对 Requirement ID 必须标记为启发式或拒绝过度声明。

### 9.3 Action 约束

- Actions 由 Flow compiler 生成，Skill 不推断顺序；
- Action 带 actor、authority、inputs、writes、doneWhen、Evidence 和 revision；
- inputs 是最小相关集合并说明原因，不返回全部 Specs；
- external/CLI Action 不能由 Agent 冒领；
- 多 Action 只有依赖、写入和外部资源均不冲突时并行；
- 提交结果前检查 revision；
- rework 明确目标 Stage 和失效范围；
- 需要用户决定时返回 `request-decision`。

## 10. Gates、Evidence 与失效

质量分三层：

| 层 | 作用 |
| --- | --- |
| Artifact validator | 单个 Proposal/Specs/Design/Report 的结构和最小契约 |
| Check Skill | Major 实现前跨 artifact 的语义一致性与可实施性 |
| Verify Skill + Gates | 实现后符合性、测试和机器 Evidence |

Evidence 至少绑定 Change ID、Flow ID/version、Stage、State revision、Git base/head、输入 artifact digests、Gate ID/version/command、timestamp、exit status 和输出 digest。

上游材料性变更使下游按 digest 依赖失效：

```text
Proposal/Specs changed -> Clarify/Design/Check/Apply/Verify stale
Design changed         -> Check/Apply/Verify stale
Implementation changed -> Verify receipt stale
Scaffold asset changed -> installed target digest stale
```

Archive 只接受当前 revision 的成功 receipt；Install 只接受当前 scaffold assets 和 Manifest 选择形成的计划。

## 11. 完备性审计

### 11.1 能力覆盖

| 能力域 | 负责组件 | 状态 |
| --- | --- | --- |
| 需求创建与规格化 | Propose | 完整 |
| 关键歧义治理 | Major Clarify | 完整 |
| 技术决策 | Solid/Major Design | 完整 |
| 实现前质量 | Major Check | 完整 |
| 即时规划与实施 | Apply | 完整 |
| 实现后验证 | Verify + Gates | 完整 |
| Specs 同步与关闭 | Verify 的 Archive action | 完整 |
| 只读调查 | Explore | 完整 |
| 状态查询 | Status + State | 需 Requirement ID 索引补强 |
| 中断恢复与继续 | Continue + Actions | 需多 Action/Stage State 落地 |
| 规划材料维护 | Revise + invalidation | 需 digest 失效传播落地 |
| 项目 Agent 能力定制 | Scaffold + Install | Install 链路已具备；需 Skill 和资源 State 协议落地 |
| 新手引导 | Bootstrap + AGENTS | 基础完整；交互式 Onboard 可选 |
| 批量生命周期操作 | 无核心 Skill | 非当前必需；真实需求后扩展 CLI |
| 发布/部署 | 项目自定义 Skill/Flow | 明确不属于核心 XForge Archive |

### 11.2 结论

在“单项目、以 Change 为单位、从需求到验证归档、支持项目 Agent 能力定制”的范围内，设计闭环已经完备。当前剩余缺口不是继续增加 Skill，而是把以下协议能力实现出来：

1. Stage-aware Flow v1alpha2；
2. 多个 revision-bound `nextActions`；
3. Stable Requirement ID 与状态索引；
4. Artifact validator 和 digest 失效传播；
5. Verification receipt 与 Archive freshness；
6. Scaffold 资源盘点、引用、敏感权限和安装后状态验证。

不建议现在新增 Onboard、FF、Sync、Bulk Archive 或 Deliver。它们要么已有协议承载，要么不是高频独立权限意图。

## 12. 评测

### 12.1 触发评测

重点区分：

- Explore vs Status；
- Propose vs Revise；
- Continue vs Apply；
- Check vs Verify；
- Revise vs Apply rework；
- Scaffold vs 普通产品代码修改；
- Verify-only vs Verify-and-Archive。

### 12.2 行为矩阵

```text
Skills: 7 core + 4 auxiliary
x Flows: quick/solid/major/custom
x State: ready/blocked/rework/stale/resumed/multiple-changes
x Mode: portable/managed
x Result: success/ambiguity/failed-check/failed-gate/conflict
```

核心断言：

- Quick 不生成 Design/Clarify/Check artifacts；
- Solid 不生成 Clarify/Check artifacts；
- Major Check 失败不能进入 Apply；
- Apply 按复杂度选择内部计划或持久 work packages；
- Verify 失败返回 Apply rework；
- Archive 只在明确授权且 receipt 当前时发生；
- Explore/Status 始终只读；
- Continue 不跳过 Flow 边界；
- Revise 不修改代码或 Evidence；
- Scaffold 只改项目本地 assets/选择，并由 Install 投影；
- Stage Skill 不硬编码 Flow 名称和序列。

## 13. 落地顺序

实现按以下顺序推进；兼容策略在每一阶段保持有效：

### P0：冻结设计

1. 冻结 Quick/Solid/Major 阶段图。
2. 冻结 7 个核心 + 4 个辅助 Skill 的职责和触发边界。
3. 冻结 Verify/Archive 的 Skill 与协议分层。
4. 冻结 State/Status、Continue 和 Requirement ID 语义。
5. 冻结 Scaffold 只修改项目本地 assets/Manifest selection 的边界。

### P1：Flow/State

1. 定义 Flow `v1alpha2` 的 policy、stages、terminal 和 Evidence。
2. `prime.yaml` 迁移为 `major.yaml`。
3. 返回 Stage 状态、多个 Actions、revision 和 reworkTo。
4. 引入 Artifact validators 和 digest 失效传播。
5. 建立 Requirement ID index。

### P2：核心 Skills

1. 新增 Clarify/Design/Check；收窄 Propose；重构 Apply/Verify。
2. Archive Skill 保留一版 shim 后退出 canonical 集合。
3. 更新 Manifest、Adapters、触发评测和行为评测。

### P3：辅助 Skills

1. 实现 Status/Continue/Revise/Scaffold。
2. 增加项目本地 Scaffold 引用闭合和敏感权限校验。
3. 验证 install dry-run/install/ownership 全闭环。
4. 增加 Requirement/Change 状态查询 golden tests。

### 兼容策略

- v1alpha1 项目继续使用当前 Flow 和五个 Skills；
- v1alpha2 使用 Major、七个核心和四个辅助 Skills；
- `prime`、旧 Archive Skill 只保留一个迁移周期；
- 不永久维护无提示 alias；
- 项目可在 Manifest 中选择是否启用辅助 Skills；
- Scaffold Skill 本身也通过项目 `xforge/scaffold` 和 `xforge install` 管理。

## 14. 最终决策

1. **Flow 收敛为 Quick、Solid、Major。** Prime 更名为 Major。
2. **移除独立 Plan。** Apply 即时规划，复杂时才持久化 work packages。
3. **移除统一 Implementation Approval。** 高风险副作用使用 Action 级即时确认。
4. **保留 Major Clarify 和 Check。** 分别控制需求歧义和实现前质量。
5. **Verify 在 Skill 层承接 Archive，在协议层保持权限分离。**
6. **核心生命周期 Skills 固定为七个。**
7. **辅助 Skills 增加 Status、Continue、Revise、Scaffold。**
8. **State 是机器协议；Status 是用户解释层。**
9. **Continue 替代 FF/Deliver，Revise 对应规划维护。**
10. **Scaffold 只定制当前项目 `xforge/scaffold`，由 Install 投影到 Agent 目录。**
11. **Specs Sync 绑定 Archive，不提供独立 Sync Skill。**
12. **设计范围内已经完备，下一步重点是协议实现与评测，不是增加更多 Skills。**

## 15. 外部参照

- [Agent Skills Specification](https://github.com/agentskills/agentskills/blob/217be548739f21d6008915c29aefe320ea1a90af/docs/specification.mdx)：可移植格式、description 路由与渐进式披露。
- [OpenSpec](https://github.com/Fission-AI/OpenSpec/tree/e50bd0983dc8dc48250e3181f36e28450542f2ab)：动态 artifact graph、Continue/Update/Apply/Verify 等辅助意图。
- [Spec Kit](https://github.com/github/spec-kit/tree/684b3d8e05263a7c1948d3d0699ab1cb4f77c3d5)：Specify、Clarify 和实现前 cross-artifact analysis。
- [Superpowers](https://github.com/obra/superpowers/tree/44c9b2d6e889982ac18c27d05a19fefe335194e1)：完成前新鲜证据和独立 review。
- [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD/tree/cbb69e64e744ef545f174386ca793144ecbd1cfc)：按需上下文、恢复和分层审查。
