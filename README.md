# XForge

**XForge 是一个 Git 原生的治理控制面，用于有治理的 AI 辅助软件开发。**

它把规格、工作流状态、工程规则、质量证据、审批与审计历史，变成**版本化的项目事实**，
再把相应的 Skills、Agent 定义、权限策略与 Hook **投影**到团队已经在用的 AI 编程工具里。

> **当前版本：** `@xforge/cli 0.7.21`、Protocol 2、Node.js 20 或更高。
> 只支持从 npm 安装精确版本，不支持从源码安装。实现仍在活跃开发中。

---

## 它不做什么

- **不是 Agent 运行时**——不托管模型、不执行推理、不创建模型进程；
- **不是编程工具的替代品**——探索、设计、写代码仍由 Codex / Claude Code / Cursor / OpenCode / Copilot 完成；
- **不是发布系统**——`archive` 关闭的是一个 Change，不部署、不发版、不跑迁移、不授予生产权限。

一句话概括分工：

> **模型负责「怎么做」，XForge 负责「什么是真的、哪一步是合法的、推进前必须拿出什么证据」。**

---

## 概念

### 两个物件，一个方向

XForge 在你的仓库里其实只有两样东西。分清它们能解释掉后面大部分规则。

```text
  @xforge/cli  (npm，精确版本固定)
  └── 内含经过校验的 Scaffold 载荷
                    │
                    │  xforge init          ── 每个项目一次
                    ▼
  xforge/                                     ← 规范源，项目所有，进 Git
  ├── manifest.yaml · constitution.md · XFORGE.md
  ├── specs/ · changes/ · flows/
  └── scaffold/  skills · agents · rules · policies · hooks · gates
                    │
                    │  xforge install / sync / update
                    ▼
  .claude/ · .agents/ · .codex/ · .cursor/ · .opencode/ · .github/
                                              ← 生成的投影，不是源

  Agent 读的是投影。            CLI 读的是 xforge/，
  它跟着 Skill 走。             并回答 state / Gate / receipt / approval / audit。
```

**Scaffold 是 Agent 读的东西；CLI 是说真话的东西。** 由此派生三条最常让新人意外的规则：

- **投影是单向、可重算的。** 改 `xforge/scaffold/**` 然后 `xforge sync`。
  手改生成物会被**拒绝**而不是合并——因为下一次投影会静默覆盖它。
- **npm 包是唯一受支持的输入。** Scaffold 随固定版本的 CLI 一起发布、按校验和清单验证，
  所以一个项目永远能说清自己跑的是哪些字节。
- **你的定制在升级中存活。** `xforge/scaffold/**` 初始化后归你所有；
  CLI 做的是**调和**而不是替换，分不清哪个改动是谁的时候就拒绝。

与你共有的文件（`AGENTS.md`、`CLAUDE.md`）通过标记块合并：
`<!-- XFORGE:BEGIN -->` … `<!-- XFORGE:END -->` 之外的内容逐字节保留。

### 三种东西不许互相冒充

这是整套设计的核心公理：

| | 它能做的 | 它**不能**变成的 |
| --- | --- | --- |
| **Rule** | 指导模型 | 不能拦住任何东西，也不构成证据 |
| **PermissionPolicy** | 实时守住一个动作（allow / ask / deny） | 不是质量证明 |
| **Gate** | 跑确定性检查，产出与 revision 绑定的 Evidence | 不是授权 |
| **Approval** | 记录人（或外部系统）的决定 | 不能由 Agent 自签 |

> **一条 Rule 可以指导，一条 PermissionPolicy 可以守卫，一道 Gate 可以证明，
> 一次 Approval 可以授权——XForge 从不让其中一个顶替另一个。**

由此派生出你会反复遇到的一条规则：**只有 CLI 的 JSON 输出与 Gate Evidence 算事实。**
Agent 的自然语言结论、聊天记忆、勾选框、自报退出码，一律不是事实。

Rule 有一个特别之处：它声明自己**声称**由谁强制执行，每次算 `state` 时拿这个声称去核对，
产出 `coverage`——`instructed` / `guarded` / `verified` / `approved` /
`uncovered` / `unenforceable`。**它做的是把「写下来了」和「真的被强制执行」之间的落差
暴露出来，而不是藏起来。**

