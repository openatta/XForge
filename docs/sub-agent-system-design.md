# XForge 子 Agent 协作系统设计

- **状态：** Protocol 2 工作包、dispatch binding、交付校验和 Workflow Audit 已实现
- **日期：** 2026-08-09
- **范围：** XForge 项目内的并行开发协作协议

Rules、PermissionPolicy、Hooks、Transition、Approval 和 Audit 的权威语义见
[治理控制面设计](governance-control-plane-design.md)；当前实现版本为 `0.7.7`。

## 1. 设计结论

XForge 子 Agent 系统定义为项目级、Git 原生、可验证的协作协议，而不是
通用多 Agent Runtime。它规定 Main Agent 如何拆分和调度工作、子 Agent 如何
交付，以及 XForge 如何验证边界和证据；具体的进程创建、模型调用和执行沙箱
仍由目标 AI 工具提供。

系统只定义三种子 Agent：

- `worker`：执行一个封闭的写入型工作包；
- `integrator`：单实例完成提交集成和共享文件修改；
- `reviewer`：独立、默认只读地审查最终结果。

Main Agent 自身承担 Coordinator 职责，不再创建 `coordinator` 子 Agent。
测试和探索是工作方式而不是长期 Agent 类型：编写测试由 Worker 加载测试
Skill 完成，集成测试由 Integrator 运行，探索由 Main Agent 或 Reviewer 加载
`xforge-explore` 完成。

## 2. 目标与非目标

### 2.1 目标

- 在 Apply 中从当前 Change 的 Specs、可选 Design 和 Check report 即时派生可审计的工作包 DAG；
- 只在依赖独立且写路径不冲突时并行；
- 使用固定 base commit、独立 branch 和 worktree 隔离写入型任务；
- 通过 Git diff、命令退出状态和 Gate Evidence 验证 Agent 交付；
- 让 Main Agent 只能请求 Stage Transition，由 CLI 验证 Gate、Approval 和 Audit；
- 记录 dispatch、delivery、integration、review 和 retry 的 Workflow Audit；
- 以少量通用 Agent 配合按需 Skills，避免按业务模块创建 Agent 类型；
- 在不同 Adapter 上明确报告 `native`、`degraded` 或 `unsupported`，不夸大能力。

### 2.2 非目标

- 不实现通用调度服务、模型路由服务或常驻 Agent Runtime；
- 不保证不同 AI 工具具有等价的权限、委派和沙箱语义；
- 不用 Prompt 代替路径检查、测试、门禁和审批；
- 不引入第二套 Specification、Plan 或 Tasks 事实源；
- 不默认依赖 OpenSpec 或 Spec Kit Runtime；
- 不使用 worktree 伪装对数据库、端口、缓存或外部服务的完全隔离。

## 3. 逻辑结构

```text
Main Agent / Coordinator
│
├── Worker A ── worktree A ── commit A
├── Worker B ── worktree B ── commit B
├── Worker C ── worktree C ── commit C
│
├── Integrator ── integration worktree ── integrated commit
│
└── Reviewer ── review worktree / Review Evidence / Gate Evidence input

XForge Control Plane
├── State revision / PermissionPolicy snapshot
├── Work-package validation / Gate Runner
├── Transition Guard / Approval receipts
└── Workflow Audit / Evidence freshness
```

Main Agent 负责读取 XForge 状态、生成工作包 DAG、检查依赖和路径冲突、准备
worktree、调度 ready 节点、验证 Worker 交付，并决定是否启动 Integrator 和
Reviewer。Main Agent 不把这些协调职责再次委派给其他 Agent。

Main Agent 可以选择 ready Action、创建运行环境和请求 Transition，但不能代表 CLI
把 Stage 标记完成，也不能代表人类或外部系统签发 Approval。

## 4. 工作包协议

### 4.1 规范字段

一个工作包只保留以下八个字段：

```yaml
id: T012

goal: >
  实现订单退款状态转换和幂等处理。

depends_on:
  - T003

inputs:
  - specs/add-refund/plan.md
  - contracts/openapi/refund.yaml

write_paths:
  - backend/order/**

skills:
  - implement-order-refund

verify:
  - ./gradlew :backend:order:test

done_when:
  - 状态转换符合退款契约
  - 相同幂等键不会重复创建退款
```

工作包保存在当前 Change 的 `work-packages.yaml` 中，容器格式固定为：

```yaml
apiVersion: xforge.dev/v1alpha1
kind: WorkPackagePlan
packages:
  - id: T012
    # 其余七个规范字段
```

