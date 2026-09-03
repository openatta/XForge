---
name: xforge-design
description: 为 Solid 或 Major Change 形成受治理的技术设计、替代方案、失败与验证边界；用于 State 返回 ready Design Action，且 Proposal/Specs 与所需 Clarifications 已满足时。
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# 不变量

- **进入**用 `xforge stage --change <id>`。它一次返回：Change 在哪、ready 的 Action 及其 `writes`/`requiredSections`/`instruction`/`outline`、**该 Action `inputs` 的正文**、Constitution 正文，以及诊断。不要再单独去打开那些输入——它们已经到了。每写完一个 Artifact 重跑一次，而不是另外去问「变了什么」。 它同时携带本 Stage 声明了什么——产出、Gate、exit 条件、返工路线——所以**不需要打开 `xforge/flows/*.yaml`**：那个文件 400 行，而你要去那里找的 outline，Action 里已经有了。
- Design 解释 HOW、决策与边界，不重复 Proposal，不退化为逐文件任务列表或长期 Plan。
- Constitution、Rules、现有架构和 Specs 是约束；不把约束原文机械复制进设计。

# 权限

- 只可写 Action 返回的 Artifact 路径。在受契约治理的 Flow 上那是两份文档：Design 与 `contract-delta`，两者都不是 `xforge/contracts/` 本身。
- 不得改 Proposal/Specs/Clarifications、产品代码、Check report、Evidence、任务或 Archive；上游需要修改时返回 rework。

# 执行

1. 建模当前系统、目标行为、集成点、数据与接口边界。
2. 记录主要决策、可行替代方案及拒绝理由，覆盖失败模式、兼容性、迁移和回滚。
3. 严格按照当前 Action 的 Design artifact `instruction` 与 outline 执行——Solid 与 Major 的深度差异（例如 Major 的 trust boundaries、风险与缓解、测试策略、rollout、monitoring、stop signals、owner 和并行边界）已经在其中表达，不要补充或省略 Action 未定义的章节。
4. 当 Action 列出 `contract-delta` Artifact 时，按该 Action 的 `instruction` 与 `outline` 写——元素 id 的形式、id 从哪里读、空段落意味着什么，都由它们给出。有一件事不在其中，因为它关乎这个项目而不是这个 Artifact：声明了 `contract-lint` 的 Stage，在项目用 `xforge verification declare --gate-name contract-lint --command '[...]' --by <person>` 记录命令之前不可能通过——declared Gate 在没有声明时是拒绝，不是放行。不要为了绕过它去手改 Manifest。
5. 刷新 State 并运行 `xforge check --change <id>`；只修复 Design 权限内的结构问题，然后调用 typed nextAction 中通往 Check 的 Transition。所有随附 Flow 都不在 Design 出口收取审批——`planning-solid` 与 `implementation-major` 都改在 Check 出口收取——所以不要在这里等一份没人会发起的 receipt，也不要尝试为本 Stage 审批：`xforge approve` 会拒绝任何策略都不治理的 transition。

# 证据

- 存在 `xforge/architecture.md` 时读取它，并说明本 Change 对它触及的每条决策的立场——在其之内，或给出理由地偏离。当设计需要*修改*某条决策时，把提议写进你自己拥有的 Design Artifact，然后停下来等人。不要自己写 `evidence/conditions/architectureDeltas.yaml`：那条记录要填具名的 `decidedBy`，Agent 去填一个人的名字，就是在记录一份没人给过的授权。没有任何东西会拦住你：没有任何 Flow 把这个账本声明为 exit condition，所以没有 Gate 读它，也没有转移会因它被阻。这是该守规矩的理由，不是放松的理由——那条记录是这个决定唯一留下的痕迹，而伪造的那一条此后永远与真的无法区分。由人授权并调用 `xforge-architect`，它是架构文件及其账本的唯一写者。文件不存在时说明一次并继续：那是一个尚未写下架构的项目，不是一个违规的项目。
- 每项关键决策映射到 Requirement、项目约束或代码事实，并给出可验证结果。
- 按 Action 的 `doneWhen` 报告覆盖范围、残余风险和下一合法 Action。
- 若某个项目自有的 Flow 确实在 Design 出口声明了审批（随附的三个 Flow 都没有），在用户签字前运行 `xforge check --change <id>`，把其中的 `XFORGE_RECONCILE_*` 条目交给他们。每一条都是一处已陈述的差异，不要重新措辞。

# 停止与返工

- 在材料性歧义、规格冲突、未知 trust boundary、不可回滚影响或需要修改上游时停止。
- 将上游问题交给 Clarify/Revise；不要在 Design 中静默扩大 Scope。

# 判断要点

- 看起来成本最低的方案，不代表就该最后一个被否决。即使一个更简单的方案"明显不够用"，也要写清楚为什么否决它——"明显不够用"恰恰是那种六个月后的评审者，如果没有当初的推理过程就无法自行验证的判断。
- 兼容性和可回滚性是两个不同的问题。一个数据格式向后兼容的设计，仍可能因为迁移是单向的而在实际中不可回滚——要分别检查这两点，不要把"兼容"当成"可回滚"的同义词。
