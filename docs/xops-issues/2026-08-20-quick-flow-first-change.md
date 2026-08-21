# XOps 首个 Change 的完整实测反馈

> 来源：XOps 项目（`github.com/openatta/XOps`）的 Change `repo-skeleton`
>
> 日期：2026-08-20
>
> 提交人：xbitshans

## 环境

| 项 | 值 |
|---|---|
| CLI | `@xforge/cli 0.7.16` |
| Protocol | 2 |
| Scaffold | 0.7.16，`--language zh-CN` |
| 投影目标 | `claude`（Claude Code） |
| Flow | `quick`（manifest 默认为 `solid`，本 Change 显式覆盖） |
| 运行环境 | macOS，Node v26.7.0，pnpm 11.22.0 |

## 这次实测覆盖了什么

一个从 `xforge init` 开始的空项目，走完了第一个 Change 的全程：propose → apply → verify → ready-to-archive → archive。期间发生 **7 次 stage 转换**（含 **2 次 rework**）、**2 次人工审批**、**1 次 `verification declare`**、**多轮 `check`**。

Change 本身是仓库工程骨架（pnpm workspace、TS 编译基线、三条命令、CI），6 条 Requirement、13 个 Scenario，最终归档成功。

**下面的问题全部来自这一次真实执行，不是设想。** 按代价排序。

---

## ISSUE-1：`ready-to-archive` 是一条单向死路（严重）

### 现象

转入 `ready-to-archive` 之后修改了 assurance（为消除一处 digest 自引用），转换回执与 `contentRevision` 失配，`archive` 报：

```
XFORGE_ARCHIVE_GOVERNANCE_BLOCKED: Archive governance is blocked by transition:ready-receipt-stale.
```

随后穷举了该 stage 的全部转换目标：

```
ready-to-archive -> propose           : not allowed by the Flow
ready-to-archive -> apply             : not allowed by the Flow
ready-to-archive -> verify            : not allowed by the Flow
ready-to-archive -> ready-to-archive  : not allowed by the Flow
ready-to-archive -> archive           : not allowed by the Flow
```

唯一出口 `xforge archive` 要求回执当前有效，而回执**无法重新签发**；`transition` 与 `archive` 均无 `--force` 或 rework 选项。

### 代价

唯一可行的恢复手段是把 Artifact **逐字节还原**到回执签发时的 `contentRevision`（本例用 `git checkout <commit> -- <artifact>` 完成）。这个解法 CLI 没有任何提示，是靠推理得出的。

后果是：**该 Change 想做的 Artifact 修正永久无法进入**，归档记录里因此永久带着一条 marker 警告（见 ISSUE-2）。审批人也被迫多签了一次。

### 分析

触发原因是使用者的错误——在 transition 之后修改了 Artifact。但**"不存在恢复路径"是 Flow 的设计选择**，而这个选择似乎买不到对应的安全收益：

> 允许 `ready-to-archive → verify` 不会削弱任何治理。ApprovalReceipt 本来就绑定 `contentRevision`，退回重走必然使其失效、必然需要重新审批。禁止这条转换**没有多守住任何东西**，只是把一个可恢复的操作错误变成不可恢复的状态。

对比之下，`apply` 与 `verify` 都定义了 `reworkTo`，唯独 `ready-to-archive` 没有。

### 建议

1. 为 `ready-to-archive` 增加 `reworkTo: [verify]`（丢弃 ready 回执并强制重新审批，语义与现有 rework 一致）。
2. 若第 1 条不被接受，至少让 `transition:ready-receipt-stale` 的诊断消息携带**回执记录的 `contentRevision`** 与恢复指引，而不是只报告状态。

---

## ISSUE-2：Artifact 合规检查的时机过晚

### 现象

`quick` Flow 为 `proposal` 与 `assurance` 都声明了 `outline`，但只有 `assurance` 声明了 `markers`。实际表现：

- **proposal 缺少 outline 声明的 `## Impact and rollback` —— 全程零诊断**。propose 阶段的 `xforge check` 只回 `Structural validation passed.`
- **assurance 的 marker 不匹配，直到 `xforge archive --dry-run` 才第一次报告**：

