[English](../README.md) | 简体中文

# XForge

XForge 是一个面向 AI 辅助软件研发的 Git 原生治理控制平面。它把规格、流程状态、
工程规则、质量证据、审批和审计历史变成可版本化的项目事实，再将项目需要的
Skills、子 Agent、策略和 Hooks 投影到团队已经使用的 AI 编程工具中。

XForge 不是另一个 Agent Runtime。模型和编程工具仍然负责探索、设计与实现；
XForge 负责定义什么是当前事实、下一次状态转换是否合法，以及一个 Change 在推进或
关闭前必须具备哪些证据。

> **当前版本：** `@xforge/cli 0.7.15`、Protocol 2，需要 Node.js 20 或更高
> 版本。只支持从 npm 安装精确版本，不再支持源码安装。项目仍在积极开发中。

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

XForge 由两样东西构成，它们在你的仓库里汇合：一个**命令行**，负责判定什么是
事实、哪个转换合法；一套**脚手架**，负责告诉 Agent 该怎么做事。分清这两者，
下面几乎所有规则都不言自明。

```text
  @xforge/cli（npm，固定精确版本）
  └── 内含经过校验的脚手架 payload
                    │
                    │  xforge init          ── 每个项目一次
                    ▼
  xforge/                                      ← 规范来源，项目所有，纳入 Git
  ├── manifest.yaml · constitution.md · XFORGE.md
  ├── specs/ · changes/ · flows/
  └── scaffold/  skills · agents · rules · policies · hooks · gates
                    │
                    │  xforge install / sync / update
                    ▼
  .claude/ · .agents/ · .codex/ · .cursor/ · .opencode/ · .github/
                                               ← 生成的投影，不是来源

  Agent 读投影出来的内容，遵循 Skills。   CLI 读 xforge/，给出状态、Gate、
                                          receipt、审批与审计。
```

**脚手架是 Agent 读的东西，命令行是说出事实的东西。** Skill 能指导、
PermissionPolicy 能拦截、Gate 能证明——XForge 从不让其中一个冒充另一个，
且只有 CLI 的 JSON 输出与 Gate 证据算作事实。

由此推出三条结论，新用户遇到的意外多半出自这里：

- **投影是单向且可重算的。** `xforge/scaffold/**` 是来源，工具目录是产物。要改
  就改来源，再运行 `xforge sync`。手改生成文件会被**拒绝**而不是合并——因为下
  一次投影会静默覆盖它。
- **npm 包是唯一受支持的输入。** 脚手架随固定版本的 CLI 一起发布，写入前会对
  照校验清单验证。源码检出、本地 tarball、独立压缩包都不是安装输入，所以任何
  项目都能准确说出自己跑的是哪些字节。
- **你的定制能扛过升级。** 初始化之后 `xforge/scaffold/**` 归你编辑；CLI 做的是
  调和而非替换，分不清哪些改动是你的时会拒绝操作而不是猜。

与你共有的文件——`AGENTS.md`、`CLAUDE.md`——采用标记块合并。
`<!-- XFORGE:BEGIN -->` 与 `<!-- XFORGE:END -->` 之外的内容逐字节保留，重复安装
会**原地替换**该块，不会追加第二份。

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

npm 包内置与 CLI 精确配套、经过校验的项目 Scaffold。`init`、`install`、`sync`、
`update` 和 `uninstall` 使用按 Target 记录的所有权与内容摘要。Dry run 会展示完整
写入计划；未知文件、用户修改、符号链接、路径穿越和所有权冲突都会被拒绝。卸载只会
删除 XForge 拥有且摘要仍匹配的文件。

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

### 项目自己声明验证，与语言无关

出厂的 `unit-tests` 与 `security-scan` Gate 曾经直接跑 npm。在没有 `package.json`
的项目上，它们**什么都没断言就报告 `passed`**——一条 `must` 规则因此失去了唯一的
强制力，归档时的必过 Gate 变成空的。

现在 Gate 运行的是项目在 `manifest.verification` 下声明的命令，**没有声明就拒绝**。
拒绝是一个尚未回答的问题，不是一次失败的检查。`xforge verification declare` 负责写入
条目，任何 Agent 都不必手改 Manifest；跨十五种生态的工具链探测会给出**建议**——而建议
是向人提问的开始，永远不是答案。

### 架构有一个可以写下来的地方

