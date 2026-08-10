# XForge 产品开发基线

> 面向企业软件研发的 Git 原生 AI Agent 工程框架

| 项目 | 内容 |
|---|---|
| 文档状态 | Draft / 产品与架构基线 |
| 基线版本 | 0.1.0 |
| 主要读者 | 产品负责人、架构师、维护者、承担实现工作的 AI Agent |
| 产品名称 | XForge |
| 名称含义 | X = cross-agent / extensible；Forge = 把企业规范、Agent 能力、研发流程和质量门禁铸进每一个项目 |

本文档是 XForge 第一阶段开发的事实来源。除非产品负责人明确修改，开发 AI Agent 不得自行改变本文中的仓库边界、目录边界、命令模型和安全约束。

> 本文保留最初的产品/Protocol 1 基线和历史约束。Rules、PermissionPolicy、双平面
> Hooks、Transition、Approval、Audit 与当前 Protocol 2 实现以
> [governance-control-plane-design.md](governance-control-plane-design.md) 和 ADR 0002
> 为准；`@xforge/cli 0.6.0` 已完成 P0–P4，Protocol 1 仅保留 Portable-read 迁移。
>
> 第 4.3 节的 Flow 同样是历史示例：文中的第三档 Flow ID 写作 `prime`，Schema 写作
> `artifacts` + `operations`。当前实现的第三档 Flow ID 是 `major`，Schema 是
> `stages` + `governance` + `terminal`（含 `approvalPolicies`、`reworkTo`、
> `terminal.archive`），详见 [flows-and-skills-design.md](flows-and-skills-design.md)
> 和 `scaffold/payload/xforge/flows/{quick,solid,major}.yaml`。不要照抄本节的
> Flow YAML 示例作为当前 Schema 参考。

文中的“必须”“不得”表示强制要求；“应当”表示默认要求，偏离时必须记录原因；“可以”表示可选能力。

---

## 1. 产品定义

XForge 是面向企业软件研发的项目级 AI Agent 工程框架。它将以下资产作为代码仓库的一部分统一管理：

- 当前有效的产品与工程规格；
- 进行中的变更、设计、任务和验证证据；
- 项目研发流程定义（Flows）；
- Skills、Agents、Rules、Hooks、Scripts；
- 研发流程、质量门禁和工具适配配置；
- 面向不同 AI 编码工具的生成结果和安装状态。

XForge 的一句话定位：

> 将企业规格、Agent 能力、流程门禁和质量证据本地化到每个代码仓库，并让 AI Agent 以可审查、可验证、可回滚的方式执行它们。

XForge 吸收轻量级规格驱动开发的思想，但不是 OpenSpec 的企业版，也不以兼容或扩展 OpenSpec 为产品前提。XForge 面向企业项目治理，覆盖从需求、设计、开发到验证、门禁和归档的完整工程闭环。

### 1.1 核心价值

1. **项目所有**：规范和 Agent 资产进入用户项目，不依赖外部聊天记录或个人机器配置。
2. **Git 原生**：所有重要变更均可通过 commit、diff、branch 和 pull request 审查。
3. **统一来源、多端安装**：以统一资产模型为事实来源，再生成并安装到 Claude、Codex、Cursor、OpenCode 和 GitHub Copilot 的项目级默认目录。
4. **AI 优先**：接口主要服务 AI Agent，默认结构化、无交互、可确定解析。
5. **门禁执行**：关键要求通过检查和门禁执行，而不只是提示词建议。
6. **证据驱动**：没有验证结果和交付证据，不得宣称变更已经完成。
7. **克制实现**：优先文件协议和少量确定性操作，不引入不必要的服务、数据库和命令。

### 1.2 非目标

XForge v1 不做以下事情：

- 不实现 IDE；
- 不实现新的大模型或通用 Agent Runtime；
- 不实现 Agent 市场或公共 Skill Registry；
- 不提供云端控制台、后台服务或常驻 Daemon；
- 不替代 Git、CI、测试框架、安全扫描器和制品系统；
- 不为每一种资源提供独立 CRUD 命令；
- 不实现复杂 Flow 继承、任意深度合并或依赖求解器；
- 不承诺不同 AI 工具的 Agents、Hooks 和权限语义完全等价。
- v1 不支持 Claude、Codex、Cursor、OpenCode、GitHub Copilot 之外的 Adapter，也不提供第三方 Adapter 插件机制。

---

## 2. 单仓库与目录级分发

XForge 的脚手架、工具实现和产品文档放在同一个 `xforge` 仓库中，但使用清晰的一级目录隔离。这样可以让工具与脚手架在同一 commit 中配套演进，也允许 AI Agent 只取得某个脚手架目录，而不把工具源码和全部文档复制进用户项目。

### 2.1 XForge 源仓布局

```text
XForge/                              # XForge 源仓
├── README.md                         # 仓库入口，只指向 docs/bootstrap.md
├── LICENSE
├── scaffold/                         # 唯一的官方可本地化脚手架
│   ├── scaffold.yaml                 # 版本、协议和 payload 描述
│   ├── files.sha256                  # payload 文件摘要清单
│   └── payload/                      # 只有这里的内容会进入用户项目
│       ├── AGENTS.md
│       └── xforge/
│           ├── manifest.yaml
│           ├── flows/
│           │   ├── quick.yaml
│           │   ├── solid.yaml
│           │   └── prime.yaml
│           └── scaffold/skills/      # OpenSpec 启发的初始 Skills
│               ├── xforge-explore/
│               ├── xforge-propose/
│               ├── xforge-apply/
│               ├── xforge-verify/
│               └── xforge-archive/
├── xforge/                           # CLI、文件协议 Schema、构建与测试
│   ├── package.json
│   ├── src/
│   ├── schemas/
│   ├── scripts/
│   ├── test/
│   └── dist/
└── docs/                             # 产品、架构、Bootstrap、协议和维护文档
    ├── bootstrap.md
    ├── product-baseline.md
    ├── file-protocol.md
    └── adapter-matrix.md
```

除仓库惯例所需的 `README.md`、`LICENSE` 和少量根配置外：

- 所有能被同步到用户项目的内容必须位于唯一的 `scaffold/`；
- 所有工具代码、构建脚本、协议 Schema 和测试必须位于源仓 `xforge/` 实现目录；
- 所有说明性文档必须位于 `docs/`；
- 不在用户 payload 中放入工具实现源码、构建产物或 XForge 仓库历史。

XForge 只有一套官方脚手架，不设置 `standard/` 子目录，也不为第三方、企业或用户自定义脚手架预留目录。企业和用户取得 `scaffold/` 后，在自己的代码仓中直接定制并自行维护。三个研发量级只是同一脚手架中的三个 Flow 文件，不是三套脚手架。

### 2.2 npm 内置脚手架

XForge 只通过 `@xforge/cli` npm 包分发。每个发布包必须同时包含 CLI、Schemas 和与
该版本精确配套的 `scaffold/`。用户和 Agent 不再从 Git 子目录、源码 checkout、
本地 tarball 或独立 HTTP 制品获取 Scaffold。

`xforge init` 从已安装包内读取 descriptor 与 payload，在任何项目写入前验证完整
inventory、SHA-256、版本、Protocol、路径和符号链接边界。CLI 与 Scaffold 版本不匹配
时必须 fail closed。

每个 `scaffold.yaml` 至少包含：

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Scaffold
metadata:
  version: 0.6.0
protocol: "2"
payload: payload
integrity:
  algorithm: sha256
  manifest: files.sha256
xforgeCompatibility:
  protocol: "2"
```

`files.sha256` 使用稳定的相对路径排序生成，不包含自身。npm 包中的 Scaffold 只能包含
`scaffold.yaml`、摘要清单和 `payload/`，不得包含工具实现源码或完整 XForge 仓库历史。

本地化后的文件归用户项目 Git 直接管理。项目可以修改 Flow、Skill、Rule、Hook、Script 和 Gate，不要求与源脚手架逐文件一致。升级不得直接覆盖项目文件，必须形成普通项目变更，展示三方 diff，通过检查后再合并。

### 2.3 XForge CLI 声明、调用与缓存

同一源仓的 `xforge/` 实现目录负责确定性能力，包括项目解析、五种 Adapter 安装、所有权保护、检查、门禁和归档。CLI 源码不复制到用户项目；用户项目只在 Manifest 的 `xforge` 字段中固定 npm 精确版本。

```yaml
xforge:
  source: npm
  package: "@xforge/cli"
  version: "0.6.0"
  protocol: "2"
