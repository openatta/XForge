---
name: xforge-verify
description: 用当前证据核验 Change 的完整性、正确性、一致性与 Gates，并在用户明确授权时预览后归档；用于验收 readiness、验证并关闭 Change，或归档一个已有当前验证回执的 Change。
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# 不变量

- 先运行 `xforge state --change <id>`，解析用户意图为 `verify-only`、`verify-and-archive` 或 `archive-current`；没有明确归档授权时只验证。
- 重读当前 revision 的 Proposal、delta/main Specs、可选 Clarifications/Design/Check report、实现 diff、工作包/deliveries、Constitution、Rules 和 Gates。
- 默认不修产品代码，不手写或篡改 Gate Evidence；实现变化会使旧验证回执失效。
- Archive 是独立的 `archive-write` 协议动作，不代表 deploy/release 权限。
- Reviewer/Agent 只能形成 assurance，不能签发 Approval；Machine Gate 只接受 CLI runner 生成并绑定当前 revision 的 Evidence。

# 权限

- 可写 Verify Stage `produces` 的 Artifact——assurance——以及 `evidence/verification-receipt.yaml`，后者是本 Stage 的 exit condition 而不是 Artifact。Gate Evidence（`evidence/*.json`）只能由 `xforge check` 生成；receipt 只引用这些 digest，不得把它们改写成自己的结论。
- 本 Stage 运行的 `builtin: declared` Gate 若尚无声明，用 `xforge verification declare` 记录本项目的答案——绝不自己编辑 `xforge/manifest.yaml`。本 Stage 就声明了这类 Gate（`unit-tests`，Major 下还有 `security-scan`），而只有一份声明能让它们通过，所以记录声明的权限属于这里。它仍然是用户的答案，不是你的：见「停止与返工」。
- 关闭一条没有 `reworkTo` 的未决 Check finding，必须用 `xforge findings resolve`，绝不直接编辑 `evidence/check-findings.yaml`——该 Artifact 属于 Check Stage，而这条命令正是让它的答案能在此处被记录下来的唯一途径。它记录的是用户的答案和用户的署名，不是你的。
- 只有 `verify-and-archive` 或 `archive-current` 的明确用户授权允许调用 `xforge archive`；先 dry-run，再执行原子同步与移动。
- 失败时只报告并返回 Apply rework；除非用户另行明确授权，不修改实现。

# 执行

1. 解析唯一 Change 和模式；若 `archive-current` 的 receipt 不属于当前 revision/Git HEAD/Flow/Gate versions，先重新 Verify。
2. 按完整性、正确性和一致性审查：把每个 Requirement/Scenario 映射到实现与自动化测试，把 Design/Constitution/Rules 映射到最终 diff。
3. 若存在工作包，要求每个包有有效完成 delivery，核对依赖 commit、实际写入边界、验证命令，并确认每项 `done_when` 都有精确一次的非空证据映射；高风险或跨系统结果使用独立 Reviewer。Reviewer 只读，无法自行写证据文件——必须由你逐字转录它的结论后再确认（见 `xforge-apply` 第 8 步）。
4. 运行 `xforge check --change <id>`，重新执行工作包验证和所有 mandatory Gates；重开 Evidence，核对 Change、命令、时间、退出状态、digest 与当前 revision。

   随后读 `evidence/check-findings.yaml`，找出 `status` 不是 `resolved` 且没有 `reworkTo` 的条目。这些是更早的 Stage 指向收尾审批人的提问，没有任何机制会把它们送回去——它们不是 blocker，没有 Gate 会报告——`xforge check --change <id>` 会把每一条列在 `nextActions` 里，并附上关闭它的那条 `findings resolve` 命令。把每一条交给用户，并用 `xforge findings resolve --change <id> --id <finding-id> --answer <用户的回答> --by <回答的人>` 记录他们的答案；绝不要自己编答案或署名，理由与 `verification declare --by` 相同。必须在**这里**做，在 receipt 之前：这次写入会改变 `contentRevision`，此刻的代价只是重跑一次 `xforge check`；而同样的修改若发生在第 6 步过渡之后，会让收尾回执变 stale、让绑定其上的审批作废，并且需要 `transition repair` 才能退回。
