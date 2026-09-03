---
name: xforge-check
description: 对 Solid 或 Major Change 做实现前跨 Artifact 语义审查，检查完整性、一致性、可测试性、风险与可实施性；用于 State 返回 ready Check Action 或规划需要正式质量门时。
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# 不变量

- **进入**用 `xforge stage --change <id>`。它一次返回：Change 在哪、ready 的 Action 及其 `writes`/`requiredSections`，以及 `owes` 下这个 Stage 仍欠的每个 Artifact 及其 `instruction`/`outline`、**该 Action `inputs` 的正文**、Constitution 正文，以及诊断。不要再单独去打开那些输入——它们已经到了。每写完一个 Artifact 重跑一次，而不是另外去问「变了什么」。 它同时携带本 Stage 声明了什么——产出、Gate、exit 条件、返工路线——所以**不需要打开 `xforge/flows/*.yaml`**：那个文件 400 行，而你要去那里找的 outline，Action 里已经有了。
- `xforge-check` 做语义审查；`xforge check` 提供 schema、路径、Gate 和 Evidence 的确定性输入，二者不能互相替代。
- 默认只读 governing artifacts；发现问题时报告 rework，不在审查中悄悄改写上游。
- Check report 是 LLM Review Evidence，不是 Gate Evidence；即使写出 `PASS` 也不能通过 Machine Gate、Transition 或 Approval。
- Gate Evidence 绑定 Gate 运行当刻的 content revision。**必须在最后一次写入之后**、一次性运行 Gate。先跑一个 Gate、再改 Artifact、再跑下一个，会让先跑的 Gate 变陈旧：所有 Gate 都报 `passed`，Stage 却仍然出不去。

# 权限

- 只可写 Check Stage `produces` 的 Artifact：`check-report.md`、`evidence/check-findings.yaml` 和 `evidence/constitution-check.yaml`。两个台账都由 Agent 撰写——没有任何 CLI 命令会生成它们，而 Stage 缺少它们就无法退出。
- 在受契约治理的 Flow 上，Stage 还必须满足 `contractDecisions` 这个 exit condition，`evidence/conditions/contractDecisions.yaml` 是同一类由 Agent 撰写的第三个台账。它位于 `evidence/` 之下，但同样不是 Gate Evidence。
- 不得写产品代码、Proposal/Specs/Clarifications/Design、工作包或 Archive。
- "Gate Evidence" 指只由 `xforge check` 写入的 `evidence/*.json`（`structure.json`、`check-findings.json`、`constitution-check.json`、`contract-compat.json` 等），绝不手写或修改。上面两个 YAML 台账是 Gate 读取的 Artifact，不是 Gate Evidence。

# 执行