### 治理强度与风险成比例

| Flow | 适用 | stage graph | 人工审批 |
| --- | --- | --- | --- |
| `quick` | 低风险、单模块、可回滚 | propose → apply → verify | 归档 1 次 |
| `solid` | 常规产品与工程变更（默认） | propose → design → check → apply → verify | check 出口 + 归档，各 1 人 |
| `major` | 高风险 / 关键影响 / 跨系统 | propose → clarify → design → check → apply → verify | 同上，且审批人不能是实现者 |

**资格是结构性强制的，不靠 Agent 自觉：** `quick` 会**拒绝**跨模块或非低风险的工作；
触及安全 / 隐私 / 公开 API / 数据迁移的高风险变更**必须**走 `major`。

Stage 由**受保护的 CLI transition** 推进，不是靠 Agent 编辑一个状态字段、
或者声称工作已完成。

### 什么算「事实」

当前 Stage 不是从文件存在与否推断的，而是从一条经过校验的 **transition receipt 链**重建的。
证据、审批、派工凭据全部绑定到内容 revision 上：

```text
policySnapshotDigest = hash(constitution + flow + rules + policies + hooks + gates)
contentRevision      = hash(change 输入 + policySnapshotDigest)
stateRevision        = hash(contentRevision + currentStage + transitionHead)
governingRevision    = hash(截至当前 Stage 的产出 + policySnapshotDigest)   ← 审批专用
```

**在受管边界上失败即关闭：** 生成物冲突、陈旧 receipt、失败的 Gate、不完整的审计历史、
不安全路径——一律中止操作，而不是静默忽略。

### 两种运行模式

| 模式 | 条件 | 能做什么 |
| --- | --- | --- |
| **Managed** | 声明的 CLI 身份、Protocol、Lock 完整性全部匹配 | 投影、跑 Gate、受治理的 transition、审批、派工、审计、归档 |
| **Portable** | 不匹配 | 仓库仍可读、文件仍是有效指导，但**不声称**确定性强制执行发生过 |

---

## 安装

**XForge 的命令是给 AI 编程 Agent 用的，不是给人临时敲的。**
人或 CI 只做一次性安装；此后每一次操作——初始化、执行 Flow、Transition——
都是 Agent 按已安装的 `xforge-*` Skills 所写去运行 `xforge ...`。

> **npm 只是分发方式。** XForge 是一个命令，不是你项目的依赖：
> 它不会成为你构建的一部分，安装它也不会把一个 Python / Go / Rust 仓库变成 Node 仓库。
> 全局安装之后，你的项目里不会留下 `package.json` 和 `node_modules`。

### 方式一：让 Agent 来做（推荐）

在 AI 编程工具里打开项目，把下面这段粘进会话：

```text
在这个仓库里设置 XForge。

先问我两个问题并等我回答：
  1. Scaffold 语言 —— `en` 还是 `zh-CN`？
  2. XForge 要投影到哪个 AI 编程工具 —— codex、claude、cursor、opencode
     还是 github-copilot？

然后用我的答案作为 <LANG> 和 <TOOL>：
  1. npm install -g @xforge/cli
  2. xforge version            → 把版本和 executablePath 报告给我
  3. xforge init --language <LANG> --target <TOOL> --dry-run
  4. 把计划给我看，确认后再跑一次不带 --dry-run 的同一条命令。
  5. xforge state --text       → 确认它报告 mode: managed

规则：直接运行 `xforge`。如果找不到这个命令，停下来告诉我——
绝不要退回到 `npx xforge`，npm 上有一个同名的无关包。
不要创建 package.json，不要运行不带 -g 的 npm install：
这个项目不是 Node 项目，XForge 是工具不是依赖。
绝不覆盖已有文件，绝不提交。
任何一步报告冲突或诊断，停下来把 JSON 给我看，不要绕过去。
```

