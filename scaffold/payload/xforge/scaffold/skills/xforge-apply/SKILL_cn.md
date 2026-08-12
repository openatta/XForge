---
name: xforge-apply
description: 对 Apply ready 的 Change 即时拆分并实现最小交付单元，必要时通过工作包 DAG 激活并行子 Agent；用于用户明确要求开始、继续或返工实现，并且 State 已允许 implementation-write 时。
allowed-tools: Read Grep Glob Write Edit Bash Task
---

# 不变量

- 开始及每次材料性变更后运行 `npx --no-install xforge state --change <id>`；只消费当前 revision 的 ready Apply Action，不猜测 Flow 序列、路径、Gate 或并行策略。
- 从磁盘读取 Action 的全部 inputs、Constitution、相关 Rules/Specs、可选 Design/Check report 和现有工作包；聊天记忆不是事实源。
- Main Agent 永远承担 Coordinator；Worker 不继续委派。XForge 不创建模型进程，子 Agent 由目标 runtime 的原生能力激活。
- 计划是 Apply 的即时执行资产，不是新 Stage 或第二份规格事实源。
- 必须以 `state.change.governance.currentStage=apply`、当前 `stateRevision`、`policySnapshotDigest` 和 typed `nextActions` 为准；不得直接改 Stage、Transition/Approval receipt 或核心 Audit。

# 权限

- Main Agent 可以修改 Change scope 内的产品代码、测试、Action 允许的精简任务记录、`work-packages.yaml` 和已验收的 delivery records。
- Worker 只能修改分配 worktree 中匹配 `write_paths` 的文件；不得写工作包计划、Evidence、Constitution、主 Specs、Archive，以及共享契约、迁移、generated、lock 等 Integrator 独占路径。
- 现实推翻 Proposal/Specs/Design 时不得静默改写治理事实；返回 Action 指定的 rework Stage。
- 所有写入同时受适用 PermissionPolicy 约束；Agent 不得替人审批，也不得把 Reviewer 结论当 Approval。

# 执行

1. 固定 State revision 与 Git base，从 governing artifacts 提取约束、依赖顺序、最小交付单元、每单元验证命令和可观察完成条件。
2. 先判断直接串行还是持久工作包：单一小任务使用 Main Agent 的内部短计划；复杂、长时、需恢复或多 Agent 任务按 Action 的 execution policy 生成 `work-packages.yaml`。
3. 每个工作包只能包含 `id`、`goal`、`depends_on`、`inputs`、`write_paths`、`skills`、`verify`、`done_when` 八个字段。让每条路径只有一个明确写者，收窄会吞掉其他包路径的父级 glob；调度时另附 `change_id`、`execution_id`、`base_commit`、dependency commits、branch、worktree 与 delivery mode，不把它们写回静态计划。
4. 写计划后重新运行 State；在创建任何 worktree 前，让 CLI 校验 ID/DAG、inputs、skills、Change scope、保护路径、依赖 commits、verify 命令和 ready 集合。对每个 ready 包运行 `npx --no-install xforge work-package dispatch --change <id> --package <package>`，把 receipt 的 `stateRevision`、`policySnapshotDigest`、`auditCorrelationId` 和 `executionId` 随派工 envelope 传给 Worker。
5. 仅当至少两个节点依赖已满足、`write_paths` 不相交、数据库/端口/缓存/账号/生成物等共享资源可隔离，且 Adapter 的 Agent 投影与 runtime 的子 Agent 执行都报告为 `native` 时并行激活 Worker。不得用模块数量代替冲突判断。
6. 为每个 ready 包固定同一可信 base，创建独立 branch/worktree，并向一个 Worker 只派一个包。Worker 先读全部 inputs/skills，只做最小实现与范围内测试，真实运行所有 `verify`，原生模式下提交 commit，再返回固定 delivery contract。
7. Main Agent 逐份核对 dispatch binding、commit ancestry、`base...head` 实际 diff、`write_paths`、验证退出码和 `done_when` 语义证据；成功 delivery 必须使用 `done_when_evidence` 将每条原始 `done_when` 精确映射一次到非空证据，并回带 `state_revision`、`policy_snapshot_digest`、`audit_correlation_id`。通过后才写入 `<change>/evidence/agents/<package>/<execution>.yaml` 并刷新 State，释放下一波依赖节点。
8. 有多个 commits、共享契约、迁移、generated/lock 文件或集中集成验证时最多激活一个 Integrator，并由它独占这些共享写入；保存集成证据后运行 `xforge work-package acknowledge ... --as integrator --evidence <path>`。高风险或跨系统最终结果交给未参与实现的 Reviewer，保存审查证据后以 `--as reviewer` 确认。发现未声明的路径重叠时重新规划，不让 Integrator 掩盖规划错误。
9. Adapter 为 `degraded` 或 `unsupported` 时由 Main Agent 顺序执行工作包，或按声明的 degraded patch 流程交付；明确报告未获得并行/worktree 隔离，不得声称已激活子 Agent。
10. 每个连贯单元完成后运行相称的测试、lint/build；所有实现完成后运行 `npx --no-install xforge check --change <id>`，请求 `npx --no-install xforge transition --change <id> --to verify`，再交给 `xforge-verify`。

# 证据

- 交付成功必须同时具备真实 Git diff、全部 `verify` 退出为零、每项 `done_when` 的精确非空 `done_when_evidence` 映射，以及 CLI 重新校验结果。
- Worker 的自然语言、checkbox 或自报退出码都不是 Gate Evidence；报告包状态、changed paths、命令结果、集成结果和未解决风险。

# 停止与返工

- 在 prerequisite/revision 失效、DAG 非法、inputs/skills 缺失、路径冲突或逃逸、依赖漂移、共享资源不可隔离、测试失败、秘密信息、未授权迁移或材料性歧义时停止。
- 实现失败返回 `apply:rework`；Proposal/Specs/Design 假设失效时按 `reworkTo` 交给 `xforge-revise` 或对应 Stage Skill。不得归档。

# 判断要点

- "`write_paths` 不相交"是并行派工的必要条件，不是充分条件——两个工作包的 `write_paths` 可以完全不重叠，却仍然争用同一个端口、数据库、缓存 key，或某个 `write_paths` 里根本没写出来的生成物/lock 文件。派工前要核实的是实际资源隔离，不是 glob 不相交；模块数或路径数一致，不代表两者互相独立。
- 工作包粒度本身是一个判断，两个方向都有失败模式：拆得太细会增加协调和 Integrator 开销，并放大出现未声明共享写入的概率；拆得太粗会掩盖包内部真正的依赖关系，压掉本可并行的空间。粒度应该按代码里真实的依赖图来定，不是把任务列表平均分成几份。
