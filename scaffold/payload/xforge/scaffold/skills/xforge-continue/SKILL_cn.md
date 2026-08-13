---
name: xforge-continue
description: 从当前机器状态恢复 Change，并执行与用户授权一致的下一合法 Action；用于用户说继续、恢复、执行下一步，或新会话需要从中断点推进时。
allowed-tools: Read Grep Glob Bash
---

# 不变量

- 先运行 `npx --no-install xforge state` 并解析唯一 Change，再运行 `npx --no-install xforge state --change <id>`；不硬编码 Quick/Solid/Major 顺序。
- 只选择 CLI typed `nextActions` 中 actor、authority 和用户授权匹配的 `status=ready` Action，并执行其 command；不得从 Markdown 或熟悉的 Flow 猜下一步。
- 每个 Action 完成后刷新 State，不依赖旧会话或模型记忆推进。

# 权限

- 权限来自被选择的 ready Action 与对应 Skill；Continue 本身不扩大写权限。
- external/CLI/用户决定 Action 不得由 Agent 冒领；Archive 永远需要明确授权。
- Approval Action 只能通过终端交互或 mcp provider 轮询请求（提交）人类/外部 provider 的决定，Agent 永远不能自行批准。

# 执行

1. 解析用户要推进一个 Action 还是连续推进；多 Change 时先消除歧义。
2. 读取 ready Actions、blocking diagnostics、inputs、writes、doneWhen、requiredEvidence 和 reworkTo。
3. 选择与授权一致的 Action，加载并完整遵守对应 Skill，完成后重新查询 State。
4. 连续推进时重复上述循环，但不得跳过 Clarify/Check、失败 Gate 或 revision 检查。
5. 默认最多推进到 Verify satisfied；用户未明确授权时停在 ready-to-archive。

# 证据

- 每一步报告消费的 Action、State revision、实际变更和满足的 Evidence；最终给出新的下一 Action。

# 停止与返工

- 在材料性歧义、范围扩大、失败 Gate、权限扩大、stale revision、外部副作用或无 ready Action 时停止。
- State 返回 rework 时转到指定 Stage，不自行选择更晚阶段绕过问题。
- 当 Approval Action 因所配置的 provider 缺失、不可达或策略不允许而失败或阻塞（例如 `XFORGE_APPROVAL_PROVIDER_FORBIDDEN`）——不同于 `status: pending` 这种真正等待人类决定的 Action——这属于配置缺口，不是普通的待审状态。此时应停止、不要重试，并明确告知用户需要配置 approval provider：指向 manifest.yaml 的 `approvals.providers` 与对应 Flow 的 `approvalPolicies`。
