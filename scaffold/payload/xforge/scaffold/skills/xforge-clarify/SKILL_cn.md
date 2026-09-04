---
name: xforge-clarify
description: 消除 Major Change 中会改变范围、设计、兼容性、风险或验收的关键歧义，并原子回写上游规格；用于 State 返回 ready Clarify Action 或规划审查要求澄清时。
---

# 不变量

- **进入**用 `xforge stage --change <id>`。它一次返回：Change 在哪、ready 的 Action 及其 `writes`/`requiredSections`，以及 `owes` 下这个 Stage 仍欠的每个 Artifact 及其 `instruction`/`outline`、**该 Action `inputs` 的正文**、Constitution 正文，以及诊断。不要再单独去打开那些输入——它们已经到了。每写完一个 Artifact 重跑一次，而不是另外去问「变了什么」。 它同时携带本 Stage 声明了什么——产出、Gate、exit 条件、返工路线——所以**不需要打开 `xforge/flows/*.yaml`**：那个文件 400 行，而你要去那里找的 outline，Action 里已经有了。
- 优先从代码、Specs、Rules 与 Proposal 查明事实；只询问会材料性改变结果且项目无法回答的少量问题。
- Clarifications 与对 Proposal/delta Specs 的获授权回写必须保持一次一致修订；未解决的 material question 继续阻塞。

# 权限

- 只可写 Clarify Stage `produces` 的两份 Artifact——`clarifications.md` 与 `evidence/conditions/materialQuestions.yaml`——以及 `revises` 中明确列出的 Proposal/delta Spec 现有路径。
- material-questions 台账由 Agent 撰写：没有任何 CLI 命令写它，而本 Stage 没有它就无法退出。它位于 `evidence/` 之下，但**不是** Gate Evidence——"Gate Evidence"专指只能由 `xforge check` 生成的 `evidence/*.json`，那些永远不得手写或编辑。该台账是控制平面读取的 Artifact，与 `xforge-check` 撰写的两份台账同性质。
- 不得写 Design、Check report、代码、主 Specs、Gate Evidence、任务或 Archive，不得替用户作材料性决定。

# 执行

1. 重读 Action inputs，列出会影响范围、兼容性、风险、实现边界或验收的未知项及其影响。
2. 调查能由项目事实回答的问题；对剩余问题一次提出最小、可决策的问题集。
3. 写 `clarifications.md`，并把同一组内容按`owes` 中该 Artifact 的 `instruction` 与 `outline` 记成机器可判定的条目，写进 `evidence/conditions/materialQuestions.yaml`。**Stage 的出口取决于那份台账，永远不取决于散文。** 然后把已确认的决定同步进 Proposal 与 delta Specs，保持 Requirement 与 Scenario 可测试。
4. 重跑 `xforge stage --change <id>`，确认 `materialQuestions: resolved`，然后运行 `xforge advance --change <id>`：它检查结构与 policy，只有在无人拒绝时才执行转换。若多个转换同时 ready，它会反问——用 `--to` 指明 typed nextAction 给出的那一个。

# 证据

- 每项决定必须引用用户决定或项目事实来源，并指出它更新了哪些 Requirement/Scenario。
- 只有 State 的 exit 条件满足才能声明 Clarify satisfied。

# 停止与返工

- 用户未决定、输入冲突、范围扩大、revision 变化或需要额外权限时停止并返回 `request-decision`。
- 遇到 `condition:materialQuestions:stale-<ids>`：本 Change 曾退回到 Clarify 之前又走了回来，被点名的条目当初所依据的 Proposal 或 delta Specs 在那之后被改写过。**把每一条被点名的问题，对照当前的 Artifact，重新交给拍板的人回答**，再记录答案与新的 `decidedAt`。仍然成立的决定是被重新确认的，不是被默认的——只把时间戳往后调而不去问，等于记录了一个没人给过的答案，这正是 `decidedBy` 与该字段存在的目的。返工没有触及的条目保留原有 `decidedAt`；只有 CLI 点名的那些才算失效。
- 后续发现新的材料性歧义时使下游失效，并通过 `xforge-revise` 返回 Clarify。

# 判断要点

- 不是所有开放问题都是材料性的。会改变 Design 方案或验收边界的问题才算材料性；答案只影响实现细节的问题应该留给 Apply，不属于这里——把后者也升级为开放问题只会拖慢规划，不会让规划更好。
- 没有人提出某个问题，不代表项目已经就它的答案达成了共识。沉默通常意味着没人做过这个决定，而不是"显而易见的选项已经被采纳"——一个没被说出口、但影响重大的默认假设，要按开放问题同等对待。
