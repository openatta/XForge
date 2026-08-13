---
name: xforge-check
description: 对 Major Change 做实现前跨 Artifact 语义审查，检查完整性、一致性、可测试性、风险与可实施性；用于 State 返回 ready Check Action 或 Major 规划需要正式质量门时。
allowed-tools: Read Grep Glob Write Edit Bash(npx:*)
---

# 不变量

- 先运行 `npx --no-install xforge state --change <id>`，只消费当前 revision 的 ready Check Action，重读 Proposal、Specs、Clarifications、Design、Constitution、Rules 与代码事实。
- `xforge-check` 做语义审查；`npx --no-install xforge check` 提供 schema、路径、Gate 和 Evidence 的确定性输入，二者不能互相替代。
- 默认只读 governing artifacts；发现问题时报告 rework，不在审查中悄悄改写上游。
- Check report 是 LLM Review Evidence，不是 Gate Evidence；即使写出 `PASS` 也不能通过 Machine Gate、Transition 或 Approval。
- Gate Evidence 绑定 Gate 运行当刻的 content revision。**必须在最后一次写入之后**、一次性运行 Gate。先跑一个 Gate、再改 Artifact、再跑下一个，会让先跑的 Gate 变陈旧：所有 Gate 都报 `passed`，Stage 却仍然出不去。

# 权限

- 只可写 Action 允许的 `check-report` 和由 CLI 生成的检查 Evidence。
- 不得写产品代码、Proposal/Specs/Clarifications/Design、工作包、Gate Evidence 或 Archive。

# 执行

1. 检查 Proposal/Specs 是否完整、明确、可测试，关键问题是否 resolved。
2. 检查 Design 是否覆盖所有 Requirement、约束、trust boundaries、失败场景、兼容性、迁移和回滚。
3. 核对测试、rollout、monitoring、stop signals、owner、path scope、依赖与并行边界是否匹配重大影响。
4. 运行 `npx --no-install xforge check --change <id>`，把确定性诊断作为证据输入。
5. 按 blocker、warning、suggestion 写报告；每项指出 Artifact/Requirement 位置、原因和 `reworkTo` Stage。
6. 在 `check-report.md` 与所有 Evidence 台账都写完之后，再运行一次 `npx --no-install xforge check --change <id>`，它会对最终内容重新运行并刷新当前 Stage 的整个 Gate 集合；`--all-gates` 还会运行 Change 尚未到达的 Stage 所属的 Gate，那些 Gate 不可能通过，Stage 中途通常不需要这样做。
7. 刷新 State；有 blocker 时请求 State 指定的 rework Transition；无 blocker 时仍由 CLI Gate 与 Approval 决定是否可运行 `npx --no-install xforge transition --change <id> --to apply`。

# 证据

- 报告跨 Artifact 映射、CLI 检查结果、未覆盖 Requirement/风险和可实施性结论。
- 只有 blocker 为零且 Action `doneWhen` 满足时才能声明 Check satisfied。

# 停止与返工

- 在材料性遗漏、矛盾、范围漂移、不可测试 Requirement、缺少 rollback 或路径/owner 冲突时停止。
- 按最早受影响点返回 Propose、Clarify 或 Design，不检查不存在的长期任务计划。

# 判断要点

- "评审通过"和"CLI Gate 是绿的"是两句不同的话。一份 Design 完全可以内部自洽、写得很好，却因为某条 Requirement 完全没有测试策略而在 Check 里不通过——单个 Artifact 内部一致，不代表所有 Artifact 之间彼此覆盖。
- 缺失的反面场景（失败路径、边界条件、兼容性破坏）最容易被漏掉，因为一份看起来干净的 Design 里，没有任何东西会主动指出"这里本该有、但没有"。要检查的是本该存在却不存在的东西，不只是已经存在但写错的东西。
