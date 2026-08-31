# XForge CLI 用法

> 命令参考。**概念与机制**见 [概念与架构](concepts-and-architecture.md)，
> 这份只讲「有哪些命令、接什么参数、返回什么」。
>
> 对应实现：`@xforge/cli 0.7.21`、Protocol 2。
> 本文档以 `xforge/src/cli.ts` 的命令表为准；有出入时以 `xforge help --text` 为准。

---

## 1. 怎么调用

**XForge 的命令是给 AI 编程 Agent 用的，不是给人临时敲的。**
人或 CI 只做一次性安装；此后每一次操作都是 Agent 按已安装的 `xforge-*` Skills 运行 `xforge ...`。

两种调用形式，**沿用你项目已经在用的那一种，不要来回改写**：

```bash
xforge <command> ...                 # 全局安装
npx --no-install xforge <command>    # 项目本地安装（可执行文件在 node_modules/.bin，不在 PATH 上）
```

> ⚠️ **绝不要退回到 `npx xforge`。** npm 上有一个同名的无关包，npx 会把它拉下来运行。
> 找不到 `xforge` 命令时**停下并报告**，不要为了绕过「命令不存在」而自行安装 CLI——
> 本项目运行哪个版本，是记录在 `xforge/manifest.yaml` 里的决定，不是在 shell 里临时做的决定。

---

## 2. 通用约定

### 2.1 只有选项，没有位置参数

项目根目录来自 `--root <path>`，**绝不是位置参数**。唯一的位置参数是子命令
（`audit status`、`transition repair`、`work-package dispatch` 这一类）和 `help <command>`。

- 未知选项 → `XFORGE_OPTION_UNKNOWN`
- 重复同一个选项 → `XFORGE_ARGUMENT_DUPLICATE`
- 选项缺值 → `XFORGE_OPTION_VALUE_MISSING`

`--help` 与 `--version` 是快捷方式，不能同时使用。
**裸跑 `xforge`（不带任何参数）会直接打印帮助**——敲一个工具的名字就是在问它能做什么；
但 `xforge --text` 或 `xforge --root x` 属于格式错误的调用，仍然会失败，
这样脚本不会把它误认成一次成功运行。

### 2.2 一个 JSON 信封

所有普通命令返回**恰好一个** Protocol 2 信封：

```json
{
  "protocolVersion": "2",
  "ok": true,
  "command": "state",
  "root": "/project",
  "data": {},
  "diagnostics": [],
  "changes": [],
  "nextActions": []
}
```

加 `--text` 得到人类可读视图，**不改变语义与退出状态**。
需要程序或 Agent 消费结果时用默认的 JSON。

两个命令有专门的文本渲染：`state`（项目与 Change 摘要）与 `upgrade-scaffold`（合并计划）。
唯一不返回信封的是 `hook dispatch`——它要往 stdout 写目标平台要求的 Hook 响应 JSON。

### 2.3 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 失败（`ok: false`），或 `--field` 未命中 |
| `2` | **仅 `hook dispatch`**：`before` / `permission` 类事件的 deny。`after` 类事件失败返回 `0`，以免破坏平台自己的记账 |

---

## 3. 命令一览

| 命令 | 读 / 写 | 作用 |
| --- | --- | --- |
| `help` | 读 | 通用或单命令帮助 |
| `version` | 读 | CLI / protocol / runtime / build 身份 |
| `init` | 有条件写 | 校验内置 Scaffold，初始化项目，可选投影到一个目标 |
| `state` | 读 | 解析后的项目与 Change 状态 + typed `nextActions` |
| `install` | 写 | 首次或幂等的目标投影 |
| `sync` | 写 | 增量同步本地化的 Scaffold 改动 |
| `update` | 写 | 完整调和目标、身份与 Adapter 输出 |
| `uninstall` | 写 | 摘要安全地移除受管文件 |
| `check` | 有条件写 | 结构诊断 + 真实的 Gate Evidence |
| `verification` | 写 | 声明本项目怎么跑 declared Gate；起草验证 receipt |
| `findings` | 写 | 记录某条 Check finding 的答案并置为 resolved |
| `transition` | 写 | 受保护的 Stage 转换；`repair` 丢弃一张叶子回执 |
| `approve` | 写 | 交互式本地审批或 mcp provider 审批 |
| `review` | 写 | 无工作包计划时记录 Change 级复核 |
| `work-package` | 写 | 派工 / 起草交付 / 确认集成或复核 |
| `audit` | 读 / 有条件写 | 审计链的检视、校验、导出、重投递、修剪 |
| `archive` | 写 | 校验、合并 Specs、原子归档 |
| `upgrade-scaffold` | 写 | 暂存并分类新版受管树供人合并；完成 / 回滚时自己重新投影 |
| `doctor` | 读 | 报告未被引用与悬空的扩展资源 |
| `hook` | 内部 | 平台 Hook 分发器 |

