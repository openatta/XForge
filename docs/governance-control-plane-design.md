# XForge 质量门、流程管制与审计控制面设计

- **状态：** Accepted / Protocol 2 P0–P4 已实现
- **日期：** 2026-08-09
- **适用目标：** XForge Protocol 2 / `@xforge/cli 0.7.6`
- **当前基线：** [XFORGE_PRODUCT_SPEC.md](XFORGE_PRODUCT_SPEC.md)
- **关联设计：** [Flows 与 Skills](flows-and-skills-design.md)、[子 Agent](sub-agent-system-design.md)、[CLI](cli-tool-design.md)、[Adapter 能力矩阵](adapter-matrix.md)

## 1. 决策摘要

XForge 应成为 Git 原生的研发控制平面，而不是另一个 Agent Runtime。它统一项目事实、流程状态、质量证明和审计记录，同时把平台差异限制在 Adapter 中。

目标模型分为七种不同语义：

```text
Constitution        长期治理原则
    ↓
Rule                给 Agent 的工程指导
PermissionPolicy    对工具、命令、路径和网络的运行权限
    ↓
Flow / Transition   阶段状态、合法转换和 rework
    ↓
Hook                事件拦截、自动化和审计采集
Gate                确定性质量检查
Approval            人或授权外部系统作出的决策
    ↓
Evidence + Audit    当前修订的证明和全过程记录
```

必须保持以下真实性边界：

1. Rule 被加载不等于被执行；
2. Hook 被触发不等于质量通过；
3. Agent、Reviewer 或模型给出的 `PASS` 不等于机器 Gate；
4. Gate 只有在当前修订上真实运行并生成有效 Evidence 才算通过；
5. Approval 必须来自可识别的人或授权系统，Agent 不得自我批准；
6. Archive 只接受当前修订的 Gates、Approvals 和 Audit completeness。

## 2. 设计来源与取舍

### 2.1 OpenSpec

借鉴：

- Change 是一个独立工作单元；
- Delta Specs 表达变化；
- Archive 把变化折叠回当前 Specs；
- Artifact 可以返回修改，不把每次文件写入变成流程阻塞。

不照搬：

- OpenSpec 明确把许多团队行为视为约定而非强制执行；
- XForge 必须额外提供 Transition Guard、Gate Evidence、Approval 和 Audit。

