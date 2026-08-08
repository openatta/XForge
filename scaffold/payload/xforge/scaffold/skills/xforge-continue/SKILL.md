---
name: xforge-continue
description: 从当前机器状态恢复 Change，并执行与用户授权一致的下一合法 Action；用于用户说继续、恢复、执行下一步，或新会话需要从中断点推进时。
license: MIT
metadata:
  author: xforge（基于 OpenSpec 工作流适配）
  version: "2.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# 不变量

- 先运行 `xforge state` 并解析唯一 Change，再运行 `xforge state --change <id>`；不硬编码 Quick/Solid/Major 顺序。
- 只选择 actor、authority 和用户授权匹配的 ready Action，并遵守 Action 推荐的 Stage Skill。
- 每个 Action 完成后刷新 State，不依赖旧会话或模型记忆推进。

# 权限

- 权限来自被选择的 ready Action 与对应 Skill；Continue 本身不扩大写权限。
- external/CLI/用户决定 Action 不得由 Agent 冒领；Archive 永远需要明确授权。

# 执行

1. 解析用户要推进一个 Action 还是连续推进；多 Change 时先消除歧义。
2. 读取 ready Actions、blocking diagnostics、inputs、writes、doneWhen、requiredEvidence 和 reworkTo。
3. 选择与授权一致的 Action，加载并完整遵守对应 Skill，完成后重新查询 State。
4. 连续推进时重复上述循环，但不得跳过 Clarify/Check、失败 Gate 或 revision 检查。
5. 默认最多推进到 Verify satisfied；用户未明确授权时停在 verified-active。

# 证据

- 每一步报告消费的 Action、State revision、实际变更和满足的 Evidence；最终给出新的下一 Action。

# 停止与返工

- 在材料性歧义、范围扩大、失败 Gate、权限扩大、stale revision、外部副作用或无 ready Action 时停止。
- State 返回 rework 时转到指定 Stage，不自行选择更晚阶段绕过问题。
