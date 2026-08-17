# Greeter 测试需求（Python）

请实现一个无第三方依赖的 Python 命令行工具，入口为 `src/cli.py`。这是低风险、
单模块、无状态、可回滚的最小变更，使用 XForge Quick Flow，Change ID 固定为
`greeter`。

**本项目不是 Node 项目——没有 `package.json`，没有 npm。** 这正是它存在的理由：
在 CLI 改为安装到项目之外以前，这套实跑测试**结构上无法构造出这种项目**，于是
"随包发布的 Gate 只跑 npm、在其他语言上一路绿灯却什么都没断言"这个缺陷，对它是
不可见的。

## 功能需求

### REQ-GREET-001 问候

`python3 src/cli.py greet --name <text>` 输出 `Hello, <name>!`。`name` 去除首尾
空白后不能为空。

### REQ-GREET-002 喊话模式

`python3 src/cli.py greet --name <text> --shout` 输出内容全大写并在末尾追加
`!!!`（例如 `HELLO, ADA!!!!`）。

### REQ-GREET-003 协议与错误

stdout 每次只输出一个 JSON 文档，stderr 保持空。输出 envelope：

- 成功：`ok=true`、`data.message` 为字符串、`diagnostics=[]`；
- 使用错误（缺少或空白 `--name`、未知参数）：exit 2，诊断码 `USAGE_ERROR`。

## 工程约束

- 只能实现 `src/**`；不得修改 `test/**`、`TEST_REQUEST.md` 或 XForge 治理资产来规避验收；
- 只使用标准库（`argparse`、`json`、`unittest`），不引入任何依赖；
- 不需要持久化存储，不需要 work-packages.yaml。

## 本项目如何运行测试

```
python3 -m unittest discover -s test
```

`unit-tests` Gate 没有预置命令，它会拒绝直到本项目声明为止——这是设计如此。上面
这一行就是本项目负责人给出的答案，把它记入 `xforge/manifest.yaml` 的
`verification.unit-tests`。**不要照抄 CLI 给出的候选建议**：`pyproject.toml` 会让
它建议 `pytest`，而本项目用的是标准库 `unittest`，环境里没有 pytest。

## 验收标准

上述命令全部通过；完整 Quick Change 经当前 revision 的 Gate、Transition、Audit 和
Archive 后，delta Spec 合并到主 Specs，原 Change 被原子移动到 archive。