1. 检查 Proposal/Specs 是否完整、明确、可测试，关键问题是否 resolved。
2. 检查 Design 是否覆盖所有 Requirement、约束、trust boundaries、失败场景、兼容性、迁移和回滚。
3. 核对测试、rollout、monitoring、stop signals、owner、path scope、依赖与并行边界是否匹配重大影响。
4. 把 `xforge stage` 已经返回的诊断作为证据输入。**不要为了拿诊断去跑 `xforge check`**：不带 Gate 选择时它还会执行每个工作包声明的全部 `verify` 命令——十个包的计划就是几十条外部命令、数分钟墙钟——而且它此刻产出的 Gate 结果本来就没有价值，因为那些 Gate 要读的台账还不存在。本 Stage 真正需要的那次 `check` 在第 9 步，写入之后。
5. 按 `owes` 中该 Artifact 的 `instruction` 与 `outline` 写 `evidence/check-findings.yaml`。字段集合、空列表的写法、`resolvedBy` 身份拿什么去比对，都由那两者给出，本 Skill 不再复述。本 Skill 欠你的是评审本身：这里记下的每一条 blocker 都意味着 Change 要退回某个 Stage，所以只记你愿意为之辩护的，不愿意的就不要记。
6. 按 `owes` 中该 Artifact 的 `instruction` 与 `outline` 写 `evidence/constitution-check.yaml`——每条原则一个条目，每条都要引用机器可定位的东西。依据这个 Change 实际做了什么去回答每一条原则；把 `not-applicable` 当成一个需要论证的主张，而不是绕开一条你还没想清楚的原则的出口。
7. 在受契约治理的 Flow 上，写 `evidence/conditions/contractDecisions.yaml`：每一处需要人来拍板的接口变更一条——通常就是 `contract-delta` 声明的每个破坏性变更——字段名恰好是 `question`、`decision`、`decidedBy`、`decidedAt` 四个。没有别名：`resolvedBy` 与 `approvedBy` 属于上面两个台账，在这里完全不被读取；而且拼错键是静默的，这个文件不像 findings 台账那样会给出近似拼写提示。`decidedAt` 必须能被解析为日期，`decidedBy` 必须命中本 Change 某份 receipt 上的审批人或它的某个 Git 作者——与上面同一条标准，也同样在两者都还不存在时暂时放行。**不要自己替人做这些决定。** 一条写着某人名字的记录就是那个人的授权，替他写就是记录一份没人给过的授权。把问题交给用户，写下他们的回答。本 Change 没有需要拍板的接口变更时，整份文件就是 `entries: []`，那是一条断言而不是一处遗漏。CLI 会把缺口原样报成 `condition:contractDecisions:<reason>`——`undecided-N` 会点名是哪几条，`ledger-missing-expected-resolved` 表示文件根本不存在。
8. 受契约治理的 Flow 在 Check Stage 还会跑 `contract-compat`，它是一道 declared Gate：在本项目用 `xforge verification declare --gate-name contract-compat --command '[...]' --by <人>` 记录命令之前，它是拒绝而不是放行。这种拒绝在 `blockedBy` 里表现为 `gate:contract-compat:failed`，与真失败无法区分——看诊断码，不要看阻断词，也绝不要为此手改 `xforge/manifest.yaml`。
8b. **`check-report.md` 最后写，在两份台账之后。** 它的 `Gates and evidence` 段落记录的是 `xforge check` 实际报告了什么，而 Gate 是对着台账评估的——所以先写报告就必然引用尚不存在的结果，事后订正又会推动 content revision、把它刚引用的 Gate 弄陈旧。会收敛的顺序是：先台账，再一次 `check`，再写引用它的报告，最后第 9 步那次 `check`。四次实测都是靠试错发现这一点的；那次先写报告的运行，花了三轮「改—重跑」才走出来。
9. 在 `check-report.md` 与各个台账都写完之后，再运行一次 `xforge check --change <id>`，它会对最终内容重新运行并刷新当前 Stage 的整个 Gate 集合；`--all-gates` 还会运行 Change 尚未到达的 Stage 所属的 Gate，那些 Gate 不可能通过，Stage 中途通常不需要这样做。若只需刷新其中一个 Gate（`XFORGE_GATE_EVIDENCE_STALE` 在后续写入使其过期后要求的正是这个），运行 `xforge check --change <id> --gate <gate-id>`。
10. 刷新 State；有 blocker 时请求 State 指定的 rework Transition；无 blocker 时仍由 CLI Gate 与 Approval 决定是否可运行 `xforge transition --change <id> --to apply`。

# 证据

- 报告跨 Artifact 映射、CLI 检查结果、未覆盖 Requirement/风险和可实施性结论。
- 只有 blocker 为零且 Action `doneWhen` 满足时才能声明 Check satisfied。
- 在放行实现的那次审批之前，运行 `xforge check --change <id>`，把其中的 `XFORGE_RECONCILE_*` 条目交给用户。每一条陈述的是本 Stage 自己的账本与文件之间的一处差异——回应它们，不要与它们争辩。不要用自己的话复述：它们本来就只有一行，把一处已陈述的差异重新措辞，就是把它变成一个观点。

# 停止与返工

- 在材料性遗漏、矛盾、范围漂移、不可测试 Requirement、缺少 rollback 或路径/owner 冲突时停止。
- 按最早受影响点返回 Propose、Clarify 或 Design，**经由 `xforge-revise`**——它是修改上游 Artifact 的正规路径：一致地修订受影响的 Artifact，并让 digest 链使依赖它们的 Evidence 失效。直接改上游 Artifact 会让 Change 的其余部分静默地与它不一致。
- 不检查不存在的长期任务计划。

# 判断要点

- "评审通过"和"CLI Gate 是绿的"是两句不同的话。一份 Design 完全可以内部自洽、写得很好，却因为某条 Requirement 完全没有测试策略而在 Check 里不通过——单个 Artifact 内部一致，不代表所有 Artifact 之间彼此覆盖。
- 缺失的反面场景（失败路径、边界条件、兼容性破坏）最容易被漏掉，因为一份看起来干净的 Design 里，没有任何东西会主动指出"这里本该有、但没有"。要检查的是本该存在却不存在的东西，不只是已经存在但写错的东西。