---

## 4. 认识与诊断

### `help` / `version`

```bash
xforge help [command] [--text]
xforge version [--text]
```

`version` 同时给出版本和 **`executablePath`**——那是区分陈旧全局安装
与遮蔽它的项目本地安装的关键。

### `state`

```bash
xforge [--root <path>] state [--change <id>] [--kind <kind>] [--target <target>] [--text] [--field <path>]
```

读取解析后的项目与 Change 状态。**`state.nextActions` 是推进 Change 的权威**——
不要背命令序列。

#### `--field`：取单个值，不要 grep

```bash
xforge state --change <id> --field change.governance.revision.contentRevision
xforge state --change <id> --field change.governance.readyTransitions.0.to
```

`--field` **只打印一个值、不打印别的**，所以 `$(xforge state --field ...)` 是安全的。

#### `--text`：要点清单，不是 JSON 转储

`state` 的 `data` 是整个解析后的项目，在受治理的 Stage 上打印成 JSON 有五万字符量级。
`--text` 因此渲染成要点清单：当前 Stage、内容 revision、下一个 Artifact、
mandatory Gate Evidence（跑了什么命令、是否绑定当前内容 revision、之后源码动了几个文件）、
可用的 Transition 及其 blockedBy、待办审批、审计链摘要。

它**只改变呈现**——JSON 信封原样不变，机器读者用 JSON 或 `--field`，不要读这个。
清单末尾会明说**没有显示什么**以及怎么拿到。这条改动的直接动因是：
一次实测里 `xforge state --change <id>` 已经在 `nextActions` 里给出了完整的
`xforge approve ... --for archive --policy <id>` 命令，但它排在四万多字符的 JSON 之后，
操作者据此认为 CLI 没有给出审批命令。

> ⚠️ **不要用 grep 从 JSON 里挑值。** `contentRevision` 在 `xforge state` 里
> 每一份历史回执下都出现一次，`grep -m1` 会把一个**已被取代的** revision 当成当前值报出来
> ——一次实测就是这样对着旧值手写了一份 receipt。
>
> 未命中时 `--field` **大声失败**（`XFORGE_FIELD_NOT_FOUND`，退出码 1）而不是打印空行：
> 一个看起来像值的空捕获，正是这个选项要消灭的失败模式。

### `check`

```bash
xforge [--root <path>] check [--change <id>] [--gate <id>] [--stage <id> | --all-gates] [--force] [--text]
```

校验项目结构、work-package 交付，并运行**当前 Stage 要求的那一组 Gate**。

> **必须在最后一次写入之后、一次性运行。** Gate Evidence 绑定运行当刻的 `contentRevision`：
> 先跑一个 Gate、再改 Artifact、再跑下一个，会让先跑的变陈旧——
> 结果是所有 Gate 都报 `passed`，Stage 却仍然出不去。

`--all-gates` 会连 Change 尚未到达的 Stage 的 Gate 一起跑，**那些不可能通过**，中途一般不需要。

**开销**：不带任何 Gate 选择时，`check` 还会执行**每个工作包声明的全部 `verify` 命令**——
一个十包的计划就是几十条外部命令、数分钟墙钟时间，从命令名完全看不出来。
用 `--gate <id>`、`--gate stage:<id>`、`--stage <id>` 或 `--all-gates` 中任意一种收窄，
都只跑选中的 Gate 并跳过工作包 verify；Verify 阶段只想重跑三个 mandatory Gate 时，
`--stage verify` 就是那条路。四种写法在这一点上行为一致，
输出里的 `workPackagesSelected` 明说这一趟跑没跑工作包。

`check` 还会**把 delta Spec 与主 Specs 比一次**，回答「这份 delta 能不能合并进去」：
每条 `MODIFIED` / `REMOVED` / `RENAMED` 指名的 Requirement 在主 Specs 里是否定位得到。
标题就是合并键，所以**改了标题的 MODIFIED 块结构上完全合法、却定位不到它要改的那条**——
诊断会顺带指出主 Specs 里引用同一编号的那条标题。

> **为什么这条必须在 `check` 做**：`archive` 在任何治理阻塞存在时**会在计算合并计划之前返回**，
> 而「还没过渡到 ready-to-archive」和「收尾审批还没拿到」都是治理阻塞。
> 也就是说 `archive --dry-run` **结构上不可能**用来提前问这个问题——合并计划只在其余一切都通过后才算。
> 一次实测的 Major 因此在 `closing-major` 已签之后才撞上 `XFORGE_SPEC_MERGE_CONFLICT`，
> 而唯一的退路 `transition repair` 会作废那次审批。
> `check` 里这条是必要不充分的：别的 Change 可能先归档并改动同一份主 Specs，所以 `archive` 仍然会重判一次。