```

Manifest 和 Lockfile 不接受 Git CLI identity。npm 包必须作为项目精确依赖安装；缺包或
版本不匹配时不得从网络临时下载替代版本。

XForge CLI 启动后必须自检实际 package version、integrity 和协议，不匹配时只返回诊断，不修改项目。XForge 区分两种保证级别：

| 级别 | XForge CLI 状态 | 能力 |
|---|---|---|
| Portable | 声明的 CLI 暂不可用 | AI Agent 可直接读取文件并按文档工作；约束以指导性为主 |
| Managed | CLI 已解析且版本匹配 | 提供确定性安装、检查、门禁、所有权保护和归档 |

Portable 模式不得伪装成已执行强制门禁。只有 Managed 模式可以声明“门禁已执行”或“安装已验证”。

### 2.4 配套版本协议

同一仓库不等于使用浮动版本。项目通过四层机制固定安装输入：

1. `xforge/manifest.yaml` 声明 npm Scaffold package 与精确版本；
2. Manifest 的 `xforge` 字段声明同一 npm package version；
3. `xforge/lock.yaml` 保存 Scaffold 与 XForge CLI 的实际来源、内容摘要和 integrity；
4. XForge CLI 在任何写操作前检查自身版本、Scaffold 版本和文件协议兼容性。

XForge CLI 发布版本、脚手架版本和文件协议版本必须分开。一次 XForge 仓库 commit 可以同时推进三者，但用户项目可以在兼容范围内独立选择。破坏性文件协议修改必须提升协议版本。

---

## 3. 用户项目目录

用户项目固定使用 `xforge/` 保存 Manifest、Lockfile、Constitution、Flows、Scripts 和 Scaffold 资产。`specs/` 与 `changes/` 是两个逻辑目录，默认位于 `xforge/` 下，但可以在 Manifest 中重定位到项目内其他位置，例如现有的 `docs/`。

`flows/` 保存项目直接使用的研发流程定义，用于描述变更包含哪些 Artifact、阶段如何衔接、何时执行检查以及归档前置条件。它替代原来的一级 `schemas/`，避免把业务流程定义与用于校验 YAML/JSON 的技术 Schema 混为一谈。

`scripts/` 保存项目共享的确定性程序；Skill 内部仍可按照 Agent Skills 约定携带自己的私有 `scripts/`。`scaffold/` 只保存需要安装或适配到 AI 编程工具的项目资产，不再额外维护模板层或工具实现代码。

### 3.1 默认目录

```text
user-project/
├── AGENTS.md                         # 推荐的最小 bootstrap，项目所有
├── xforge/
│   ├── manifest.yaml                 # 项目声明，必须提交
│   ├── lock.yaml                     # 外部资产和安装输入锁定，必须提交
│   ├── constitution.md               # 项目宪法，最高层稳定工程原则
│   ├── .state.json                    # 本地安装状态，默认不提交
│   ├── specs/                        # 当前有效事实
│   ├── changes/                      # 进行中及已归档变更
│   ├── flows/                        # 同一脚手架的三个流程文件
│   │   ├── quick.yaml
│   │   ├── solid.yaml               # 默认标准流程
│   │   └── prime.yaml
│   ├── scripts/                      # 项目共享程序，TypeScript 优先
│   └── scaffold/
│       ├── README.md
│       ├── skills/                   # 当前直接使用的 Skills
│       ├── agents/                   # 当前直接使用的 Agent 定义
│       ├── rules/                    # 当前直接使用的 Rules
│       ├── hooks/                    # 当前直接使用的 Hooks
│       └── gates/                    # 当前直接使用的质量门禁
├── .agents/                          # Codex 生成目标，不是事实来源
├── .claude/                          # Claude 生成目标
├── .cursor/                          # Cursor 生成目标
├── .opencode/                        # OpenCode 生成目标
└── .github/                          # GitHub Copilot 生成目标
```

项目已有文档体系时，可以保持该体系不变，只在 Manifest 中改写两个逻辑路径：

```text
user-project/
├── docs/
│   ├── specs/                        # project.paths.specs
│   └── changes/                      # project.paths.changes
└── xforge/
    ├── manifest.yaml
    ├── constitution.md
    ├── flows/                        # quick.yaml / solid.yaml / prime.yaml
    ├── scripts/
    └── scaffold/
```

### 3.2 项目宪法

`xforge/constitution.md` 定义项目长期稳定、不可被普通功能变更绕过的工程原则。其定位参考 Spec Kit constitution，但 XForge 将它直接置于项目事实目录，并由 Flow、Skill 和 `check` 显式消费。

Constitution 应包含：

- 项目使命和边界；
- 架构原则；
- 安全、隐私和合规原则；
- 测试、质量和可观测性底线；
- 兼容性与版本策略；
- 变更、批准和例外治理方式。

建议使用 Markdown frontmatter 记录治理元数据：

```markdown
---
version: 1.0.0
ratified: 2026-08-08
lastAmended: 2026-08-08
---

# Project Constitution

## Principles

...

## Governance

...
```

Constitution 只保存原则和不可协商的约束，不保存具体 API、数据库字段或单个功能需求；这些细节属于 `specs/` 和具体 Change。修改 Constitution 必须通过独立 Change、说明影响范围并按语义版本更新：破坏性原则变化为 MAJOR，新增或实质扩展原则为 MINOR，文字澄清为 PATCH。

所有 Flow 指令、生成的 XForge 工作流 Skill、`state` 和 `check` 都必须读取当前 Constitution。Constitution 与 Rule 冲突时，Constitution 优先；工具不得静默选择低优先级内容。

### 3.3 用户源码布局

XForge 不要求用户移动或重组现有源码。单仓库、Monorepo 和多应用仓库都通过 Manifest 中的 `project.modules` 描述：

```text
user-project/
├── apps/                            # 用户源码，可按现有习惯组织
│   └── web/
├── services/
│   └── api/
├── packages/
│   └── shared/
├── xforge/                          # XForge 项目事实与脚手架资产
└── .claude/ .agents/ ...            # install 生成目标
```

```yaml
project:
  layout: monorepo
  paths:
    specs: docs/specs
    changes: docs/changes
  modules:
    - id: api
      path: services/api
      kind: service
    - id: web
      path: apps/web
      kind: application
    - id: shared
      path: packages/shared
      kind: library
```

Change 通过 module ID 表达影响范围，不复制一份源码目录模型：

```yaml
# 默认位置：xforge/changes/add-login/change.yaml
flow: solid
classification:
  risk: medium
  security: false
  privacy: false
  publicApi: false
  dataMigration: false
