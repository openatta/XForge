[English](../README.md) | 简体中文

# XForge

XForge 是一个面向 AI 辅助软件研发的 Git 原生治理控制平面。它把规格、流程状态、
工程规则、质量证据、审批和审计历史变成可版本化的项目事实，再将项目需要的
Skills、子 Agent、策略和 Hooks 投影到团队已经使用的 AI 编程工具中。

XForge 不是另一个 Agent Runtime。模型和编程工具仍然负责探索、设计与实现；
XForge 负责定义什么是当前事实、下一次状态转换是否合法，以及一个 Change 在推进或
关闭前必须具备哪些证据。

> **当前版本：** `@xforge/cli 0.4.1`、Protocol 2，需要 Node.js 20 或更高
> 版本。可以从 npm 安装精确版本，也可以从同一版本源码构建。项目仍在积极开发中。

## 设计目标

- **项目事实保存在 Git 中。** Constitution、Specs、Changes、Flows、Rules、
  策略以及项目本地化后的 Agent 资产都与代码一起维护；即使没有托管控制平面或服务
  账号，也可以直接阅读和审查。
- **跨 Agent 工具保持可移植。** 同一套规范模型可以投影到 Codex、Claude Code、
  Cursor、OpenCode 和 GitHub Copilot。平台能力不一致时，XForge 会明确报告降级，
  不会假装它们具备相同的权限与 Hook 能力。
- **把指导、权限和证明分开。** Rule 用于指导 Agent，PermissionPolicy 用于约束
  动作，Gate 用于证明确定性检查结果；三者不能互相冒充。
- **治理强度与风险相称。** 低风险、易回滚的小变更走 Quick；常规产品研发走
  Solid；高风险、跨系统或关键影响变更走 Major，并引入更强的审查、审批和审计边界。
- **在受管边界上 fail closed。** CLI/Protocol 身份不匹配、生成文件冲突、Receipt
  过期、Gate 失败、审计不完整或路径不安全时，写操作会停止，而不是静默忽略问题。
- **只做控制平面，不垄断执行。** XForge 管理状态、证据与策略，但不托管模型、
  不替换编程工具，也不会自动获得生产部署权限。

## 整体模型

```text
项目所有的规范事实
  AGENTS.md + xforge/{manifest,constitution,specs,changes,flows,scaffold}
                              |
                              v
                    @xforge/cli（Protocol 2）
                    /                         \
       确定性流程状态与治理证据              Agent 工具 Adapter 投影
       Gate / Approval / Receipt            Skills / Agents / Policy / Hook
       Audit / 原子 Archive                 投影到各类编程工具
```

`xforge/` 下的文件是事实来源；`.agents/`、`.codex/`、`.claude/`、
`.cursor/`、`.opencode/` 以及部分 `.github/` 文件是生成结果。需要修改时应编辑
规范资产，再运行 `xforge sync` 或 `xforge update`，不要手改生成文件。

## 主要特性

### 按风险分级的规格驱动 Flow

| Flow | 适用场景 | 持久化生命周期 |
| --- | --- | --- |
| `quick` | 低风险、范围明确、容易回滚的变更 | Propose → Apply → Verify → Archive |
| `solid` | 常规产品功能和工程变更 | Propose → Design → Apply → Verify → Archive |
| `major` | 高风险、关键影响或跨系统变更 | Propose → Clarify → Design → Check → Apply → Verify → Archive |

Flow Policy 会验证 Change classification 是否适用。阶段只能通过 CLI 的受保护
Transition 推进，Agent 不能靠修改状态字段或声称“已经完成”来跨越质量边界。

### 语义明确的治理模型

- **Constitution**：保存长期稳定、不可被普通功能变更绕过的工程原则。
- **Rules**：向模型提供带作用域的工程指导，并声明对应的 Gate、Policy 或
  Approval 覆盖。
