# XForge

XForge 是一个 git 原生的控制面，让 AI Agent 在项目里做的每一次改动都走一条有门、有记录、有人把关的流程。

它不写代码、不写文档、不做判断。它做四件事：告诉 Agent 它在哪、欠什么、什么挡着；把跑过的门刻成证据；把人说过的话记进审计链；在条件满足时让状态机走一格。真正推进工作的是 Agent 按 Skill 写文件，人只在审批、署名、确认交付这几个点介入。

## 安装与三步上手

```
npm install -g @xforge/cli
cd <你的项目>
xforge init --flow solid --platform claude      # 建 xforge/ 治理目录，投影 Skill 与执法钩子
```

之后在 Claude Code 里只需要记一个名字：

```
/xforge
```

入口 Skill 会读控制面的定向、写下这次改动的声明、把每一站派给隔离的执行者，直到归档或需要人。人要做的事，控制面会在 `xforge state` 里逐条列出，每条带一个可以直接执行的命令。想自己逐站推进也可以，每一站有自己的 Skill（`/xforge-propose`、`/xforge-design` …），做完一站它会告诉你下一步敲什么。

## 双治理：两条各自独立的基线

XForge 治理的对象是两条基线，机制对称，主题独立，各有自己的开关：

| | 规格基线 | 接口基线 |
| --- | --- | --- |
| 说的是什么 | 产品对外做什么，每条是一个有 id 的 Requirement | 模块之间与对外承诺的接口，每条是 `fn:` `type:` `endpoint:` 这类元素 |
| 谁来改 | 只有归档合并；Agent 在 Change 里写 delta，不许直接改基线 | 同左 |

两个开关组合出四种项目：

| 规格 | 接口 | 适合什么项目 | 一次 Change 欠什么 |
| --- | --- | --- | --- |
| 开 | 开 | 产品与接口都要有人说了算 | 规格 delta + 接口 delta，归档时两条基线都合并 |
| 开 | 关 | 只管产品行为 | 规格 delta |
| 关 | 开 | SDK、基础库、基础设施：行为在别处定义，接口必须守住 | 接口 delta |
| 关 | 关 | 只要流程与门，不要基线 | 无 delta，也不做保证层 |

开关在 `xforge/manifest.yaml` 的 `governance` 里，随时可改；关着的那条，对应的产出与门都是「不欠」，不会变成待办。保证层（基线门、`verify` 站的保证说明）随任意一条基线打开，不单独开关。

## 一次 Change 怎么走

三条流程按风险等级选，同一序列的三种长度：

| 流程 | 风险 | 站 |
| --- | --- | --- |
| `quick` | low | propose → apply → verify |
| `solid` | low、medium | propose → design → check → apply → verify |
| `major` | 全部 | propose → clarify → design → check → apply → verify |

每一站有它欠的产出与台账、要过的门、出站条件。门有七道：结构、台账受理、章程、规格 delta、接口 delta、接口兼容、项目自己声明的验证命令。门跑过就刻下运行记录并绑定输入的内容修订，输入一变记录就过期。

apply 站按工作包派工：每个包有自己的写入路径与验证门，交付记录由执行者以执行 id 署名；验证门当前且通过、改动路径与工作树一致，登记交付就是集成，没有人逐包确认。

人介入的点只有三类：给台账条目署名（评审发现、章程答复、验证收据）、审批、声明验证命令。审批点按流程定：quick 只有终局，solid 加 check 出站，major 再加 clarify 出站。审批绑当时的内容修订，批完再改产出，审批作废要重批。

## 五个动词

| 动词 | 做什么 |
| --- | --- |
| `xforge state [--orient]` | 我在哪、欠什么、什么挡着；`--orient` 追加这个项目与这一站的定向，就是执行者的简报 |
| `xforge show <ref>` | 点名取一段材料：一个二级标题、一条基线条目、一次门输出、一份台账 |
| `xforge inspect` | 这份记录合法吗：receipt 链、审计链、署名、索引、投影，不写盘不跑命令 |
| `xforge run` | 跑门，刻下结果 |
| `xforge attest` | 人说的话：审批、给台账条目署名、签验证收据、声明验证命令 |
| `xforge advance` | 让状态机走一格：出站、返工、派工、交付登记、归档 |

每条命令回一个 JSON 信封，退出码 0 成功、1 被挡、2 用法错、3 记录损坏。`--text` 给人看，`--field` 只取一段。

## 写入范围由执法守着，不靠提示词

进站时方案的作用域、派工时包的路径被投影成策略，执法钩子在每次写文件前按工作目录找到在途的投影，不在范围内就拒绝。治理目录本身由分发策略保护：证据只有控制面写，基线只有归档写。Skill 里的「边界」是提示，一段散文永远不能扩大可写范围。

## 审批可以由 MCP 给

在 `xforge/manifest.yaml` 里配一个 MCP 审批服务，`xforge attest approve --stage check --via <id>` 就把这次审批交给它：控制面把项目 git 地址、Change、站、当时的修订、请求者的 git 身份和材料引用发过去，它回 approved 或 rejected。MCP 批了就是同意，与人批是同一种审计事件，人数、职责分离、修订绑定、`inspect` 一视同仁，事件上多记 `via`、请求者与答复摘要。流程的审批策略可以规定哪些点只许人批、哪些点许 MCP 批。MCP 内部怎么审不是控制面的事。

## 署名可引用不可编造

审批、署名、确认都写进 `xforge/.audit/chain.jsonl`，身份从 git 读，命令行没有参数能覆盖。台账里的署名必须与审计链里的登记逐字相等，`inspect` 会核对；改一个 receipt，`inspect` 立刻报链断。

## 多个实现方案

一个 Change 可以有多个实现方案，典型是双路开发：一个方案写实现，另一个从同一份规格出发写黑盒测试。规格侧共享，实现侧各在 `changes/<id>/<方案>/` 下，各有自己的状态机与门记录。每个方案在自己的 git worktree 里推进，会话设两个环境变量即可，Skill 不用改：

```
XFORGE_ROOT=<主检出目录>  XFORGE_SCHEME=<方案 id>
```

不给方案 id 就是默认方案，目录与行为和单方案项目完全一样。归档是 Change 级，先归档的方案赢。

## 宿主

`claude`：Skill、执行者子 Agent、执法钩子全部投影。`codex`：投影 Skill，没有钩子也没有隔离，定向里会明说 `enforcement: unavailable`。

## 读什么

| 想知道 | 看 |
| --- | --- |
| 概念、对象与不变量 | `docs/concepts-and-architecture.md` 及命令行、脚手架规则文件、Skill 三份分文档 |
| 每种文件长什么样 | `docs/design/rule-files.md` |
| 每个命令做什么、回什么 | `docs/design/cli.md` |
| Skill 与执行者怎么组织 | `docs/design/skills.md` |
| 真实模型怎么测 | `docs/design/live-test.md` |

## 开发

```
npm ci
npm test            # typecheck + build + unit / integration / product
npm run test:live   # 真实模型，手动跑，不进合并门
```

每个源文件第一行是它依据的设计章节；设计文档是代码的依据，改行为先改设计。
