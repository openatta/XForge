# XForge Skill 编写规范

> 这份文档回答的是「一个 Skill 该**怎么写**」。
> 「怎么**新增**一个 Skill 资源」（放哪、怎么登记、怎么投影）见
> [扩展指南 §1](extension-guide.md)。
>
> 对应实现：`@xforge/cli 0.8.2`、Protocol 2。
> 本文档是**指导性**的；其中被机器强制的部分在 §7 逐条列出对应的校验器。

---

## 1. 一个 Skill 的职责边界

XForge 有三层，每层都在回答「这个 Stage 该做什么」的一部分。
**Skill 写得乱，几乎总是因为它答了不属于它的那部分。**

| 层 | 它是什么的权威 | 变更方式 | 变更代价 |
| --- | --- | --- | --- |
| **Flow**（yaml） | Artifact 的 `instruction` / `outline` / `markers`；Stage 的 `produces` / `gates` / `exit.conditions` | 改 yaml | 低 |
| **CLI**（typed envelope） | `nextActions[]` 的 `command` / `inputs` / `writes` / `requiredSections` / `doneWhen` / `requiredEvidence` / `blockedBy` / `reworkTo` | 改代码 + 发版 | 中 |
| **Skill**（散文） | **判断**：目标是否成立、边界画在哪、什么时候该停下问人 | 改 SKILL.md | 低，但下游项目要合并 |

一句话：

> **Skill 是把「控制面给出的 typed Action」翻译成「一次可交付的工作」的那层判断。**
> 它不是 CLI 的说明书，不是 Flow 的副本，也不是事故档案。

三条推论，后面所有规则都从这里来：

1. Flow 和 CLI 能陈述的事实，**Skill 说「按它执行」，不复制内容**（§5 列出七个必须复述的例外）。
2. Skill 独有的是判断。判断被淹没在协议叙述里，就等于没写。
3. Skill 里的每一句话都应该能回答「**如果它错了，谁会先发现**」。答不上来的句子是负债。

---

## 2. 四类句子

写和改 Skill 时，先把每一句归到下面四类之一。**归不了类的句子，删掉。**

| 类 | 是什么 | 权威在哪 | 出错时谁发现 | 该怎么处置 |
| --- | --- | --- | --- | --- |
| **A · 事实转述** | 复述 Flow / schema / envelope 的内容 | 不在 Skill | **没人**（静默漂移） | 改写成「按 `<字段>` 执行」，或进 §5 的强制复述清单 |
| **B · 协议动作** | 调用哪个命令、按什么次序 | CLI | 契约测试 | **只能**用 §3 的统一写法 |
| **C · 判断** | CLI 答不了的取舍 | **Skill** | 实跑 | 这是 Skill 的全部价值，写厚一点 |
| **D · 事故记忆** | 「一次实跑曾经……」 | 历史 | —— | **迁往 `xforge explain <CODE>`**，不留在 Skill |

### 2.1 A 类：为什么复制事实是负债

A 类句子的问题不是啰嗦，是**它没有校验者**。

`xforge-propose/SKILL.md` 曾写：

```text
写出该 Flow 的 proposal outline 声明的每一个 ## 段落
—— 这个集合各 Flow 不同，只有 Major 带 ## Actors
```

后半句是一份手抄的 Flow 快照。改一个 Flow 定义，它就错了，**而且不会有任何测试变红**。
与此同时 `xforge state` 正在 `nextActions[].requiredSections` 里逐字返回当前 Flow 解析好的段落集合。

> ✅ 「写出 `requiredSections` 列出的每一个 `##` 段落，逐字照抄标题。」
> ❌ 「写出 `## Why` / `## Scope` / `## Non-goals` ……（只有 Major 带 `## Actors`）」

这同时也是[扩展指南 §1.4](extension-guide.md) 那条「不要按 Flow 名字分支」的一般形式：
**按 Flow 名字分支，只是 A 类漂移里最容易看见的一种。**

### 2.2 C 类：判断该写多厚

判断是 Skill 唯一不可替代的内容，判据是「**换一个称职的人来做，会不会做成另一个样子**」。

`xforge-propose` 的两句判断是好例子：