Requirements 能活过一个 Change，是因为 `syncSpecs` 会把它们合并回去。架构没有这条
通路，于是每个 Change 的决策随它一起归档，下一个 Change 只能从代码里重新推导。
`xforge/architecture.md` 就是这份持久记录，`xforge-architect` 是它唯一的写者——可以
从现有代码生成、通过提问收敛，或从一段描述生成。它被限制在 50 行、6 条决策以内：
一条决策配得上位置，是因为**推翻它会牵动好几个模块**。这个文件不是必需的，`doctor`
只会建议，永远不会因为它缺失而失败。

### 独立于 Change 生命周期的只读 Skills

不是所有 Skill 都会读写 Change/Flow/Gate 状态。`xforge-kanban` 把纯 `git log` 转成
Markdown 活动看板：按贡献者统计 commit、代码行数与活跃天数、按星期几 x 小时的活动
热力图、feat/fix/其他分类，以及多模块项目的按模块拆分。`xforge-status` 报告某个
Change 的处境，`xforge-architect` 写架构文件，`xforge-upgrade-scaffold` 合并新版脚手架。
它们对 Change 状态都是只读的，随时可以运行。

提案之前调查代码、Specs 与方案不需要单独的 Skill——阅读与检索是 XForge 投影到的每个
编程工具的原生能力；把模糊想法收敛成可 Propose 的范围，是 `xforge-propose` 的第一步。

### Portable 与 Managed 两种模式

- **Portable 模式**：声明的 CLI 暂时不可用时，仓库中的项目文件仍可被直接阅读，
  但这些约束只能作为指导；XForge 不会声称 Gate 或治理动作已经执行。
- **Managed 模式**：声明的 CLI 身份、Protocol 与 Lockfile integrity 必须匹配。
  只有此模式可以安装投影、运行 Gate、记录受管 Transition、审批、派发工作包、审计
  写入/投递和归档。

## 开始使用

XForge 命令的正常调用方是 AI Agent，不是人类临时手敲。人类或 CI 只做一次性安装；
此后的每一步——初始化、执行 Flow、Transition——都是 Agent 按已安装的 `xforge-*`
Skills 里给出的原文，发出 `xforge ...`。

**npm 只是分发通道。** XForge 是一个命令，不是你项目的依赖：它不会成为你构建的
一部分，安装它也不会把一个 Python、Go 或 Rust 仓库变成 Node 项目。**全局安装之后，
你的项目里不会出现 `package.json`，也不会出现 `node_modules`。**

三种安装方式，按推荐顺序：