**当前 Stage 一个 Gate 都不声明时**（`solid` 的 design / apply、`quick` 的 apply），
返回的是 `gates: []` 且 `ok: true`——这是如实报告，不是「Gate 都过了」。
这种情况下 `check` 会额外给一条 `XFORGE_CHECK_NO_GATES_AT_STAGE`（info）说明这一点：
结构校验跑了，其余什么都没跑。

### `doctor`

```bash
xforge [--root <path>] doctor [--kind <kind>] [--strict] [--text]
```

报告悬空引用与未被引用的扩展资源。**默认只警告，从不阻塞**；`--strict` 让它成为失败。

Flow 漂移会报成两条不同的 `info`，因为修法不同：

- `XFORGE_DOCTOR_FLOW_VERSION_DRIFT` —— 本地版本落后出厂版本。常见情形，
  跑 `xforge upgrade-scaffold` 会把出厂 Flow 暂存到 `xforge/.upgrade/incoming/flows/`，由你决定是否采纳——
  Flow 规定了一个 Stage 需要几个审批、blocker 把工作退回哪里，所以它只被**带来**，不会被替你采纳。
- `XFORGE_DOCTOR_FLOW_CONTENT_DRIFT` —— **版本号相同但内容不同**。要么是有人就地改了 Flow
  却没动版本号，要么它来自一个用同一编号发出不同内容的构建。**只比版本号看不见这一种**，
  而两边号一致，所以其它任何检查也不会提它。

`--kind` 取值（**单复数都接受**）：

```text
skills  agents  rules  policies  hooks  gates  scripts  flows  approvals  mcp-servers
```

---

## 5. 安装与投影

### `init`

```bash
xforge [--root <path>] init [--language <en|zh-CN>] [--target <target>] [--dry-run] [--text]
```

`--language` 覆盖语言检测。**只有在交互式终端里才能省略**（它会问你）；
非交互运行以 `XFORGE_LANGUAGE_REQUIRED` 失败关闭，而不是替你选——
因为 Constitution 和 Agent 会读的每一个 Skill 都用这里选的语言书写。

`--target` 取值：`claude` · `codex` · `cursor` · `opencode` · `github-copilot`。

- 没有 `xforge/` 的项目用 `init`；已经有的用 `install`
  （在未初始化目录上 `install` 会报 `XFORGE_PROJECT_NOT_FOUND`）。

### `install` / `sync` / `update` / `uninstall`

```bash
xforge [--root <path>] install   [--target <t>] [--adopt] [--dry-run] [--text]
xforge [--root <path>] sync      [--target <t>] [--adopt] [--dry-run] [--verify-digests] [--text]
xforge [--root <path>] update    [--target <t>] [--adopt] [--dry-run] [--text]
xforge [--root <path>] uninstall [--target <t>] [--force]  [--dry-run] [--text]
```

| 命令 | 什么时候用 |
| --- | --- |
| `install` | 首次投影，或幂等地调和已选中的资产。省略 `--target` 时投影 Manifest 里启用的每一个目标 |
| `sync` | 编辑了 `xforge/scaffold/` 或改了 manifest 的选中项之后 |
| `update` | 目标、Scaffold / CLI 身份或 Adapter 输出发生变化时 |
| `uninstall` | 移除某一个目标的受管文件；摘要不匹配时拒绝，除非 `--force` |

**`--adopt` 的语义要说清楚：** 它把一个**被手工改过、但 XForge 已经拥有**的目标文件
重新基线到生成内容上。它是刻意 opt-in 且刻意狭窄的——**只覆盖安装记录里已有的目标，
绝不采纳一个不在记录里的文件**。它存在是因为：一个被手改过的受管文件会卡住其它所有文件的同步，
而在此之前唯一的出路是手工把那个文件还原回去。

`--verify-digests`（仅 `sync`）会核对已安装文件的摘要。

> **`xforge update` 不升级 Scaffold**，它把你**已有的** Scaffold 重新投影一遍。
> 换掉 Scaffold 本身的是 `upgrade-scaffold`。

### `upgrade-scaffold`

```bash
xforge [--root <path>] upgrade-scaffold [--complete | --rollback] [--with-active-changes] [--allow-dirty] [--force] [--dry-run] [--text]
```