- **PermissionPolicies**：对文件、Shell、网络、MCP、子 Agent 和外部写入表达
  `allow`、`ask`、`deny`。
- **Hooks**：桥接平台真实支持的 Runtime 事件，或提供 Workflow 自动化；Hook
  被调用并不等于质量已经通过。
- **Gates**：执行确定性命令，并为当前修订写入 Evidence。
- **Approvals**：记录交互式人工决定，或验证外部签名 Receipt；Agent 不能自我
  批准。
- **Transitions 与 Archive**：只接受当前版本的 Artifact、Evidence、Approval
  和完整 Audit。Archive 会合并 delta Specs 并以原子事务关闭 Change。

### 安全、可复现的 Agent 工具投影

`install`、`sync`、`update` 和 `uninstall` 使用按 Target 记录的所有权与内容摘要。
Dry run 会展示完整写入计划；未知文件、用户修改、符号链接、路径穿越和所有权冲突都
会被拒绝。卸载只会删除 XForge 拥有且摘要仍匹配的文件。

当前支持的投影目标：

- Codex
- Claude Code
- Cursor
- OpenCode
- GitHub Copilot

不同平台在指导、权限、Runtime Hook、Cloud 与 Managed Policy 上的支持并不相同。
具体实现和降级边界见 [Adapter 能力矩阵](adapter-matrix.md)。

### 机器可读的状态与证据

CLI 默认输出单个 Protocol 2 JSON envelope，其中包含 diagnostics、文件变更计划和
类型化的 next actions。增加 `--text` 只会切换成人类可读格式，不改变语义和退出码。

Change 状态与 revision 绑定。Gate Evidence、Transition Receipt、Approval
Receipt、工作包派发与交付以及 append-only Audit chain 都会和当前 content、state、
policy snapshot 及 Git HEAD 交叉验证。

### 受治理的并行研发

Apply 可以生成带依赖关系、且写入路径互不重叠的 work packages。XForge 负责签发与
当前修订绑定的 dispatch receipt 并验证 delivery evidence，真正的子 Agent 调度仍由
所选编程工具完成。如果平台没有原生子 Agent 能力，就按顺序执行并报告能力降级。

### Portable 与 Managed 两种模式

- **Portable 模式**：声明的 CLI 暂时不可用时，仓库中的项目文件仍可被直接阅读，
  但这些约束只能作为指导；XForge 不会声称 Gate 或治理动作已经执行。
- **Managed 模式**：声明的 CLI 身份、Protocol 与 Lockfile integrity 必须匹配。
  只有此模式可以安装投影、运行 Gate、记录受管 Transition、审批、派发工作包、审计
  写入/投递和归档。

## 开始使用

安装 XForge 包含两个步骤：把经过完整性校验的 Scaffold 本地化到目标仓库，再让精确
版本的 CLI 同时对命令行和 Agent 工具的 Hooks 可用。项目有意不提供依赖浮动版本的
一行式安装脚本。

最可靠的方式，是让编程 Agent 严格执行根目录中的
[Agent 安装手册](../AGENT_INSTALL.md)：

```text
请严格按照 AGENT_INSTALL.md 把 XForge 安装到当前仓库。
使用源码模式，源码位于 <XForge源码绝对路径>，固定提交为 <完整commit>。
不要覆盖已有文件，不要提交 Git；遇到冲突时停止并报告。
```

该手册同时覆盖 npm 精确版本和“源码构建本地包”路径。它还要求 Agent 校验
Scaffold 摘要、调整 modules/targets/Gates、保留已有文件、确认 Managed mode、
审查安装 dry run，并验证 Runtime Hook 能找到裸命令 `xforge`。

安装完成后，在目标项目根目录执行：

```bash
xforge version --text
xforge state --text
xforge check --text
```

给程序或 Agent 消费时应去掉 `--text`，使用默认 JSON 输出。

## 用 XForge 开发一个 Change

安装后的 `xforge-*` Skills 是主要用户入口。一个典型的首次请求是：