```
XFORGE_ARTIFACT_MARKER_SECTION_MISSING: Artifact assurance declares marker
verification-coverage in section "Completeness", which this file does not contain.
```

此时已经完成 transition 并取得审批。

### 代价

这是最贵的发现时机。同一个问题在 propose 阶段报告的代价是数十秒；在归档前报告，代价是一次额外的人工审批，以及（因 ISSUE-1）一条永久留在归档记录中的警告。

### 建议

1. 把 outline 与 marker 的一致性检查前移到**产出该 Artifact 的那个 stage 的 `xforge check`**。
2. 明确 `outline` 的语义：目前它对 proposal 完全不生效（无 markers 即不检查），容易被理解为"声明了就会被检查"。要么统一检查，要么在文档中写明 outline 仅为提示、markers 才是约束。

---

## ISSUE-3：verification receipt 缺少 draft 命令（与 `work-package draft` 不对称）

### 现象

`evidence/verification-receipt.yaml` 需要人工填写四类字段——`contentRevision`、`gitHead`、以及每个 gate 的 `evidence` digest——而**这些全部是机器已知的**。

实测中因此犯了两次错：

1. 用 `grep -m1 '"contentRevision"'` 从 `xforge state` 输出里取值，抓到的是**某个历史回执中的** `contentRevision`，不是当前 revision（见 ISSUE-5）。
2. 把 gate digest 抄进 assurance 正文后，该文件内容变化导致 `contentRevision` 改变，**刚抄下的 digest 当场失效**——一个真实的循环依赖。

### 分析

`xforge work-package draft` 的存在理由正是"机器已知的部分不要手抄"。verification receipt 是纯机器数据，却没有对应命令，这是一处明显的不对称。

同时，"assurance 里不能记录 gate digest"这条约束是实测撞出来的，文档没有提示。

### 建议

1. 增加 `xforge verify draft-receipt --change <id>`：从当前 gate evidence 生成 receipt 骨架，人只需填 `status`。
2. 在 verify 相关文档中写明 Artifact 与 Evidence 的循环依赖：**任何写进 Artifact 正文的 digest 都会因写入行为本身而失效**。

---

## ISSUE-4：`--language zh-CN` 只投影了一半

### 现象

`xforge init --language zh-CN` 将 Skills 完整本地化，但 Flow 定义中的 `outline` 标题仍是英文：

```yaml
outline: |
  ## Completeness
  ## Correctness
  ## Coherence
  ## Gates and evidence
  ## Findings
```

而 marker 通过 `section: Completeness` 按标题文本定位。

### 代价

一个使用中文脚手架的项目，被迫在中文正文中插入英文小标题，否则 marker 定位不到内容。首次撰写时几乎必然写成中文标题并因此不匹配（本次即如此）。

### 建议

outline 随 `language` 一并本地化；或让 marker 支持按**段序**而非标题文本定位。

---

## ISSUE-5：`xforge state --text` 输出的不是 text

### 现象

`--text` 的输出是一个标着 `Data:` 的大 JSON。取一个字段（如 `governance.revision.contentRevision`）需要外部 JSON 解析器。

### 代价

ISSUE-3 中那次取错 `contentRevision`，直接原因就是试图用 `grep` 从该输出中捞值——JSON 里存在多处同名键，`grep -m1` 命中的是历史回执中的值。

### 建议

`--text` 真正渲染为可读文本；或提供 `--field <json-path>` 以便脚本安全取值。

---

## ISSUE-6：可用的审批路径只有"人去开终端"，而这件事没有提前说明

### 现象

`xforge approve` 的本地路径要求真实交互终端：

```
XFORGE_APPROVAL_INTERACTIVE_REQUIRED: Local approval requires an interactive terminal ...
For a non-interactive session, use an mcp provider instead.
```

在 Claude Code 中通过 `!` 前缀执行同样失败（其 stdin 非交互式 TTY）。审批人必须离开 agent 会话、另开终端窗口——本次发生了两次。

错误消息建议改用 mcp provider，但脚手架中唯一注册的 `enterprise-approvals` 指向一个不存在的服务。

### 需要肯定的部分