**为什么要先问。** 语言在非交互会话里无法猜测：初始化会以
`XFORGE_LANGUAGE_REQUIRED` 失败关闭，而不是替你选一个——因为 Constitution
和 Agent 会读的每一个 Skill 都用你在这里选的语言书写。目标决定哪个工具目录接收投影。

需要更深入的、清单驱动的安装（把模块、目标和 Gate 适配到一个已有仓库），
把 Agent 指向根目录的 [`AGENT_INSTALL.md`](AGENT_INSTALL.md)。

### 方式二：手动

```bash
npm install -g @xforge/cli@0.7.21
xforge version                       # 确认版本与解析位置
xforge init --language zh-CN --dry-run
xforge init --language zh-CN
```

`--language en|zh-CN` 覆盖语言检测。只有在交互式终端里才能省略它（它会问你）；
非交互运行会给出一条可操作的命令而失败，不会替你选。

然后把规范的 Skills、Agent、Rules、权限 / MCP 策略、Hook 投影到一个工具：

```bash
xforge install --target codex --dry-run
xforge install --target codex
```

- 没有 `xforge/` 的项目用 `init`，已经有的用 `install`
  （在未初始化目录上 `install` 会报 `XFORGE_PROJECT_NOT_FOUND`）；
- 两者都**只接受选项**：项目根目录来自 `--root <path>`，绝不是位置参数；
- `init --target <tool>` 对默认 Scaffold 够用的新项目可以一步到位；
- `install` 省略 `--target` 时会投影 Manifest 里启用的每一个目标。

### 方式三：项目本地安装

全局安装在机器上只放一个版本。每个项目在 `xforge/manifest.yaml` 里固定自己的版本，
所以两个跑不同 XForge 版本的项目无法同时被它满足——不匹配的那个会掉到 Portable 模式
并拒绝写入（`XFORGE_CLI_IDENTITY_MISMATCH`）。出现这种情况，或者一个 CI runner
要构建多个项目时，按项目安装：

```bash
npm install --save-dev --save-exact @xforge/cli@0.7.21
npx --no-install xforge version
```

**只有在这里 `npx --no-install` 才是对的，而且两半都重要：**
`npx` 从不在 `PATH` 上的 `node_modules/.bin` 里解析可执行文件，
`--no-install` 阻止 npm 在本地缺失时去拉那个无关的 `xforge` 包。
这是唯一会在项目里留下 `package.json` 和 `node_modules` 的路径。

### 验证与诊断陈旧安装

```bash
xforge version --text                # 哪个 build 在应答，来自哪里
xforge state --text                  # mode: managed，声明值 vs 实际值
xforge check --text
```

**报告 `XFORGE_CLI_IDENTITY_MISMATCH` 意味着应答的 CLI 不是该项目固定的版本。**
`xforge version` 会同时给出版本和 `executablePath`——那是区分陈旧全局安装
与遮蔽它的项目本地安装的关键。三条出路：升级项目（`xforge update`）、
升级全局安装、或按上面的方式为该项目做本地安装。
**陈旧安装绝不会是静默的**：身份一致之前写入一律被拒绝。

需要程序或 Agent 消费结果时，用默认的 JSON 输出而不是 `--text`。

---

## 使用

### 通过 Skills

已安装的 `xforge-*` Skills 就是日常界面。典型的第一个请求：

```text
用 xforge-propose Skill 为 <目标> 创建一个 Change。
选择安全前提下最弱的 Flow，并解释这个分类。
```

之后：

| Skill | 做什么 |
| --- | --- |
| `xforge-status` | 报告在途 Change 的全景与各自所在 Stage，深入解释一个 Change，**并指出下一个合法动作但不替你做** |
| `xforge-propose` / `clarify` / `design` / `check` / `apply` / `verify` | 处理当前活跃阶段 |
| `xforge-revise` | 修改规划产物并保持它们相互一致 |
| `xforge-scaffold` | 定制项目自有的 Agent 资产 |
| `xforge-architect` | 写 `xforge/architecture.md`（跨 Change 的架构决策，上限 50 行 / 6 条） |
| `xforge-kanban` | 把 `git log` 变成 Markdown 活动看板；**完全在 Change 生命周期之外，随时可跑** |
| `xforge-upgrade-scaffold` | 合并更新的 Scaffold |