把这个 CLI 附带的受管树**暂存**到 `xforge/.upgrade/incoming/`，逐文件分类，供人或 Agent 合并。
**它从不替你合并。** 这不是胆怯，而是可计算与需判断的边界正好落在这里：
哪些文件不同是算术；一个项目自己写进 Skill 的措辞该不该让位给更新的默认值，
是关于这个项目意图的问题——替你回答它，等于把 Scaffold 存在的意义（邀请你改它）覆盖掉。

**受管树有三棵**：`xforge/scaffold/**`、`xforge/flows/**`、`xforge/scripts/**`。
三棵一起快照、一起比对、一起恢复。Script 与 Flow 一样是一等资源源，只是不住在 `scaffold/` 里面。

#### 三个时刻

一次由别人完成的合并，缺任何一个时刻都不安全：

| 时刻 | 命令 | 做什么 |
| --- | --- | --- |
| **stage** | `upgrade-scaffold` | 先拍快照 → 暂存新版 → 分类 → 立哨兵。`xforge/scaffold/` 下不会有任何改动 |
| **complete** | `--complete` | 清掉 `.upgrade/`、推进 Scaffold 版本锚点、**重新投影**、写 `upgrade-log.md`、撤哨兵。这是「合并后基线」唯一存在的时刻 |
| **rollback** | `--rollback` | 从快照整树恢复、退回版本锚点、**重新投影**、撤哨兵。完成之后又有新工作时它会拒绝——没有 complete 记下的那份基线，它根本看不出有新工作 |

#### 磁盘上的东西

| 路径 | 是什么 |
| --- | --- |
| `xforge/.upgrade/incoming/` | 新版 `scaffold/` `flows/` `scripts/`，按它们该去的相对位置摆好 |
| `xforge/.upgrade/snapshot/` | 暂存前的受管树整树。**只有一份**，它是回滚点 |
| `xforge/.upgrade/state.json` | `fromVersion` / `toVersion`、暂存与完成时间、提交 id、前后摘要 |
| `xforge/.upgrade/plan.json` · `plan.md` · `MERGE.md` | 分类结果：机器一份、人一份、交给 Agent 的合并提示一份 |
| `xforge/UPGRADING.md` | 在途哨兵，刻意可见 |
| `xforge/upgrade-log.md` | 追加式历史，跨完成与回滚存活 |

**目录名里不带版本号。** 同时只可能有一次升级在途，是哪一次由 `state.json` 里的
`fromVersion` / `toVersion` 回答，那是记录该待的地方，不是目录名。

`xforge/.upgrade/` 整个 gitignored——CLI 暂存时往里写一份 `.gitignore`，
与 `xforge/.audit/` 同法。`xforge/UPGRADING.md` 则**不是**：
一次没走完的升级应当在目录列表和 `git status` 里都扎眼。
它存在期间，`doctor`、`state`、`check`、`transition` 都会给出警告——
在一半的合并上继续推进一个 Change，是要被告知的。

#### 选项

| 选项 | 作用 |
| --- | --- |
| （无） | 快照 + 暂存 + 分类 + 立哨兵 |
| `--complete` | 合并完成后收尾：推进版本锚点、重新投影、记账 |
| `--rollback` | 恢复到暂存之前并重新投影。**只保留一份快照**（本次暂存时拍的那份） |
| `--with-active-changes` | 接受「在有未归档 Change 的情况下升级」 |
| `--allow-dirty` | 接受「受管路径有未提交改动」，并把「这次没有提交兜底」记进 `state.json` |
| `--force` | 升级完成后受管树又变过，仍然回滚 |

#### 两道拒绝

> **有未归档 Change 时拒绝**（`XFORGE_UPGRADE_ACTIVE_CHANGES`）：
> 那些 Change 剩下的 Stage 会在它们的 Design 从未见过的 Gate 与 Skill 下运行。
> 这是一个关于工作的决定，所以它停下来点名。`--with-active-changes` 是接受这个后果，不是消除它。
>
> **受管路径有未提交改动时拒绝**：`stage` 只对那三棵受管树和 `xforge/manifest.yaml` 跑一次 `git status --porcelain`。
> 干净——记下当前 HEAD 的提交 id；脏——要求你**先提交**；`--allow-dirty` 放行，
> 代价是这次升级没有提交兜底，`state.json` 会如实记下这一点。
> 不是 Git 工作树时不记提交 id，直接落到快照这一条路上。

#### 提交是兜底，快照仍是正路

`--rollback` 恢复的**永远**是快照。记下过提交 id 时它多做一件事：把那条按路径限定的
Git 命令**打印**出来，作为手工退路——

```bash
git restore --source=<记下的 HEAD> -- xforge/scaffold xforge/flows xforge/scripts xforge/manifest.yaml
```

