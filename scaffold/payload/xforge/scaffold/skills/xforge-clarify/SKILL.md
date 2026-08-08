---
name: xforge-clarify
description: 消除 Major Change 中会改变范围、设计、兼容性、风险或验收的关键歧义，并原子回写上游规格；用于 State 返回 ready Clarify Action 或规划审查要求澄清时。
license: MIT
metadata:
  author: xforge（基于 OpenSpec 工作流适配）
  version: "2.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# 不变量

- 先运行 `xforge state --change <id>`，只消费当前 revision 的 ready Clarify Action，不因熟悉 Major 顺序而猜路径。
- 优先从代码、Specs、Rules 与 Proposal 查明事实；只询问会材料性改变结果且项目无法回答的少量问题。
- Clarifications 与对 Proposal/delta Specs 的获授权回写必须保持一次一致修订；未解决的 material question 继续阻塞。

# 权限

- 只可写 Action 返回的 clarifications 路径和 `revises` 中明确列出的 Proposal/delta Spec 现有路径。
- 不得写 Design、Check report、代码、主 Specs、Evidence、任务或 Archive，不得替用户作材料性决定。

# 执行

1. 重读 Action inputs，列出会影响范围、兼容性、风险、实现边界或验收的未知项及其影响。
2. 调查能由项目事实回答的问题；对剩余问题一次提出最小、可决策的问题集。
3. 记录问题、影响、决定、来源和状态；将已确认结果同步回 Proposal 与 delta Specs，保持 Requirement/Scenario 可测试。
4. 刷新 State，确认 `materialQuestions: resolved`；运行 `xforge check --change <id>` 检查结构和 policy。

# 证据

- 每项决定必须引用用户决定或项目事实来源，并指出它更新了哪些 Requirement/Scenario。
- 只有 State 的 exit 条件满足才能声明 Clarify satisfied。

# 停止与返工

- 用户未决定、输入冲突、范围扩大、revision 变化或需要额外权限时停止并返回 `request-decision`。
- 后续发现新的材料性歧义时使下游失效，并通过 `xforge-revise` 返回 Clarify。
