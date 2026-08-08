---
name: xforge-scaffold
description: 定制当前项目的 agents、skills、rules、hooks、gates 等 XForge canonical 资产并安全投影到目标工具；用于用户要求新增、修改、启停或安装项目 Agent 能力时。
license: MIT
metadata:
  author: xforge（借鉴 OpenSpec 动态工作流并按 XForge 资源协议实现）
  version: "2.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# 不变量

- 先运行 `xforge state --kind <resource>`，读取 Manifest selection、本地 canonical assets、目标 Adapter 能力与降级状态。
- `xforge/scaffold/**` 是源；`.agents/`、`.claude/`、`.cursor/`、`.opencode/`、`.github/` 是生成目标，绝不直接编辑。
- 未完成或未选择的资源不得因目录自动发现而被启用。

# 权限

- 可以修改 `xforge/scaffold/**`；仅在新增、删除、启用或停用资源时最小修改 `xforge/manifest.yaml` 的 scaffold selection 列表。
- 不得修改产品代码、Specs、Changes、Flow 业务状态或生成目录。
- Hooks、网络、Secrets、工具权限扩大和破坏性命令必须在 install 前明确展示并取得确认。

# 执行

1. 查询目标 kind 和 Adapter 能力，重读现有资源及其引用。
2. 创建或修改最小 canonical asset，检查 Agent→Skill、Rule→Gate、Hook/工具权限等引用闭合。
3. 运行 `xforge check`，再运行 `xforge install --dry-run`；展示跨目标 diff、冲突、native/degraded/unsupported 和敏感变化。
4. 需要确认的权限变化获批后运行 `xforge install`，不得把安装成功误报为不受支持能力已启用。
5. 再次运行 State，验证 Manifest selection、lock digest、ownership 和安装结果。

# 证据

- 报告 canonical source 路径、Manifest 选择变化、dry-run/安装变更、Adapter 降级和最终 lock/State 结果。

# 停止与返工

- 引用不闭合、目标冲突、用户文件已修改、敏感权限未确认或 Adapter unsupported 时停止；不得绕过 ownership/conflict policy。