- 「想法仍然模糊时，先把它收敛，再创建任何东西 —— 不要为一个还界定不了的想法创建 Change。」
- 「一条需求对作者本人读起来很清楚，但只有掌握了未写明的实现细节才能理解，对别人就不算可测试。」

两句都没有对应的 CLI 字段，两句都会改变产出。**这类句子应该占 Skill 的主要篇幅。**

### 2.3 D 类：事故记忆的正确归宿

这个仓库最贵的资产就是实跑买来的教训。**问题从来不是要不要保留，而是保留在哪里。**

写在 SKILL.md 里，代价是每次进入这个 Stage 都要读一遍 —— 包括 90% 根本不会撞上它的场次。
写进 `diagnostics-catalogue`，Agent 在**真正撞上那个诊断码的那一刻**读到它，而且能读到更全的版本。

`xforge explain <XFORGE_CODE>` 的定位就是「一个 code 的严重度 + 它能携带的**每一条**消息」。

| 事故记忆 | 现在在哪 | 该在哪 |
| --- | --- | --- |
| `moduleContract` 答 `false` 是唯一能让接口变更溜进弱 Flow 的动作 | `xforge-propose` 正文 7 行 | `XFORGE_FLOW_TOO_WEAK` |
| 手写 `manifest.verification` 缩进少一级，之后治理调度器拒绝了每一个工具调用 | `xforge-verify` / `xforge-scaffold` 正文 | `XFORGE_VERIFICATION_NOT_DECLARED` |
| 复核记录写成 `.yaml` 会被当成交付记录解析 | `xforge-apply` 正文 | 对应的路径诊断码 |

> **迁走的是解释，不是**诊断码本身。Skill 仍然要字面写出会挡住本 Stage 的那个码（§5 第 8 条），
> 否则 Agent 撞见拒绝时接不上；正文只保留「这是键在起作用，不是错误」这一句判断，
> 完整成因交给 `xforge explain`。
>
> **判据**：一句以「一次实跑 / a live run」开头的话，问它「Agent 在**什么条件下**需要知道这件事」。
> 答案如果是一个诊断码，它就属于那个诊断码。
> 答案如果是「每一次」，它才留在 Skill —— 那种情况远比现在写下来的少。

---

## 3. 工具使用规范（**唯一**的 CLI 调用写法）

这一节是硬规范。CLI 调用散落各处、每个 Skill 各写各的措辞，是 Skill 层最主要的维护成本来源。

### 3.1 三个动作，每个 Skill 都只用这三个

一个受治理的 Stage，无论它做什么，都是这三个动作的组合。**Skill 只填参数，不改措辞、不改次序、不增动作。**

| # | 动作 | 写法 | 各 Skill 可变的部分 |
| --- | --- | --- | --- |
| 1 | **进入** | `xforge stage --change <id>` | 无 |
| 2 | **写** | 按 Action 的 `writes` / `requiredSections` / `instruction` / `outline` 写 | 无 |
| 3 | **推进** | `xforge advance --change <id>` | 无 |

> 这里原本是六个动作。塌缩成三个不是措辞简化，是产品改了：
>
> - **进入**：`xforge stage` 一次返回 Change 在哪、ready 的 Action（含 `writes`/`requiredSections`/`instruction`/`outline`）、**该 Action `inputs` 的正文**、Constitution 正文、诊断。原来的「取阅读计划」和「刷新」都不再是独立动作 —— 计划连着正文一起来，而每个写命令都回带刷新后的状态。
> - **推进**：`xforge advance` 跑 Gate、判定、就绪则转换。原来的「判定」与「推进」是固定成对的两次调用（实测十二个 Stage 零方差）。
>
> **记录没有合并。** Gate Evidence 与 Transition 回执照旧分别落盘、分别审计；Gate 失败会拒绝转换并点名。这只是调用数的优化。

**`--content` 是意图，不是字段清单：**

| 值 | 何时用 |
| --- | --- |
| 省略（`changed`） | 默认。本 Stage 的产出 + 进入本 Stage 后动过的 + Constitution，带正文；其余给摘要与段落清单 |
| `full` | 摘要不够、要看原文 |
| `none` | 只要计划，便宜的重新轮询 |

**不要让调用方枚举字段。** 要求它列出自己需要什么，等于要求它先知道自己来问的那个问题的答案；而且猜错一个的代价是整个回复 —— `--field` 是全有或全无。