> 调查代码、Specs 与选项**不需要专门的 Skill**——阅读与检索是每个被投影目标的原生能力。
> 把一个模糊想法收敛成可提案的范围，是 `xforge-propose` 的第一步。

### 底层的 CLI 循环

```bash
xforge state --change <change-id>
xforge check --change <change-id>
xforge transition --change <change-id> --to <next-stage> --dry-run
xforge transition --change <change-id> --to <next-stage>

# 当 state 报告有就绪的工作包时：
xforge work-package dispatch --change <change-id> --package <package-id>

# 当 state 报告需要审批时。从 state.nextActions[] 里把命令原样复制出来，
# 不要自己拼：--for 填的是该审批所解锁的那次 transition，
# approve 会拒绝任何其它值，而不是写一份没人会数的 receipt。
xforge approve --change <change-id> --for <transition-id-or-archive> ...

xforge audit verify --change <change-id>
xforge archive --change <change-id> --dry-run
xforge archive --change <change-id>
```

> **不要照抄这个序列。** `state.nextActions` 才是权威——一条 Flow 可能要求返工、
> 额外的 Gate、外部审批 receipt 或远端审计投递，才允许下一次 transition。

### 几条日常要点

- **被 `blockedBy` 挡住时读它说的那一条**，而不是绕开。
  **Gate refuse ≠ Gate fail**——refuse 是「你还没告诉我这个项目怎么验证自己」。
- **Gate 必须在最后一次写入之后一次性跑完。** 先跑一个 Gate、再改文件、再跑下一个，
  会让先跑的变陈旧——所有 Gate 都报 `passed`，Stage 却仍然出不去。
- **项目自己声明怎么验证。** `unit-tests` 和 `security-scan` 跑
  `manifest.verification` 下声明的命令（任意语言），没声明就**拒绝**。
  用 `xforge verification declare` 写入，绝不手改 Manifest。
- **改治理资产不属于一个进行中的 Change**——它会让所有活跃 Change 的 revision 漂移。

---

## 维护与升级

### 日常同步

编辑了 `xforge/scaffold/` 下的规范资源、或改了 `xforge/manifest.yaml` 里选中的资源之后：

```bash
xforge sync --dry-run
xforge sync --verify-digests
```

目标、Scaffold / CLI 身份或 Adapter 输出发生变化时：

```bash
xforge update --dry-run
xforge update
```

安全移除某一个目标的受管文件：

```bash
xforge uninstall --target <target> --dry-run
```

### 迁移到更新的 Scaffold

> **`xforge update` 不做这件事。** 它把你**已有的** Scaffold 重新投影一遍。
> 真正换掉 Scaffold 本身的是 `xforge upgrade-scaffold`。

`xforge/scaffold/**` 由 `init` 播种一次，此后不再自动更新——一个项目会一直保留
它被创建时的那套 Skills、Rules 和 Gates，直到有人搬动它。

**它从不替你合并。** 它把新来的 Scaffold 暂存在你自己的旁边、给你现有的做快照、
并对每个文件分类——因为**哪些文件不同是算术，而你在某个 Skill 里的措辞是否该让位给
一份更新的默认，是一个关于你项目的问题**。在你或 Agent 做出决定之前，
`xforge/scaffold/` 下不会有任何东西被改动。

**先归档或完成打开的 Change。** 否则一个 Change 剩下的 Stage 会在它的 Design
从未见过的 Gate 下运行——命令会拒绝，而不是让这件事静默发生。

把下面这段交给你的编程 Agent：