**它自己绝不执行这条命令。** 一次升级被授权改写的只有那三棵树与版本锚点的当前内容；
替你跑一条从历史里取版本的 Git 命令，是它没有拿到的授权。把命令摆在你面前，决定权还在你这边。
提交 id 同时写进 `xforge/upgrade-log.md`，与暂存 / 完成时间戳并排——
事后要回答「那次升级是从哪个提交出发的」，看的是这里。

#### 完成与回滚自己重新投影

`--complete` 与 `--rollback` 都会在收尾时把投影重跑一遍，**不需要你再手动 `xforge install`**。

投影是纯函数：源 × Manifest × Adapter 版本。既然算得出来就不必快照它——
**回放比保存便宜，而且不会保存到一份过期的**：合并动过源，快照下来的投影就是错的。
以前 `--rollback` 只还原源，然后叫你「跑 `xforge install` 重新投影」，
结果是在有人想起来之前，项目一直自相矛盾：源已经退回旧版，
`.claude/` / `.codex/` 等投影和 `lock.yaml` 还停在新版。

收尾之后仍然建议跑一次 `xforge doctor`；**`xforge install` 不再是其中一步。**

---

## 6. Change 生命周期

### `transition`

```bash
xforge [--root <path>] transition --change <id> --to <stage> [--dry-run] [--text]
xforge [--root <path>] transition repair --change <id> --receipt <receiptId> [--dry-run] [--text]
```

评估并记录一次受保护的 Stage 转换。未满足的门会出现在
`state.governance.readyTransitions[].blockedBy` 里。

**`repair` 不是 `--force`：** 它丢弃一张已记录的转换回执，把 Change 退回该转换离开的 Stage，
并把「丢弃了什么」记入审计链。**只有叶子回执可以丢**——被后续回执链接的回执是承重的，会被拒绝。
归档审批会随之失效，因为审批绑定的是它被给予时的内容。

这也是 `ready-to-archive` 卡住时的出路：那是一个**合成 Stage**，不在 `flow.stages` 里，
所以没有任何合法的前进或返工目标。

### `approve`

```bash
xforge [--root <path>] approve --change <id> --for <transition-id|archive> \
       [--policy <id>] [--provider <mcp-provider-id>] [--dry-run] [--text]
```

**只有两种审批机制**：CLI 自己的交互式终端（`local`），或 manifest 里登记的 `mcp` provider。
没有第三种。

> ⚠️ **`--for` 填的是该审批所解锁的那次 transition 的 id**（Flow 里的目标 Stage id，
> 或字面量 `archive`），**不是 `stage` 这类字面词**。
> **一律从 `state.nextActions[].command` 里原样取**，不要照 usage 自己拼。
>
> `XFORGE_APPROVAL_TRANSITION_UNKNOWN` / `_UNAPPROVABLE` 表示参数错了**且什么都没写入**
> ——改参数，不要重跑，更不要再请人签一次。

`--actor` / `--role` / `--reason` / `--decision` / `--attestation human` **只是预填建议**，
不是权威值：本地审批必须在**真实 TTY** 里由 CLI 自己的 `readline` 对话现场问出来。

`--dry-run` **不需要终端、也不惊动审批人**，就能把参数先校验一遍。

遇到 provider 配置类错误要**停止，不要对同一个 provider 反复重试**：

```text
XFORGE_APPROVAL_PROVIDER_FORBIDDEN     XFORGE_APPROVAL_MCP_SERVER_MISSING
XFORGE_APPROVAL_MCP_TOKEN_MISSING      XFORGE_APPROVAL_MCP_CONNECTION_FAILED
```

**provider 未配置，不是决定仍在等待。**

### 审批前的核对：`check` 的 `XFORGE_RECONCILE_*`

`xforge check --change <id>` 在跑 Gate 的同时，会比对这个 Change 的**记录**与它的**文件**，
把每一处差异作为一条 `info` 诊断报出来（RC-1 至 RC-5）：

- 台账说某条 finding 已解决，而它所引的 Requirement 不在它所引的 Artifact 里
- 某条 Requirement 没有被这个 Change 的任何其它 Artifact 引用
- 某条 Requirement 不在 Flow 声明的覆盖段里
- 某处「留到后面再说」没有任何 finding 承接
- Constitution 台账引用的 Gate 在当前 revision 下没有通过的证据

**每一条只陈述差异，从不判断它是不是问题**——这是它能被审批人直接读、
而不至于被当成噪声或当成阻断的原因。同一次运行的 `nextActions` 里，
还会为每一条等待人回答的 finding 附上填好 id 的 `xforge findings resolve` 命令。

