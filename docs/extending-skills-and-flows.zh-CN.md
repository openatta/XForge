[English](extending-skills-and-flows.md) | 简体中文

# 扩展 Skills 与 Flows

本指南面向两类读者：在使用 XForge 的项目里添加自定义 Skill 或自定义 Flow 的人，
以及维护本仓库内置 Skills/Flows 的人。想先搞清楚 Skill/Flow 到底是什么，
见 [Skills、Flows、Rules、Gates、Hooks、PermissionPolicies 与 Approvals](governance-concepts.zh-CN.md)；
想看完整设计理由，见 [Flows 与 Skills](flows-and-skills-design.md)。

## 添加自定义 Skill

一个 Skill 就是一个目录，包含英文 `SKILL.md`；需要本地化时再配一份中文
`SKILL_cn.md`。新增 Skill 不需要改任何代码：

1. 在项目的规范 Scaffold 源里创建 `xforge/scaffold/skills/<skill-id>/SKILL.md`
   （+ `SKILL_cn.md`）——如果是在给 XForge 本体贡献代码，路径是
   `scaffold/payload/xforge/...`；如果是在已经跑过 `xforge init` 的项目里，路径是
   `xforge/scaffold/skills/...`。
2. 把 `<skill-id>` 登记进 `xforge/manifest.yaml` 的 `scaffold.skills` 列表。同步
   是由 manifest 驱动的，不是扫描目录——一个没有 manifest 条目的 Skill 目录，哪怕
   文件本身完全合法，也永远不会被投影出去。
3. 运行 `xforge sync --dry-run`，确认后运行 `xforge sync`，把 Skill 投影到每个
   已启用 Target 的目录（`.claude/skills/<skill-id>`、
   `.cursor/skills/<skill-id>`、`.opencode/skills/<skill-id>`、
   `.agents/skills/<skill-id>`、`.github/skills/<skill-id>`，以及 Codex 对应位置）。
   投影完成后，每个 Target 都拥有一份可以独立使用的副本。

`xforge-scaffold` 这个 Skill 就是为了在一次受治理的操作里完成第 1–2 步而存在
的——如果是 Agent 在做这件事，优先用它，而不是手改 `manifest.yaml`。

### 新 `SKILL.md` 的写作规范建议

沿用所有内置 Skill 已经统一的结构：

- **Frontmatter** —— `name`、一句话说清"产出什么、什么时候用"的 `description`、
  `license`，以及 `metadata`（`author`、`version`，如果是从别处改编的还要写
  `source`）。
- **固定五个章节，顺序不变** —— `Invariants`（行动前必须读取/成立的前提）、
  `Authority`（明确列出这个 Skill 能写哪些路径，以及明确列出它不能碰的东西）、
  `Execution`（编号步骤）、`Evidence`（要报告什么、对照哪个
  `doneWhen`/`requiredEvidence`）、`Stop and rework`（什么时候必须停下、由哪个
  Skill 负责修）。
