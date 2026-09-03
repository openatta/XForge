---
name: xforge-revise
description: 一致地修订已有 Change 的规划 Artifacts，并让受影响的下游状态与证据失效；用于需求、范围或决定变化，或 Check/Apply 发现上游假设错误时。
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# 不变量

- **进入**用 `xforge stage --change <id>`。它一次返回：Change 在哪、ready 的 Action 及其 `writes`/`requiredSections`/`instruction`/`outline`、**该 Action `inputs` 的正文**、Constitution 正文，以及诊断。不要再单独去打开那些输入——它们已经到了。每写完一个 Artifact 重跑一次，而不是另外去问「变了什么」。 它同时携带本 Stage 声明了什么——产出、Gate、exit 条件、返工路线——所以**不需要打开 `xforge/flows/*.yaml`**：那个文件 400 行，而你要去那里找的 outline，Action 里已经有了。
- 每次编辑前重读磁盘上的现有文件与 Action inputs，跨 Artifact 保持 Requirement、Scenario、决定和范围一致。
- 依靠 digest/revision 让 Check、Apply 或 Verify 的旧结果失效，不手工篡改 Evidence。

# 权限

- 只可修改用户已授权范围内、State 明确返回的现有 Proposal、delta Specs、Clarifications 或 Design 路径。
- 不得写产品代码、Check report、工作包 delivery、Gate Evidence、verification receipt、主 Specs 或 Archive。

# 执行

1. 解析变更原因和最早受影响 Artifact，计算需要同步的下游规划材料。
2. 对现有具体路径做最小一致性修订；保留机器要求的 Requirement/Scenario 标题和稳定 ID。
3. 材料性扩大 Scope、兼容性或权限时先请求用户决定。
4. 刷新 State，运行 `xforge check --change <id>`，确认旧 Gate/Approval 下游 revision 已失效并列出必须重跑的 Stages；Stage 变化只通过 CLI Transition。

# 证据

- 报告修改的 Artifact/Requirement、修改原因、新 State revision、失效范围和下一合法 Action。

# 停止与返工

- 目标路径不存在、输入冲突、用户授权不覆盖修改或需要改代码/Evidence 时停止并转交对应 Skill。