| | 什么时候用 | 会在你项目里留下什么 |
| --- | --- | --- |
| [交给 Agent](#1-交给-agent) | 常规路径——你本来就在编程工具里 | `xforge/`、`AGENTS.md`、一个工具目录 |
| [手动安装](#2-手动安装) | 你想自己敲命令 | 同上 |
| [项目本地安装](#3-项目本地安装一个全局版本不够用时) | 多个项目锁定不同 XForge 版本，或 CI runner 需要隔离 | 同上，外加 `package.json` 与 `node_modules` |

### 1. 交给 Agent

在 AI 编程工具里打开你的项目，把下面这段粘进会话。它会完成装包、初始化项目、
投影脚手架——并且在动手写任何文件之前，**先问你两个工具替你回答不了的问题**。

```text
在这个仓库里安装配置 XForge。

先问我两个问题并等我回答：
  1. 脚手架语言——`en` 还是 `zh-CN`？
  2. XForge 要投影到哪个 AI 编程工具——codex、claude、cursor、
     opencode 还是 github-copilot？

拿到我的答复后，以它们作为 <LANG> 与 <TOOL>：
  1. npm install -g @xforge/cli
  2. xforge version            → 把版本与 executablePath 报给我
  3. xforge init --language <LANG> --target <TOOL> --dry-run
  4. 把这份计划给我看，确认后再执行去掉 --dry-run 的同一条命令。
  5. xforge state --text       → 确认它报告 mode: managed

规则：直接运行 `xforge`。如果找不到该命令，停下来告诉我——**绝不要退回用
`npx xforge`**，那会解析到 npm 上一个同名的无关包。不要创建 package.json，
也不要执行不带 `-g` 的 `npm install`：这个项目不是 Node 项目，XForge 是工具
不是依赖。
不要覆盖任何已有文件，不要提交 Git。任何一步报出冲突或诊断信息时，
停下来把 JSON 原样给我看，不要绕过去。
```

**为什么必须先问。** 语言在非交互会话里无法推断：初始化会以
`XFORGE_LANGUAGE_REQUIRED` 直接失败而不是替你选一个——因为宪法和 Agent 会读到的
每一个 Skill 都用你在这里选定的语言书写。目标工具则决定投影落到哪个目录。

需要更细致、按检查清单推进的安装（调整既有仓库的 modules、targets、Gates），
就让 Agent 执行根目录的 [Agent 安装手册](../AGENT_INSTALL.md)：

```text
请严格按照 AGENT_INSTALL.md 把 XForge 安装到当前仓库。
不要覆盖已有文件，不要提交 Git；遇到冲突时停止并报告。
```

### 2. 手动安装

```bash
npm install -g @xforge/cli@0.7.15
xforge version                       # 确认版本，以及它解析到了哪个文件
xforge init --language zh-CN --dry-run
xforge init --language zh-CN
```

`--language en|zh-CN` 覆盖语言自动检测。只有在交互式终端里才可以省略它（终端会
询问）；非交互执行会失败并给出可直接使用的命令，而不是替你选。宪法、`XFORGE.md`、
Skills 与子 Agent 指令都会按该语言安装——**每份文档只落地一个文件，用规范文件名**
——其余脚手架资产保持英文。

再把规范 Skills、Agents、Rules、权限/MCP Policies、Hooks 等资产投影到指定工具：

```bash
xforge install --target codex --dry-run
xforge install --target codex
```

**没有 `xforge/` 的项目用 `init`，已经有的用 `install`**——对未初始化的目录执行
`install` 会报 `XFORGE_PROJECT_NOT_FOUND`。两个命令都只接受选项：项目根目录通过
`--root <path>` 指定，**不能作为位置参数**传入。

`init --target <工具>` 可以把两步合并，适用于无需调整默认脚手架的新项目。
`install` 不指定 `--target` 时会投影 Manifest 里启用的全部 Target。

### 3. 项目本地安装（一个全局版本不够用时）

全局安装在一台机器上只能有一个版本。而每个项目在 `xforge/manifest.yaml` 里各自
锁定版本，所以**两个锁定不同版本的项目无法同时被一个全局安装满足**——对不上的那个
会退出 Managed 模式并拒绝写入，报 `XFORGE_CLI_IDENTITY_MISMATCH`。出现这种情况，
或者 CI runner 要构建多个项目时，改用项目本地安装：

```bash
npm install --save-dev --save-exact @xforge/cli@0.7.15
npx --no-install xforge version
```

**只有在这条路径下 `npx --no-install` 才是对的**，而且两半都不可少：`npx` 负责从
不在 `PATH` 上的 `node_modules/.bin` 里解析出可执行文件，`--no-install` 负责在本地
没装时阻止 npm 去拉那个同名的无关包。这也是唯一会在项目里留下 `package.json` 与
`node_modules` 的方式。

### 验证，以及排查装错版本

```bash
xforge version --text                # 哪个构建在应答，来自哪个文件
xforge state --text                  # mode: managed，declared 与 actual 是否一致
xforge check --text
```

**项目报 `XFORGE_CLI_IDENTITY_MISMATCH` 时，说明应答的 CLI 不是该项目锁定的版本。**
`xforge version` 会同时给出版本与 `executablePath`，这正是区分"某个旧的全局安装"
与"项目本地安装把它盖住了"的依据。处理方式：升级项目（`xforge update`）、升级全局
安装（`npm install -g @xforge/cli@<版本>`），或按上面第 3 种方式为该项目单独安装。
**装错版本绝不会静默发生**——身份对不上时写操作一律被拒。

给程序或 Agent 消费时应去掉 `--text`，使用默认 JSON 输出。

## 用 XForge 开发一个 Change

安装后的 `xforge-*` Skills 是主要用户入口。一个典型的首次请求是：

```text
请使用 xforge-propose Skill 为 <目标> 创建一个 Change。
选择足够安全的最轻量 Flow，并解释 classification。
```

随后可使用 `xforge-status` 报告在飞 Change 的全局清单与各自所处阶段、解释单个 Change
的详情，并指出下一项合法 Action 而不代为执行。生命周期 Skills 包括 `xforge-clarify`、`xforge-design`、
`xforge-check`、`xforge-apply` 和 `xforge-verify`；`xforge-revise` 用于在保持
一致性的前提下修改规划产物，`xforge-scaffold` 用于定制项目所有的 Agent 资产。
`xforge-kanban` 完全独立于该生命周期，按需报告 Git 历史活动，不读取也不依赖任何
Change。

底层 CLI 的典型闭环是：

```bash
xforge state --change <change-id>
xforge check --change <change-id>
xforge transition --change <change-id> --to <next-stage> --dry-run
xforge transition --change <change-id> --to <next-stage>

# state 报告 work package ready 时：
xforge work-package dispatch --change <change-id> --package <package-id>

# state 报告需要审批时：
xforge approve --change <change-id> --for <transition-id-or-archive> ...

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

## 把项目搬到新版 XForge 上

`xforge/scaffold/**` 只在 `init` 时播种一次，**之后永不更新**，所以项目会一直带着
创建时的那套 Skills、Rules 和 Gates，直到有人把它搬过去。`xforge update` **不做**
这件事——它是把你**已有的**脚手架重新投射进 `.claude/` 等目录。改变"已有的是哪一套"
的是 `xforge upgrade-scaffold`。

它**从不替你合并**：把新版原样暂存在你自己的脚手架旁边、快照你现在的状态、把每个
文件分类。因为哪些文件有差异是算术，而"你在某个 Skill 里的措辞是否该让位给新的默认
值"是一个关于你这个项目的问题。在你或 Agent 做出决定之前，`xforge/scaffold/` 下面
一个字节都不会动。

**先归档或走完进行中的 Change。** 否则那个 Change 剩下的 Stage 会在它的 Design
从未见过的 Gate 下运行；命令会拒绝，而不是让这件事悄悄发生。

### 把这段交给你的编程 Agent

```text
把本项目的 XForge 脚手架升级到已安装 CLI 所带的版本。

1. 运行 `npm i -g @xforge/cli@latest`，再用 `xforge version` 确认。
2. 运行 `xforge upgrade-scaffold --dry-run --text`，把计划给我看。如果它拒绝就停下：
   进行中的 Change 必须先归档，那是我的决定。
3. 运行 `xforge upgrade-scaffold` 暂存。这一步 `xforge/scaffold/` 下不会有任何变化。
4. 读 `xforge/scaffold-<version>/MERGE.md`。它已经点名了每一个有差异的文件和每一个
   新增文件。不要自己去翻脚手架——计划就是工作面的陈述，相同的文件已成定局。
5. 按那个文件合并。吸收新版**规定**的东西，保住本项目**知道**的东西——带着我们真实
   测试命令的 Gate、我们选定的措辞、有人调过的阈值。两者不能同时成立时，停下来问我。
6. **不要**往 `xforge/manifest.yaml` 里加任何东西。文件随发行版到达，不等于决定要
   运行它。把到达但未选中的列出来，由我来选。
7. 绝不删除标记为 `project-only` 的文件；绝不触碰 `xforge/changes/`、`xforge/specs/`、
   审计链、审批、`constitution.md`、`architecture.md`。
8. 最后运行 `xforge upgrade-scaffold --complete`，然后 `xforge install`，
   然后 `xforge doctor`。
9. 报告：每个有差异的文件你取了哪一边、为什么；第 8 步的采纳计数**逐字引用、不要
   打分**；以及有哪些等着我决定。
```

已选中 `xforge-upgrade-scaffold` 的项目，可以让 Agent 直接调用那个 Skill——它带着
同样的规则，并且附有权限边界。

### 出问题了怎么办

`xforge upgrade-scaffold --rollback` 会把脚手架**逐字节**还原成暂存之前的样子。
**只保留一份快照**（最近一次升级的），因为允许任意版本穿梭就会把这个方案要解决的
问题重新引进来。如果升级完成后脚手架又被改动过，回滚会**拒绝**——那样会丢掉这些
工作；`--force` 可以强制。`xforge/upgrade-log.md` 记录每一次完成的升级，它活过暂存
目录，也活过回滚。

## 必须了解的边界

- Runtime Hook 和权限覆盖取决于平台，通常还需要用户在编程工具中显式信任项目
  配置。
- `runtime-audit` Hook 作为未选择的示例随包提供：目前没有任何 dispatcher 会执行它的
  `builtin: audit` action，因此即使选择它也不会产生任何效果。
- 生成的 Hook 从项目根目录调用 `xforge`，只解析项目本地的精确
  npm 包，缺包时不会在线下载替代版本。
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
- [Skills、Flows、Rules、Gates、Hooks、PermissionPolicies 与 Approvals](governance-concepts.zh-CN.md)
- [扩展 Skills 与 Flows](extending-skills-and-flows.zh-CN.md)
- [扩展 Gate、Rule、PermissionPolicy、Hook 与 Approval](extending-gates-rules-policies-hooks-approvals.zh-CN.md)
- [用 MCP provider 扩展 Approvals](extending-approvals-with-mcp.zh-CN.md)
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
