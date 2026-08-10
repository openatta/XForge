---
name: xforge-design
description: 为 Solid 或 Major Change 形成受治理的技术设计、替代方案、失败与验证边界；用于 State 返回 ready Design Action，且 Proposal/Specs 与所需 Clarifications 已满足时。
license: MIT
metadata:
  author: xforge（基于 OpenSpec 工作流适配）
  version: "3.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# 不变量

- 先运行 `npx --no-install xforge state --change <id>`，只消费当前 revision 的 ready Design Action，并重读全部 Action inputs。
- Design 解释 HOW、决策与边界，不重复 Proposal，不退化为逐文件任务列表或长期 Plan。
- Constitution、Rules、现有架构和 Specs 是约束；不把约束原文机械复制进设计。

# 权限

- 只可写 Action 返回的 Design Artifact 路径。
- 不得改 Proposal/Specs/Clarifications、产品代码、Check report、Evidence、任务或 Archive；上游需要修改时返回 rework。

# 执行

1. 建模当前系统、目标行为、集成点、数据与接口边界。
2. 记录主要决策、可行替代方案及拒绝理由，覆盖失败模式、兼容性、迁移和回滚。
3. Solid 至少写清 implementation approach 与 verification notes，服务稳定交付。
4. Major 额外覆盖 trust boundaries、风险与缓解、测试策略、rollout、monitoring、stop signals、owner 和安全并行边界。
5. 刷新 State 并运行 `npx --no-install xforge check --change <id>`；只修复 Design 权限内的结构问题。若下一步需要 Approval，停止并请求人类决定；receipt 满足后才调用 typed nextAction 中的 Transition。

# 证据

- 每项关键决策映射到 Requirement、项目约束或代码事实，并给出可验证结果。
- 按 Action 的 `doneWhen` 报告覆盖范围、残余风险和下一合法 Action。

# 停止与返工

- 在材料性歧义、规格冲突、未知 trust boundary、不可回滚影响或需要修改上游时停止。
- 将上游问题交给 Clarify/Revise；不要在 Design 中静默扩大 Scope。