scope:
  modules: [api, web]
  paths:
    - services/api/src/auth/**
    - apps/web/src/login/**
```

约束如下：

- 所有路径相对用户代码仓根目录解析；
- 单体项目可以只声明一个 `path: .` 模块；
- Change 可以在 `change.yaml` 中声明受影响的 module ID；
- Rule、Script 和 Gate 可以按 module ID 或路径限定作用域；
- v1 只允许仓库根存在一个 `xforge/manifest.yaml`，不实现嵌套 XForge 根；
- XForge 不根据目录名猜测模块，未声明时只把仓库根视为一个模块。

### 3.4 Scaffold 资产

源仓 `scaffold/payload/` 是完整脚手架；本地化后的 `xforge/scaffold/` 只保存需要安装到 AI 编程工具的 Agent 资产，不代表另一套脚手架，也不再区分“模板”和“实例”。

- `scaffold/skills/` 等目录中的内容可以被 Manifest 选择并安装；
- 目录中存在资源不代表自动启用，最终以 Manifest 为准；
- AI Agent 可以直接按项目需要修改这些资产，再通过普通 Git diff 审查；
- XForge CLI 不实现模板实例化、在线模板市场或运行时隐式下载。

### 3.5 当前规格与变更

逻辑 `specs` 路径表示当前已生效事实；逻辑 `changes` 路径表示尚未进入当前事实的提议或执行中工作。默认值分别为 `xforge/specs` 和 `xforge/changes`：

```yaml
project:
  paths:
    specs: xforge/specs
    changes: xforge/changes
```

已有 `docs/` 管理约定的项目可以改为：

```yaml
project:
  paths:
    specs: docs/specs
    changes: docs/changes
```

路径约束：

- 路径必须相对用户项目根目录，不允许绝对路径、`..` 或符号链接逃逸；
- 两个路径不得相同、互相包含或落入 XForge 生成目标目录；
- Manifest 未声明时必须使用默认值，工具不得根据现有目录猜测；
- `state`、`check`、`archive`、Flow 和工作流 Skills 必须只使用解析后的逻辑路径，不得硬编码 `xforge/specs` 或 `xforge/changes`；
- Lockfile 记录规范化后的相对路径；路径变化必须作为普通项目 Change 审查；
- 修改路径不会自动搬迁已有文件。AI Agent 必须先生成移动计划，经冲突检查后使用 Git 可追踪的重命名完成迁移。

建议的变更结构：

```text
<project.paths.changes>/add-login/
├── change.yaml
├── proposal.md
├── specs/
├── design.md
├── tasks.md
├── approvals/
└── evidence/
    ├── structure.json
    ├── tests.json
    └── security.json
```

已完成变更归档到：

```text
<project.paths.changes>/archive/<date>-<change-id>/
```

验证证据优先跟随具体变更保存，不额外建立全局一级 `evidence/` 目录。

### 3.6 npm Agent Bootstrap

首次接入时，用户让本地 AI Agent 执行根目录 `AGENT_INSTALL.md` 的 npm-only 安装协议。
Agent 必须先安装精确 `@xforge/cli` 项目依赖，再调用包内置的 `xforge init`，不得自行
读取或复制 XForge 源仓文件。

建议用户给 Agent 的唯一指示为：

```text
Follow AGENT_INSTALL.md to install exact @xforge/cli from npm,
initialize its bundled Scaffold, project the selected Agent tools,
preserve existing files, and stop on conflicts.
```

`docs/bootstrap.md` 必须指导 Agent 完成以下确定性步骤：

1. 确认用户项目根目录和工作区状态；
2. 通过 npm 安装 Manifest 要求的精确 `@xforge/cli` 项目依赖；
3. 执行 `xforge init --dry-run`，由 CLI 校验 npm 包内 Scaffold 版本、协议、inventory、
   内容摘要和路径安全；
4. 遇到现有文件默认停止，不覆盖；
5. 执行 `xforge init` 本地化 payload；
6. 根据项目事实调整 modules、Specs/Changes 路径、Gates、资源选择和 Targets；
7. 对每个目标先执行 `install --target <target> --dry-run`，确认后执行 `install`；
8. 执行 `state` 与 `check`，确认 Managed mode；
9. 如果默认 Scaffold 无需定制，可用 `init --target <target>` 合并初始化和单 Target 投影；
10. npm 包不存在或版本不匹配时停止，不得回退到源码、Git、HTTP 或临时在线下载。

Agent 不得静默执行全局 npm 安装、修改系统 PATH 或从未声明地址运行代码。项目本地
命令与生成 Hook 使用 `npx --no-install xforge`，缺少精确依赖时直接失败。

脚手架 payload 应包含项目内的长期发现入口。推荐在根 `AGENTS.md` 中只放一个短指示，要求后续 Agent 读取 `xforge/manifest.yaml`、Constitution 和当前 Change；XForge CLI 不应反复重写用户已有的完整 `AGENTS.md`。对于不读取 `AGENTS.md` 的目标工具，首次 `install` 生成各自的最小 bootstrap 文件。

文档中的“安装”分为两层：`xforge init` 负责校验并本地化 npm 包内 payload；
`xforge install` 负责把已本地化的 Agent 资产同步到五种目标工具目录。

---

## 4. Scaffold 资产模型

### 4.1 Manifest 是选择入口

`manifest.yaml` 声明项目结构、默认 Flow、目标工具、Scaffold 资产、项目脚本和 XForge CLI 精确版本。目录中存在某个资源不代表它自动生效。

```yaml
apiVersion: xforge.dev/v1alpha1
kind: Project

metadata:
  name: payments-api

project:
  layout: monorepo
  paths:
    specs: docs/specs
    changes: docs/changes
  modules:
    - id: api
      path: services/api
      kind: service
    - id: web
      path: apps/web
      kind: application

scaffold:
  version: 0.6.0
  source:
    type: npm
    package: "@xforge/cli"
    version: 0.6.0
  skills:
    - xforge-explore
    - xforge-propose
    - xforge-apply
    - xforge-verify
    - xforge-archive
  agents:
    - worker
    - integrator
    - reviewer
  rules: []
  hooks: []
  gates:
    - structure
    - unit-tests
    - security-scan

scripts:
  - project-context

xforge:
  source: npm
  package: "@xforge/cli"
  version: "0.6.0"
  protocol: "2"

flow: solid

targets:
  - codex
  - claude
  - cursor
  - opencode
  - github-copilot

install:
  conflictPolicy: fail
  prune: managed-only
  commitGeneratedFiles: true
```

`scaffold.source` 只接受 `type: npm`、固定包名和精确版本。

### 4.2 Lockfile

`lock.yaml` 只保存解析后的确定状态，不重复 Manifest 的意图。至少记录：

- Scaffold npm package 与精确版本；
- XForge CLI npm package version；
- 解析后的 Specs 与 Changes 相对路径；
- 资源 ID 和版本；
- 内容摘要；
- 许可证；
- 目标工具；
- 生成协议版本。

Scaffold 和 XForge CLI 的 npm 精确版本由 Manifest 固定，Lockfile 记录实际解析结果和 integrity。Manifest 表达期望，Lockfile 保证同一输入可以复现。

### 4.3 Flows

Flow 的设计重点参考 OpenSpec custom schema：以有序 Artifact 列表描述工作产物，以 `requires` 表达依赖，以操作定义实施和归档前置条件。XForge 将其命名为 Flow，并取消独立模板目录，把产物骨架直接放进 `flow.yaml`。

唯一的官方脚手架必须在 `xforge/flows/` 中提供三个平级 Flow 文件，ID 固定为 `quick`、`solid`、`prime`。它们只是同一文件协议下的三个流程定义，不对应不同脚手架、目录层级或运行引擎。

```text
xforge/flows/
├── quick.yaml
├── solid.yaml                        # Manifest 默认
└── prime.yaml
```

| Flow | 适用范围 | Artifact 依赖顺序 | Apply 前置 | Archive Gates |
|---|---|---|---|---|
| `quick` | 小特性、小 Bug、低风险且影响范围清晰的变更 | `proposal → specs → tasks` | `tasks` | `structure`, `unit-tests` |
| `solid` | 普通产品功能和常规工程变更，作为标准流程和默认选择 | `proposal → specs → design → tasks` | `tasks` | `structure`, `unit-tests` |
| `prime` | 复杂、高风险、跨系统、安全/隐私、公共 API、数据迁移和关键发布 | `proposal → specs → design → risk-assessment → test-plan + rollout-plan → tasks → approval` | `approval` | `structure`, `unit-tests`, `security-scan` |

`quick` 仍生成精简 Specs 并在归档时同步主规格，只省略独立 Design 等重型 Artifact。超出单模块、低风险和清晰边界的变更至少使用 `solid`。`prime` 的 `approval` Artifact 只能由授权的人或外部审批系统完成，AI Agent 可以生成审批请求，但不得自行标记批准。

`solid.yaml` 是 Flow Schema 的基准示例：

```yaml
apiVersion: xforge.dev/v1alpha1
kind: Flow

metadata:
  name: solid
  version: 1
  description: Default product and engineering change flow

artifacts:
  - id: proposal
    generates: proposal.md
    description: Explain why the change is needed
    instruction: Focus on problem, scope, impact and rollback.
    outline: |
      ## Why
      ## Scope
      ## Impact
      ## Rollback
    requires: []

  - id: specs
    generates: specs/**/*.md
    description: Define observable requirements and scenarios
    instruction: Describe what the system must do, not implementation details.
    outline: |
      ## Requirements
      ## Scenarios
    requires: [proposal]

  - id: design
    generates: design.md
    description: Explain the technical approach
    instruction: Evaluate alternatives and constitution constraints.
    outline: |
      ## Context
      ## Decisions
      ## Risks
    requires: [proposal, specs]

  - id: tasks
    generates: tasks.md
    description: Track implementation work
    instruction: Produce verifiable, dependency-aware tasks.
    outline: |
      ## Tasks
    requires: [design]

operations:
  apply:
    requires: [tasks]
    tracks: tasks.md
  archive:
    requires: [specs, tasks]
    syncSpecs: true
    mandatoryGates: [structure, unit-tests]
