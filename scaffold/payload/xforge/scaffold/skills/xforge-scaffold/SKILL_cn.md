---
name: xforge-scaffold
description: 定制当前项目的 agents、skills、rules、permission policies、hooks、gates 等 XForge canonical 资产并安全投影到目标工具；用于用户要求新增、修改、启停或安装项目 Agent 能力时。
tools: [read, search, write, test]
---

# 不变量

- 先运行 `npx --no-install xforge state --kind <resource>`，读取 Manifest selection、本地 canonical assets、目标 Adapter 能力与降级状态。
- `xforge/scaffold/**` 是源；`.agents/`、`.codex/`、`.claude/`、`.cursor/`、`.opencode/`、`.github/` 与 `opencode.json` 是生成目标，绝不直接编辑。
- 未完成或未选择的资源不得因目录自动发现而被启用。
- Agents 与 Skills 必须同时维护英文默认文件和 `_cn` 中文变体，由 Manifest 的 `scaffold.language` 选择投影；其它 Scaffold 资产统一使用英文。

# 权限

- 可以修改 `xforge/scaffold/**`；仅在新增、删除、启用或停用资源时最小修改 `xforge/manifest.yaml` 的 scaffold selection 列表。
- 不得修改产品代码、Specs、Changes、Flow 业务状态或生成目录。
- Hooks、PermissionPolicy、网络、Secrets、工具权限扩大和破坏性命令必须在 install 前明确展示并取得确认。安装、平台信任和运行时 active 是三个独立状态，不得互相推断。

# 执行

1. 查询目标 kind 和 Adapter 能力，重读现有资源及其引用。
2. 创建或修改最小 canonical asset，检查 Agent→Skill、Rule→Gate/Policy/Approval、Hook→dispatcher/事件/失败策略等引用闭合；`Rule` 只表达指导与覆盖，门禁权限必须使用 `PermissionPolicy`。
3. 每次修改 Agent/Skill 文本时同步更新英文与 `_cn` 版本，确保不变量、命令、权限、证据和停止条件语义等价。
4. 运行 `npx --no-install xforge check`，再运行 `npx --no-install xforge sync --dry-run`；展示跨目标 diff、冲突、native/degraded/unsupported 和敏感变化。
5. 需要确认的权限变化获批后运行 `npx --no-install xforge sync`；如果 CLI 返回 `XFORGE_FULL_UPDATE_REQUIRED` 或 `XFORGE_STATE_UPGRADE_REQUIRED`，改为 `npx --no-install xforge update --dry-run`，确认后运行 `npx --no-install xforge update`。不得把安装成功误报为不受支持能力已启用。
6. 再次运行 State，验证 Manifest selection、language、lock digest、ownership、Adapter coverage 和安装结果；平台要求 review/trust 时单独报告待信任状态。

# 证据

- 报告 canonical source 路径、Manifest 选择变化、dry-run/同步变更、Adapter 降级和最终 lock/安装记录结果。

# 停止与返工

- 引用不闭合、目标冲突、用户文件已修改、敏感权限未确认、语言版本不对等或 Adapter unsupported 时停止；不得绕过 ownership/conflict policy。