5. 生成 assurance。然后生成 verification receipt——必须在第 4 步的 Gate 全部通过**之后**，绝不能提前，因为它要点名那次运行记录下的 Gate。`evidence/verification-receipt.yaml` 不是内容 Artifact，而是本 Stage 的 `verificationReceipt` exit condition，由 CLI 对照磁盘上的 Evidence 判定。

   不要手抄，也不要手工拼装。运行：

   ```
   xforge verification finalize --change <id> --status passed --by <做出该断言的人>
   ```

   `change`、`contentRevision`、`gitHead` 以及完整的 Gate 引用集合都是 XForge 已经掌握的事实，它写下的正是稍后判定该 exit condition 所依据的同一份 Gate 集合。`--status passed` 是它唯一不肯替你计算的东西：那个字段是"本 Stage 已验证这项工作"的断言，由 CLI 填写就等于让它替你决定这份 receipt 本身要记录的那件事。

   它不是绕过检查的捷径。在记录某个 Gate 通过之前，它会从磁盘重读该 Gate 的 Evidence；只要本 Stage 引用的任何一个 Gate 相对当前 content revision 已过期、失败过、或从未运行，它就**什么都不写**，并分别指出该重跑、该修、还是该首次运行——那是三个不同的问题。它只写 `passed` 这一种状态；没有验证通过的 Stage 不产出回执。

   需要手工拼装回执时，`xforge verification draft-receipt --change <id>` 输出同样的事实而不写文件。

   它替你避开两个真实运行中付过代价的坑。其一，`xforge state` 里每份历史回执各带一个 `contentRevision`，靠肉眼或 `grep` 取值会拿到已被取代的那个；确需单独取值时用 `--field change.governance.revision.contentRevision`（并带上 `--change <id>`）。其二，引用只写 Gate 名，绝不写 digest——每个 per-run digest 都会随正常推进而变化，抄下来的那一刻起就在失效。不要加 `evidence:` 这一行，没有任何代码会读它。

   本 Stage 每个通过的 Gate 都要引用一次——不得遗漏、不得引用其它 Stage 的 Gate。`gates` 只放 Gate；work-package 交付写在 `workPackageDeliveries`（`package`、`delivery`、`dispatch`、`status`、`verifyCommand`、`exitCode`），写成 `gates` 的一行会被以 `gate-unverifiable-<name>` 拒绝。之后若再改动任何 Artifact，必须重跑 Gate 并重新 draft——写入动作本身会改变 `contentRevision` 并使 Evidence 变 stale。任一 mandatory Gate、Requirement 或关键约束未验证时请求 `apply` rework Transition；不得手写 Gate PASS。
6. Gate 和 Artifact 满足后调用 `xforge transition --change <id> --to ready-to-archive`；`verify-only` 到此停止，并报告 Closing Approval 与 Audit blockers。
7. 已获当前 revision 的人类/外部 Closing Approval 后运行 `xforge audit verify --change <id>` 和 `xforge archive --change <id> --dry-run`，展示完整 Specs merge/move 计划、冲突和显著兼容影响；仅在 Approval、Audit、Gate 全部当前且计划无错误时运行 `xforge archive --change <id>`。
8. 归档后运行 `xforge state`，确认 Change 离开 active set、主 Specs 可见且 Evidence 位于归档目录。

# 证据

- 输出 Requirement/Scenario、实现、测试、Design、工作包和 Gate 的可定位映射，以及 receipt 的 `contentRevision`、`gitHead` 和它引用的 Gate。
- 只有所有当前 mandatory Gate 成功且没有 blocker 时，才能声明 ready for archive；只有 CLI 原子事务成功才能声明 closed。
- 在关闭审批之前，运行 `xforge check --change <id>`，把其中的 `XFORGE_RECONCILE_*` 条目交给用户。每一条陈述的是这个 Change 的记录与它的文件之间的一处差异；回应它们，而不是重新措辞。

# 停止与返工