参考：[Core Concepts](https://github.com/Fission-AI/OpenSpec/blob/main/docs/overview.md)、[Team Workflow](https://openspec.dev/docs/team-workflow)、[Customization](https://openspec.dev/docs/customization)。

### 2.2 Spec Kit

借鉴：

- Constitution 是后续阶段的治理输入；
- 实现前进行跨 Artifact 一致性分析；
- Workflow 保存运行状态和 JSONL 日志；
- 人工 Gate 可以暂停并恢复流程。

不照搬：

- Workflow shell 没有能力沙箱；
- Extension Hook 主要是工作流拼装，不能直接成为 Agent Runtime 安全边界。

参考：[Agentic SDD](https://github.github.com/spec-kit/reference/agentic-sdd.html)、[Workflows](https://github.com/github/spec-kit/blob/main/docs/reference/workflows.md)、[Extensions](https://github.github.com/spec-kit/reference/extensions.html)。

### 2.3 Kiro 与 BMAD

Kiro 把 Specs、Steering、Permissions 和 Hooks 分成不同能力，说明“指导模型”“运行权限”“事件触发”“规格流程”不应共用一个 Rule/Hook 概念。BMAD 则明确区分模型判断和适合交给确定性脚本的机械工作。

参考：[Kiro Specs](https://kiro.dev/docs/specs/)、[Kiro Hooks](https://kiro.dev/docs/hooks/)、[Kiro Permissions](https://kiro.dev/docs/permissions/)、[BMAD Sprint Planning](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/explanation/sprint-planning.md)。

## 3. 控制面边界

### 3.1 XForge 负责

- 解析 Constitution、Rules、Policies、Flow 和 Change；
- 计算当前 State revision 和合法 Actions；
- 验证 Transition 前置条件；
- 运行确定性 Gates 并写 Evidence；
- 记录 Approval receipts；
- 记录 XForge Workflow Audit；
- 规范化平台 Runtime Hook 事件；
- 验证 Evidence freshness 和 Audit completeness；
- 在 Archive 时原子同步 Specs 并移动 Change。

### 3.2 XForge 不负责

- 创建或托管模型进程；
- 承诺五种 Agent 工具具有等价的 Hook、权限或沙箱；
- 用 Prompt 实现硬权限；
- 把仓库内可修改 Hook 当成不可绕过的企业策略；
- 自动获得生产部署、数据库写入或外部系统权限；
- 保存完整 Prompt、模型思维过程、环境变量或未脱敏工具输出。

### 3.3 两个执行平面

```text
Agent Runtime Plane
  平台 session / prompt / tool / permission / subagent / stop events
  作用：实时 guard、观察、补充审计

XForge Workflow Plane
  change / stage / gate / approval / archive events
  作用：跨平台一致的流程状态、质量证明和核心审计
```

Workflow Plane 是核心保证。即使目标平台不支持 Runtime Hook，XForge 仍必须能够控制 Check、Transition 和 Archive。

## 4. Rules 与 PermissionPolicy

### 4.1 Rule 只表达工程指导

Rule 是模型可见的项目指导，不直接表示运行权限。目标字段语义：

```yaml
kind: Rule
metadata:
  name: api-compatibility
spec:
  severity: must            # must | should
  instruction: 公共 API 必须保持向后兼容。
  scope:
    modules: [api]
    paths: [services/api/**]
    stages: [design, apply, verify]
  enforcement:
    gateRefs: [api-compatibility]
    policyRefs: []
```

这是目标示例，不是当前已实现 Schema。

`severity: must` 表示项目要求强度，但不自动形成 Gate pass。`xforge state/check` 应计算 Rule coverage：

| 状态 | 含义 |
| --- | --- |
| `instructed` | Rule 已进入当前 Agent/Skill 上下文 |
| `guarded` | 存在适用的 PermissionPolicy 或 Runtime Guard |
| `verified` | 当前修订上存在关联的成功 Gate Evidence |
| `uncovered` | `must` Rule 没有可执行验证或批准覆盖 |

只有 `verified` 或明确设计为人工判断且具有当前 Approval receipt 的要求，才能满足 Transition。

### 4.2 PermissionPolicy 是独立资源

PermissionPolicy 表达 Agent 运行时权限：

```yaml
kind: PermissionPolicy
metadata:
  name: protected-files
spec:
  capability: fs.write
  effect: deny               # deny | ask | allow
  match:
    paths:
      - xforge/constitution.md
      - xforge/specs/**
  exceptActors: [integrator]
```

目标 capability：

- `fs.read`、`fs.write`；
- `shell`；
- `network`；
- `mcp`；
- `subagent`；
- `external.write`。

固定合并规则为 `deny > ask > allow`。同级策略按更具体 scope 优先；冲突不能静默降级。

### 4.3 平台名称不决定 XForge 语义

Codex 原生 `Rules` 控制沙箱外命令权限，因此映射 PermissionPolicy，而不是 XForge Rule。Claude、Cursor、Copilot 和 OpenCode 中的 instructions/rules/steering 主要映射 XForge Rule。具体路径和能力见 [Adapter matrix](adapter-matrix.md)。

## 5. Hooks

### 5.1 Runtime Hook

Runtime Hook 使用规范化事件命名：

```text
agent.session.start
agent.session.end
agent.prompt.submit
agent.tool.before
agent.tool.after
agent.permission.request
agent.permission.result
agent.subagent.start
agent.subagent.stop
agent.turn.stop
```

每个 Adapter 只投影平台真实支持的事件，并报告：

- 是否存在项目级位置；
- 是否可以阻塞；
- 是否可以返回 allow/ask/deny；
- 是否支持 local/cloud；
- 是否支持 managed policy；
- 失败与超时是 fail-open 还是 fail-closed；
- 哪些工具不会经过 Hook 路径。

Runtime Hook 不能直接写 Gate Evidence 或改变 Stage。它只能：

- 返回平台允许的实时 guard decision；
- 把事件交给 XForge Audit normalizer；
- 请求 Agent 补充工作；
- 记录平台覆盖缺口。

### 5.2 Workflow Hook

Workflow Hook 由 XForge CLI 触发：

```text
change.created
stage.entering
stage.entered
stage.rework
gate.before
gate.after
approval.requested
approval.decided
archive.before
archive.after
```

它不通过 Target Adapter 安装，也不依赖 Agent 平台。核心审计事件由 CLI 内建产生，不允许项目 Hook 关闭；项目 Hook 只是附加自动化。

### 5.3 Hook Action

项目 Hook 默认只引用受管 Script：

```yaml
kind: Hook
metadata:
  name: audit-tool-use
spec:
  plane: runtime             # runtime | workflow
  event: agent.tool.after
  action:
    scriptRef: audit-writer
  failurePolicy: spool       # deny | ask | stop | spool | warn
  timeoutSeconds: 10
```

不建议在 Hook 中直接内嵌任意 Shell 字符串。Adapter 生成的目标文件应是薄桥接，只负责把平台事件 JSON 传给固定 XForge dispatcher。

### 5.4 失败策略

| Hook 类别 | 默认策略 | 说明 |
| --- | --- | --- |
| Guard | `deny` 或 `ask` | 只用于明确的高风险 pre-event；必须报告平台超时语义 |
| Audit | `spool` | 远端失败先本地排队；在 Archive Gate 检查交付完整性 |
| Automation | `warn` | 不因格式化、通知等附加动作阻断核心工作 |

仓库级 Hook 可被同仓库修改，不构成最高保证。Major/受监管环境需要平台 managed policy、设备管理或 CI protected checks。

## 6. Flow、Transition 与 Approval

### 6.1 状态模型

Stage graph 仍由 Flow 定义，但 Stage 完成必须通过显式 Transition：

```text
Draft → Planned → Approved → Implementing → Verifying → ReadyToArchive → Archived
          ↑             ↖──────── Rework ────────────────↙
```

具体 Flow 可以省略某些状态，但不得省略 Verify 和 Archive freshness。

### 6.2 Transition Guard

一次状态转换必须满足：

```text
Artifact prerequisites
+ Machine Gate results for current revision
+ Required Approval receipts
+ Audit completeness
= Transition allowed
```

Transition 由 CLI 决定。Skill、Main Agent、子 Agent 和 Hook 可以请求转换，但不能自行把 Stage 标成 `satisfied`。

### 6.3 Approval

Approval 不是 Gate，也不是普通 Markdown 结论。Receipt 至少绑定：

- Change ID、Flow/Stage、State revision；
- Git base/head 和 governing artifact digests；
- decision：approve/reject；
- approver identity、provider、role；
- timestamp、reason 和可选有效期；
- separation-of-duties 信息；
- receipt digest 或外部系统引用。

交互式 CLI 可以记录当前用户决定；非交互模式只接受授权外部 provider 的可验证 receipt。Agent 不得代表用户调用批准动作。

### 6.4 风险分层

| Flow | 默认 Transition 策略 |
| --- | --- |
| Quick | 不设独立 planning approval；实现前做结构检查；Archive 需要明确用户意图和当前 Evidence |
| Solid | Design → Apply 需要单人 planning approval；Archive 需要当前验证和关闭批准 |
| Major | Check → Apply 和 ReadyToArchive → Archived 都要求显式 Approval；可要求双人、角色分离、managed guard 和远端 Audit delivery |

项目可以提高要求，不能通过自定义 Flow 降低 Constitution 或企业 managed policy 的底线。

## 7. Gates 与 Evidence

### 7.1 Gate 定义

Gate 是确定性检查：

- 内建结构与协议检查；
- 参数数组形式的项目命令；
- 受管 Script；
- 对已签名外部检查结果的验证。

模型生成的 Check report、Reviewer verdict 和 assurance narrative 是 Review Evidence，不是 Machine Gate。若流程要求依赖语义判断，应通过人工 Approval 或独立、可重复的 validator 完成 Transition。

### 7.2 Gate 分层

| 层 | 示例 |
| --- | --- |
| G0 Structure | Schema、路径、引用、所有权、Flow/State 一致性 |
| G1 Planning readiness | Artifact 完整性、未解决 blocker、所需 Approval |
| G2 Implementation quality | test、lint、build、security scan |
| G3 Conformance | Requirement → implementation/test/evidence trace、work-package diff |
| G4 Archive | current revision、Audit completeness、Approval、Spec merge dry-run |

G1 中的机器部分只验证结构化事实；“设计是否合理”等语义判断仍属于 Review/Approval。

### 7.3 Evidence freshness

Gate Evidence 至少绑定：

- Change、Flow、Stage、State revision；
- Git base/head；
- Constitution、Rule、Policy、Gate 和输入 Artifact digests；
- command argv、working directory、runner identity；
- started/finished/duration、exit status；
- bounded/redacted output digest；
- result 和 Evidence schema version。

以下变化必须使 Evidence stale：

```text
Proposal/Specs changed     -> downstream planning/apply/verify stale
Design/Check changed       -> apply/verify stale
Implementation HEAD changed -> verify/archive stale
Rule/Policy/Gate changed   -> linked coverage/evidence stale
Flow changed               -> stage/transition receipts stale
```

## 8. Audit

### 8.1 审计来源

Audit 至少覆盖：

1. XForge 命令调用和结果；
2. Change/Stage/Transition 状态变化；
3. Gate 执行；
4. Approval 请求和决定；
5. Archive 计划和结果；
6. Work Package dispatch、delivery、integration 和 review；
7. 平台 Runtime Hook 能观察到的 session/tool/permission/subagent 事件；
8. 事件覆盖缺口、丢失和远端交付状态。

### 8.2 Audit Envelope

规范化事件至少包含：

```text
eventId / eventType / timestamp
platform / platformVersion / surface
sessionId / turnId / toolCallId / correlationId
actor / change / flow / stage / workPackage
stateRevision / gitBase / gitHead
tool / targetDigest / ruleRefs / policyRefs / gateRefs
decision / approver / reason / outcome / duration
inputDigest / outputDigest / redaction
prevHash / deliveryState
```

平台缺失字段保持 `unknown` 并记录 coverage，不允许伪造完整性。

### 8.3 三层存储

```text
xforge/.audit/*.jsonl
  本地原始 spool，默认 Git ignore，短期、脱敏前禁止提交

<change>/evidence/audit/
  可提交的规范化摘要、索引、覆盖报告和哈希

remote append-only sink
  可选企业长期留存；Cloud Agent 和 Major/regulated 场景使用
```

默认不记录完整 Prompt、模型隐藏思维、全部环境变量、Secrets 或无限工具输出。优先保存 metadata、digest、decision 和受限摘要。

### 8.4 Audit completeness

实时远端写入失败时使用本地 spool，避免每次工具调用都因网络抖动失败。Archive Gate 根据 Flow policy 检查：

- required event classes 是否存在；
- 是否覆盖当前 State revision 和 Git HEAD；
- hash chain 是否连续；
- 是否完成要求的远端交付；
- 是否存在未解释的 runtime coverage gap。

## 9. CLI 集成目标

`0.7.6` 保留 `state/install/sync/update/uninstall/check/archive`，并已增加以下控制面动作：

| 命令 | 目标语义 |
| --- | --- |
| `xforge state --change <id>` | 返回 Stage、Transition requirements、Rule coverage、Policy/Hook/Audit coverage |
| `xforge transition --change <id> --to <stage>` | dry-run 并执行合法状态转换 |
| `xforge check --change <id> [--gate <id>]` | 运行 Machine Gate 并生成当前 Evidence |
| `xforge approve ...` | 交互式记录人类决定，或验证外部 Approval receipt |
| `xforge audit status|verify|export ...` | 查询覆盖、验证链和导出脱敏审计 |
| `xforge work-package dispatch ...` | 生成 revision/policy/audit 绑定的派工 receipt |
| internal hook dispatcher | 接收平台 Hook JSON，规范化并执行 guard/audit action |

所有写命令继续采用：

```text
resolve current state
→ produce dry-run plan
→ verify authority/approval
→ execute transaction
→ write evidence/audit
→ return one JSON envelope
```

Hook dispatcher 是 Adapter 使用的内部稳定入口，不作为普通用户 CRUD 命令。

## 10. Skills 集成

Skill 保持“意图入口 + 权限边界 + 最短执行循环”，不复制 Flow 状态机。

每个写入型 Skill 必须：

1. 调用 `xforge state` 获取当前 revision 和 ready Actions；
2. 只接受与自己 authority 匹配的 Action；
3. 加载适用 Constitution、Rules、PermissionPolicy 摘要和 Gate 要求；
4. 在 Action 边界重新查询状态；
5. 请求 CLI Transition，而不是直接修改 Stage；
6. 遇 Approval、权限扩大、外部副作用或 stale revision 时停止；
7. 不自行写 Gate Evidence、Approval receipt 或核心 Audit 记录。

职责调整：

- `xforge-check` 产生语义 Review Evidence，不宣布 Machine Gate pass；
- `xforge-apply` 遵守 PermissionPolicy 和 work-package isolation；
- `xforge-verify` 调用确定性 Gate，形成 assurance 与 receipt；
- `xforge-continue` 只能选择 `state.nextActions` 中的合法 Action；
- `xforge-scaffold` 可以编辑 Rule/Policy/Hook/Gate 源资产，但必须展示权限和信任影响，并通过 install/sync 投影；
- `xforge-status` 展示 coverage、stale Evidence、pending Approval 和 Audit gaps。

## 11. 子 Agent 集成

子 Agent 协议仍只有 Worker、Integrator、Reviewer，不新增 Gatekeeper Agent。

- Worker 只能完成一个工作包，不能批准、转换 Stage 或写 Gate Evidence；
- Integrator 是共享路径唯一写者，但仍受 PermissionPolicy 和 Change scope 约束；
- Reviewer 只生成 findings/Review Evidence，不能签发 Approval；
- Main Agent 负责调度和请求 Transition，但 CLI 决定是否合法；
- XForge Workflow Audit 记录 dispatch、delivery、integration、review 和 retry；
- 平台 Runtime Hook 能覆盖时补充 subagent start/stop/tool events；缺失时明确标记 coverage gap。

工作包静态八字段保持不变；运行 envelope 增加 State revision、policy snapshot digest 和 audit correlation ID，避免把一次性执行信息写回 governing artifact。

## 12. Adapter 目标模型

Adapter capability 不再只使用单一 `rules/hooks: native|degraded|unsupported`，而是分别报告：

```text
guidance
permissionPolicy
runtimeHook.events
runtimeHook.blocking
runtimeHook.managed
surface.local/cloud
auditDelivery
subagent
```

Adapter 只负责：

- 渲染 Rule/PermissionPolicy/Runtime Hook bridge；
- 映射规范事件与平台事件；
- 报告能力、失败语义和覆盖缺口；
- 保护生成文件所有权。

Flow、Transition、Gate、Approval、Evidence 和 Audit completeness 不能进入 Adapter。

## 13. 目标目录与资源选择

概念目录：

```text
xforge/
├── manifest.yaml
├── constitution.md
├── flows/
├── scripts/
│   ├── hook-dispatch/
│   ├── audit-writer/
│   └── policy-evaluator/
├── scaffold/
│   ├── skills/
│   ├── agents/
│   ├── rules/
│   ├── policies/
│   ├── hooks/
│   │   ├── runtime/
│   │   └── workflow/
│   └── gates/
├── .audit/                    # local/gitignored
└── changes/<id>/
    ├── approvals/
    └── evidence/
        ├── gates/
        ├── agents/
        ├── audit/
        └── receipts/
```

Manifest 必须显式选择 Rule、Policy、Hook、Gate 和 Target。目录中存在资源不代表启用。Hook 的“安装”和“激活/信任”是两个不同状态。

## 14. 安全与信任

- 项目 Hook 默认禁用，启用前必须展示命令、Script、权限、网络、事件和失败策略；
- Hook/Policy 变更使相关信任和 Adapter 输出 stale；
- 平台要求 Hook trust review 时，XForge 只报告状态，不绕过平台确认；
- managed policy 与项目 policy 必须分层，项目不能覆盖企业 deny；
- 所有外部命令使用 argv；Shell 必须显式提升风险；
- output 有大小上限和脱敏；
- Audit sink 凭证不进入 Manifest、Lock、生成文件或提交 Evidence；
- CI/受保护分支仍是合并层的最终组织门禁，项目 Hook 不能替代它。

## 15. 兼容策略

Protocol 1 和旧 Schema 不支持 PermissionPolicy、双平面 Hook、Approval receipt、Transition 和 Audit Envelope。当前兼容策略为：

1. Protocol 1 项目保持 Portable read；managed write 使用 Protocol 2；
2. 新资源使用新的 Schema version，不让旧 CLI 静默忽略；
3. Adapter capability report 升级但保留当前汇总字段一个迁移周期；
4. 旧 `Rule.level=mandatory/advisory/scoped` 可迁移为 `severity + scope + enforcement`；
5. 旧 `writePolicy: integrator-only` 迁移为 PermissionPolicy，兼容期继续由结构检查执行；
6. 旧 Hook 事件按 runtime/workflow 分类；无法唯一映射时要求人工选择；
7. 已有 Gate Evidence 不自动升级为新 receipt；首次 vNext Verify 重新生成；
8. ADR 0001 保留为 v1 历史决策；接受本文后新建 superseding ADR。

## 16. 验收标准

设计实施后至少满足：

1. `must` Rule 没有 Gate/Approval 覆盖时报告 `uncovered`；
2. Codex 权限 Rules 不再被误报为 XForge Guidance Rule；
3. Runtime Hook 不可用时 Workflow Gate/Archive 仍正常工作；
4. Hook 不能直接把 Gate 或 Stage 标记成功；
5. Machine Gate 只接受真实 runner Evidence；
6. LLM Check/Reviewer `PASS` 不成为机器 Gate；
7. stale HEAD、Flow、Policy、Gate 或 Artifact 会拒绝 Transition/Archive；
8. Agent 不能生成有效 Approval；
9. Quick/Solid/Major 执行不同的 Approval/Audit policy；
10. Sub-agent delivery 与 State revision、policy snapshot 和 audit correlation 绑定；
11. Cloud Agent 的临时本地日志不被误报为长期审计；
12. 远端 Audit 暂时失败可 spool，但要求远端交付的 Flow 不能归档；
13. 项目 Hook 被修改后需要重新信任和重新投影；
14. Adapter 对 local/cloud、blocking、managed 和事件覆盖逐项报告；
15. Archive receipt 能追溯到当前 Gate、Approval 和 Audit index。

## 17. P0–P4 实施状态

### P0：冻结协议决策（完成）

- 确认 Rule/PermissionPolicy 分离；
- 确认 Hook 两平面；
- 确认 Approval 是一级 receipt；
- 确认 Solid/Major 默认审批策略；
- 确认 Audit 三层存储与隐私边界。

### P1：Workflow Core（完成）

- Flow/State 增加 Transition Guard；
- 实现 Evidence freshness 和 Archive G4；
- 实现 Approval receipt；
- 实现 XForge 内建 Workflow Audit；
- 此阶段不依赖任何平台 Runtime Hook。

### P2：Rule、Policy 与 Skills（完成）

- 升级 Rule Schema 和 coverage；
- 新增 PermissionPolicy Schema/loader；
- 重构核心/辅助 Skills 的 state/transition 边界；
- 把 integrator-only 等现有约束迁移到 Policy。

### P3：Runtime Hook Adapters（完成）

- 先接 Claude、Codex、Cursor、Copilot；
- OpenCode 使用受管的轻量 plugin bridge；
- 建立事件映射、trust、local/cloud 和覆盖测试；
- 默认选择但禁用 runtime audit bundle；项目 PermissionPolicy 使用最小 pre-tool bridge。

### P4：Enterprise Audit（完成）

- append-only remote sink；
- spool/retry/delivery receipt；
- managed policy capability/上游优先级集成；
- CI protected check 和审计导出；
- retention、redaction 和合规配置。

## 18. 已接受的实施决策

1. Solid 默认要求 Design → Apply 单人批准和 Archive 关闭批准；
2. Major 默认要求双人、角色分离的外部签名批准；
3. Runtime Audit Hook bundle 首次 Scaffold 即选择，但保持禁用和未信任；
4. 首个 Protocol 2 版本同时提供本地 spool、提交索引和远端 append-only sink；
5. PermissionPolicy 使用独立 Kind；
6. CLI 同时提供 typed `state.nextActions` 与独立 `transition/approve/audit` 命令；
7. Envelope 与资源协议升级为 Protocol 2，Protocol 1 保留 portable read 迁移路径。

正式决策记录见 [ADR 0002](adr/0002-governance-control-plane.md)。