```text
把这个项目的 XForge Scaffold 升级到已安装 CLI 附带的版本。

1. 运行 `npm i -g @xforge/cli@latest`，再用 `xforge version` 确认。
2. 运行 `xforge upgrade-scaffold --dry-run --text` 并把计划给我看。
   如果它拒绝，停下：打开的 Change 必须先归档，那是我的决定。
3. 运行 `xforge upgrade-scaffold` 暂存。这一步 `xforge/scaffold/` 下不会有变化。
4. 读 `xforge/scaffold-<version>/MERGE.md`。它列出每一个不同的文件和每一个新增文件。
   不要自己去通读 Scaffold——那份计划就是任务的陈述，相同的文件已经有定论了。
5. 按那份文件合并。采纳新版本更好的部分；保留这个项目知道的东西——
   一个承载我们真实测试命令的 Gate、我们选定的措辞、某个人调过的阈值。
   两者不能兼得时，停下来问我。
6. 不要往 `xforge/manifest.yaml` 里加任何东西。一个随发布到达的文件不等于一个运行它的决定。
   把到达但未被选中的列出来，让我选。
7. 绝不删除任何标记为 `project-only` 的文件；绝不碰 `xforge/changes/`、
   `xforge/specs/`、审计链、approvals、`constitution.md` 或 `architecture.md`。
8. 以 `xforge upgrade-scaffold --complete` 收尾，然后 `xforge install`，然后 `xforge doctor`。
9. 报告：每个变更文件你站了哪一边、为什么；第 8 步的采纳计数逐字引用、不加评价；
   以及还有什么在等我决定。
```

选中了 `xforge-upgrade-scaffold` 的项目可以让 Agent 直接调用那个 Skill，
它带着同样的规则，并附有权限边界。

### 出问题时

```bash
xforge upgrade-scaffold --rollback
```

把 Scaffold 恢复到暂存之前的样子。**只保留一份快照**——上一次升级的——
因为任意版本穿梭会重新引入这套机制所要替代的问题。
升级完成之后 Scaffold 又发生变化时它会拒绝（回滚会丢弃那些工作），`--force` 可以覆盖。

`xforge/upgrade-log.md` 记录每一次完成的升级，并且在暂存目录和回滚之后都存活。

---

## 重要边界

- 运行时 Hook 与权限覆盖是平台相关的，可能需要在编程工具里显式信任该项目。
- `runtime-audit` Hook 作为**未选中**的示例随包发布：目前没有 dispatcher 执行它的
  `builtin: audit` 动作，选中它不会有任何效果。
- 生成的 Hook 从项目根调用 `xforge`，以便解析到确切的本地包而不去下载替代品。
- **Gate 成功证明的是配置好的命令针对被记录的 revision 跑过了**，
  不证明每一条语义需求都正确。
- 本地审批凭证是仓库级证据，不是企业身份。更高保证级别的流程应使用 MCP provider。
- **`archive` 关闭的是一个 XForge Change。** 它不部署应用、不发布版本、
  不运行迁移、不授予生产系统访问权限。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/index.md) | 按「我要解决什么问题」组织 |
| [概念与架构](docs/concepts-and-architecture.md) | XForge 按什么逻辑运转 |
| [治理模型](docs/governance-model.md) | 七类治理资源各自能证明什么 |
| [扩展指南](docs/extension-guide.md) | 新增 Skill / Flow / Gate / Rule / Policy / Hook / Approval / Agent / MCP |
| [仓库与文件布局](docs/repository-layout.md) | 每个中间产物落在哪、归谁写、什么该进 Git |
| [子 Agent 设计](docs/sub-agent-design.md) | 并行工作包与 Worker / Integrator / Reviewer |
| [CLI 用法](docs/cli-tool-usage.md) | 命令、参数、退出码与常见诊断码 |
| [Agent 安装手册](AGENT_INSTALL.md) | 清单驱动的安装流程 |

---

## 仓库结构

```text
XForge/
├── scaffold/              # 版本化的规范 Scaffold 发行物
├── xforge/                # @xforge/cli 源码、schemas、构建与测试
├── docs/                  # 概念、治理、扩展与设计文档
├── tests/                 # 产品 / 安全与实机引擎验证
├── AGENT_INSTALL.md       # Agent 可执行的安装手册
└── README.md              # 本文件
```

## 开发 XForge

```bash
npm ci --prefix xforge
npm run verify
```

更窄的检查：`npm run build`、`npm test`、`npm run check:scaffold`、`npm run test:product`。
改动了 `scaffold/payload/**` 之后需要 `npm run relock` 重算校验和清单。

发布维护者请遵循 [发布手册](RELEASING.md)。

## 许可

Apache License 2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
