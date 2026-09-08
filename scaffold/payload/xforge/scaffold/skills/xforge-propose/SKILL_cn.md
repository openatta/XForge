---
name: xforge-propose
description: 创建受治理的 Change，并且只写 Propose Stage 允许的 change.yaml、提案与 delta Specs；当用户希望把一个足够清晰的想法、缺陷或特性正式规格化，但尚未授权实现时使用。
---

# 不变量

- **进入**用 `xforge state --field nextActions --field diagnostics --field constitution --field project --field flows --field changes --field specs`：读取 ready 的 `create-change` Action（它携带 `change.yaml` 模板以及写到哪里）、Constitution 的版本与路径、Changes 路径、项目模块、Specs，以及每个 Flow 及其用于判定 eligibility 的 `policy`。Constitution 按这里报告的路径去读文件：State 只携带它的版本与路径，不携带正文。**本 Stage 用 `state` 进入而不是 `stage`，是因为此时还没有 Change；从第 3 步起，入口是 `xforge stage --change <id>`，它会把 Action 的输入正文一起带来。**
- `change.yaml` 存在之后，后续每一次读取都是 `xforge stage --change <id>`：它返回 Change 在哪、ready 的 Action 及其 `writes`/`requiredSections`，以及 `owes` 下这个 Stage 仍欠的每个 Artifact 及其 `instruction`/`outline`、**该 Action `inputs` 的路径（每份附摘要与章节清单）**、Constitution 正文，以及诊断。只打开你真正需要的那几份，且每份只打开一次；回复里已经写明它们是哪些、以及自本 Stage 开始以来哪些动过，因此不需要靠列目录树去找。
- **命令一律运行 `state.nextActions[].command` 给出的那条，不要自己拼装。** 第 3 步是唯一的例外，因为没有任何 Action 会创建 Change。
- 只消费 `xforge-propose` 对应的 ready Action；每次写入前从磁盘重读它的 `inputs`。
- Flow 的选择依据是 State 报告的各 Flow `policy.eligibleWhen`，绝不依据 Flow 的名字或印象。分类与可用 Flow 冲突时，升级或请求决定。
- Specs 使用机器约定的 `ADDED|MODIFIED|REMOVED|RENAMED Requirements`、`Requirement`、`Scenario`、`WHEN`、`THEN` 标题。

# 权限

- 可以在 State 解析的 Changes 目录创建一个 kebab-case Change ID，写 `change.yaml` 以及 Propose Action 返回的 Proposal 与 delta Spec 路径。
- 可以用 `xforge verification declare` 记录本项目对某个必需的 `builtin: declared` Gate 从未给出的答案——绝不自己手改 `xforge/manifest.yaml`，`protected-manifest` PermissionPolicy 本来也会拒绝。权限落在这里是因为拒绝落在这里：本 Flow 声明的这类 Gate 会挡住这个 Change 的**第一次**转换，早于任何真正运行它的 Stage。它依然是项目的答案而不是你的——见「执行」第 6 步。
- 不得写 Design、Clarifications、Check report、长期 Tasks、产品代码、主 Specs、Evidence 或 Archive。
- 不得替用户决定材料性兼容、数据、安全、隐私或范围问题。

# 执行

0. **想法仍然模糊时，先把它收敛，再创建任何东西。** 读代码、Spec 与约束，直到能陈述一个目标、它的边界、以及「做完」的判据。**调查本身不需要 Skill**，用普通的阅读与检索即可。这一步欠用户的是一个结论：要么给出一个有边界的目标，要么明确报告这个想法尚不可分离成一个目标。**不要为一个还界定不了的想法创建 Change**——一个没有边界的 Change，拆解它的代价远高于问一个问题的代价。
1. 解析唯一目标，并检查是否已有覆盖同一问题的 active Change。
2. 将 `flow` 设为 State 解析出的 manifest 默认值，除非用户明确要求使用其他 Flow。仅当分类与该默认值明显冲突时才可主动偏离——此时应升级或请求决定，而不是静默改写。升级与降级并不对称，这个不对称本身就是要点：更重的 Flow 永远合法，所以没有任何东西会拒绝它；而更轻的 Flow 一旦分类超出其承载范围就会被拒绝。**因此降级只能提出，不能自行采纳。** 当这个 Change 满足某个更轻 Flow 的全部 `eligibleWhen`、并且不需要默认 Flow 才有的任何 Stage 时，说明这一点并交给用户决定——这和任何一个「移除一道检查」的决定是同一个道理，答案属于用户。`## Flow choice` 是每个 Flow 的 proposal outline 都声明的段落，所以它总是要写；变的是里面写什么。被覆盖、被升级、或被用户接受的降级，都要写明理由；单纯继承默认值时，就照实写「继承了 manifest 默认值」——那是诚实的内容，不是可以省略的理由。
3. 依据 `create-change` Action 创建最小 `change.yaml`：把它的 `template` 写到它的 `writes` 路径下一个新的 kebab-case Change id 里，把每一处占位替换成项目事实。模板里已经带上了本项目的默认 Flow 与第一个模块；`paths` 与每一个 classification 键要你自己回答。然后运行 `xforge state --change <id>`。

   每一个 classification 键都依据工作本身回答，绝不依据你更想跑哪个 Flow。`moduleContract` 为真的条件是这个 Change 移动了**模块之间**的接口——一个签名、一个端点、一个别的模块会读的存储结构；它不是 `publicApi`——后者为真的条件是这个 Change 动了外部消费者已经依赖的东西：一个已发布的入口、一个有文档的端点、一个已发行的 CLI 选项。一个仓库之外根本触达不到的导出，无论从内部看多么显眼，都不是 public API；而模块边界之内的重命名，两个键都不是。**为了消除一次拒绝而不诚实地回答某个键，是本 Stage 事后唯一无法发现的失败。** 当 `moduleContract` 为真、而所选 Flow 没有任何 Stage 声明接口 delta 时，会被以 `XFORGE_FLOW_TOO_WEAK` 拒绝——**那次拒绝正是这个键在起作用，不是一个要清掉的错误**：它会点名哪个 Flow 能承载这个 Change，而 `xforge explain XFORGE_FLOW_TOO_WEAK` 会说明为什么答 `false` 不是一道更松的检查，而是另一回事。

   只在 Propose 的 Artifact 与 Action 处于 ready 时继续，并先清掉由这个 Change 自己的文件引起的 schema 诊断。**本 Stage 权限之内清不掉的诊断——尚无后续 Artifact 锚定的 Requirement、本 Flow 承载不了其强制手段的 Rule——是报告，不是修复。** 为了消掉它而伸手到 Stage 之外，正是本 Skill 的「权限」一节要防的越界。未声明的验证 Gate 是例外，且它在第 6 步回答而不是这里：那是一个本 Stage 确实有权记录的项目级问题，只记录一次，且取自项目自己给出的答案。