### 3.2 命令一律取自 `nextActions[].command`，不自行拼装

这是本节最重要的一条。

`state.nextActions[]` 已经把命令连同参数一起拼好了 —— 包括 `--change`、`--for`、`--policy`
这些最容易写错的部分。Skill 自己拼一条命令，等于用一份**没有校验者的手抄本**
去覆盖一份**当前解析结果**。

> 一次实跑在 `--for` 上写了 Stage 的**名字**而不是 id，花掉了一个真人的签名，
> 而 receipt 什么都不算数。同一时刻 `nextActions[].command` 里那条命令是对的。

**Skill 允许自己写出完整命令的，只有一种情况：控制面在那一刻不会给出这条命令。**
目前只有一处 —— Change 尚不存在时的 bootstrap（见 §3.5）。
除此之外，Skill 提到某个命令时应当只写命令名，用于让 Agent 认得它，
而参数以 `nextActions[].command` 为准。

### 3.3 `--field`：只在工作集之外还需要一个值时用

`xforge stage` 已经给出本 Stage 要用的东西，所以 `--field` 不再是每个 Skill 都要拼的开局参数。它剩下的用途是**在工作集之外单点取一个值** —— 比如报告里要引用当前 `contentRevision`。

三条规则：

1. **路径不能猜。** `--field` 是全有或全无：一个路径解析不了，整次调用失败、一个值都拿不到。新增前先在真实项目上验证一次 —— `field-path-contract` 测试会检查 Skill 与 XFORGE.md 里出现的每一条。
2. **`gates` 属于 `check`，不属于 `state`。** 同名不同命令是最容易写错的一类。
3. **`change.` 开头的路径必须带 `--change`。**

### 3.4 读回复的四种形状（每个 Skill 都适用，不需要各自重写）

这些写在 `xforge/XFORGE.md` 里，**Skill 不重复它们，但作者必须知道**：

| 情况 | 回复长什么样 |
| --- | --- |
| 成功，单个 `--field`，值是标量 | **裸值加换行**，不是 JSON（这样 `$(xforge state --field ...)` 才安全） |
| 成功，单个 `--field`，值是对象 | 该对象的 JSON |
| 成功或拒绝，多个 `--field` | 一个按路径键控的对象，**请求的每一条都在里面** |
| 拒绝 | 信封保留，`ok:false`，退出码 1，只有 `data` 收窄 |

第三种曾经不成立：多字段请求会把一部分放进 `data`、一部分留在信封顶层，而回复里没有任何东西说明哪个在哪。**同一个下午有三个读取器各自把自己没找的那一半读成了「没有答案」。** 已修。

`gates: []` 既可能是本 Stage 不声明 Gate，也可能是 Evidence 陈旧 —— **只有 `diagnostics` 能分辨**。

### 3.5 曾经的 bootstrap 例外，已经不是例外了

创建 Change 一度是唯一没有 typed Action 的步骤，所以 `xforge-propose` 内嵌了一份 `change.yaml` 模板 —— 一份手工维护的形状副本，`moduleContract` 就是这样以「schema 定义了、checker 读了、三个 Flow 都声明了，唯独 Skill 没提，于是整条防线永远不可能触发」的方式漏掉的。

现在它是 `create-change` Action 的 `template`，由产品渲染，带上这个项目自己的默认 Flow 与第一个模块。**Skill 里不再有任何内嵌模板。**

**这条留在这里作为判据**：新写的 Skill 如果发现自己需要内嵌模板或自拼命令，那不是一种写法，那是 CLI 缺一个 action。先去补 action。

## 4. 六个章节各装什么

前五节是硬契约（§7），顺序不可变。第六节可选。

| 章节 | 装什么 | 不装什么 |
| --- | --- | --- |
| **不变量 / Invariants** | 动作 1 的完整调用；本 Stage 恒真的前提 | 步骤、事故记忆 |
| **权限 / Authority** | 能写哪些路径，**以及相邻但明确不能碰的** | 判断、命令 |
| **执行 / Execution** | 编号步骤，按 §3 的六动作组织 | Flow 内容的复制品 |
| **证据 / Evidence** | 报告什么，对照哪个 `doneWhen` / `requiredEvidence` | 结论的替代品 |
| **停止与返工 / Stop and rework** | 什么条件必须停、交给哪个 Skill | 事故记忆（迁往 explain） |
| **判断要点 / Judgment calls**（可选） | C 类判断里最容易被漏掉的 | A / B / D 类 |