`apiVersion`、`kind` 和 `packages` 属于计划容器，不属于单个工作包；容器中的
每个工作包对象仍然只有上述八个字段。

| 字段 | 回答的问题 | 约束 |
|---|---|---|
| `id` | 这是哪个任务？ | 在当前 Change 内唯一且稳定；作为依赖和证据关联键 |
| `goal` | 要完成什么？ | 描述单一、可交付的结果，不包含额外授权 |
| `depends_on` | 什么时候可以开始？ | 仅引用同一 DAG 中的工作包；全部成功后才可进入 `ready` |
| `inputs` | 必须参考什么？ | 开始前必须读取的项目事实或契约；只读且必须存在 |
| `write_paths` | 可以修改哪里？ | 项目根相对路径；范围外默认禁止产生可提交修改 |
| `skills` | 需要加载什么专业能力？ | 必须能从项目已安装或声明的 Skills 中解析 |
| `verify` | 必须执行什么验证？ | 从分配的 worktree 根目录执行；非零退出即未完成 |
| `done_when` | 怎样判断完成？ | 可观察、可核对，并应能映射到实现、测试或契约证据 |

### 4.2 字段语义

`inputs` 是必读上下文，不是新的事实源，也不是完整的读取权限白名单。Worker
可以为了理解实现而读取相关代码，但必须先读取所有 `inputs`，且不得修改它们，
除非它们同时被明确包含在 `write_paths` 中。若输入之间互相冲突，Worker 必须
停止并返回 `blocked`，不能自行选择一个版本继续。

`write_paths` 使用项目根目录相对的 POSIX 路径或 glob。绝对路径、`..`、越过
项目根的符号链接和空泛的仓库根写权限应被拒绝。它约束 Git 可跟踪、可提交的
修改；验证命令在分配 worktree 内产生的 ignored 构建缓存可以存在，但不得借此
修改 worktree 外的项目或未经授权的外部状态。

`skills` 由 Main Agent 在规划或调度时解析。缺失 Skill 是调度错误，不允许
Worker 静默改用一套临时流程。通用能力不需要转化为新的 Agent 类型。

`verify` 中的命令必须真实执行并记录命令、工作目录、时间、退出状态和受限日志。
列表中任一命令失败，工作包状态只能是 `failed` 或 `blocked`。Agent 对测试结果的
自然语言描述不构成验证证据。

`done_when` 是语义验收条件，不能被 `verify` 的退出码替代。每一项都应能映射到
相关实现、测试、契约或 Gate Evidence；无法证明的条件保持未完成。

### 4.3 调度元数据

以下信息由 Main Agent 在派发时生成，不属于工作包的规范字段：

```yaml
change_id:
execution_id:
base_commit:
dependency_commits: []
branch:
worktree:
delivery_mode: commit
state_revision:
policy_snapshot_digest:
audit_correlation_id:
```

把运行信息移出工作包可以保持 governing artifacts 到工作包的转换简单，并避免规划文件记录
一次性机器路径。派发时，静态工作包和调度元数据共同构成一次执行请求。

后三个治理字段由 `xforge work-package dispatch --change <id> --package <id>` 生成，
不改变工作包静态八字段，也不写回 `work-packages.yaml`。CLI 将 dispatch receipt
保存到 `<change>/evidence/agents/<package>/dispatch/<execution>.json`。

### 4.4 固定的交付契约

交付格式是 Agent 协议的一部分，不在每个工作包中重复声明：

```yaml
execution_id:
recorded_at:
status: succeeded | blocked | failed
package_id:
base_commit:
head_commit:
changed_paths: []
validation:
  - command:
    exit_code:
issues: []
done_when_evidence:
  - criterion:
    evidence: []
state_revision:
policy_snapshot_digest:
audit_correlation_id:
```

Main Agent 将交付记录保存到
`<change>/evidence/agents/<package-id>/<execution-id>.yaml`。目录名、文件名和
记录内的 `package_id`、`execution_id` 必须一致；重试使用新的执行 ID，旧记录
保留。Worker 只返回交付契约，不直接写 Evidence。

成功交付必须为静态工作包中的每一条 `done_when` 提供且只提供一个
`done_when_evidence` 映射；每个映射至少引用一项实现路径、测试、契约或 Gate
Evidence。缺失、重复或未知 criterion 都会使交付失败。

原生 Git/worktree 执行要求成功的 Worker 返回 commit。目标工具无法可靠提交时，
可以使用 `patch` 交付模式，但 Adapter 必须将其标记为 `degraded`，由 Main Agent
在应用 patch 前重新执行路径和内容检查。