> 这些规则原本印在 `xforge brief` 里。那份文档长到 36KB、要求逐字转交，
> 于是必须整篇穿过模型的上下文才能到达一个人手里——既不是它当初的设计目标
> （一屏、每轮一次），也不是模型该替人搬运的东西。它的其余部分已删除；
> 这一部分留下来了，因为它本来就只有 1–3KB，而且每一条都可以直接行动。

### `findings`

```bash
xforge [--root <path>] findings resolve --change <id> --id <finding-id> \
       --answer <what was decided> --by <person> [--dry-run] [--text]
```

记录某个人对**一条** Check finding 的答案，并把该条置为 `status: resolved`。

它补的是一个**授权缺口**，不是便利性缺口：`xforge check` 在每个 Stage 都会列出
「记录答案并把该条设为 `status: resolved`」，而 Check Stage 结束之后，**没有任何被授权的执行者能做这件事**
——`xforge-check` 拥有 `evidence/check-findings.yaml` 但只在 Check 运行；
`xforge-verify` 的权限止于 assurance 与验证 receipt；
`xforge-revise` 覆盖 Proposal / Specs / Clarifications / Design，且明确排除 Check 报告。

四条边界：

- **只有一个状态转换**：open → resolved，且条目必须已存在。没有 `findings add`，不能改 severity，不能重开。
  写 finding 仍然是 Check Stage 的事，仍然手写。
- **`--answer` 必填且会被写入条目**。只翻一个状态位、不记录决定了什么，正是这个台账要防的失败。
- **`--by` 要对得上本 Change 记录的身份**（receipt 上的审批人或 Git author，
  与 `check-findings` Gate 对 blocker 的 `resolvedBy` 同一条标准）。Agent 可以**引用**决策人，不能**发明**决策人；
  和 `verification declare --by` 一样，「不得代替用户回答」这一条靠 Skill 文本守着。
- **在代价高的位置直接拒绝**：Change 已处于 `ready-to-archive` 时命令报
  `XFORGE_FINDINGS_STAGE_CLOSED` 并指向 `archive --dry-run` / `transition repair`，
  因为那里的写入会让收尾回执变 stale 并使已给出的审批作废。

写入成功后命令会明说自己作废了什么（`XFORGE_FINDINGS_REVISION_MOVED`），
并在 `nextActions` 里给出 `xforge check --change <id>`；已存在验证 receipt 时还会给出重新 draft 的命令。

> 一条非 blocker 的 finding 被标为 resolved 却没有可核对的 `resolvedBy` 时，
> `check-findings` Gate 会报 **warning**（不失败）。只有 blocker 的归属会让该 Gate 失败，
> 这一点没有变——但「只有 blocker 被检查」以前是看不见的，而被指向审批人的条目通常恰恰是 warning。

### `verification`

```bash
# 声明本项目怎么跑一个 declared Gate
xforge [--root <path>] verification declare --gate-name <gate> \
       ( --command '["prog","arg"]' | --not-applicable <marker> --justification <text> ) \
       --by <person> [--module <id>] [--covers '["marker"]'] \
       [--working-directory <path>] [--timeout-seconds <n>] [--dry-run] [--text]

# 退役一条不该再跑的声明（保留记录，停止执行）
xforge [--root <path>] verification retire --gate-name <gate> \
       ( --command '["prog","arg"]' | --not-applicable <marker> ) \
       --by <person> --reason <text> [--module <id>] [--dry-run] [--text]

# 起草当前 Stage 的验证 receipt
xforge [--root <path>] verification draft-receipt --change <id> [--text]
```

**`--by` 是必填的**，因为「一条命令是否真的在验证什么」没有任何机械方式可以判定——
这个字段记录的是**谁回答了这个问题**。

> **绝不手工编辑 `xforge/manifest.yaml`。** 它受 `protected-manifest` 策略管辖，
> 而一次实测里手写该块时缩进少了一级，此后治理 dispatcher 再也读不了 Manifest，
> 于是拒绝了每一次工具调用——包括本可以修复它的那些。
> 这条命令会写好该块、自动填 `declaredAt`，**宁可拒绝也不会产出一份加载不了的 Manifest**。

### 为什么是「退役」而不是「删除」

`declare` 曾经只增不减，而 Gate run **按序执行全部声明**——一条为某个阶段声明的命令，
会在此后每一次 Gate run 上继续跑，唯一的移除途径是手改受 `protected-manifest` 管辖的 Manifest。
一次实测里，为文档阶段声明的 grep 在很久之后仍在每次 `unit-tests` 上执行：
**Gate 成本随项目历史线性增长，而历史恰恰是唯一改不动的东西。**