```text
请使用 xforge-propose Skill 为 <目标> 创建一个 Change。
选择足够安全的最轻量 Flow，并解释 classification。
```

随后可使用 `xforge-status` 解释当前状态，或使用 `xforge-continue` 执行下一项合法
Action。生命周期 Skills 包括 `xforge-clarify`、`xforge-design`、
`xforge-check`、`xforge-apply` 和 `xforge-verify`；`xforge-revise` 用于在保持
一致性的前提下修改规划产物，`xforge-scaffold` 用于定制项目所有的 Agent 资产。

底层 CLI 的典型闭环是：

```bash
xforge state --change <change-id>
xforge check --change <change-id>
xforge transition --change <change-id> --to <next-stage> --dry-run
xforge transition --change <change-id> --to <next-stage>

# state 报告 work package ready 时：
xforge work-package dispatch --change <change-id> --package <package-id>

# state 报告需要审批时：
xforge approve --change <change-id> --for <stage-or-archive> ...

xforge audit verify --change <change-id>
xforge archive --change <change-id> --dry-run
xforge archive --change <change-id>
```

不要机械地一次执行完这些命令：`state.nextActions` 才是当前事实。Flow 可能要求先
rework、运行额外 Gate、取得外部签名 Approval，或清理远端 Audit 欠账。

## 维护现有安装

修改 `xforge/scaffold/` 下的规范资源，或调整 `xforge/manifest.yaml` 中选中的资源
后，运行：

```bash
xforge sync --dry-run
xforge sync --verify-digests
```

Targets、Scaffold/CLI 身份或 Adapter 输出变化时，先运行 `xforge update
--dry-run`，确认后再运行 `xforge update`。需要移除某个 Target 时，先用 `xforge
uninstall --target <target> --dry-run` 查看只针对受管文件的删除计划。

## 必须了解的边界

- Runtime Hook 和权限覆盖取决于平台，通常还需要用户在编程工具中显式信任项目
  配置。
- 默认 `runtime-audit` Hook 已被选择但处于 disabled 状态，项目必须主动启用。
- 当前生成的 Hook 调用裸命令 `xforge`；它必须出现在 Agent 工具运行环境的
  `PATH` 中，仅在某个终端里能用绝对路径执行 Node 脚本还不够。
- Gate 成功只能证明指定命令在记录的 revision 上运行成功，不能自动证明所有语义
  需求都正确。
- 本地 Approval attestation 是仓库级证明，不等于企业身份。高保障 Flow 应使用
  外部签名 Receipt。
- `archive` 表示关闭 XForge Change，不等于部署应用、发布版本、执行数据迁移或获得
  生产系统权限。

## 仓库结构

```text
XForge/
├── scaffold/              # 带版本的唯一规范 Scaffold 分发
├── xforge/                # @xforge/cli 源码、Schemas、构建和测试
├── docs/                  # 产品、协议、治理和设计文档
├── tests/                 # 产品、安全边界和真实 Agent 引擎验证
├── AGENT_INSTALL.md       # 可直接交给编程 Agent 的安装手册
└── README.md              # 英文项目说明
```

## 延伸文档

- [Agent 安装手册](../AGENT_INSTALL.md)
- [CLI 使用指南](cli-tool-usage.md)
- [Flows 与 Skills](flows-and-skills-design.md)
- [治理控制平面](governance-control-plane-design.md)
- [文件协议](file-protocol.md)
- [子 Agent 设计](sub-agent-system-design.md)
- [产品规格](XFORGE_PRODUCT_SPEC.md)

## 开发 XForge

```bash
npm ci --prefix xforge
npm run verify
```

更小范围的检查包括 `npm run build`、`npm test`、`npm run check:scaffold` 和
`npm run test:product`。

发布维护者应遵循包含隐私保护要求的[发布说明](RELEASING.zh-CN.md)。

## License

Apache License 2.0，详见 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。