- 在不完整实现、失败 Gate、无效 delivery、stale receipt、Spec 冲突、路径安全问题、目标碰撞或未授权归档时停止。
- 遇到 `XFORGE_VERIFICATION_NOT_DECLARED` 或 `XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED` 时，**停下来询问用户本项目如何运行该项检查**，再用 `xforge verification declare --gate-name <gate> --command '["<program>","<arg>"]' --by <回答问题的人>` 记录答案。该 Gate 有意不覆盖的工具链改为记录 `--not-applicable <marker> --justification <理由> --by <人>`。这里有两件事不可让步。**不得猜测，也不得因为 CLI 给了建议就采用它**——它读的是构建系统标记，判断不了一条命令是否真的在验证什么；在一个没有任何测试的仓库上，一条测试命令照样能让这个 Gate 变绿而什么都没断言。**不得手工编辑 `xforge/manifest.yaml`**：该文件受 `protected-manifest` PermissionPolicy 管辖，而一次实测手写该块时缩进少了一级，此后治理 dispatcher 再也读不了 Manifest，于是拒绝了每一次工具调用——包括本可以修复它的那些。命令会写好该块、自动填 `declaredAt`，并且宁可拒绝也不会产出一份加载不了的 Manifest。Major 下要**一次把两个** declared Gate 都声明：只声明 `unit-tests` 会让 `security-scan` 在若干回合之后、在已经收过审批的归档路径上才失败。
- 遇到 `condition:independentReview:review-missing`：本 Change 欠一次独立复核，且没有 work-package plan 可供按包形态挂靠。让复核者读交付的 diff，把它返回的结果**逐字**转录到 `<change>/evidence/review/<name>.md`——必须放在该目录下，才能随 Change 一起归档——然后运行 `xforge review acknowledge --change <id> --evidence <该路径>`。没有 `--by`：actor 取自环境。`review-stale` 表示已有复核记录但其后工作又变动了，需针对当前内容重新复核并再次确认。`unreviewed-<package>` 属于按包形态，见 `xforge-apply` 第 8 步。
- 处于 `ready-to-archive` 时没有任何前进或 rework Transition：它是合成 Stage，不在 `flow.stages` 里，因此 `xforge state` 报不出合法目标。这不是卡死，而是 Stage 层面已无可走。若此时仍需修改 Artifact，`xforge archive --dry-run` 会指出出路：`xforge transition repair --change <id> --receipt <receiptId>` 丢弃收尾那一张回执，把 Change 退回该转换离开的 Stage。它**不是 `--force`**：只允许丢弃叶子回执，丢弃了什么会记入审计链，并且归档审批会随之失效——审批绑定的是它被给予时的内容。在把 Change 报告为受阻之前，先读 CLI 给出的这条补救。
- 在 approval provider 配置失败（`XFORGE_APPROVAL_PROVIDER_FORBIDDEN`、`XFORGE_APPROVAL_MCP_SERVER_MISSING`、`XFORGE_APPROVAL_MCP_TOKEN_MISSING`、`XFORGE_APPROVAL_MCP_CONNECTION_FAILED`）时停止：provider 未配置，不是决定仍在等待。告知用户配置其 McpServer 与 token（见 `scaffold/mcp-servers/`），或改在终端本地审批；绝不对同一个 provider 反复重试。
- 审批命令一律从 `state.nextActions[].command` 里取，不要照 usage 字符串自己拼。`--for` 填的是该审批所解锁的那次 transition——Flow 里的 Stage id，绝不是 `stage` 这类字面词；填错过去会把真实的人类签字消耗在一份不会被计数的 receipt 上。`XFORGE_APPROVAL_TRANSITION_UNKNOWN` 与 `XFORGE_APPROVAL_TRANSITION_UNAPPROVABLE` 表示参数错了、且什么都没写入：改参数，不要重跑，更不要再请人签一次。`xforge approve ... --dry-run` 不需要终端、也不惊动审批人，就能把这些先校验一遍。
- 归档时出现 `audit:remote-pending` 要停止：远端 audit 投递被设为 required，而 `XFORGE_AUDIT_ENDPOINT` 未设置或不可达，`audit retry` 没有可投递的去处。应告知用户配置该 endpoint（以及 token/HMAC 环境变量），或不再对该 assurance level 要求远端投递；绝不反复重试。
- Verify 失败返回 Apply；governing artifact 自相矛盾时按 State 的 `reworkTo` 返回更早 Stage，**经由 `xforge-revise`**——它会一致地修订受影响的 Artifact，并让 digest 链使依赖它们的 Evidence 失效。直接改 governing artifact 会让 Change 的其余部分静默地与它不一致。

# 判断要点

- 一个 mandatory Gate 通过是可以归档的必要条件，不是充分条件——Gate 只检查它被写来检查的那件事。一条 Requirement 可以拥有完整测试覆盖、Gate 也是绿的，但测试断言的其实是错的行为；要核对 Scenario 的意图和测试实际检查的内容是否一致，不能只看它跑过且退出码为零。
- 一份每条 `done_when` 都填了引用的 `done_when_evidence` 映射看起来像证据，但引用本身可能和它要证明的结论无关——比如一条日志只证明某个函数执行过，不证明它产出了正确结果。接受这份映射之前要看引用实际展示了什么，不能只看每一项是不是都填了。