**段落级所有权（约定，工具不强制）**

| 段 | 属于 | 升级时 |
| --- | --- | --- |
| `# Invariants` / `# Authority` / `# Execution` | **产品** | 取上游。项目保留自己那份，等于让自己的 Agent 被一个已经前进了的控制面拒绝 |
| `# Judgment calls` | **项目** | 保留自己的 |
| `# Evidence` / `# Stop and rework` | 混合 | 按内容各自判断 |

`xforge-upgrade-scaffold` 的第 2 步写着同一条约定，因为它是真正执行合并的那一个。
**没有任何东西比较段落** —— `classifyScaffold` 是整文件摘要级的，要做到机器强制需要三方合并（得有 base 版本），那是另一个设计。在此之前，这条约定只在合并者遵守时成立。

**Authority 为什么要写「不能碰的」**：排序的权威始终是 Flow 的 stage graph。
把相邻的东西显式排除，Agent 就不需要靠推理来知道边界在哪。

---

## 5. 强制复述清单（少而准）

§1 说「不复制事实」，这里是**七个必须复制的例外**。
它们的共同点：**Agent 只读 Skill 时，会被通用规则引向相反的结论。**

设计取向是 `flow-skill-conformance.ts` 定下的 —— *少而准，不多而近似*。
一条会误报的规则，最终教会所有人忽略那些不会误报的。

| # | 必须字面出现 | 为什么 | 校验者 |
| --- | --- | --- | --- |
| 1 | 本 Stage 产出的 `evidence/` 下 Artifact 的**文件名** | 每个 Skill 都被告知「不要手写 Gate Evidence」，这是那条禁令的例外，不点名就是禁令赢 | conformance R1 |
| 2 | Stage 声明 `builtin: declared` Gate 时，`verification declare` | 那种 Gate 只有声明能清掉；不写，Agent 被挡住时手上没有出路 | conformance R2 |
| 3 | Stage 的 `exit.conditions` 的 **key** | CLI 原样回报 `condition:<key>:<reason>`，不写 Agent 接不上 | conformance R3 |
| 4 | `change.yaml` 模板里 schema 的**每一个** classification key | `moduleContract` 曾经全线接好、唯独 Skill 没提，整条防线永远不可能触发 | classification 契约测试 |
| 5 | `xforge state` | Skill 必须至少读一次状态 | product 契约测试 |
| 6 | 中英双语同时满足以上全部 | 校验器逐个变体检查 | 全部校验器 |
| 7 | 六动作里 Skill 实际会跑的命令名 | 与 CLI help 对照，防止指示一个不存在的 flag | command 契约测试 |
| 8 | 会挡住本 Stage 的**诊断码字面量**（如 `XFORGE_FLOW_TOO_WEAK`） | 与第 3 条同理：CLI 原样回报这个 token，Skill 不写出来，Agent 就接不上自己撞见的那条拒绝 | 逐 Skill 的契约测试 |

> 第 1 条的边界很关键：**只对 `evidence/` 下的 Artifact 生效**。
> `design.md` / `assurance.md` 这类不存在冲突，Skill 说「按 Action 返回的路径写」就够了，
> 对它们也要求点名，就变成了会误报的规则。

---

## 6. 禁止清单

| 禁止 | 为什么 |
| --- | --- |
| 按 Flow 名字分支（「Solid 时…… Major 时……」） | 新增自定义 Flow 会被**静默**处理错 |
| 复制 `outline` / `instruction` 的内容 | A 类漂移，无校验者 |
| 自行拼装 `state` 已经给出的命令 | 手抄本覆盖当前解析结果 |
| 把事故记忆写进正文 | 每次进入都付费，且撞上时反而看不到全文 |
| frontmatter 写 `license:` / `metadata:` | 归属信息只在 `scaffold/NOTICE` 里写一次 |
| 引用别的 Skill 的内部步骤 | 步骤是私有的，只有 Stage 边界是公开的 |
| 只改一个语言变体 | 校验器逐变体检查，且中文用户会拿到另一份产品 |