`retire` **保留条目、停止执行**，并在条目上记下 `retiredBy` / `retiredAt` / `retiredReason`。
不删除的理由和当初 `declaredBy` 必填的理由是同一条：
没有任何机械方式能判定一条命令是否真的在验证什么，所以**决定不再跑它同样是一次判断**，
应当有人能在事后找到它。`--by` 与 `--reason` 都必填。

同一条参数匹配到多条活跃声明时命令**拒绝执行**并要求用 `--module` 指名——
替你挑一条，等于替你撤掉一个你没打算撤的检查。

`draft-receipt` **刻意不产出 `status`，也不写文件**——那个字段是本 Stage
对「这项工作已被验证」的断言，由 CLI 填它，就等于让它替你决定这份 receipt 本身要记录的那件事。
把结果里的 `receipt` 写进 `evidence/verification-receipt.yaml`，只补一行 `status: passed`。

### `review`

```bash
xforge [--root <path>] review acknowledge --change <id> --evidence <path> [--scope <text>] [--dry-run] [--text]
```

记录「本 Change 交付的工作被复核过」，**用于没有工作包计划的 Change**。
按包的形态是 `work-package acknowledge --as reviewer`；**存在工作包计划时这条命令会被拒绝**。

> **没有 `--by`：actor 取自环境。** 一个邀请填写复核者姓名的字段，邀请的是一个编造的姓名。

### `work-package`

```bash
xforge [--root <path>] work-package dispatch    --change <id> --package <id> [--dry-run] [--text]
xforge [--root <path>] work-package draft       --change <id> --package <id> [--text]
xforge [--root <path>] work-package acknowledge --change <id> --package <id> \
                                    --as <integrator|reviewer> --evidence <path> \
                                    [--scope <text>] [--dry-run] [--text]
```

| 子命令 | 作用 |
| --- | --- |
| `dispatch` | 只允许 Apply Stage 的 ready 节点，且**整份计划校验无 error** 后才原子写入派工 receipt |
| `draft` | 回填机器已知的那一半：execution id、两个 commit、`changed_paths`、每条声明的 `verify` 命令与实际退出码。**这些不要手抄** |
| `acknowledge` | 记录集成或复核证据；ack receipt 绑定 `deliveryDigest`，无法被重放到另一份 delivery 上 |

> **复核转录写 `evidence/agents/<package>/review/<execution>.md`**，不要写成
> `evidence/agents/<package>/*.yaml`——那一层是**交付记录**的解析面，
> 写在那里的转录会被当成交付记录校验：一份只读复核在那个信封里没有诚实的 `status`
> （枚举只有 `succeeded|blocked|failed`），也给不出 `changed_paths`，
> 结果要么把已 `succeeded` 的包压回 `blocked`，要么被要求提供它不可能有的 dispatch receipt 与
> `done_when_evidence`。误放时 CLI 会直接报 `XFORGE_WORK_PACKAGE_DELIVERY_SLOT_MISUSED` 指出真正的原因。

`acknowledge` 的 `--scope <text>` 记录**这次确认实际覆盖了什么**，逐字写进回执。
可选，且绝不推断——不写就等于没人说过。
`independentReview` 只问「有没有复核」，一份「我全面复核了这个包」和一份
「我只验了上面列的五条修法」在回执上本来无法区分，而它们的证据强度差很多。

### `archive`

```bash
xforge [--root <path>] archive --change <id> [--dry-run] [--text]
```

在 **plan 和 execution 两次**检查终态治理，重跑强制 Gate，合并 delta Specs，
再执行原子事务。任何中间错误都保持 Change 未归档。

**`archive` 关闭的是一个 XForge Change。** 它不部署应用、不发布版本、
不运行迁移、不授予生产系统访问权限。

---

## 7. 审计

```bash
xforge [--root <path>] audit <status|verify|export|retry|prune> [--change <id>] [--output <path>] [--text]
```

| 子命令 | 作用 |
| --- | --- |
| `status` | 按 eventType 计数、覆盖缺口、待远端投递数量 |
| `verify` | 哈希链完整性 + 该 Change 所属 Flow 要求的事件类型是否齐全 |
| `export` | 完整的脱敏事件列表，供外部审阅（**`--output` 只对它有效**） |
| `retry` | 重投递积压的事件 |
| `prune` | 按保留策略修剪本地链 |

`audit verify --change <id>` 是真正卡住 Archive 的那个命令，**也可直接作为 CI protected check**。
欠账按 Change 计算，避免一个 Change 阻塞另一个。

远端投递靠三个环境变量，这就是全部契约：

```text
XFORGE_AUDIT_ENDPOINT      投递地址（未设置 = 所有事件停在 deliveryState: 'pending'）
XFORGE_AUDIT_TOKEN         Bearer
XFORGE_AUDIT_HMAC_SECRET   HMAC
```

