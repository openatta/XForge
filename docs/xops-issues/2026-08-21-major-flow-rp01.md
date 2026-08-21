# Major Flow 首次实测反馈：RP-01 平台基座

> 承接 `2026-08-20-quick-flow-first-change.md`（quick flow / 首个 Change）。
> 那份报告的 8 条已全部处置并发布于 0.7.17。**本项目仍固定在 0.7.16**，因此其中
> `transition repair` 与 `verification draft-receipt` 两个新命令在本次实测中不可用；
> 凡与它们相关的痛点，本报告只作版本说明，不重复上报。

## 环境

| | |
|---|---|
| CLI | `@xforge/cli@0.7.16`（protocol 2），manifest 固定 |
| Flow | `major`（前一次实测是 `quick`） |
| Change | `rp-01-platform-foundation`，已于 2026-08-21 归档 |
| 规模 | 57 条 Requirement / 151 个 Scenario / 440 个自动化测试 / 12440+ 行 |
| 治理量 | 29 次 transition、10 份人类审批回执（4 轮 implementation-major + 1 轮 closing-major）、1078 条审计事件 |
| 独立复核 | 4 轮，共 3 blocker / 6 major / 21 minor |

这次覆盖了 quick flow 走不到的部分：`clarify` 与 `check` 两个 Stage、`materialQuestions`
与 `check-findings` 两个台账、`implementation-major` 的多轮失效与重签、`independentReview`
退出条件、以及**没有 work-packages.yaml 时的 Major 交付形态**。

---

## ISSUE-1：`independentReview: complete` 在没有工作包时形同虚设（严重）

### 现象

`flows/major.yaml` 的 verify 出口声明：

```yaml
exit:
  conditions:
    verificationReceipt: passed
    independentReview: complete
```

该字段旁边的注释写明了它被加入的理由：

> Major declares three semantic reviews and ships a reviewer sub-Agent, but nothing ever
> required one: `succeeded` alone satisfied the control plane, so a high-risk Change could be
> designed, implemented, reviewed and signed off by a single executor. This makes the Reviewer
> acknowledgement a condition of leaving Verify.

**本次 Change 从未记录过任何 reviewer acknowledgement，`ready-to-archive` 照常解锁、归档照常成功。**

可核验的事实：

1. 本 Change **没有** `work-packages.yaml`（见 ISSUE-2），因此从未调用过
   `xforge work-package acknowledge --as reviewer`。
2. 归档目录下 `evidence/agents/` 里只有两份主 Agent 手工转录的 `.md`，不是 Skill 描述的
   `review-<execution>.yaml`，也不与任何工作包关联。
3. 审计索引里 `reviewer` / `acknowledge` / `independentReview` / `review` 四个字符串
   出现次数**均为 0**。
4. 全部 29 份 transition 回执**没有任何一份带 `conditions` 字段**。
5. 最关键的一条对照：在 `verify` 阶段，`condition:verificationReceipt:receipt-missing`
   **确实出现在 `blockedBy` 里**并挡住了转换；而 `condition:independentReview`
   **从头到尾没有出现过一次**。

也就是说：同一个 `exit.conditions` 块里，一条被求值并生效，另一条没有。

### 两种可能的成因，我无法区分，但后果相同

- **要么**它根本没有被求值；
- **要么**它被求值但**真空成立**——因为记录 reviewer 结论的唯一机制
  （`work-package acknowledge --as reviewer --evidence <path>`）绑定在工作包上，
  而没有工作包时就没有任何东西可以确认，条件因此恒真。

第二种读法更值得担心，因为它是**结构性**的：`xforge-apply` 明确允许"单一小任务使用
Main Agent 的内部短计划"，即合法地不产出 `work-packages.yaml`。于是——

> **一个高风险 Major Change，只要选择不用工作包交付，就自动失去 `independentReview`
> 的全部强制力。** 而这恰好是该条件的注释所说的、要防的那个场景：
> 「designed, implemented, reviewed and signed off by a single executor」。

本次实测里真的做了四轮独立复核（并且抓到了 3 个 blocker，其中一个是"平台没有任何登录
入口、真实部署下无人能拿到 MCP 令牌"），所以结果无碍。但**控制平面没有要求过它**——
我完全可以一轮不做直接归档，CLI 不会有任何反应。

### 建议

1. 让 `independentReview` 在**没有工作包时**也有可满足的路径，且**不满足即阻塞**。
   最小改动是允许一份 Change 级的 reviewer 确认（例如
   `xforge review acknowledge --change <id> --evidence <path> --by <name>`），
   与工作包级的 acknowledge 并存。
2. 无论采用哪种机制，请让该条件在 `state.readyTransitions[].blockedBy` 里**可见**——
   一条从不出现在 `blockedBy` 里的退出条件，与不存在没有区别，而 `verificationReceipt`
   已经证明这个通道是通的。
