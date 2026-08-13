---
name: xforge-archive
description: 兼容旧入口，把明确的归档请求转交 xforge-verify 的 archive-current 流程，由该流程驱动 `xforge archive` CLI（同步 Specs、终局治理复查、原子移动 Change）；仅用于仍以旧 Archive Skill 名称发起明确归档请求时。
allowed-tools: Read Grep Glob Bash(npx:*)
---

# 不变量

- 运行 `npx --no-install xforge state --change <id>`，解析唯一 active Change，不猜测 readiness 或 Evidence freshness。
- 本 Skill 仅是委托入口；归档语义、验证与权限由 `xforge-verify` 的 `archive-current` 模式承担，实际同步 Specs 与原子移动 Change 由该流程驱动的 `xforge archive` CLI 完成。

# 权限

- 本 Skill 不直接写 Specs、Evidence 或 Archive，不直接移动 Change。
- 只有用户明确要求归档才可转交 archive-current；仅要求验证时改用 verify-only。
- Agent 不能创建 Closing Approval；必须由交互式人类或已配置外部 provider 提供当前 revision 的 receipt。

# 执行

1. 查询 State 并说明旧入口已并入 `xforge-verify`。
2. 使用 `xforge-verify` 的 `archive-current` 流程：确认 Stage 为 `ready-to-archive`，运行 `npx --no-install xforge audit verify --change <id>`，检查当前 Gate/Approval/Audit receipts，执行 archive dry-run，确认后再归档。
3. 刷新 State 并报告最终结果。

# 证据

- 只引用 Verify receipt、Gate Evidence、dry-run 计划和 CLI 归档事务结果。

# 停止与返工

- 未明确授权、receipt stale、Gate 失败或 dry-run 有诊断时停止；不得绕过 Verify。
