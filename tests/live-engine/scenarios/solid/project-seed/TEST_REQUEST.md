# Task Ledger 测试需求

请实现一个无第三方运行时依赖的 Node.js 命令行工具，入口为
`src/cli.mjs`。这是低风险、单模块、可回滚的常规产品功能，使用 XForge
Solid Flow，Change ID 固定为 `task-ledger`。

## 功能需求

### REQ-TASK-001 添加任务

`node src/cli.mjs add --title <text>` 添加一个 open 任务。标题去除首尾空白后
不能为空。ID 从 `T0001` 起单调递增，删除或完成任务后不复用。

### REQ-TASK-002 查询任务

`node src/cli.mjs list` 按 ID 升序返回全部任务；可选
`--status open|done` 过滤状态。

### REQ-TASK-003 完成任务

`node src/cli.mjs done --id <task-id>` 把已存在任务设为 done。重复完成应幂等；
未知 ID 返回稳定诊断。

### REQ-TASK-004 存储与兼容

数据文件由 `TASK_LEDGER_FILE` 指定；未指定时使用
`.task-ledger/tasks.json`。父目录不存在时创建。文件损坏时不得覆盖原文件。

### REQ-TASK-005 协议与错误

stdout 每次只输出一个 JSON 文档，stderr 保持空。输出 envelope：

- 成功：`ok=true`、`data` 非空、`diagnostics=[]`；
- 使用错误：exit 2，诊断码 `USAGE_ERROR`；
- 未知任务或数据错误：exit 1，分别使用 `TASK_NOT_FOUND`、`DATA_INVALID`。

## 工程约束

- 只能实现 `src/**`；不得修改 `test/**`、`TEST_REQUEST.md` 或 XForge 治理资产来规避验收；
- 使用现有 `node:test` 黑盒测试，不引入依赖；
- 创建一个 `T001` 工作包，`write_paths` 为 `src/**`，输入包含 delta Spec 和 Design，Skill 为 `xforge-apply`，验证命令为 `npm test`；
- 设计中说明原子写策略、损坏文件行为、退出码和回滚；
- 验证必须引用真实测试和 XForge Gate，不得用自然语言 `PASS` 代替 Evidence。

## 验收标准

`npm test` 全部通过；完整 Solid Change 经当前 revision 的 Approval、Gate、
Transition、work-package dispatch/delivery、Audit 和 Archive 后，delta Spec 合并到
主 Specs，原 Change 被原子移动到 archive。
