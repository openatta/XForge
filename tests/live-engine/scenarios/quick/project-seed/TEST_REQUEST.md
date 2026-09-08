# Greeter 测试需求

请实现一个无第三方运行时依赖的 Node.js 命令行工具，入口为
`src/cli.mjs`。这是低风险、单模块、无状态、可回滚的最小变更，使用 XForge
Quick Flow，Change ID 固定为 `greeter`。

## 功能需求

### REQ-GREET-001 问候

`node src/cli.mjs greet --name <text>` 输出 `Hello, <name>!`。`name` 去除首尾
空白后不能为空。

### REQ-GREET-002 喊话模式

`node src/cli.mjs greet --name <text> --shout` 输出内容全大写并在末尾追加
`!!!`（例如 `HELLO, ADA!!!!`）。

### REQ-GREET-003 协议与错误

stdout 每次只输出一个 JSON 文档，stderr 保持空。输出 envelope：

- 成功：`ok=true`、`data.message` 为字符串、`diagnostics=[]`；
- 使用错误（缺少或空白 `--name`、未知参数）：exit 2，诊断码 `USAGE_ERROR`。

## 工程约束

- 只能实现 `src/**`；不得修改 `test/**`、`TEST_REQUEST.md` 或 XForge 治理资产来规避验收；
- 使用现有 `node:test` 黑盒测试，不引入依赖；
- 不需要持久化存储，不需要 work-packages.yaml（Quick Flow 的 Apply 阶段按
  `execution.workPackages: internal` 直接由 Main Agent 实现）。

## 本项目如何运行检查

下面就是命令本身。没有人在终端边上可以再问一次，所以照写在这里的样子记录，不要猜，
也不要改写成看起来更像的东西。

| gate | command |
| --- | --- |
| `unit-tests` | `["npm","test"]` |

## 决策人

Mei Tanaka <mei.tanaka@example.test> 是本项目的负责人，上面这些命令是这个人给的答案——记录它们时用这个名字署名。

**这一条只管上面那张表。** 台账里的 `decidedBy` / `resolvedBy` / `approvedBy` 是另一回事：那些字段要对得上这个仓库真实记录过的身份（本 Change 的 Git author，或某张审批回执上的审批人），本项目负责人的名字不在其中，写进去会被拒绝。

## 验收标准

`npm test` 全部通过；完整 Quick Change 经当前 revision 的 Gate、Transition、
Audit 和 Archive 后，delta Spec 合并到主 Specs，原 Change 被原子移动到
archive。