---

## 7. 机器校验对照表

写完对照这张表，就知道哪些错误会被挡住、哪些不会。

| 校验器 | 位置 | 挡住什么 |
| --- | --- | --- |
| 五章节 + 双语 + `allowed-tools` + 无 `license:`/`metadata:` | `tests/product-validation.test.ts` | 结构走形 |
| Flow↔Skill 一致性 R1/R2/R3 | `xforge/src/core/flow-skill-conformance.ts`（跑在 `doctor`） | §5 的 1–3 条 |
| 命令 / 子命令 / flag 存在性 + golden | `xforge/test/integration/skill-command-contract.test.ts` | 指示一个 CLI 不接受的调用 |
| 写入路径不撞 CLI 的命名空间 + golden | `xforge/test/integration/skill-cli-contract.test.ts` | 把复核记录写进交付记录的槽位 |
| classification key 齐全 | `xforge/test/integration/skill-classification-contract.test.ts` | §5 第 4 条 |
| 载荷里不含测试用语 | `tests/live-engine/check-vocabulary.mjs` | 测试脚手架泄漏进产品 |

**目前没有校验者的**（写错只能靠实跑发现）：

- `--field` 的 dotted path 是否解析得了
- A 类事实转述是否已经和 Flow 漂移
- 判断写得够不够厚

前两项应当补上校验器；第三项本质上补不了，只能靠评审。

---

## 8. 改一个 Skill 的流程

1. **先问改动属于哪一类**（§2）。A/B 类的正确修法通常是**改 CLI 或 Flow**，不是改 Skill。
2. **中英同改**，结构与语义镜像，不是逐字翻译。
3. **`npm run relock`** —— 两份 payload、`scaffold/files.sha256`、lockfile 一起动。
4. **保持 diff 局部。** `upgrade-scaffold` 从不自动合并：
   *「一个项目自己的措辞是否该让位给新的默认值，是关于这个项目意图的问题。」*
   整篇重排 = 让每个下游项目面对一次全文冲突。**逐个 Skill 改、段落边界稳定。**
5. **按改动性质选验证深度**：
   - 只动措辞 / 位置 → 不单独实跑（实测天花板 < 2%），搭下一次实跑的车
   - 改变 Agent 取哪些数据、何时读到什么 → 欠一次该 Stage 的实跑
   - 覆盖矩阵在 `tests/live-engine/coverage-matrix.yaml`，按 Skill 查到对应 scenario

> **探针会替换 Skill，默认开启。** `tests/probe/probe.mjs` 除了装本地 CLI、替换 Flow 文件，
> 还会把工作树里当前的 Skill 覆盖进 fixture 的 `xforge/scaffold/skills/`（项目自己的那一份），
> 然后运行 `xforge update` 把它投影到各个目标。覆盖了哪些文件写在结果的 `skills` 字段里。
>
> **只写项目自己的那份，绝不手写投影副本。** `.claude/skills/` 之类是受管文件、带记录的摘要，
> 手写一个会让下一次受管操作以 `XFORGE_MANAGED_FILE_MODIFIED` 拒绝——那是所有权记录在正常工作。
>
> `xforge update` 在这里还解决另一件事：每个 fixture 都钉着捕获当天的 CLI，而探针永远装工作树的构建，
> 两者必然不一致。fixture 带一个 fail-closed 的 `agent.tool.before` Hook，于是 Agent 的**每一个**
> 工具调用都会被治理调度器拒绝——包括 `xforge state`。Agent 会照 Skill 说的停下并报告诊断，
> 结果两个 Artifact 检查都红，而**看上去完全像是 Skill 不产出 Artifact**。
> `update` 只推进 CLI 钉住的版本，`manifest.scaffold.version` 留在文件所在的位置。
>
> 只有要**复现一次旧结果**时才用 `--overlay-skills false` —— 那种情况下 Agent 读到的是
> fixture 冻结当天的 Skill，结论只对那一天成立。
>
> 在这之前探针不做这件事，于是它结构上无法回答「Skill 改对了吗」，
> 每次 Skill 改动都欠一次全场景实跑（约一小时、十几美元）。**这就是 Skill 改动积累成猜测的原因。**
