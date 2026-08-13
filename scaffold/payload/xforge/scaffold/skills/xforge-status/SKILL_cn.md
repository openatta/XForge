---
name: xforge-status
description: 把 xforge state 的机器状态解释为 Change 或 Requirement 的可读进度；用于用户询问做到哪、为何阻塞、剩余工作包、Evidence 是否当前或能否 Verify/Archive 时。
allowed-tools: Read, Grep, Glob, Bash(npx:*)
---

# 不变量

- 运行 `npx --no-install xforge state`，解析唯一 Change 后运行 `npx --no-install xforge state --change <id>`；State 是唯一状态事实源。
- 严格只读，不维护第二份进度，不顺便继续、修复或勾选任务。

# 权限

- 可以查询、筛选和解释 State、work packages、deliveries、diagnostics 与 Evidence freshness。
- 不得修改任何项目文件、生成 Evidence、执行 ready Action 或归档。

# 执行

1. 解析 Change ID；多 Change 或 Requirement 归属不唯一时请求用户选择。
2. 固定输出 Flow、当前 Stage/state revision、ready/blocked Transitions、pending Approvals、Rule 的 instructed/guarded/verified/approved/uncovered coverage、Policy/Hook active coverage、Audit chain/remote pending/gaps、工作包/deliveries、Evidence freshness、Verify/Archive readiness。
3. 给出下一合法 Action、对应 Skill 和为何尚未 ready。
4. Requirement ID 确定性索引不可用时明确标记为启发式，不从 Markdown 搜索结果过度推断状态。

# 证据

- 所有进度结论引用同一次 State revision 与具体诊断/Evidence 路径。

# 停止与返工

- ID 歧义、State 错误或 Evidence 无法验证时停止并说明缺失信息；不得用会话记忆补齐。