3. 建议在 transition 回执里落 `conditions` 字段。现在回执记录了 `gates` 与 `approvals`，
   唯独不记条件求值结果；归档之后无从回答"当时那条条件是怎么过的"。

---

## ISSUE-2：选择"全部做完再提交"，会静默失去整套工作包治理（严重）

### 现象

使用者要求"实现全部完成后再提交"（这在真实开发里很常见：不希望主干上出现半成品）。
而工作包的派工契约要求**每个 ready 包固定同一可信 base commit、创建独立 worktree**，
delivery 记录也要引 `base...head` 的真实 diff。二者不相容：实现尚未提交时，
worktree 里根本没有前序工作包的产出。

于是本次 Major Change **完全没有使用工作包**：主 Agent 用 runtime 原生子 Agent
在同一棵树上并行两个包，写入边界由 prompt 传递、由主 Agent 对真实 diff 事后核验。

**CLI 全程没有任何提示。** 没有 warning、没有 info、doctor 也不报。

### 代价（连锁的，且都是静默的）

| 失去的 | 后果 |
|---|---|
| dispatch receipt | delivery 里的 `execution_id` / `state_revision` / `policy_snapshot_digest` / `audit_correlation_id` 全部无从填写 |
| delivery records | 没有可核对的完成记录与 `done_when_evidence` 映射 |
| worktree 隔离 | 写入边界只由 prompt 传递，**不是** CLI 强制 |
| Constitution 的并行研发条款 | 「并行工作包写入路径互不重叠」在本形态下**无可核对的记录**，独立 Reviewer 四轮均将其列为「无法验证」 |
| **`independentReview`** | 见 ISSUE-1——同一个选择顺带关掉了它 |

最后一行是我认为最需要重视的：**一个关于提交节奏的工程偏好，静默地关掉了两处治理机制**，
其中一处还是 Flow 专门为防止"单人自审自签"而加的。

### 分析

我不认为该强迫使用者改变提交节奏。工作包的价值真实存在，但它把三件事捆在了一起：

1. 并行调度（谁能开工）
2. 写入边界的**强制**（worktree 隔离）
3. 交付证据（delivery、done_when 映射）

只有第 2 项真的需要"已提交的 base commit"。第 1、3 项不需要。

### 建议

1. **至少让这个降级可见。** 当 Change 处于 `apply` 且无 `work-packages.yaml` 时，
   `state` 或 `doctor` 给一条 info：说明哪些治理机制因此不生效
   （尤其点名 `independentReview` 与 Constitution 的并行条款）。
   这条建议成本极低，收益是把"静默消失"变成"知情选择"。
2. 考虑允许一种**不依赖 base commit 的工作包形态**：仍产出计划与 delivery 记录、
   仍做写入边界的事后 diff 判定，但不创建 worktree。`xforge-apply` 已经描述了
   "Adapter 为 degraded 时顺序执行并报告能力降级"这条路径——现状是这条路径**只存在于
   Skill 的散文里，CLI 侧没有任何对应物**。

---

## ISSUE-3：审批回执无法承载它被指向去回答的问题

### 现象

Major 的两处机制都会把问题**明确指向审批人**：

- `design.md` 的 `deferred-question` marker（`**留待 Check 决议：`）；
- `check-findings.yaml` 里 `reworkTo: null` 的 open finding。

本次有两条这样的问题（`CHK-010`：是否接受单实例部署形态、什么信号触发换库；
`CHK-011`：某条纪律是否落成项目 Rule）。Design 白纸黑字写着由 `implementation-major`
的审批人回答。

而 `xforge approve` 能记录的只有一个自由文本 `reason`。结果是：

> **10 份人类审批回执，`reason` 全部是 `"good"`。两条问题至今 `status: open`。**

使用者在会话里口头答过，但那不在任何被 Gate 读取的记录里；归档之后
`check-findings.yaml` 也再改不了（`ready-to-archive` 单向，见版本说明）。
最终归档记录如实呈现的是：**两个问题指向审批人、审批人没有留下答案。**

### 这不只是"人偷懒"

本次 Major 因四轮独立复核，前后**重签了四轮 `implementation-major`**——每次 Spec 或
Design 改动都会变更 `contentRevision` 并使旧回执失效（这个机制本身是对的，我不建议改）。
但它带来一个副作用：

> 审批人被要求对**同一个 Change** 反复签字，而每次签的都是"整体"，没有"这次变的是什么"
> 的呈现，也没有任何字段承载对未决问题的回答。回执的信息量因此收敛到 `"good"`。