> 归档时出现 `audit:remote-pending` 要**停止**：远端投递被设为 required，
> 而 endpoint 未设置或不可达，`audit retry` 没有可投递的去处。**绝不反复重试。**

---

## 8. 内部命令

```bash
xforge hook dispatch --target <target> --event <event>
```

平台 Hook 分发器，由生成的 Hook 配置调用，**不是给人敲的**。
它往 stdout 写目标平台要求的 Hook 响应 JSON，而不是 XForge 信封——
一个完整的 Envelope 出现在平台的输出通道上，会被读成一个「没有意见的决定对象」，
也就是说一个配置错误的 hook 命令会**静默放行每一次工具调用**。

失败时 `before` / `permission` 类事件退出 `2`（deny），`after` 类退出 `0`。

---

## 9. 典型序列

```bash
xforge state --change <change-id>
xforge check --change <change-id>
xforge transition --change <change-id> --to <next-stage> --dry-run
xforge transition --change <change-id> --to <next-stage>

# 当 state 报告有就绪的工作包时：
xforge work-package dispatch --change <change-id> --package <package-id>

# 当 state 报告需要审批时（命令从 nextActions 里原样复制）：
xforge approve --change <change-id> --for <transition-id-or-archive> ...

xforge audit verify --change <change-id>
xforge archive --change <change-id> --dry-run
xforge archive --change <change-id>
```

> **不要照抄这个序列。** `state.nextActions` 才是权威——一条 Flow 可能要求返工、
> 额外的 Gate、外部审批 receipt 或远端审计投递，才允许下一次 transition。

---

## 10. 常见诊断码

| 码 | 含义与处置 |
| --- | --- |
| `XFORGE_CLI_IDENTITY_MISMATCH` | 应答的 CLI 不是项目固定的版本。跑 `xforge version` 看 `executablePath`，然后升级项目 / 升级全局 / 本地安装。**如实报告，不要绕过** |
| `XFORGE_PROJECT_NOT_FOUND` | 在未初始化的目录上跑了 `install`。用 `init` |
| `XFORGE_LANGUAGE_REQUIRED` | 非交互式 `init` 没给 `--language`。给它，不要替用户选 |
| `XFORGE_VERIFICATION_NOT_DECLARED` | Gate **拒绝**（不是失败）：项目没说自己怎么验证。**停下来问用户**，然后 `verification declare` |
| `XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED` | 同上；有意不覆盖的工具链用 `--not-applicable` |
| `XFORGE_UPGRADE_ACTIVE_CHANGES` | 有未归档 Change。先归档，这是人的决定 |
| `XFORGE_UPGRADE_UNCOMMITTED` | 受管路径有未提交改动，这次升级会没有提交兜底。**先提交**；`--allow-dirty` 是接受后果，不是消除它 |
| `XFORGE_UPGRADE_UNCOMMITTED_ACCEPTED` | warning：`--allow-dirty` 已放行，快照是唯一退路 |
| `XFORGE_UPGRADE_IN_PROGRESS` | warning：`xforge/UPGRADING.md` 还在，一次合并没有收尾。`doctor` / `state` / `check` / `transition` 都会说这句 |
| `XFORGE_UPGRADE_ROLLBACK_BACKSTOP` | info：回滚已用快照完成，这条给出那条按路径限定的 `git restore` 手工退路 |
| `XFORGE_FIELD_NOT_FOUND` | `--field` 路径不存在。去掉 `--field` 看 `data` 的形状 |
| `XFORGE_APPROVAL_TRANSITION_UNKNOWN` / `_UNAPPROVABLE` | `--for` 填错了，**什么都没写入**。改参数，不要重跑 |
| `XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN` | receipt 在审计链里找不到匹配事件，不进有效集合 |
| `XFORGE_FLOW_EXIT_UNSTRUCTURED` | Flow 的 `exit` 用了裸映射旧形态。改成结构化四字段 |
| `XFORGE_MANAGED_FILE_ADOPTED` | info：`--adopt` 把一个手改过的受管文件重新基线了 |

---

## 11. 三个「别这么用」

1. **别用 `grep` 从 `xforge state` 的 JSON 里挑值。** 用 `--field`。
   多个历史回执下重复出现的字段会让行匹配返回过时的那一个。
2. **别照 usage 字符串拼审批命令。** 从 `state.nextActions[].command` 里原样取。
3. **别把「拒绝」当成「失败」去绕过。** Gate refuse 是一个未被回答的问题，
   `upgrade-scaffold` refuse 是一个属于人的决定（先归档、或者先提交），
   `ready-to-archive` 无可用 transition
   是 Stage 层面已无可走——三者的正确反应都不是重试。