## 5. DAG 与调度

### 5.1 派发前检查

Main Agent 在启动任何 Worker 前必须确认：

1. 工作包 ID 唯一，依赖存在，DAG 无环；
2. 所有 `inputs` 存在且可以读取；
3. `write_paths` 安全、范围合理且不包含受保护的共享路径；
4. 所有 `skills` 可以解析；
5. `verify` 命令来自项目工作包且满足项目执行策略；
6. Proposed vNext 中，当前 State revision 和 PermissionPolicy snapshot 仍有效；
7. 并行节点的写路径不相交；
8. 依赖节点的实际交付 commit 与调度记录一致；
9. 数据库、服务端口、缓存和外部账号等共享资源有安全隔离方案。

并行的判断依据是“至少两个依赖已满足、写路径不重叠且不争用共享资源的节点”，
而不是涉及了多少业务模块。同一模块可以存在独立并行任务，两个模块也可能因为
共享契约或迁移而必须串行。

`state` 返回确定性的静态 `waves` 和当前 `parallelCandidates`。它们是宿主原生
子 Agent runtime 的调度输入，不是 XForge 已启动模型进程的声明；宿主仍必须检查
数据库、端口、缓存、账号等 CLI 无法从 Git 路径推断的共享资源。

### 5.2 状态模型

```text
planned → ready → running → succeeded
                    ├──────→ blocked
                    └──────→ failed

succeeded → integrated → reviewed
```

一个工作包失败不会自动取消所有独立节点，但所有直接或间接依赖它的节点不得
启动。对同一工作包的重试应生成新的 `execution_id`，并保留前一次证据。

## 6. Agent 职责

### 6.1 Worker

Worker 是通用写入型执行体：

- 一个实例只执行一个工作包，不继续委派；
- 只在分配的 worktree 和 branch 中工作；
- 开始前读取全部 `inputs` 和所列 Skills；
- 只修改 `write_paths`；
- 实现代码时同时补充范围内的自动化测试；
- 真实执行全部 `verify` 命令；
- 原生模式下提交代码并返回结构化结果。

Worker 不能请求批准、签发 Approval、推进 Stage、写 Machine Gate Evidence 或修改
核心 Audit。它只能报告交付事实和问题。

Worker 在需要修改共享文件、路径范围不足、依赖漂移、输入冲突、规格歧义、测试
失败或发现未授权迁移时必须停止。它不得自行扩大 `write_paths`、修改 Constitution、
主 Specs、审批文件或归档内容。

### 6.2 Integrator

每个 Change 最多运行一个活动 Integrator。它等待必需的 Worker 全部成功后，在
独立 integration worktree 中：

- 按 DAG 拓扑顺序集成已验证的 commits；
- 作为共享契约、数据库迁移、生成代码和 lock 文件的唯一写者；
- 只修复明确的集成问题，不随意重写 Worker 模块；
- 运行契约测试、集成测试和端到端测试；
- 返回最终 commit、全量验证结果和未解决问题。

Integrator 的验证输出仍需由 XForge Gate Runner 复核；Integrator 是共享路径
唯一写者，不是 Gate 或 Approval authority。

若出现未声明的写路径重叠，说明工作包规划失效。Integrator 应停止并要求 Main
Agent 重新规划，而不是把结构性冲突作为普通 merge conflict 静默解决。

只有存在多个 Worker commit、共享文件修改或集中集成验证时才需要 Integrator。
单个工作包和无共享写入的小任务可以由 Main Agent 直接验收和集成。

### 6.3 Reviewer

Reviewer 不参与原始实现，默认不修改产品代码。它审查最终
`base_commit...integrated_commit`，而不是只阅读 Worker 或 Integrator 的总结。

Reviewer 必须核对：

- Specs、可选 Design/Check report 和 Constitution；
- 工作包的 `inputs`、`write_paths`、`verify` 和 `done_when`；
- 最终 Git diff 和共享文件所有权；
- 兼容性、安全性、测试覆盖和实际 Gate Evidence；
- 是否存在越界修改、遗漏需求或未经授权的行为。

每个发现包含严重程度、文件位置、原因和修改建议；无实质问题时明确报告通过。
需要执行会产生缓存、coverage 或构建产物的命令时，Reviewer 使用独立 review
worktree，避免破坏只读审查的语义。

Reviewer 的通过结论是 Review Evidence。它可以供人类批准者参考，但不能成为
Machine Gate 或 Approval receipt，也不能自行推动 Transition。