- **只跟着 Action 走，不要跟着 Flow 名字走。** Skill 应该消费 `xforge state`
  返回的当前 ready Action，并严格按该 Action 的 `instruction`/`outline` 执行，
  绝不应该写死 `if flow is quick/solid/major` 这类分支，也不应该引用别的 Skill
  内部的步骤。详见下文
  [Flow 相关的差异该放在哪一层](#flow-相关的差异该放在哪一层)——这是最常见的设计
  错误，`xforge-design` 之前就踩过这个坑（见下面的案例）。
- **中英文必须同步修改。** 对 `SKILL.md` 或 `SKILL_cn.md` 的任何修改，都必须在
  同一次改动里镜像到另一个文件——结构和语义一致，不是逐字翻译。参见仓库根目录的
  [`AGENTS.md`](../AGENTS.md)。
- **Authority 要收窄。** 精确写出这个 Skill 能写哪些 Artifact 路径，并明确列出
  相邻但不能碰的 Artifact（视情况包括 Proposal、Specs、Design、Evidence、
  Archive 等）——这样排序的权威来源始终是 Flow 的 stage graph，而不是 Skill 自己
  的判断。

## 扩展或自定义 Flow

Flow 是纯数据：`xforge/flows/*.yaml`，加载方式是读取该目录下的每个文件，再用
`xforge/schemas/flow.schema.json`（`v1alpha2`）校验。没有任何 TypeScript 枚举
挡着新文件——加一个 `xforge/flows/hotfix.yaml`，只要满足 schema，它就会像
`quick`/`solid`/`major` 一样被加载：

- `metadata.name` 必须和文件名一致。
- `stages` 至少 3 项，每项 `id` 唯一；stage graph 必须包含 `propose`、`apply`、
  `verify`（由 `flow-resolver.ts` 里的 `stageGraphDiagnostics` 校验）。
- `policy.assuranceLevel` 目前只能取 `quick | solid | major` 三个值之一——你可以
  在一个新文件名下发布完全自定义的 stage graph 和治理策略，但目前仍需要挂靠这
  三档保证级别之一。如果要一个真正独立于这三档之外的第四档，需要改 schema，不是
  新增一个 YAML 文件就够。

让一个 Flow 可被选用：

- 在 `xforge/manifest.yaml` 的 `flow:` 字段里设为项目默认；
- 或者在某个 Change 自己的 `change.yaml` 的 `flow:` 字段里单独设置，只覆盖这一个
  Change（`xforge-propose` 默认会静默继承 manifest 的默认值，除非用户明确要求换
  一个 Flow——见该 Skill Execution 第 2 步）。

## Flow 相关的差异该放在哪一层

当两个 Flow 需要同一个阶段表现出不同行为时，按优先级有三个地方可以放这个差异：

1. **stage graph 里有没有这个阶段（优先）。** 如果某个 Flow 根本不需要某个阶段，
   直接不声明它——不要让 Skill 自己判断"要不要跳过自己的工作"。这就是为什么
   `quick` 没有 `design` 阶段：`quick` 的 `propose` 阶段职责范围本身划得够宽
   （Why/Scope/Non-goals/Success criteria/带场景的 Requirement），根本不需要单独
   的 design 阶段，`xforge-design` 的 Action 在 `quick` 下永远不会变成 ready。
   没有任何 Skill 里写着"如果是 quick 就跳过 design"这种逻辑。
2. **按 Flow 各自的 artifact `instruction`/`outline`（当同一个 Skill 确实要服务
   多个 Flow 时优先用这个）。** `design.md` 在 `solid` 与 `major` 下要求的深度不
   同，尽管两者用的都是 `xforge-design` 这个 Skill——这个差异完全放在每个 Flow
   YAML 里 `design` artifact 各自的 `instruction` 和 `outline` 字段中，而不是写
   在 Skill 的散文里。Skill 只需要说"严格按当前 Action 的 instruction 和
   outline 执行"。
3. **由引擎代码消费的结构化 stage 字段（最后手段，仅用于代码必须据此行动的行
   为）。** `stages[].execution.workPackages`（`internal | adaptive | required`）
   是唯一一个 Flow 间差异属于真正*运行时行为*（`xforge-apply` 里串行还是并行派发
   work package），而不只是写作内容的例子——所以它是一个 resolver 会读取的类型化
   schema 字段，Skill 只按"根据 Action 的 execution policy"这种通用方式引用它，
   不按 Flow 名字判断。

### Artifact `markers`：告诉工具某个小节是"干什么用的"

`outline` 规定 Artifact 必须有哪些 `## ` 小节。`artifacts[].markers` 规定其中某个小节
**意味着什么**——正是这一点让 `xforge brief` 能够算出答案，而不必请人读完散文再为它背书：

```yaml
- id: design
  outline: |
    ## Decisions and alternatives
    ## Test strategy
  markers:
    - id: verification-coverage
      section: Test strategy
      role: requirement-coverage
    - id: rejected-alternative
      section: Decisions and alternatives
      role: decision-alternative
      pattern: ['**Rejected alternative:', '**被否决的替代方案：']
      minOccurrences: 1
```

- `role: requirement-coverage` — 该小节是记录 Requirement 覆盖的地方，因此某条 Requirement
  即使出现在同一文件别处，只要不在该小节内就可被报告；
- `role: decision-alternative` — 匹配 `pattern` 的条目是被否决的替代方案，逐字引用进简报；
- `role: declared-gap` — 匹配 `pattern` 的条目把问题推给后续 Stage，简报会报告没有任何
  finding 引用它的那些。

`pattern` 是**列表**，因为 Flow 单一来源而它治理的散文是本地化的：同一个 Flow 同时治理
用英文写作和用中文写作的项目，只写一种语言的条目标记会在另一种语言下静默地什么也定位不到。

两种严重级别是刻意区分的。marker 指向 Artifact 不存在的小节是 **warning**——`outline` 一向
是指导而非强制，把缺失小节升级为错误会让 markers 出现之前就已合法的 Change 失败。
`minOccurrences` 是 **error**，因为它不同于 outline，是 Flow 明确要求某小节至少承载 N 个条目，
只有主动声明的项目才会走到那里。因此随包发布的 Flow 只声明 `requirement-coverage` 小节，
不设 `minOccurrences`。

依赖某个 marker 的规则，在 Flow 未声明该 marker 时**什么也不报告**，绝不退化为猜测。

**反模式：** Skill 自己的散文里按字面 Flow 名字分支（"Solid 时……Major 时……"）。
这比上面三种机制都脆弱——新增一个自定义 Flow（比如 `hotfix.yaml`）会被静默处理
错，因为这个 Skill 从没"听说过"它。`xforge-design` 就是具体例子：
`solid.yaml`/`major.yaml` 本身已经给 `design` artifact 准备了不同的
`instruction`/`outline` 文本，所以 Skill 自己的 `SKILL.md`/`SKILL_cn.md` 只需
要说"严格按当前 Action 的 instruction 和 outline 执行"——如果在 Skill 散文里
重写一遍"Solid 时……Major 时……"，只是在重复 Flow YAML 里已经有的数据，还会
悄悄漏掉第四个自定义 Flow。

### `outline` 由谁检查：没有人

`outline` 是写作指引。没有任何 Gate、`check` 或归档步骤会校验 Artifact 是否
包含 `outline` 声明的小节——一份缺了 `## Impact and rollback` 的 Proposal 在
任何 Stage 都不会产生诊断。真正被强制的只有 `markers`，且只有上面那两种方式。

之所以要写明，是因为这个字段看起来像 schema，实际不是。一次实测中，Proposal
缺少 `quick.yaml` 声明的一个小节，从 Propose 一路到归档看到的都是
`Structural validation passed.`。outline 已经完成了它的职责——告诉作者该写什么
——而下游没有任何环节对此有意见。

如果你需要某个小节是**必需**的，给它一个带 `minOccurrences` 的 marker。那是
唯一会让 Change 失败的机制。

### 不要把 digest 写进 Artifact 正文

`contentRevision` 会摘要每个 Artifact 的输出路径（`core/revision.ts`），而
Gate Evidence 绑定的是 Gate 运行时的 `contentRevision`。所以把某个 Gate 的
Evidence digest 粘进 `assurance.md`，**粘贴这个动作本身**就会让它失效：写入
改变了 `contentRevision`，于是 Evidence 变 stale，于是需要重跑 Gate，于是产出
的 digest 与文件里刚写下的那个不同。这里不存在不动点，一次实测为此花掉了一轮。

按名字引用 Gate，让台账去承载绑定关系。`evidence/verification-receipt.yaml`
正是出于这个原因**刻意不是**被声明的 Artifact——写它不会改变 `contentRevision`
——它的 `gates` 条目也只写 Gate 名而非 digest。`xforge verification
draft-receipt` 会生成其中全部机器已知的部分，因此没有任何东西需要手抄。

同一个陷阱也适用于 Flow 文件本身：`contentRevision` 按**原始字节**摘要
`xforge/flows/<name>.yaml`，所以编辑它——**包括改注释**——会让所有正在使用它的
活跃 Change 的 revision 发生变化。Flow 的修改属于 `xforge init`，不属于一个
进行中的 Change。

### 本地化一个 Flow

`outline` 的小标题与 `markers[].section` 都是散文，而 `section` 是按标题的
**确切文本**定位的。因此一个用 `--language zh-CN` 搭建、正文写中文的项目，配上
英文的 outline 小标题，结果是**一个 marker 都定位不到**——作者自然会写中文标题，
于是所有 marker 悄无声息地失效。

Flow 为每个文件附带一个 `_cn` 变体（`quick_cn.yaml` 与 `quick.yaml` 并列）。
`xforge init` 会把这一对折叠：所选语言的内容落到规范文件名下，变体被删除，因此
任何已安装的项目都不会同时持有两份；`core/flow-resolver.ts` 在扫描目录时也会
跳过 `_cn` 文件。

编辑它们时有三条规则：

- **`outline` 与 `markers[].section` 必须一起改。** 它们是同一个事实写了两遍，
  只翻译其中一个正是最初那个 bug。
- **只翻译散文。** `## ADDED Requirements`、`### Requirement:`、
  `#### Scenario:`、`**WHEN**`/`**THEN**`，以及 outline 内部所有台账字段名
  （`severity`、`reworkTo`、`resolvedBy`、`decidedBy`、`references` 等）都由
  `core/spec-delta.ts`、`core/spec-merger.ts` 和各台账求值器按字面匹配。翻译
  它们不会本地化任何东西，只会让 Spec 无法合并。
- **绝不让治理内容出现差异。** `test/integration/flow-localization.test.ts` 会
  从两个文件中剥掉 `description`、`instruction`、`outline` 与 `section`，然后
  要求剩下的部分完全一致。Flow 是可执行的治理规则，两份 `minApprovers` 各自漂移
  是比变体所修复的问题更严重的故障。

## 检查清单

新增 Skill：

- [ ] 已创建 `SKILL.md` + `SKILL_cn.md`，结构一致、语义镜像
- [ ] 五个标准章节齐全；Authority 精确列出能写/不能写的内容
- [ ] Skill 自己的散文里没有按 Flow 名字分支
- [ ] 已登记进 `manifest.yaml` 的 `scaffold.skills`
- [ ] 已核对 `xforge sync --dry-run`，再运行 `xforge sync`

新增或修改 Flow：

- [ ] `metadata.name` 与文件名一致
- [ ] `stages` 包含 `propose`、`apply`、`verify`；stage `id` 唯一
- [ ] `policy.assuranceLevel` 设置为正确的等级
- [ ] Flow 特有的内容深度差异通过 `artifacts[].instruction`/`outline` 表达，而
      不是新增 Skill 散文
- [ ] 真正的运行时行为差异通过类型化的 `execution` 类字段表达，而不是按 Flow
      名字做字符串判断
- [ ] 可以通过 `manifest.yaml` 的 `flow:` 或某个 Change 的 `change.yaml` 的
      `flow:` 选用
