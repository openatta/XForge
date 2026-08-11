# XForge Adapter Matrix（0.7.2 / Protocol 2）

Capability 表示“平台能提供什么”，不表示项目 Hook 已被用户信任或在当前 surface active。Flow、Transition、Gate、Approval、Archive 和 workflow audit 都由 XForge CLI 执行，不依赖 Adapter。

| Target | Guidance | PermissionPolicy | Runtime Hook | Local / Cloud | Managed | Sub-agent | 主要输出与边界 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | native | native permissions + XForge bridge | blocking native | native / degraded | degraded | native | `.claude/settings.json`；PreToolUse 支持 allow/deny/ask；项目 settings 仍需平台信任 |
| Codex | degraded（AGENTS/Skills）+ native Agents | shell rules native，其他 capability bridge | blocking native，部分 tool path 可 bypass | native / unsupported | native | native | `.codex/agents/*.toml`、`.codex/rules/*.rules`、`.codex/hooks.json`；项目 `.codex` layer 需 trust；PreToolUse 不支持 ask，保守映射 deny |
| Cursor | native | bridge（degraded） | blocking native | native / native | native | degraded | `.cursor/hooks.json` v1；平台未暴露事件形成 gap |
| GitHub Copilot | native | bridge（degraded） | local native，blocking/cloud degraded | native / degraded | degraded | degraded | `.github/hooks/xforge.json` v1；Cloud ask 按 deny；Cloud filesystem/logs 不是长期审计 |
| OpenCode | degraded | ordered permissions native | plugin bridge degraded | native / degraded | degraded | native | `opencode.json` last-match-wins permissions、`.opencode/plugins/xforge-governance.ts`；plugin API 未发出的事件形成 gap |

## 事件规范化

| XForge event | Claude/Codex | Cursor | Copilot | OpenCode bridge |
| --- | --- | --- | --- | --- |
| `agent.session.start/end` | `SessionStart/SessionEnd` | `sessionStart/sessionEnd` | `sessionStart/sessionEnd` | plugin exposed subset |
| `agent.prompt.submit` | `UserPromptSubmit` | `beforeSubmitPrompt` | `userPromptSubmitted` | gap if unavailable |
| `agent.tool.before/after` | `PreToolUse/PostToolUse` | `preToolUse/postToolUse` | `preToolUse/postToolUse` | `execute.before/after` |
| `agent.permission.request` | `PermissionRequest` | `preToolUse` | `permissionRequest` | permission/plugin hook |
| `agent.subagent.start/stop` | `SubagentStart/SubagentStop` | `subagentStart/subagentStop` | platform subset | gap if unavailable |
| `agent.turn.stop` | `Stop` | `stop` | `agentStop` | plugin exposed subset |

## 生成策略

- Rule Guidance 与 PermissionPolicy 分开渲染，不把 Codex permission rules 误报为 XForge Guidance Rules。
- Codex Adapter v3 把 canonical `worker`、`integrator`、`reviewer` 投影为项目级
  `.codex/agents/*.toml`；Agent 进程与委派仍由 Codex 原生 runtime 创建，XForge
  只提供契约、DAG、派工绑定与验收。
- 有项目 PermissionPolicy 时生成最小 pre-tool dispatcher bridge，用于跨 capability 一致判定和审计；平台 native permissions 仍作为更早的 defense-in-depth。
- `runtime-audit` 默认 selected 但 disabled，因此不会生成 PostToolUse audit handler；启用后才投影相应事件。
- Adapter 输出进入 ownership 和 Lock source trace；canonical Policy/Hook 改动要求重新 sync/update。平台的 hash/trust review 由平台完成，XForge 不绕过。
- 企业 managed deny 位于项目输出之上。XForge capability 只报告 managed 支持程度，不尝试从项目覆盖组织策略。

## 审计解释

`auditDelivery: native` 表示 XForge dispatcher 能把已观察事件写入本地/remote sink，不表示平台能暴露全部事件。Cloud Agent 的临时工作区日志永远不能单独证明 retention；需要 remote append-only sink 或提交的 Change audit index。

Runtime Hook 缺失或 bypass 时，Workflow Gate/Transition/Archive 仍工作；若 Flow 要求 runtime completeness，coverage gap 会阻塞 `audit verify`/Archive。