## 7. 确定性验证

Prompt 只提供指导，以下事实必须由 Main Agent、Git 或 XForge Gate 检查：

- 当前目录属于分配的 worktree；
- 工作 branch 从指定 `base_commit` 派生；
- `head_commit` 真实存在且属于该 branch；
- `git diff --name-only <base_commit>...<head_commit>` 全部落在 `write_paths`；
- Worker 没有修改 Integrator 独占的共享路径；
- 交付时不存在未声明的可提交修改；
- 所有 `verify` 命令均有真实执行记录且退出状态为零；
- `done_when` 均有实现、测试、契约或 Gate Evidence 支撑；
- 删除、不可逆迁移、生产写入或权限扩大等敏感 Action 的确认来自用户或授权外部系统，而不是 Agent 自我声明。

Protocol 1 项目可以通过 scoped Rule 的 `writePolicy: integrator-only` 声明额外共享路径。
XForge 还内建保护 Manifest、Lockfile、Constitution、主 Specs 和当前 Change
目录。`xforge check --change <id>` 会重新运行每个工作包的 `verify` 命令并生成
受限、脱敏的 Evidence，因此 Worker 填写的退出码不是最终证明。

符号链接解析、路径规范化、日志截断和敏感信息脱敏沿用 XForge 的安全不变量。
任何一项检查失败，都不能把工作包标记为 `succeeded`。

Protocol 2 使用 PermissionPolicy 表达 `integrator-only`。Rule 只向 Agent 说明工程
要求，实际写路径权限由 Policy、work-package validator 和最终 Git diff 共同执行。

## 8. LLM 上下文设计

一次子 Agent 调用由三层信息组成：

1. **静态 Agent 契约**：角色、权限、禁止事项、停止条件和返回格式；
2. **静态工作包**：八个规范字段；
3. **动态调度上下文**：Change、base commit、依赖 commits、worktree、执行 ID、State revision、Policy snapshot 和 audit correlation ID。

XForge 状态提供 Constitution、相关 Specs、Design、Rules、PermissionPolicy 摘要、
Gate、Approval 和 Audit 要求。Main Agent
只注入与当前工作包有关的上下文，避免复制整个项目或把聊天历史当成事实源。

强模型提示应集中表达硬边界：只完成当前工作包、先读哪些输入、只能修改哪些
路径、何时必须停止、如何验证以及必须返回什么机器可检查的信息。专业过程由
`skills` 按需加载，不在 Agent instructions 中重复展开。

## 9. 与 XForge Flow 和 Skills 的关系

- `quick`：默认由 Main Agent 直接完成，原则上不引入并行编排；
- `solid`：Apply 可以从 Specs 和 Design 即时派生工作包 DAG，以稳定集成为优先；
- `major`：Apply 可以从 Specs、Clarifications、Design 和 Check report 即时派生工作包 DAG，并受重大风险、rollout、monitoring 与 Action 级确认约束；
- `xforge-propose`：由 Main Agent 用于规划，不交给 Worker；
- `xforge-apply`：Main Agent、Worker 和 Integrator 的主要执行流程；
- `xforge-verify`：供 Integrator 和 Reviewer 获取确定性检查与 Evidence；
- `xforge-verify` 在明确授权时请求协议层 Archive Transition；`xforge-archive` 只保留迁移 shim。

每个 Stage Skill 完成后只能请求 CLI Transition。Sub-agent delivery success 只满足
Apply 的一个前置条件；它不自动使 Apply completed，也不使 Verify ready。

工作包是 Apply 的执行资产，不替代 Proposal、Specs、Clarifications、Design 或 Check report。默认流程
不调用 Spec Kit；如未来提供 Spec Kit 兼容能力，应作为显式可选 Adapter，并单独
定义导入映射、所有权和冲突处理。

## 10. Adapter 降级

- `native`：目标工具原生支持子 Agent，且可以为实例指定独立执行目录；
- `degraded`：只能安装提示或 Skills，由 Main Agent 顺序模拟工作包，或使用 patch
  交付；
- `unsupported`：不生成子 Agent 资源，也不声明具备并行执行能力。

即使为 `native`，worktree 创建、base commit 固定、diff 路径检查和交付验收仍由
Main Agent 与 XForge 负责，不能假设目标工具已经提供等价的强制权限。

当前 capability report 分别显示：Sub-agent、PermissionPolicy、Runtime Hook
subagent/tool events、blocking、managed 和 local/cloud。目标工具能启动子 Agent 不
代表 XForge 获得完整 runtime audit；缺失事件必须形成 coverage gap。