该占位文件的注释非常诚实，明确写出它会以 `XFORGE_APPROVAL_MCP_TOKEN_MISSING` 失败而**不是"假装能用"**。这个取舍是对的，不建议更改。

### 问题所在

`xforge doctor` **不报告**"当前不存在可用的非交互审批 provider"。对一个 agent 驱动的项目而言，"每次审批都要人工开终端"是一个显著的工作方式约束，却要到第一次审批时才发现。

### 建议

`doctor` 增加一条检查：当所有已注册的审批 provider 均不可用时予以报告，让人在项目起步阶段就知道审批的实际形态。

---

## ISSUE-7：强制 gate 的命令声明时机过晚

### 现象

`xforge init` 之后，`quick` Flow 的强制 gate `unit-tests` 没有任何命令声明。这一点直到**第一个 Change 走到 verify** 才暴露，表现为一个 `actor: human`、`status: blocked` 的 `declare-verification` 维护动作。

### 需要肯定的部分

该 gate **拒绝在无声明时通过**，并要求记录 `declaredBy`，同时明确写出：

> Every suggestion above is a starting point for a question, never an answer. Do not guess.

这一条在本次实测中**直接改变了交付质量**：顺着它才发现，若当时随手声明为 `pnpm run test`，该 gate 会在一个尚无任何测试的仓库上**绿得毫无意义**。这促成了后续补齐自动化测试与变异验证。这个设计不应更改。

### 问题所在

只是时机：它出现在第一个 Change 的中途，而不是项目初始化时。

### 建议

`xforge init` 时询问并记录，或由 `doctor` 提前报告"存在尚未声明命令的强制 gate"。

---

## ISSUE-8：`doctor` 的信噪比

### 现象

新初始化的项目上，`doctor` 唯一的输出是：

```
XFORGE_DOCTOR_UNUSED_FLOW: Flow major is not the Manifest default and is not used by any active Change.
XFORGE_DOCTOR_UNUSED_FLOW: Flow quick is not the Manifest default and is not used by any active Change.
```

其中 `quick` 正是本次即将使用的 Flow（当时尚无 active Change）。

### 分析

三条 Flow 中必有两条不是默认值，因此该警告在任何项目的起步阶段都必然出现，且使用者无法处理——只能忽略。**必然被忽略的警告会训练人忽略所有警告。**

### 建议

在不存在 active Change 时抑制该检查，或将其降级为 info。

---

## 实测中确认有效、建议保持不变的设计

这些在本次执行中起了实际作用：

1. **`unit-tests` gate 拒绝无声明通过**，并拒绝替人猜测（见 ISSUE-7）。它是本次交付质量提升的直接触发点。
2. **`xforge brief` 的三段式分割**——COMPUTED（结构化数据推导）/ EXTRACTED（Artifact 原文逐字）/ **NOT COVERED**（签署**不代表**审阅了什么）。最后一段主动缩小自身可信范围，很少见，很有价值。
3. **审批不接受 flag**：*"The decision is typed at the terminal; it cannot be supplied by a flag."* 这是整套设计的锚点——Agent 转述的"用户说批准"不构成审批。虽然带来 ISSUE-6 的不便，但方向正确。
4. **fail-closed 且无后门**：没有 `--force`、没有跳过。在 ISSUE-1 卡住时确实希望有，但若存在，大概率会被使用，本次的教训也就不会产生。
5. **占位资源诚实失败**而非静默假装可用（见 ISSUE-6）。

---

## 优先级建议

| 优先级 | ISSUE | 理由 |
|---|---|---|
| **P0** | ISSUE-1 | 唯一造成**不可恢复损失**的问题 |
| **P1** | ISSUE-2 | 代价最高的时机错位，直接导致额外的人工审批 |
| **P1** | ISSUE-3 | 与既有 `work-package draft` 的明显不对称，且已实际导致两次错误 |
| P2 | ISSUE-5、ISSUE-6、ISSUE-7 | 摩擦与发现时机问题，不造成永久损失 |
| P3 | ISSUE-4、ISSUE-8 | 体验问题 |

ISSUE-1 与 ISSUE-2 属于同一类：**工具已经知道答案，但选择在代价最高的时刻才说出来。**
