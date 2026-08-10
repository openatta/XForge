---
name: xforge-explore
description: 只读调查代码、规格、约束、缺陷或方案，并把模糊想法收敛为可提案范围；用于用户要求分析、诊断、比较方案或判断 Flow，但尚未授权创建 Change 或修改项目时。
license: MIT
metadata:
  author: xforge（基于 OpenSpec 工作流适配）
  version: "3.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# 不变量

- 先运行 `npx --no-install xforge state`；涉及已有 Change 时再运行 `npx --no-install xforge state --change <id>`，不猜测 Flow、路径、约束或状态。
- 以实际代码、Constitution、Rules、Specs 和 CLI 诊断为事实；明确区分观察、假设与建议。
- 全程只读，不把探索结果伪装成 Artifact、Gate Evidence 或完成声明。

# 权限

- 可以读取和搜索项目、运行无副作用的诊断、比较方案并建议 Change 范围与 Flow。
- 不得创建或修改 Change、代码、Specs、Scaffold、Evidence、生成目录或外部系统。
- 用户要求记录或实施时，停止 Explore，转交 `xforge-propose` 或对应 ready Action 的 Skill。

# 执行

1. 查询 State，解析相关模块、active Changes、Constitution、Rules、PermissionPolicy、Hook/Audit coverage、Specs 和 Adapter 的 local/cloud/managed/blocking 降级。
2. 先调查代码与运行事实，再建立集成点、约束、未知项和影响范围。
3. 比较可行方案，说明兼容性、风险、回滚成本与验证方式；只询问无法从项目查明且会改变结果的问题。
4. 问题足够清楚时，给出有边界的 Change 描述、classification、path scope 与 Quick/Solid/Major 建议。
5. 结束前再次确认工作区没有因本 Skill 产生修改。

# 证据

- 引用具体文件、命令结果或现有 Spec；自然语言推测不是机器证据。
- 报告只读检查范围、关键事实、剩余未知和推荐下一步。

# 停止与返工

- 一旦需要写入、扩大权限、访问敏感外部状态或替用户做材料性决定，立即停止并请求授权。
- Portable 模式必须说明治理约束未被 CLI 强制执行。