### 10.1 流程转换与审计

XForge Workflow Audit 至少记录：

- 工作包生成、验证和废弃；
- dispatch actor、State revision、Policy snapshot 和 correlation ID；
- Worker start/stop、delivery、retry 和失败原因；
- Integrator 选择、集成 commit 和验证结果；
- Reviewer findings 和 Review Evidence digest；
- Main Agent 请求的 Stage Transition 及 CLI 决定。

平台支持 Runtime Hook 时，可补充 session/tool/permission/subagent start/stop 事件；
平台不支持时不伪造这些事件。Archive 可以要求 Workflow Audit 完整，并按 Flow
policy 决定是否还要求 Runtime coverage 或远端交付。

## 11. Constitution 与根 AGENTS.md

Constitution 包含 `Parallel Development` 原则，规定：

- 只并行依赖独立、写路径不重叠的工作包；
- 写入型 Worker 使用独立 worktree 和固定 base commit；
- 每条路径在同一阶段只有一个写者；
- 共享文件由 Integrator 独占；
- 交付必须以 Git diff、验证命令和 Gate Evidence 验收；
- Agent 不得自行批准例外。

该原则作为实质性治理新增项，将 Scaffold Constitution 的 MINOR 版本提升为
`1.1.0`。

根 `AGENTS.md` 只提供长期发现入口和并行启动条件，要求 Agent 读取 Manifest、
Constitution、当前 Change 和本协议。它不复制完整工作包流程，也不覆盖用户已有
的项目指令。

## 12. 验收场景

实现该设计时至少验证以下场景：

1. 两个无依赖、路径不重叠的 Worker 并行完成并生成独立 commits；
2. DAG 中有依赖的 Worker 只在上游成功后启动；
3. 两个候选工作包路径重叠时，在派发前拒绝并行；
4. Worker 修改 `write_paths` 外文件时，即使测试通过也验收失败；
5. Worker 修改共享契约或 lock 文件时验收失败；
6. `inputs` 缺失、冲突或 Skill 无法解析时任务保持 blocked；
7. 任一 `verify` 命令失败时不得返回 succeeded；
8. Integrator 按拓扑顺序集成并运行全量测试；
9. Reviewer 能基于最终 diff 和 Evidence 报告问题且不修改原实现；
10. 不支持子 Agent 的 Adapter 明确降级，不声称已经并行隔离执行；
11. 单模块小任务由 Main Agent 直接完成，不产生不必要的编排开销；
12. 测试产生缓存或构建产物时，不污染其他 Worker 的 worktree；
13. Worker/Integrator/Reviewer 都不能生成有效 Approval 或推进 Stage；
14. stale State revision 或 Policy snapshot 会阻止 dispatch/验收；
15. Runtime Hook 缺失时 Workflow Audit 仍记录完整工作包 lifecycle，并报告 coverage gap；
16. Reviewer `PASS` 不被当作 Machine Gate。

## 13. 实现范围

### 13.1 当前实现

1. `state --change` 解析工作包计划、DAG、输入、Skills、Change scope、共享路径、
   Git HEAD 和已有 delivery，返回 ready/blocked/succeeded/failed 状态；
2. `work-package dispatch` 在 Apply Stage 为 ready package 生成 revision/policy/audit
   绑定；Protocol 2 delivery 必须回带并通过 receipt 校验；
3. `check --change` 在 Verify/ReadyToArchive 要求所有工作包存在有效 succeeded delivery，
   验证 `done_when_evidence`、commit ancestry、实际 diff 和 `write_paths`，重新执行
   `verify`，并只记录 delivered Workflow Audit；
4. Scaffold 安装 `worker`、`integrator`、`reviewer` 三种子 Agent，并由 Main
   Agent 负责协调；
5. Constitution、根 `AGENTS.md`、`xforge-apply` 和 `xforge-verify` 共同提供长期
   发现入口和操作协议；
6. Adapter 逐项报告 subagent、event coverage、blocking、managed 和 local/cloud；
7. Archive 验证当前 package deliveries、Gate Evidence、Approval 和 Audit completeness；
8. XForge 不创建模型进程、不自动调度 Agent，也不替目标工具创建通用 Runtime。
9. `work-package acknowledge` 要求 Integrator/Reviewer 提供包级 Evidence，显式推进
   `succeeded → integrated → reviewed`，不会把一次成功 check 当作集成或审查。