4. 写 ready Action 点名的每一个 Artifact：写在它的 `writes` 路径，带上 `requiredSections` 列出的每一个 `##` 标题，并遵循`owes` 中该 Artifact 的 `instruction` 与 `outline`。标题逐字照抄——不要新增、改名或加限定语，因为 markers 与 reconcile 的取材都按标题原文定位。Requirement 使用稳定 ID，并给出成功、失败、边界与兼容性场景。不可把来源未声明的精确契约猜测写成规范事实；已有不可修改的验收测试定义了字段、输出形状或退出行为时必须逐项保持一致，测试与需求冲突则作为材料性歧义停止。
5. 每完成一个 Artifact 就重跑一次 `xforge stage --change <id>`；当下一个 Artifact Action 属于其他 Skill 时，**停止写 Artifact**。这不是本 Stage 的结束——第 6 步才是，而且要从这里继续走下去。
6. 运行 `xforge advance --change <id>`：它跑本 Stage 的 Gate，若无拒绝则执行转换。读它报告的内容。Gate 拒绝会阻止转换并点名自己——只修复 Propose 阶段的结构问题，绝不把提示性文本读成已通过的 Gate。当多个转换同时 ready 时它会反问，因为「前进还是返工」不是默认值能定的：用 `--to` 指明。

   `verification:<gate>:undeclared` 是这里唯一一个与本 Change 无关的 block。它说的是：本 Flow 排了一个「跑项目自己声明的命令」的 Gate，而项目一条都没声明——这个问题在任何 Change 存在之前就能回答，现在问是因为此刻回答它不花任何代价。它过去从本 Stage 起只作为提示出现、几段之后才拒绝，而一次实测把这条提示从这里一路带到 Verify 都没有处理，所以同一个事实现在改为阻塞。**它点名的每一个 Gate 一次性全部声明完**，用 `remedy.commands` 里的 argv——它已经代入了 gate id，只留下 `<program>` 空着，因为那个空正是只有人能填的部分：

   - **命令是项目的答案，不是你的。** 从项目对自己的陈述里取：需求文档、README、CI 配置。`--by` 写的是给出这个答案的人。
   - **不要因为 CLI 给了建议就采纳它。** 它读的是构建系统标记，不是这条命令有没有验证任何东西：`pyproject.toml` 会让它对一个用 `unittest` 的项目建议 `pytest`；而一个没有测试的仓库上的 test 命令能让 Gate 通过，同时什么都没断言。
   - **项目没有给出答案时，停下来问，并且真的停住。** 报告哪些 Gate 没有答案、需要人决定什么。一个看起来合理的猜测正是这个 block 要防的失败，而猜对了仍然是猜——那样 Gate 会变绿，同时断言的只是那条命令碰巧断言的东西，而且是永久性的、对之后每一个 Change 都成立。

# 证据

- 按 Action 的 `doneWhen` 与 `requiredEvidence` 报告 Change ID、Flow（默认值或被覆盖，被覆盖时说明原因）与 classification、实际文件路径、假设，以及下一个合法 Action。
- 只有当前 CLI 输出能证明结构、policy 与路径校验结果。

# 停止与返工

- 在未知模块、路径/身份/协议诊断、材料性歧义、Flow policy 不满足或权限边界处停止。
- 当某条诊断就是挡住你的那个东西、而它那一行不够用时，运行 `xforge explain <XFORGE_CODE>`。它给出该 code 的严重度以及它能携带的**每一条**消息——同一个 code 会从多个地方抛出，你没见过的那条措辞正是在告诉你它还有另一个成因。不要从 code 的名字去猜它的含义。
- 上游事实改变时交给 `xforge-revise`；不要在本 Skill 中顺便实现。

# 判断要点

- Flow 默认值存在的意义就是让常见情况不需要专门做风险分类推理；覆盖默认值才是例外路径，覆盖了却不在 Proposal 里说明，在后来者看来会像是疏漏，而不是一次深思熟虑的决定。
- 一条需求对作者本人读起来很清楚，但只有掌握了未写明的实现细节才能理解，对别人来说就不算可测试。要写出一个完全不了解这个 Change 背景的评审者，仍能对照实际运行系统去验证的场景。
