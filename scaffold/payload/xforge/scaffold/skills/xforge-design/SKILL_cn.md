---
name: xforge-design
description: 为 Solid 或 Major Change 形成受治理的技术设计、替代方案、失败与验证边界；用于 State 返回 ready Design Action，且 Proposal/Specs 与所需 Clarifications 已满足时。
---

# 不变量

- **进入**用 `xforge stage --change <id>`。它一次返回：Change 在哪、ready 的 Action 及其 `writes`/`requiredSections`，以及 `owes` 下这个 Stage 仍欠的每个 Artifact 及其 `instruction`/`outline`、**该 Action `inputs` 的路径（每份附摘要与章节清单）**、Constitution 正文，以及诊断。只打开你真正需要的那几份，且每份只打开一次；回复里已经写明它们是哪些、以及自本 Stage 开始以来哪些动过，因此不需要靠列目录树去找。每写完一个 Artifact 重跑一次，而不是另外去问「变了什么」。 它同时携带本 Stage 声明了什么——产出、Gate、exit 条件、返工路线——所以**不需要打开 `xforge/flows/*.yaml`**：那个文件 400 行，而你要去那里找的 outline，Action 里已经有了。
- Design 解释 HOW、决策与边界，不重复 Proposal，不退化为逐文件任务列表或长期 Plan。
- Constitution、Rules、现有架构和 Specs 是约束；不把约束原文机械复制进设计。

# 权限

- 只可写 Action 返回的 Artifact 路径。对声明了 `classification.moduleContract: true` 的 Change 那是两份文档：Design 与 `contract-delta`，两者都不是 `xforge/contracts/` 本身——基线只由 archive 写入，`protected-files` 会拒绝这次写。
- 不得改 Proposal/Specs/Clarifications、产品代码、Check report、Evidence、任务或 Archive；上游需要修改时返回 rework。

# 执行

1. 建模当前系统、目标行为、集成点、数据与接口边界。
2. 记录主要决策、可行替代方案及拒绝理由，覆盖失败模式、兼容性、迁移和回滚。
3. 严格按照`owes` 中 Design Artifact 的 `instruction` 与 outline 执行——Solid 与 Major 的深度差异（例如 Major 的 trust boundaries、风险与缓解、测试策略、rollout、monitoring、stop signals、owner 和并行边界）已经在其中表达，不要补充或省略 Action 未定义的章节。
3b. **写覆盖映射时，每一行都要引出那条断言本身，而不是测试的名字。** 无论这份 Design 的 outline 把它叫作测试策略还是验证注记，只要你在把某条 Requirement 或 Scenario 记为"已被自动验证覆盖"，就必须指出**是哪一条断言建立了它**——测试文件里的那一行、或它断言的那个具体判据。做不到这一点，这一行就不是覆盖，改写成缺口。

一个测试名不构成覆盖的证据。实测的失败形态是这样的：覆盖矩阵把 REQ「未知 id → 文件内容不变」记给一条名为 `reports not-found for an unknown id on verify or rotate` 的用例，而那条用例只断言了信封与诊断码、**从未断言文件不变**，并且它跑在存储文件根本不存在的临时目录上。名字读起来完全对得上，断言一条都不沾。同类形态在历史记录里是 Check 最常提的一类（30/34 条 blocker），**而下游会把这张表当成"什么已经被验证"的依据**：Apply 据此决定还要补什么，Check 据此裁决缺口。高报一行，下游就少验一处。

Propose 已经逐条判定过"有没有自动验证可依"并把无法验证的写进了 `## Scope`。这一步是它的对账面：**它问的是"你说已覆盖的那些，是不是真的"**，不是"有没有缺口"。两处发现的缺口应该能对上；对不上的地方本身就是要写出来的结论。

4. 当 Action 列出 `contract-delta` Artifact 时，按`owes` 中该 Artifact 的 `instruction` 与 `outline` 写——元素 id 的形式、id 从哪里读、空段落意味着什么，都由它们给出。它只会为声明了 `moduleContract: true` 的 Change 列出；没列出，就是本 Change 说过它不移动任何接口，也就没有东西要写。有一件事不在其中，因为它关乎这个项目而不是这个 Artifact：声明了 `contract-lint` 的 Stage，在项目用 `xforge verification declare --gate-name contract-lint --command '[...]' --by <person>` 记录命令之前不可能通过——declared Gate 在没有声明时是拒绝，不是放行。随包的三个 Flow 都没有声明它；选了它的项目是有意为之。不要为了绕过它去手改 Manifest。
5. 刷新 State 并运行 `xforge check --change <id>`；只修复 Design 权限内的结构问题，然后调用 typed nextAction 中通往 Check 的 Transition。所有随附 Flow 都不在 Design 出口收取审批——`planning-solid` 与 `implementation-major` 都改在 Check 出口收取——所以不要在这里等一份没人会发起的 receipt，也不要尝试为本 Stage 审批：`xforge approve` 会拒绝任何策略都不治理的 transition。

# 证据

- 每项关键决策映射到 Requirement、项目约束或代码事实，并给出可验证结果。
- 按 Action 的 `doneWhen` 报告覆盖范围、残余风险和下一合法 Action。
- 若某个项目自有的 Flow 确实在 Design 出口声明了审批（随附的三个 Flow 都没有），在用户签字前运行 `xforge check --change <id>`，把其中的 `XFORGE_RECONCILE_*` 条目交给他们。每一条都是一处已陈述的差异，不要重新措辞。

# 停止与返工

- 在材料性歧义、规格冲突、未知 trust boundary、不可回滚影响或需要修改上游时停止。
- 将上游问题交给 Clarify/Revise；不要在 Design 中静默扩大 Scope。

# 判断要点

- 看起来成本最低的方案，不代表就该最后一个被否决。即使一个更简单的方案"明显不够用"，也要写清楚为什么否决它——"明显不够用"恰恰是那种六个月后的评审者，如果没有当初的推理过程就无法自行验证的判断。
- 兼容性和可回滚性是两个不同的问题。一个数据格式向后兼容的设计，仍可能因为迁移是单向的而在实际中不可回滚——要分别检查这两点，不要把"兼容"当成"可回滚"的同义词。