```

`quick.yaml` 和 `prime.yaml` 必须使用同一 Schema，仅通过 Artifacts、依赖和 Operations 表达量级差异，不在 CLI 中为三种 Flow 编写三套分支代码。`quick` 删除独立 `design` Artifact，并让 `tasks` 依赖 `[proposal, specs]`；`prime` 的新增 Artifact 固定为：

```text
risk-assessment -> risk-assessment.md    requires: [design]
test-plan       -> test-plan.md          requires: [design, risk-assessment]
rollout-plan    -> rollout-plan.md       requires: [design, risk-assessment]
tasks           -> tasks.md              requires: [design, test-plan, rollout-plan]
approval        -> approvals/release.md requires: [tasks, test-plan, rollout-plan]
```

Flow 解析保持克制：

1. `change.yaml` 显式指定的 Flow；
2. `manifest.yaml` 中的默认 `flow`；
3. 两者都没有时返回错误，不提供隐式内建 Flow。

Artifact 的 `generates` 相对当前 Change 目录解析；归档后的目标位置由 `project.paths.specs` 决定。Artifact 列表顺序决定多个 Artifact 同时可生成时的顺序，`requires` 决定是否具备生成条件。`xforge state --change <id>` 返回下一可执行 Artifact、已解析 instruction、outline、Constitution、对应 Rules 和相关 Specs，供安装后的工作流 Skills 使用。

Flow 选择必须由 Agent 在 Proposal 中解释，并在 `change.yaml.classification` 声明风险和关键影响标记。无法确认量级时选择更严格的一档；`check` 必须拒绝把跨模块、中高风险或包含安全、隐私、公共 API、数据迁移标记的 Change 配置为 `quick`，高风险或任一关键影响为 `true` 时必须使用 `prime`。

### 4.4 Skills

Skills 的组织、状态驱动方式和跨工具安装模型明确来源于 OpenSpec 的启发：项目内保存规范化源文件，CLI 动态返回当前 Artifact 状态和指令，`install` 再把 Skills 与薄命令入口安装到 AI 编程工具可发现的目录。XForge 在此基础上加入 Constitution、三档 Flow、Gates、Evidence 和 managed-only 所有权。

每个 Skill 使用独立目录和 `SKILL.md`，并允许包含私有 `scripts/`、`references/` 和 `assets/`：

```text
xforge/scaffold/skills/xforge-propose/
├── SKILL.md
├── scripts/                 # 仅供此 Skill 使用
├── references/
└── assets/
```

官方脚手架的初始工作流 Skills 固定为五个，其工作流行为均参考 OpenSpec：

| Skill | 主要行为 | OpenSpec 参考与 XForge 取舍 |
|---|---|---|
| `xforge-explore` | 只读探索问题、代码和方案，不创建 Change、不修改文件 | 参考 OpenSpec `explore` |
| `xforge-propose` | 创建 Change，选择 `quick/solid/prime`，按 Flow 生成全部可规划 Artifacts | 参考 OpenSpec `propose` 和 Artifact graph |
| `xforge-apply` | 读取已满足前置条件的 Tasks，实施并持续更新任务状态 | 参考 OpenSpec `apply` |
| `xforge-verify` | 运行 `xforge check`、Mandatory Gates，核对实现与 Specs 并保存 Evidence | 参考 OpenSpec expanded `verify`，强化为企业门禁 |
| `xforge-archive` | 先预览归档计划，再同步 Specs 并归档 Change | 参考 OpenSpec `archive`；OpenSpec `sync` 能力并入此 Skill |

XForge 不单独提供用于 Specs 的 `xforge-sync` Skill；需要提前查看 Spec 合并效果时使用 `xforge archive --dry-run`。CLI 的 `xforge sync` 专门负责把本地 `xforge/scaffold/**` 增量投影到已安装 Target，不承担 Specs 同步。后续是否增加 OpenSpec 的 `ff`、`bulk-archive` 或 `onboard`，必须基于企业试点需求决定。

五个官方 `SKILL.md` 应采用一致骨架：Purpose、Preconditions、State Query、Allowed Writes、Procedure、Verification、Stop Conditions。每个 Skill 开始时都必须查询 `xforge state`；`explore` 不要求存在活动 Change。任何 Artifact 列表、依赖和下一步都来自 Flow 解析结果，不硬编码在 Skill 中。每个 Skill 都必须清楚区分“给 Agent 的指令”和“CLI/Gate 已确定执行的事实”。

XForge 区分两类 Skill，但采用同一种安装机制：

- **项目 Skill**：由企业或项目维护，例如代码审查、安全检查和发布流程；
- **XForge 工作流 Skill**：由 `scaffold/payload/` 作为真实项目资产本地化到 `xforge/scaffold/skills/`，根据当前 Flow 驱动 explore、propose、apply、verify 和 archive，项目可以直接审查和定制。

工作流 Skill 必须调用 `xforge state` 获取当前 Change、下一 Artifact、Flow instruction、outline、Constitution、Rules 和 Specs，不得在不同 Adapter 中复制一套 Flow 状态机。XForge CLI 只负责解析和安装，不把另一套隐藏 Skill 模板编译进工具包。目标工具支持命令/Prompt 文件时，命令只作为调用对应 Skill 的薄入口；Codex 只安装 Skills，不伪造命令系统。

参考 OpenSpec 时遵守以下边界：

- 借鉴 action-based workflow、Artifact graph、动态 instructions、Skills/Commands 分层和项目本地化方式；
- XForge 的 Flow Schema、JSON 协议、Constitution、Gate 和 Evidence 保持独立设计；
- 不复制 OpenSpec 名称空间或让 XForge 项目依赖 OpenSpec Runtime；
- 如复用 OpenSpec 源码或文本，必须先确认许可证要求，在源码和 NOTICE 中保留必要归属。

企业命名应使用组织前缀，例如：

```text
acme-code-review
acme-security-audit
acme-release
```

版本放在 Skill metadata 和项目 Lockfile 中。项目内修改后，Git commit 是最终审计依据。

### 4.5 Scripts

`scripts/` 是一级目录，保存根据项目定制的共享确定性程序，可以被 Skill、Hook 或 Gate 显式引用，也可以由 AI Agent 按需调用。XForge 的默认项目运行环境包含 Node.js LTS。Skill 私有脚本仍留在对应 Skill 目录中，不提升到项目共享区。

脚本语言约定：

- TypeScript 是默认和优先选择，因为 XForge 默认假设用户已安装 Node.js；
- Python 可以用于数据处理、科学计算或已有 Python 工具链更合适的场景；
- 新脚本不得仅为简单文件复制、YAML 读取等基础行为引入 Python 与 Node 双运行时；
- 脚本必须声明入口、参数、工作目录、超时、输入输出和副作用；
- 跨项目可复用逻辑优先进入 XForge CLI 或企业公共包，项目脚本只保留项目个性化部分；
- Secrets 通过环境变量或外部 Secret Provider 注入，不得写入脚本源码。

建议结构：

```text
xforge/scripts/project-context/
├── script.yaml
├── main.ts
├── package.json          # 仅在确有独立依赖时提供
└── README.md
```

项目脚本应尽量使用 Node.js 标准库和 XForge CLI 已提供的稳定能力，避免每个脚本各自携带大型依赖树。

### 4.6 Agents

Agent 定义采用工具无关的最小中间模型：

```yaml
apiVersion: xforge.dev/v1alpha1
kind: Agent

metadata:
  name: reviewer

spec:
  role: Independent code reviewer
  instructions: reviewer.md
  skills:
    - acme-code-review
  tools:
    allow:
      - read
      - search
      - test
  delegation:
    callableBy:
      - main
    maxConcurrency: 2
  model:
    class: reasoning
    fallback: default
```

适配器必须报告能力映射：`native`、`degraded` 或 `unsupported`。不得仅因文件写入成功就声称目标工具完整支持该 Agent。

官方 Scaffold 只提供 `worker`、`integrator` 和 `reviewer` 三种子 Agent。Main Agent 是当前目标工具的协调者，不作为可并行启动的第四种子 Agent。测试编写由 Worker 加载测试 Skill 完成，集成验证由 Integrator 执行，只读审查由 Reviewer 执行。

`solid` 和 `prime` Change 可以在 Apply 阶段增加可选的 `work-packages.yaml`。该文件是 Tasks 派生的执行计划，不替代 Specs、Design 或 Tasks，也不进入第二套规格事实源。容器使用 `apiVersion: xforge.dev/v1alpha1`、`kind: WorkPackagePlan` 和 `packages`；每个工作包对象固定且只包含：

```yaml
id: T012
goal: 实现订单退款状态转换和幂等处理
depends_on: [T003]
inputs: [specs/add-refund/plan.md, contracts/openapi/refund.yaml]
write_paths: [backend/order/**]
skills: [implement-order-refund]
verify: [./gradlew :backend:order:test]
done_when: [状态转换符合退款契约, 相同幂等键不会重复创建退款]
```

`state --change` 必须验证 Schema、DAG、输入存在性、Skill 可用性、Change scope、并行写路径冲突、Integrator-only 路径和已有 delivery commit，并返回 ready/blocked/succeeded/failed 状态。Main Agent 负责固定 base commit、创建独立 branch/worktree 和调用目标工具的子 Agent 能力；XForge 不创建模型进程或提供通用 Agent Runtime。

Worker 把结构化交付返回 Main Agent，由 Main Agent 保存到 `<change>/evidence/agents/<package-id>/<execution-id>.yaml`。`check --change` 必须要求所有工作包具有有效的 succeeded delivery，核对 base/head commit ancestry、真实 Git diff、`changed_paths` 和 `write_paths`，并重新运行全部 `verify` 命令生成受限、脱敏的 XForge Evidence。Agent 自报退出码不构成最终证明。

### 4.7 Rules

本节是 Protocol-1 历史模型。vNext（Protocol 2，`@xforge/cli 0.6.0` 已完成 P0–P4）
已经把 Rule 限定为 Agent guidance，把 allow/ask/deny 运行权限迁移到独立
PermissionPolicy，并由 `state/check` 报告
`instructed/guarded/verified/uncovered` coverage；当前 Schema 见
`xforge/schemas/rule.schema.json`、`xforge/schemas/permission-policy.schema.json`
和 [governance-control-plane-design.md](governance-control-plane-design.md) 第 4 节。

Rules 分为：

- `mandatory`：必须满足，适合由 Gate 验证；
- `advisory`：指导 Agent 行为，不能声称强制执行；
- `scoped`：仅对特定目录或文件类型生效。

Scoped Rule 可以使用 `writePolicy: integrator-only` 将其 `paths` 声明为并行开发中的共享写路径。该策略由工作包结构检查执行，不依赖目标工具是否能原生表达路径权限。

XForge 不提供带业务偏好的默认规则。项目和企业必须自行编写规则。但 XForge CLI 必须内建以下技术安全不变量：

- 不覆盖未被 XForge 管理的文件；
- 不删除未知文件；
- 不越出项目根目录写入；
- Hooks 默认禁用；
- 未支持能力必须明确报告；
- Secrets 不得写入 Manifest、Lockfile 和生成文件。

### 4.8 Hooks

本节是 Protocol-1 历史模型。vNext（Protocol 2，`@xforge/cli 0.6.0` 已完成 P0–P4）
已经把事件拆为 Agent Runtime Plane 与 XForge Workflow Plane：前者由 Adapter 按
事件级能力投影，后者由 CLI 跨平台执行；核心流程审计不依赖目标平台 Hook。当前
Schema 见 `xforge/schemas/hook.schema.json` 和
[governance-control-plane-design.md](governance-control-plane-design.md) 第 5 节。

Hooks 是高风险资源。v1 只定义少量统一事件：

- `session.start`；
- `before.write`；
- `after.write`；
- `before.check`；
- `after.check`；
- `before.archive`；
- `agent.stop`。

适配器只渲染目标工具原生支持的事件。Hook 必须声明命令、超时、工作目录、权限和失败策略。任何网络访问或敏感写操作都必须显式声明。

### 4.9 Gates

vNext 继续坚持本节的确定性 Gate 定义，并额外把 LLM/Reviewer 输出标为 Review
Evidence，把人类决定标为 Approval receipt，把全过程记录标为 Audit。三者不能
冒充 Machine Gate Evidence。

Gate 是确定性检查，不是提示词。v1 支持两类：

1. XForge CLI 内建结构检查：Manifest、Schema、路径、资源引用和所有权；
2. 项目命令检查：测试、Lint、构建、安全扫描等外部命令。

示例：

```yaml
apiVersion: xforge.dev/v1alpha1
kind: Gate

metadata:
  name: unit-tests

spec:
  stage: before-archive
  required: true
  command: ["npm", "test", "--", "--runInBand"]
  timeoutSeconds: 900
  evidence: tests.json
```

Gate 输出必须写入当前变更的 `evidence/`。大体积原始日志可以只保存路径和摘要，不应无限写入 Git。

---

## 5. 命令模型

CLI 主要面向 AI Agent，同时提供完整的项目级 Scaffold 生命周期：

```text
xforge help
xforge version
xforge init
xforge state
xforge install
xforge sync
xforge update
xforge uninstall
xforge check
xforge transition
xforge approve
xforge work-package
xforge hook
xforge audit
xforge archive
```

`init` 是唯一可在尚无 Manifest 的项目中执行的写命令；它只使用当前 npm 包内置并
通过摘要验证的 Scaffold。其余项目命令必须先解析本地 Manifest 和 Lockfile。

### 5.1 `state`

只读解析项目当前状态，统一替代独立的 `list`、`show`、`status`、`context`、`doctor`、`config get` 等命令。

主要职责：

- 识别项目根和协议版本；
- 返回解析后的 Specs/Changes 逻辑路径及其来源（默认或 Manifest）；
- 返回当前 Specs、Changes、Flows；
- 返回已启用 Scaffold 资源；
- 返回目标工具能力矩阵；
- 返回 XForge CLI、Scaffold 和文件协议兼容状态；
- 返回可执行的下一步建议。

通过过滤参数缩小结果，而不是增加新命令：

```text
xforge state --change add-login
xforge state --kind agents
xforge state --target codex
```

### 5.2 `install`

将 Manifest 的期望状态安装到目标 AI 编程工具的默认项目目录，统一承担生成、安装、更新和移除资产的职责。默认位置由 Target Adapter 维护，AI Agent 不需要在普通项目中手工指定路径。

```text
xforge install
xforge install --target codex
xforge install --dry-run
```

行为要求：

- 幂等；
- 只管理带所有权记录的文件；
- 默认冲突即失败；
- 移除资源时只清理 `managed-only` 文件；
- 返回创建、修改、删除、跳过和冲突文件列表；
- `--dry-run` 不产生任何写入。

首次安装或普通幂等修复继续使用 `install`；高频本地 Scaffold 修改使用 `sync`，Target/CLI/Scaffold/Adapter 身份变化使用 `update`，清理生成资产使用 `uninstall`。

### 5.3 `sync`

根据 `xforge/.state.json` v2 中的 source 路径、mtime、size、摘要和 Adapter render version，把 `xforge/scaffold/**` 的修改、增加、删除、启用和停用增量投影到已安装 Target。目标文件若偏离上次安装摘要则冲突失败。

```text
xforge sync
xforge sync --target codex
xforge sync --dry-run
xforge sync --verify-digests
```

### 5.4 `update`

完整重新解析 Manifest、Target、Scaffold/CLI identity 和 Adapter 输出，处理 Target 增删与 v1 ownership record 升级。`update` 不负责联网下载 Scaffold 或 CLI。

```text
xforge update
xforge update --target codex
xforge update --dry-run
```

### 5.5 `uninstall`

按安装记录删除摘要仍匹配的 managed 文件。可按 Target 卸载；省略 Target 时卸载全部。最后一个 Target 清理后删除本地 `.state.json`，保留 Manifest、Lock、Specs、Changes 和 canonical Scaffold。

```text
xforge uninstall --target codex --dry-run
xforge uninstall --target codex
xforge uninstall
```

### 5.6 `check`

统一承担结构校验、Schema 校验、引用检查、质量门禁和交付验证。

```text
xforge check
xforge check --change add-login
xforge check --gate unit-tests
```

不提供独立的 `validate`、`verify`、`test`、`gate run`、`doctor` 命令。

### 5.7 `archive`

完成变更闭环：检查必要门禁、把变更规格合并到 `project.paths.specs`，保存归档记录并在 `project.paths.changes` 下移动变更目录。

```text
xforge archive --change add-login
xforge archive --change add-login --dry-run
```

`archive` 必须：

1. 先执行只读预检；
2. 阻止未通过的 mandatory Gate；
3. 生成将要修改的文件计划；
4. 原子地同步 Specs 和移动变更；
5. 返回所有写入路径和摘要。

`xforge sync` 只同步 Scaffold 投影；归档前的 Specs 同步仍属于 `archive` 的职责。

### 5.8 `help`、`version` 与 Project Root

`help`、`version` 可在项目外运行。项目命令接受全局 `--root <path>`；未指定时从当前目录向上发现 Manifest，指定后必须把该目录精确作为 Project Root，不向父目录回退。

### 5.9 AI 直接编辑，CLI 不做 CRUD

以下工作由 AI Agent 使用普通文件工具完成：

- 创建 Change；
- 编写 Proposal、Spec、Design、Tasks；
- 创建或编辑 Skill、Agent、Rule、Hook、Flow、Gate；
- 调整 Manifest 和 Flow。

XForge CLI 负责读取、检查、生成安装文件和归档，不为上述每种资源实现重复 CRUD API。

---

## 6. 默认 JSON 协议

所有命令默认输出 JSON。v1 不需要 `--json` 参数。

人类需要阅读时显式添加：

```text
xforge state --text
xforge check --text
```

### 6.1 通用输出 Envelope

成功与失败都必须返回稳定 Envelope：

```json
{
  "protocolVersion": "1",
  "ok": true,
  "command": "check",
  "root": "/workspace/project",
  "data": {},
  "diagnostics": [],
  "changes": [],
  "nextActions": []
}
```

错误示例：

```json
{
  "protocolVersion": "1",
  "ok": false,
  "command": "install",
  "root": "/workspace/project",
  "data": null,
  "diagnostics": [
    {
      "code": "XFORGE_PROTOCOL_MISMATCH",
      "severity": "error",
      "message": "Project requires XForge protocol 1.",
      "path": "xforge/manifest.yaml"
    }
  ],
  "changes": [],
  "nextActions": [
    {
      "action": "resolve-declared-xforge",
      "reason": "The running XForge CLI does not match the manifest and lockfile."
    }
  ]
}
```

### 6.2 输出约束

- 默认模式的 stdout 必须只包含一个完整 JSON 文档；
- 不得在 JSON 前后输出 banner、进度条或颜色控制符；
- 写操作必须返回受影响路径和内容摘要；
- 所有诊断必须有稳定 `code`，AI 不应依赖自然语言 message 判断类型；
- CLI 不进行交互式提问，需用户决定的事项通过 JSON `nextActions` 返回，由 AI Agent 在聊天中询问；
- 退出码保持简单：`0` 表示 `ok: true`，`1` 表示 `ok: false`；具体错误类型读取诊断 code；
- `--text` 仅改变呈现，不改变执行语义和退出码。

---

## 7. 核心工作流

### 7.1 新项目接入

```text
用户创建或克隆代码仓
        ↓
用户让 AI Agent 读取固定版本的 docs/bootstrap.md
        ↓
AI 只获取 scaffold/ 并校验摘要
        ↓
AI 规划并本地化 payload，填写 manifest 和 paths
        ↓
AI 检查 manifest 声明的 XForge CLI
        ↓
XForge CLI 缺失：向用户请求安装授权；CLI 可用：继续
        ↓
xforge state
        ↓
xforge install --dry-run
        ↓
用户确认必要的高风险写入
        ↓
xforge install
        ↓
xforge check
```

整个流程由 AI Agent 操作，用户不需要手动调用命令行。

### 7.2 普通功能变更

```text
用户描述需求
        ↓
AI 在 project.paths.changes 下创建 <id>/
        ↓
AI 编写 proposal/specs/design/tasks
        ↓
xforge check --change <id>
        ↓
AI 实现代码并更新任务
        ↓
AI 运行 mandatory Gates
        ↓
证据写入 <changes-path>/<id>/evidence/
        ↓
xforge archive --change <id> --dry-run
        ↓
xforge archive --change <id>
```

### 7.3 Scaffold 自定义

Agent 自我修改配置属于受治理变更，遵循相同 Change 流程：

1. 创建变更并说明为什么要新增或修改 Skill、Agent、Rule、Hook、Script 或 Gate；
2. 直接创建或修改 `xforge/scaffold/` 下的 Agent 资产，或修改一级 `xforge/scripts/` 中的共享脚本；
3. 修改 Manifest；
4. 执行 `install --dry-run` 查看各工具默认目录的影响；
5. Hooks、权限扩大、网络访问和破坏性命令必须由用户批准；
6. 执行 `install` 和 `check`；
7. 保存能力降级和验证结果。

正在运行的 Agent 不得静默扩大自己的权限或启用 Hook。

### 7.4 脚手架与 XForge CLI 升级

升级由 AI Agent 创建普通项目 PR：

- 安装新的精确 `@xforge/cli` npm 版本；
- 由该 CLI 读取并校验包内新版 `scaffold/`；
- 对本地化内容执行三方比较；
- 保留项目修改；
- 更新需要采用的目录、Flow 和 Scaffold 资产；
- 在 Manifest 中同步修改 Scaffold 与 CLI npm 版本并刷新 Lockfile；
- 运行 `state`、`install --dry-run` 和 `check`；
- 展示迁移说明和生成文件 diff。

v1 不开发复杂自动 rebase 能力。优先使用 Git diff、明确迁移文件和 AI Agent 判断。

---

## 8. XForge CLI 实现架构

XForge 源仓的 `xforge/` 实现目录使用 TypeScript 和 Node.js LTS，产生命令名为 `xforge` 的 CLI。实现保持单包、小型、无状态，不在 v1 引入 Monorepo、插件系统或常驻服务。建议结构：

```text
XForge/xforge/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts
│   ├── commands/
│   │   ├── state.ts
│   │   ├── install.ts
│   │   ├── check.ts
│   │   └── archive.ts
│   ├── core/
│   │   ├── project-loader.ts
│   │   ├── manifest.ts
│   │   ├── constitution.ts
│   │   ├── flow-resolver.ts
│   │   ├── validator.ts
│   │   ├── state-reader.ts
│   │   └── archiver.ts
│   ├── adapters/
│   │   ├── claude.ts
│   │   ├── codex.ts
│   │   ├── cursor.ts
│   │   ├── opencode.ts
│   │   └── github-copilot.ts
│   ├── install/
│   │   ├── planner.ts
│   │   ├── ownership.ts
│   │   └── writer.ts
│   ├── runners/
│   │   ├── gate.ts
│   │   └── script.ts
│   └── protocol/
│       ├── envelope.ts
│       └── diagnostics.ts
├── schemas/                         # XForge 文件协议校验 Schema
├── scripts/                         # 工具构建与发布脚本
├── test/
│   ├── fixtures/
│   └── integration/
└── dist/                            # 发布构建输出，不进入脚手架 payload
```

### 8.1 Adapter 边界与支持范围

Adapter 只负责把统一资源渲染为目标工具格式并报告能力，不得包含 Flow 状态机、Constitution 规则或产品工作流逻辑。

```text
Project Source Assets
        ↓
Resolved Resource Model
        ↓
One of Five Adapters
        ↓
Generated Files + Capability Report
```

v1 只支持以下五种 Adapter，目标路径对齐这些工具当前采用的项目级 Skills/Commands 约定：

| Target ID | Skill 安装目录 | 命令/Prompt 安装目录 |
|---|---|---|
| `claude` | `.claude/skills/xforge-*/SKILL.md` | `.claude/commands/xforge/<id>.md` |
| `codex` | `.agents/skills/xforge-*/SKILL.md` | 不生成；使用 Skills |
| `cursor` | `.cursor/skills/xforge-*/SKILL.md` | `.cursor/commands/xforge-<id>.md` |
| `opencode` | `.opencode/skills/xforge-*/SKILL.md` | `.opencode/commands/xforge-<id>.md` |
| `github-copilot` | `.github/skills/xforge-*/SKILL.md` | `.github/prompts/xforge-<id>.prompt.md` |

表中路径是 Adapter 的 v1 默认值，应通过集成测试锁定。工具版本变化导致路径改变时，通过 XForge CLI 发布和协议兼容策略升级，而不是让项目自由配置任意安装路径。Agents、Rules 和 Hooks 仅在目标工具存在可靠项目级映射时生成；其余情况返回 `degraded` 或 `unsupported`。

Protocol-1 的实现矩阵与 vNext 候选映射分别记录在
[adapter-matrix.md](adapter-matrix.md)。vNext capability report 将 Guidance、
PermissionPolicy、Runtime Hook event/blocking/managed/local-cloud、Audit delivery 和
Sub-agent 分开报告，不再用单一 `Rules/Hooks` 状态概括。

### 8.2 生成文件所有权

XForge CLI 必须记录每个生成文件的：

- 来源资源；
- 目标工具；
- XForge CLI 与文件协议版本；
- 内容摘要；
- 上次安装内容摘要。

当目标文件与上次生成摘要不一致时，默认视为人工修改并报告冲突，不得覆盖。资源禁用后，`install` 只删除当前内容仍与已知生成摘要匹配的文件。

### 8.3 最小依赖原则

- 使用文件系统，不引入数据库；
- 使用 JSON Schema 或等价静态 Schema 校验文件协议；
- 不启动本地服务；
- 已解析工具和依赖可用时，`state`、`install`、`check`、`archive` 不依赖网络；
- 外部命令只由显式 Script、Gate 或 Hook 配置触发；
- 核心逻辑应可作为库测试，CLI 只做参数解析和呈现。

---

## 9. 安全与企业约束

### 9.1 文件安全

- 所有写路径必须经过项目根目录包含检查；
- 必须防止 `..`、绝对路径和符号链接逃逸；
- 写操作先计算计划，再执行；
- 对多文件写入使用临时文件和可恢复策略；
- 不执行面向整个用户目录或文件系统根的清理；
- 不覆盖未管理文件。

### 9.2 XForge CLI 来源和供应链

- 正式项目只从批准的 npm Registry 安装精确 `@xforge/cli` 版本；
- npm 发布包必须同时包含精确配套的 CLI、Schemas 和 Scaffold；
- `xforge init` 必须复验包内 Scaffold inventory、摘要、版本和 Protocol；
- 企业可以限制允许的 npm Registry、scope、包名和版本；
- Lockfile 必须保存 XForge CLI 与 Scaffold 的 npm 来源、版本、完整性摘要和协议版本；
- CLI 实际身份与 Manifest/Lockfile 不一致时，任何写操作必须失败；
- 不支持 source checkout、本地 tarball、Git/HTTP Scaffold 或浮动 `npx` 安装；
- XForge CLI 缺失时必须停止，不得静默修改全局运行环境或联网下载替代版本；
- v1 不自动从任意 URL 下载和执行 Skill、Hook 或 Gate；
- 后续可以增加签名和 provenance，但不得阻塞 v1 文件协议稳定。

### 9.3 命令执行

- Gate 和 Hook 使用参数数组，避免隐式 Shell 拼接；
- 如确实需要 Shell，必须显式 `shell: true` 并提升风险等级；
- 必须支持超时、工作目录和输出大小上限；
- 默认不传递未声明 Secrets；
- 输出落盘前应支持基本敏感信息遮蔽；
- 高风险 Hook 默认要求用户批准。

### 9.4 规则与门禁的真实性

系统必须区分：

- “Agent 被告知遵守规则”；
- “存在可执行检查”；
- “检查已经运行”；
- “检查成功且证据有效”。

只有最后一种可以形成通过门禁的结论。

---

## 10. v1 实施范围

### 10.1 必须交付

1. 单一 XForge 仓库及 `scaffold/`、`xforge/`、`docs/` 一级边界；
2. 唯一的 `scaffold/`、`scaffold.yaml` 和可直接本地化的 `payload/`；
3. 同时包含 CLI、Schemas 和 Scaffold 的单一 npm 精确版本分发；
4. 根目录 `AGENT_INSTALL.md` 和 `docs/bootstrap.md` 的 npm-only Agent 安装协议；
5. `xforge/` CLI 实现，以及 Manifest/Lockfile 驱动的 npm 精确版本解析；
6. 可重定位的 `project.paths.specs` 与 `project.paths.changes`；
7. 项目初始化、状态、投影、检查与归档命令，包括 `init`；
8. 默认 JSON 与 `--text`；
9. Manifest、Constitution、Flow、Agent、Gate 等基础文件 Schema；
10. Claude、Codex、Cursor、OpenCode、GitHub Copilot 五种 Adapter；
11. managed-only 文件所有权和冲突保护；
12. Change 结构检查、Gate 执行、Evidence 输出；
13. Spec 同步和归档；
14. 一级 `scripts/` 规范、TypeScript 默认执行路径和 Python 可选路径；
15. `install` 到五种 AI 编程工具默认项目目录的映射；
16. `quick.yaml`、`solid.yaml`、`prime.yaml` 三个 Flow 文件，以及五个 OpenSpec 启发的初始工作流 Skills；
17. Constitution 治理、版本和优先级检查；
18. Portable 与 Managed 两种能力说明；
19. 八字段工作包 Schema、delivery Evidence、DAG/路径/commit 检查和三种默认子 Agent；
20. 单元测试、集成测试和最小示例项目。

### 10.2 延后交付

- Web UI；
- 企业中心服务；
- 公共/私有 Registry；
- 自动升级机器人；
- 复杂 Policy 运行时；
- Flow 继承和组合；
- 通用多 Agent Runtime；
- 五种目标之外的 AI 工具 Adapter；
- 跨仓库任务路由；
- 云端审计和组织级统计。

---

## 11. 开发里程碑

### M0：协议和样例

- 建立单一 XForge 仓库及 `scaffold/`、`xforge/`、`docs/` 边界；
- 固定 Scaffold metadata、项目目录和 Manifest v1alpha1；
- 编写并测试 `docs/bootstrap.md`；
- 定义 `quick.yaml`、`solid.yaml`、`prime.yaml` 三个 Flow golden files；
- 定义五个初始 Skills，并记录与 OpenSpec 的参考关系和差异；
- 创建示例项目和 golden files；
- 定义 Constitution、Flow、JSON Envelope、诊断 code 和 Adapter 接口。

### M1：只读基础

- 实现 Project Loader、Validator 和 `state`；
- 检查 Manifest 声明的 XForge CLI 版本、Scaffold 和文件协议兼容性；
- 解析默认及自定义 Specs/Changes 路径并执行逃逸、重叠检查；
- 输出 Specs、Changes、Flows、Scaffold 和能力矩阵；
- 完成 JSON/Text 双 Presenter。

### M2：安装闭环

- 实现 npm 包内 Scaffold 与 `init --dry-run`、`init`、`init --target`；
- 实现 `install --dry-run` 和 `install`；
- 构建 npm 包内 Scaffold 与 canonical payload 的相同摘要验证；
- 完成 managed-only 所有权；
- 实现 Claude、Codex、Cursor、OpenCode、GitHub Copilot Adapter；
- 生成并安装五个 XForge 初始 Skills 和各工具薄命令入口；
- 完成幂等、冲突和卸载测试。

### M3：质量与归档

- 实现 `check`、Gate Runner 和 Evidence；
- 实现 `archive --dry-run` 与原子归档；
- 完成失败恢复和安全路径测试。

### M4：企业试点

- 在不少于三个不同技术栈项目试用；
- 验证 Portable/Managed 模式；
- 收集目录、命令和 Adapter 缺口；
- 在保持 Protocol-1 Envelope 稳定的前提下提供完整 CLI 生命周期。

---

## 12. 验收标准

XForge v1 只有满足以下条件才可以发布：

- Agent 能从精确 npm 包完成 CLI 安装、Scaffold 初始化和 Target 投影；
- npm 包内 Scaffold 与 canonical payload 具有同版本、同 inventory、同摘要；
- 脚手架本地化后，项目无需访问 XForge 源仓即可读取和修改规范；
- XForge CLI 缺失时 Agent 会给出精确 npm 依赖，不会回退源码或静默全局安装；
- 声明的工具暂不可用时，项目仍保留完整可读的 Portable 资产，且不得伪造 Managed 结果；
- npm 精确版本能同时锁定并校验 CLI 与 Scaffold 身份；
- 用户代码仓不包含 XForge CLI 源码、缓存或仓库历史；
- `project.paths` 未声明时使用 `xforge/specs` 与 `xforge/changes`；声明为 `docs/specs` 与 `docs/changes` 时，所有状态、检查和归档行为保持一致；
- 非法、逃逸、重叠的 Specs/Changes 路径在任何写入前失败；
- Constitution 缺失、版本非法或与 Rule 冲突时返回稳定诊断；
- Flow 能按 Artifact 顺序和 `requires` 计算下一步，并把上下文交给工作流 Skill；
- `quick.yaml`、`solid.yaml`、`prime.yaml` 三个 Flow 文件的 Artifact graph、Apply 前置和 Archive Gates 均有 golden tests；
- 带安全、隐私、公共 API 或数据迁移标记的 Change 不能使用 `quick`；
- 五个初始 Skills 均能通过同一 `state` 协议驱动三个 Flow，不包含重复状态机；
- Manifest 声明的项目 module、Change scope 和路径作用域可以被一致解析；
- 工作包只接受八个规范字段，DAG 环、未知依赖、缺失输入/Skill、scope 越界和依赖独立节点的写路径重叠均返回稳定诊断；
- Worker delivery 的 base/head commit、实际 Git diff、声明 changed paths 和 write paths 可以被一致核对；
- `check --change` 重新执行工作包 `verify` 并保存受限、脱敏 Evidence，不能仅凭 Agent 自报通过；
- 默认子 Agent 固定为 worker、integrator、reviewer，Main Agent 承担 Coordinator；
- 四个命令默认只输出一个有效 JSON 文档；
- `--text` 与默认 JSON 具有相同语义；
- 连续执行两次 `install`，第二次没有非预期变更；
- `install` 不覆盖人工修改或未知文件；
- `install` 在未指定自定义路径时使用目标 AI 编程工具的默认项目目录；
- 资源移除只删除 XForge 管理且摘要匹配的文件；
- 不支持的 Agent/Hook 能力被明确标记为 `degraded` 或 `unsupported`；
- mandatory Gate 失败时无法归档；
- Gate 结果可以追溯到命令、时间、退出状态和当前 Change；
- `archive --dry-run` 零写入；
- `archive` 能同步 Specs、保存证据并移动 Change；
- 路径逃逸、符号链接逃逸和恶意资源名测试全部通过；
- 五种 Adapter 都有 golden fixture 和安装路径集成测试；
- 示例项目能够被五种目标工具中的至少两种实际发现生成资产。

---

## 13. AI Agent 开发指示

承担 XForge 实现工作的 AI Agent 必须遵循以下顺序：

1. 先阅读本文档，不从产品名称推测未写明能力；
2. 在实现前把工作拆成小型、可验证的 Change；
3. 优先定义文件协议、golden fixtures 和失败行为，再写 CLI；
4. 核心功能写成可测试库，CLI 保持薄层；
5. 新需求优先通过现有命令的参数或输出扩展解决；
6. 新增顶层命令前必须先提交架构决策并由产品负责人确认；
7. 不实现延后范围中的平台能力；
8. 每次写操作都必须先有只读计划和冲突策略；
9. 不用自然语言输出代替稳定诊断 code；
10. 不把提示词服从误报为强制门禁；
11. 所有跨工具能力都要测试 native/degraded/unsupported 三种结果；
12. 完成实现后更新示例、协议文档、测试和迁移说明。

### 13.1 固定决策

以下决策在 v1 中固定，不得自行调整：

- 产品名为 XForge；
- XForge 使用单一仓库，并以 `scaffold/`、`xforge/`、`docs/` 隔离分发资产、实现代码和文档；
- XForge 上游只维护唯一的官方 `scaffold/`，不设置 `standard/` 子目录，也不为第三方脚手架预留目录；
- 首次安装由用户或 AI Agent 精确安装 npm 包，再运行 `xforge init`；可用 `--target` 在同一步完成一个目标工具的投影；
- 脚手架本地化进入用户项目；
- XForge CLI 源码不进入用户项目，Manifest 的 `xforge` 字段只使用 `@xforge/cli` npm 精确版本固定实现；
- `flows/` 与 `scripts/` 固定在项目 `xforge/` 下；Specs 与 Changes 默认位于 `xforge/`，但可通过 Manifest 重定位；
- `xforge/constitution.md` 保存项目宪法，其稳定原则高于普通 Rules；
- 其他 Agent 资产进入 `scaffold/`；
- Scaffold 本身就是项目资产，不设置模板目录或中间配置层；
- 项目共享程序进入一级 `scripts/`，默认优先使用 TypeScript；
- 官方 Flow 是同一 `xforge/flows/` 目录下的 `quick.yaml`、`solid.yaml`、`prime.yaml`，默认使用 `solid`；
- Flow 采用 OpenSpec custom schema 风格的有序 Artifact、instruction 和 `requires` 模型；
- 初始 Skills 固定为 `xforge-explore`、`xforge-propose`、`xforge-apply`、`xforge-verify`、`xforge-archive`，其工作流模型明确参考 OpenSpec；
- Skills 使用 `SKILL.md` 目录结构，工作流 Skill 通过 `state` 消费 Flow，不复制状态机；
- v1 只支持 Claude、Codex、Cursor、OpenCode、GitHub Copilot 五种 Adapter；
- `install` 根据 Target 安装到各 AI 编程工具的默认项目目录；
- CLI 主要服务 AI Agent；
- CLI 可执行文件和命令前缀统一为 `xforge`；
- JSON 是默认输出，文本使用 `--text`；
- 顶层命令包含用于 npm 内置 Scaffold 初始化的 `init`，其余命令由 CLI help 作为事实源；
- XForge CLI 不为文件资产实现 CRUD 命令；
- 不引入数据库、Daemon、Web UI 和 Registry；
- 不覆盖或删除非 XForge 管理文件。

### 13.2 需要 ADR 的事项

以下实现细节在首次实现前可以通过 ADR 决定：

- TypeScript 编译目标、包管理器和发布工件格式；
- Manifest/资源 Schema 的具体校验库；
- 生成状态文件的精确字段；
- Spec 语义合并的最小算法；
- 五种 Adapter 对 Agents、Rules 和 Hooks 的能力降级细节；
- Evidence 原始日志的截断和外部存储策略。

ADR 不得推翻“精简命令、文件优先、单仓目录隔离、默认 JSON、managed-only 写入”等固定原则。

---

## 14. 设计参考与取舍

XForge 参考以下公开设计，但保持独立产品和文件协议：

- [Git clone documentation](https://git-scm.com/docs/git-clone.html)：使用 `--sparse` 与 partial clone 在项目外仅展开目标脚手架目录；XForge 随后只复制 payload，不把临时仓库元数据带入用户项目。
- [OpenSpec Customization](https://openspec.dev/docs/customization)：借鉴 project-local custom schema 的有序 Artifacts、`requires`、instruction 和生成骨架；XForge 将其发展为一级 `flows/`，并加入 Constitution、Gates 和企业交付语义。
- [OpenSpec: How Commands Work](https://openspec.dev/docs/how-commands-work)：借鉴“项目源资产由 CLI 安装为工具可发现的 Skills/Commands”；XForge 让工作流 Skills 消费统一 `state` 协议，并用 install/sync/update/uninstall 管理项目级投影生命周期。
- [OpenSpec Supported Tools](https://openspec.dev/docs/reference/supported-tools)：借鉴五种目标工具的项目级安装路径；XForge v1 明确只支持 Claude、Codex、Cursor、OpenCode 和 GitHub Copilot。
- [Spec Kit Constitution](https://github.com/github/spec-kit/blob/main/templates/commands/constitution.md?plain=1)：借鉴项目原则、治理、版本和一致性影响检查；XForge 将 Constitution 作为项目事实文件并纳入 Flow、Skill 和 Gate 上下文。
- [XForge Governance Control Plane](governance-control-plane-design.md)：在 OpenSpec、Spec Kit、Kiro、BMAD 与五种目标工具的 Rule/Hook 能力基础上，定义 vNext 的 Rules、PermissionPolicy、双平面 Hooks、Transition、Approval、Gate、Evidence 与 Audit 语义。

以上参考不形成运行时依赖。XForge 不读取 OpenSpec/Spec Kit 项目文件，也不承诺与其命令或 Schema 兼容。

---

## 15. 产品表达

推荐对外描述：

> XForge is a Git-native enterprise framework for governed AI-assisted software development. It localizes specifications, skills, agents, rules, hooks, scripts, quality gates, and delivery evidence into every repository, then installs them safely for the AI coding tools a team chooses.

中文：

> XForge 是面向企业软件研发的 Git 原生 AI Agent 工程框架。它把规格、Skills、Agents、Rules、Hooks、Scripts、质量门禁和交付证据本地化到每个项目，并安全安装到团队选择的 AI 编码工具。

推荐标语：

> Governed AI development, built into every repository.

> 让企业研发规范，不只被阅读，而是被执行。
