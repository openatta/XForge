---
name: xforge-verify
description: 用当前证据核验 Change 的完整性、正确性、一致性与 Gates，并在用户明确授权时预览后归档；用于验收 readiness、验证并关闭 Change，或归档一个已有当前验证回执的 Change。
license: MIT
metadata:
  author: xforge（基于 OpenSpec 工作流适配）
  version: "2.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# 不变量

- 先运行 `xforge state --change <id>`，解析用户意图为 `verify-only`、`verify-and-archive` 或 `archive-current`；没有明确归档授权时只验证。
- 重读当前 revision 的 Proposal、delta/main Specs、可选 Clarifications/Design/Check report、实现 diff、工作包/deliveries、Constitution、Rules 和 Gates。
- 默认不修产品代码，不手写或篡改 Gate Evidence；实现变化会使旧验证回执失效。
- Archive 是独立的 `archive-write` 协议动作，不代表 deploy/release 权限。

# 权限

- 可以写 Verify Action 允许的 assurance report 与 verification receipt；Gate Evidence 只能由 `xforge check` 生成。
- 只有 `verify-and-archive` 或 `archive-current` 的明确用户授权允许调用 `xforge archive`；先 dry-run，再执行原子同步与移动。
- 失败时只报告并返回 Apply rework；除非用户另行明确授权，不修改实现。

# 执行

1. 解析唯一 Change 和模式；若 `archive-current` 的 receipt 不属于当前 revision/Git HEAD/Flow/Gate versions，先重新 Verify。
2. 按完整性、正确性和一致性审查：把每个 Requirement/Scenario 映射到实现与自动化测试，把 Design/Constitution/Rules 映射到最终 diff。
3. 若存在工作包，要求每个包有有效 succeeded delivery，核对依赖 commit、实际写入边界、验证命令和每项 `done_when`；高风险或跨系统结果使用独立 Reviewer。
4. 运行 `xforge check --change <id>`，重新执行工作包验证和所有 mandatory Gates；重开 Evidence，核对 Change、命令、时间、退出状态、digest 与当前 revision。
5. 生成 assurance 与当前 verification receipt，分开列 blocker、warning、suggestion。任一 mandatory Gate、Requirement 或关键约束未验证时返回 `apply:rework`。
6. `verify-only` 到此停止，状态为 verified-active。
7. 已获归档授权时运行 `xforge archive --change <id> --dry-run`，展示完整 Specs merge/move 计划、冲突和显著兼容影响；仅在计划无错误且 receipt 当前时运行 `xforge archive --change <id>`。
8. 归档后运行 `xforge state`，确认 Change 离开 active set、主 Specs 可见且 Evidence 位于归档目录。

# 证据

- 输出 Requirement/Scenario、实现、测试、Design、工作包和 Gate 的可定位映射，以及当前 receipt 的 revision/Git/Flow 绑定。
- 只有所有当前 mandatory Gate 成功且没有 blocker 时，才能声明 ready for archive；只有 CLI 原子事务成功才能声明 closed。

# 停止与返工

- 在不完整实现、失败 Gate、无效 delivery、stale receipt、Spec 冲突、路径安全问题、目标碰撞或未授权归档时停止。
- Verify 失败返回 Apply；governing artifact 自相矛盾时按 State 的 `reworkTo` 返回更早 Stage。