`xforge brief` 做得很好——它把 CLI 算出的事实与 Artifact 原文分开呈现，这是本次实测里
最有用的单个命令。但它是**只读**的：读完之后，审批人没有任何结构化的地方写下回答。

### 建议

1. 让 `xforge approve` 能对**具名的开放条目**作答，例如
   `--answers CHK-010="接受单实例；换库触发条件待定" --answers CHK-011="不落本地 Rule"`，
   并把答案写进回执、同时把对应 finding 标为 resolved（`resolvedBy` 取审批人身份）。
   这样"Design 把问题指向审批人"才真正闭环。
2. 若第 1 条太重，**至少**在 `brief` 的 `WHAT IS BEING DECIDED` 段里显式列出
   "这次审批被要求回答的开放条目"，让审批人看见它们的存在。现在 `brief` 会列出
   open findings 的摘要，但没有指明其中哪些**在等这次签字**。
3. 多轮重签时，`brief` 若能呈现"相对上一份已签回执的 Artifact 增量"，会大幅提高
   第 2、3、4 次签字的实际含金量。

---

## 与前一份报告的关系

| 前报告 ISSUE | 本次是否复现 | 说明 |
|---|---|---|
| **1** `ready-to-archive` 单向死路 | **复现** | 本次在 `ready-to-archive` 想补 findings，三个方向全被 `XFORGE_TRANSITION_INVALID` 拒。已在 0.7.17 由 `transition repair` 修复，本项目固定在 0.7.16 故不可用。**不重复上报。** |
| **3** verification receipt 缺 draft | **复现** | 手写 receipt、手抄三个 gate digest。0.7.17 已加 `verification draft-receipt`。**不重复上报。** |
| 2 / 4 / 5 / 6 / 7 / 8 | 未构成阻碍 | — |

**一处对前报告的补充**：ISSUE-1 的修复方向（`transition repair`）我认为是对的，但本次的
触发场景与前一次不同——前一次是"transition 之后改了 Artifact"（使用者操作失误），
本次是**在完全合规的状态下，事后才发现某条 Artifact 需要补内容**。后者不是失误，
是复核天然会带来的结果。`repair` 能救，但值得在 `archive --dry-run` 的输出里
主动提示"进入此状态后 Artifact 将不可再修改"，让人在跨过那一步之前就知道。

---

## 本次实测中确认有效、建议保持不变的设计

1. **审批绑定 `contentRevision` 而非 `gitHead`。** 四轮返工中它精确地做了该做的事：
   Spec 或 Design 一改，旧签字立即失效；纯代码提交不触发重签。这个粒度是对的。
2. **`xforge brief` 的三段式分割**（COMPUTED / RECONCILIATION / EXTRACTED）。
   RECONCILIATION 抓到过一次真问题：`design.md` 的 declared-gap marker 没有指名
   可被 finding 引用的主体。**这条我自己读三遍都没发现。**
3. **Gate Evidence 绑定运行当刻的 content revision。** 它拦下了一次真实错误——
   我在跑完 Gate 之后才写 `assurance.md`，Gate 随即变 stale。独立 Reviewer 也据此
   发现过一次"证据停在四个提交之前"。这个约束不该放宽。
4. **`unit-tests` Gate 拦下了一个开发机上绿、Gate 里红的 flaky 测试。** 值得记录：
   Gate 在这里的价值不是"再跑一遍测试"，而是在一个与开发机不同的时序下跑。
5. **declared Gate 拒绝无声明通过**（前报告已肯定）。本次 `security-scan` 因此在
   Check 阶段就被发现未声明命令——若拖到 Verify，就会发生在收过两次人类审批之后。
6. **materialQuestions 台账要求 `decidedBy` 具名。** 它有效地阻止了 Agent 代替人
   作材料性决定：本次 8 条 MQ 全部由具名的人拍板，包括一次推翻 Design 已写好方案的决定。

---

## 优先级建议

| | ISSUE | 理由 |
|---|---|---|
| **P0** | 1（`independentReview` 虚设） | 它是 Flow 为防止"单人自审自签"专门加的条件，而在一个合法的交付形态下完全不生效，且不可见 |
| **P1** | 2（工作包治理静默失效） | 与 P0 同源；即便不改机制，"让降级可见"也是低成本高收益 |
| **P2** | 3（审批回执承载不了答案） | 不阻塞交付，但它让归档记录里留下"问题指向了人、人没留下答案"的永久缺口 |

三条有一个共同点，也是我认为最该带走的一句：

> **本次治理机制真正失效的地方，都不是"它拒绝了不该拒绝的东西"，
> 而是"它在某个合法路径上安静地不起作用，且没有任何信号"。**
> 相比之下，所有 fail-loud 的设计（declared Gate、contentRevision 绑定、Gate 时效性）
> 在这次实测中无一失手。
