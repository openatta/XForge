# XForge 治理模型

> 这一页回答两个问题，前九节答第一个，后四节答第二个：
>
> 1. **治理机制本身**——Skill、Flow、Rule、Gate、Hook、PermissionPolicy、Approval
>    这七个名词各自到底能证明什么、由什么触发、以及为什么 XForge 从不让其中一个顶替另一个。
> 2. **被治理的两份记录**——Spec（产品必须做到什么）与 Contract（模块之间承诺了什么）。
>    这两者是同一套「基线 + delta + 归档合并」方案的两个实例，
>    也是唯一能跨 Change 存活的东西。见 §10–§13。
>
> 怎么新增治理资源见 [扩展指南](extension-guide.md)；整体架构见 [概念与架构](concepts-and-architecture.md)；
> 每份文件落在哪、归谁写见 [仓库与文件布局](repository-layout.md)。
>
> **以源码与随包脚手架为准。** 文中每条断言都对着
> `xforge/src/**` 与 `scaffold/payload/**` 复核过；两者与本文不一致时，以它们为准。

---

## 1. 一览表

| | 主要职责 | 由什么触发 | 想做到……就扩展它 |
| --- | --- | --- | --- |
| **Skill** | 面向 Agent 的、某一类工作的执行指令 | 用户直接要求，或 Flow 的 stage graph 点名 | 新增一种能力 |
| **Flow** | Change 走过的 stage graph 与绑在上面的治理规则 | Propose 时选定（manifest 默认值或显式覆盖） | 建模不一样的交付 / 风险流程 |
| **Rule** | 一条声明性指导，其「被强制执行」的声称会被**核实**，不是被采信 | 每次算 `xforge state` 都重新评估 | 让写下来的标准变得机制上诚实 |
| **Gate** | 确定性检查，产出与 revision 绑定的 Evidence | `xforge check`、Transition 或 Archive 之前 | 加一个客观的正确性 / 质量检查点 |
| **Hook** | 编程工具原生事件到 XForge 逻辑的接线 | 每一次匹配的工具调用或治理事件，实时 | 接入新事件，或插入自定义逻辑 |
| **PermissionPolicy** | 针对某个能力的 allow / ask / deny 决定 | 每一次匹配的工具调用（经 Hook），实时 | 实时拦下某个具体的危险动作 |
| **Approval** | 人类或外部系统的决定，绑定在当前 revision 上 | Flow stage 的 `exit.approvals` 或 `terminal.archive.approvals` | 嵌入一道真正的授权步骤 |

## 1.1 核心公理

> **一条 Rule 可以指导，一条 PermissionPolicy 可以守卫，一道 Gate 可以证明，
> 一次 Approval 可以授权——XForge 从不让其中一个顶替另一个。**

由此派生出你会反复遇到的一条规则：**只有 CLI 的 JSON 输出与 Gate Evidence 算事实。**
Agent 的自然语言结论、聊天记忆、勾选框、自报退出码，一律不是事实。
Reviewer 说 `PASS` 是一种 assurance，不是 Approval，也不是 Gate Evidence。

---

## 2. 两条独立轨道，不是一条流水线

最容易踩的错误心智模型是「Gate → Rule → Policy → Approval 在每个 Stage 里挨个检查一遍」。
实际上是**两条互不相通的轨道**，外加一层横切的诚实性检查。

```text
 ┌─ 轨道 A：阶段治理（只在有东西要求推进时评估）────────────────────┐
 │   Gate ──── 确定性检查，产出与 revision 绑定的 Evidence          │
 │   Approval ─ 人 / 外部系统的决定，绑在当前 governingRevision 上   │
 │                                                                 │
 │   触发点：xforge check / xforge transition / xforge archive      │
 │   大多数 stage 两者都没有，只有 Flow 作者明确接上的那几个才有       │
 └─────────────────────────────────────────────────────────────────┘

 ┌─ 轨道 B：实时运行时（持续运行，与 Stage 无关）────────────────────┐
 │   PermissionPolicy ─ 每一次匹配的工具调用都触发                   │
 │   Hook ──────────── 编程工具原生事件 → XForge 逻辑的接线          │
 │                                                                 │
 │   跟当前走到哪个 Stage、甚至有没有活跃 Change 都没关系              │
 └─────────────────────────────────────────────────────────────────┘

        ┌── Rule：横跨两条轨道之上，做的是「核实」，不是「把关」──┐
        │  声明 severity + instruction + 它声称由谁强制执行        │
        │  每次算 state 时，拿这个声称去和当下的真实情况对照        │
        └─────────────────────────────────────────────────────────┘
```

一次 `Write` 调用会被拿去跟 PermissionPolicy 比对，不管 Agent 当时是在 Propose、Apply，
还是根本没有打开任何 Change。

---

## 3. Gate：唯一能产出机器证据的东西

### 3.1 两种形态

```yaml
spec:
  builtin: structure | check-findings | constitution-check | declared
# 或
spec:
  command: ["pytest", "-q"]      # 任意语言、任意工具链
```

四个 `builtin`：

| builtin | 做什么 |
| --- | --- |
| `structure` | CLI 进程内的项目 / Change 结构校验（schema、引用、资格） |
| `check-findings` | Check Stage 的 findings 台账没有未解决的 blocker |
| `constitution-check` | 每条 Constitution 原则都被回答，violation 有理由且有具名批准人 |
| `declared` | 跑项目在 `manifest.verification` 下声明的命令；**没声明就拒绝** |

随包共 **9 份 Gate 资源**，分成默认选中与默认不选两档：

| | Gate | 形态 |
| --- | --- | --- |
| **默认选中**（`manifest.scaffold.gates`） | `structure`、`check-findings`、`constitution-check` | builtin |
| | `unit-tests`、`security-scan` | `builtin: declared` |
| **默认不选**（随包在磁盘上，要自己登记） | `contract-lint`、`contract-compat`、`contract-drift`、`module-boundaries` | 全部 `builtin: declared` |

后四道默认不选的理由写在 `manifest.yaml` 的注释里，而且是一条通用理由：
**`builtin: declared` 的 Gate 一旦默认开启，每个新项目都会在某个 Stage 出口被一道
它从没要求过的检查挡住**——契约方言按项目而异，CLI 给不出命令。
它们做什么、什么时候值得选中，见 §12。

> ⚠️ **`spec.required` 与 `spec.stage` 已废弃，CLI 不读它们。**
> Gate 的调度完全由 Flow 的 `stage.gates` / `stage.exit.gates` 与 archive 终态决定。
> 把 `required: false` 写上去**不会禁用一个 Gate**，只会看起来像能禁用。

### 3.2 「refuse ≠ fail」

`unit-tests` / `security-scan` 现在是 `builtin: declared`，跑项目声明的命令，**没声明就拒绝**。

> **拒绝是一个未被回答的问题，不是一次失败的检查。**

这条改动的来由值得记住：这两个 Gate 曾经是 `npm test --if-present`，
在没有 `package.json` 的项目上报告 `passed` 却什么都没断言——
于是一条 `must` 级 Rule 失去了它唯一的强制手段，一次归档的强制 Gate 是空的。
**把一个响亮的错误答案变成安静的错误答案，是更坏的结果。**

遇到 `XFORGE_VERIFICATION_NOT_DECLARED` 或 `XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED` 时：

- **停下来问用户本项目如何运行该项检查**，再用 `xforge verification declare` 记录答案；
- **不得猜测，也不得因为 CLI 给了建议就采用它**——它读的是构建系统标记，
  判断不了一条命令是否真的在验证什么；
- **不得手工编辑 `xforge/manifest.yaml`**（它受 `protected-manifest` 策略管辖，
  且一次实测里手写该块缩进少了一级，此后治理 dispatcher 再也读不了 Manifest，
  于是拒绝了每一次工具调用——包括本可以修复它的那些）；
- Major 下要**一次把两个** declared Gate 都声明，否则 `security-scan` 会在若干回合之后、
  在已经收过审批的归档路径上才失败。

### 3.3 Evidence 的形状与校验

```ts
{
  protocolVersion: '2', schemaVersion: '1',
  gate, change, flow, stage,
  stateRevision, contentRevision, policySnapshotDigest, gitBase, gitHead,
  inputDigest,
  runner: { name, version, integrity },
  command: string[] | ['builtin:structure'] | ['builtin:check-findings'] | ['builtin:constitution-check'],
  shell: boolean,                  // 默认 false：Gate runner 不经 shell
  workingDirectory, startedAt, finishedAt, durationMs,
  exitCode, timedOut, outputTruncated,
  stdout, stderr,                  // 有大小上限 + secret 脱敏
  status: 'passed' | 'failed',
  digest,
}
```

读取时三重校验：`digest` 自洽 **且** `evidence.gate === gateId` **且**
`evidence.change === changeId`，任一不满足就当作「没有这份 Evidence」。

**只有 XForge 的 Gate runner 能写 Machine Gate Evidence。** 手写的、digest 不合法的一律拒绝。

**Gate 通过证明的是「配置好的命令针对被记录的 revision 跑过了」，不证明每条语义需求都对。**

### 3.4 时序陷阱

Gate Evidence 绑定 Gate 运行当刻的 `contentRevision`。

> **必须在最后一次写入之后、一次性运行 Gate。**
> 先跑一个 Gate → 改 Artifact → 再跑下一个，会让先跑的那个变 stale——
> 结果是**所有 Gate 都报 `passed`，Stage 却仍然出不去**（`gate:<id>:stale`）。

`xforge check --change <id>` 会重跑当前 Stage 的**整个** Gate 集合。
`--all-gates` 还会跑 Change 尚未到达的 Stage 所属的 Gate，那些不可能通过，中途一般不需要。

---

## 4. Approval：唯一能授权的东西

### 4.1 两种产出方式，没有第三种

| 机制 | 怎么产出 | 性质 |
| --- | --- | --- |
| **local** | 真实 TTY 里 CLI 自己的 `readline` 对话，现场问身份 / 角色 / 决定 / 理由 | 仓库级自证，**刻意做成不能自动化** |
| **mcp** | 向 manifest 登记的外部 `McpServer` 提交并轮询 | 接企业审批系统 |

**不存在「导入签名文件」这条路。** `--actor` / `--role` / `--reason` 只是**预填建议**，
不是权威值；`--attestation human` 只是意图提示。

随包的 `enterprise-approvals` 是**故意跑不通**的占位（命令不存在），
未替换成真实系统前 `xforge approve --provider enterprise-approvals` 会以
`XFORGE_APPROVAL_MCP_TOKEN_MISSING` 大声失败，而不是静默假装工作。
**因此三档 Flow 今天在实践中都走 `local`**——这也是三条策略的 `providers`
都同时列了 `local` 的原因：否则新项目在接入外部审批系统之前会被完全锁死。

### 4.2 receipt 为什么可信（它没有签名）

```ts
{
  receiptId, change, flow, stage, transition, policyId,
  stateRevision, contentRevision, policySnapshotDigest, gitBase, gitHead,
  governingDigest, governingRevision,
  decision: 'approve' | 'reject',
  approver: { id, provider, role, type: 'human' | 'external-system' },
  decidedAt, reason, digest,
  attestation?: { method: 'cli-terminal', respondedAt },   // 只有 CLI 终端对话能设置
}
```

> receipt 本身**不携带**信任。信任来自项目自己的**防篡改审计哈希链**：
> `xforge approve` 在同一次运行里写 receipt 并追加一条匹配的 `approval.decided` 事件，
> **只有能在链里找到匹配事件的 receipt 才算有效**，且每次 state 加载都复验。

一份从未经过 `xforge approve` 的手工 receipt 文件，在链里没有对应事件，会被拒绝。
**Agent、Reviewer 和 Skill 都不能签发有效的人类 Approval。**

### 4.3 有效性判定

一份 receipt 要被计入有效集合，必须同时满足：

1. `policyId` 与 `transition` 对得上（`transition` 是该审批**所解锁的那次转换**的目标）；
2. `governingRevision` 等于当前值（老 receipt 没有这个字段时退回比较 `stateRevision`）；
3. 未过期；
4. `approver.provider` 在策略的 `providers` 里；
5. `approver.role` 在策略的 `roles` 里；
6. `decision === 'approve'`；
7. 开了 `separationOfDuties` 时，`approver.id` **不在** implementers 集合里。

**同一个人算一票。** 计数键是规范化（trim + 小写）后的 `approver.id`，
**不含 provider**——同一个人通过 local 和 mcp 两条路径签两次仍然是一个人。

### 4.4 `separationOfDuties` 的真实语义

> **职责分离 = 审批人不是本 Change 的 implementer。它从来不比较角色。**

implementers 取自：Change 目录的 Git author + 每个 work-package delivery 区间
（`base_commit..head_commit`）的 Git author。

`roles` 是**资格过滤器**——谁有资格审批——与职责分离是两件事。
早先的实现是数不同角色，那是个 bug：它既让 Change 的作者可以批准自己的变更，
又拒绝了最常见的真实评审形态——两个不同的 maintainer。

**推论：`minApprovers: 1` + `separationOfDuties: true` 是自洽的**，
含义是「一个人，且这个人不能是写这段代码的人」。

### 4.5 当前的审批布局

| Flow | 实现前审批 | 归档审批 | 每点人数 | SoD | roles |
| --- | --- | --- | --- | --- | --- |
| `quick` | — | `quick-close` | 1 | ❌ | owner / maintainer |
| `solid` | `planning-solid` @ check 出口 | `closing-solid` | 1 | ❌ | owner / maintainer |
| `major` | `implementation-major` @ check 出口 | `closing-major` | 1 | ✅ | owner / maintainer / security |

设计理由：

- **实现前审批收在 check 出口**，因为那是实现开始前的最后一刻，
  且两个台账（`check-findings`、`constitution-check`）都已写完。
  收得更早，审批人会在决定「规划是否成立」的证据存在之前签字。
- **major 是 1 人而不是 2 人，且这不是放松。** 承重的是
  `separationOfDuties: true`——它要求那一个审批人不是 implementer。
  第二个签名增加的是**第二个人**，不是**第二种审视**；每个 Major 都要两个签名，
  买到的是排队而不是评审。
- **评审本身没有交给一个签名。** major 另有 `independentReview` 出口条件，
  要求交付内容有一次可归属的复核。那个条件回答「有没有被评审、被谁评审」，
  这两条策略回答「谁授权它继续」。把 `minApprovers` 调回 2 是在重复第一个问题，
  而不是加强第二个。

---

## 5. Rule：把落差暴露出来

### 5.1 结构

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Rule
metadata: { name: observable-requirements-are-tested, version: 1 }
spec:
  severity: must | should
  instruction: <一句声明性指导>
  scope:
    modules: [...]      # 可选
    paths:   [...]      # 可选
    stages:  [...]      # 可选
  enforcement:
    gateRefs:     [...]   # 必填（可为空数组）
    policyRefs:   [...]   # 必填（可为空数组）
    approvalRefs: [...]   # 可选
```

**Rule 从来不会自己拦下任何东西。** 它声明自己**声称**由谁强制执行，
每次算 `state` 时拿这个声称去核对，产出 `coverage`。

### 5.2 coverage 的七个取值

```text
instructed    基线：只是一条写下来的指导
guarded       背后真有 PermissionPolicy
structural    背后真有 Artifact validator：CLI 在进程内校验，无 Gate 无 Evidence
verified      背后真有 Gate
approved      背后真有 Approval
uncovered     这条 Rule 没有引用任何机制
unenforceable 它引用了机制，但在当前 Flow 下那个机制不存在
```

后两个是「什么都没有」的两种说法，所以**只要有一道真实存在的 PermissionPolicy，两个都不出现**。
一条只靠 `policyRefs` 强制的 Rule 报 `guarded`，不报 `uncovered`——那道守卫是真的在拒绝写入，
说它「没有引用任何机制」等于在同一个数组里同时说 P 和非 P。

> **`structural` 夹在 `instructed` 与 `verified` 之间，是契约工作逼出来的真实第三种情况。**
> 一条由 Artifact validator 强制的 Rule，在文档被读到的那一刻就被 CLI 拒绝——什么都没运行，
> 所以没有 Evidence、没有任何绑定 revision 的东西可记。叫它 `verified` 就是把它摆在一个
> 它弱于的 Gate 结果旁边；叫它 `instructed` 更糟——那不是一句 Agent 可以不听的话，那是一次拒绝。
> 所以它两者都不是，并且直说。
>
> 声明方式是 `enforcement.validatorRefs`，用的是 `flow.artifacts[].validator` 的同一套 id。
> 和 `gateRefs` 一样会被解析：当前 Flow 没有任何 Artifact 带这个 validator，这条引用就解析为空，
> 不计入 coverage。

> **`unenforceable` 不是更弱的 `uncovered`，是另一句话。**
> `uncovered` 说这条 Rule 没有引用任何机制；`unenforceable` 说它引用了一个
> **在这个 Change 正在跑的 Flow 下并不存在**的机制——项目没有的 Gate，
> 或只有另一条 Flow 才定义的审批策略。
>
> 两者都以「有没有一道解析得到的守卫」为前提：有守卫就两个都不报。
> `interfaces-are-contract-governed` 在 `quick` 下曾同时报 `guarded` 与 `unenforceable`——
> 它的 `contract-delta` validator 在那条 Flow 上解析为空，而 `protected-files` 明明还在守着。
> 这不是一个偏保守的读数，是一份自相矛盾的报告。

这个区分是补出来的。在有区分之前，第二种情况**读起来是 covered**，
因为非空的 `approvalRefs` 被当成了「有东西在强制它」的证明——
一条指向 `planning-solid` 的 `must` Rule 在 `major` 下报告为已治理，
而那里根本没有这条策略，什么都没在检查它。

`state` 里还有 `enforceableRefs` 字段：`gateRefs` / `approvalRefs` / `validatorRefs` 中
**本 Flow 和本项目真的有**的那个子集。`policyRefs` 故意不在其中：一道被选中的
PermissionPolicy 是强制，`guarded` 报的就是它，但它不是这个字段一直以来的那三种绑定
revision 的强制，混进去会改变 `state` 一直在报的东西。守卫的作用在别处——它让
`unenforceable` 不成立。

判断「这条 Rule 有没有引用机制」的算法只有一份（`core/governance.ts` 的
`resolveRuleEnforcement`），资源加载与 `state` 共用。它们**可以**在解析强度上不同——
加载资源时没有 Flow 在场，解析不了审批策略与 validator，得到的是更粗的项目级答案——
但**不可以**在「数哪几个字段」上不同。之前是两份手工维护的清单，它们分别漏了
`validatorRefs` 和 `policyRefs`，各自产出一种自相矛盾的报告。

### 5.3 随包的四条 Rule

| Rule | severity | enforcement | 说明 |
| --- | --- | --- | --- |
| `governance-assets-are-integrator-only` | must | policyRefs: `protected-files`, `protected-manifest` | 与两条策略的 `match.paths` 保持 1:1 对齐 |
| `observable-requirements-are-tested` | must | gateRefs: `unit-tests` | 只有散文证据的需求不算已验证 |
| `design-decisions-need-a-human` | must | approvalRefs: `planning-solid`, `implementation-major` | 两个都列，才能在 solid 与 major 下都可强制 |
| `interfaces-are-contract-governed` | must | policyRefs: `protected-files` + validatorRefs: `contract-delta` | 在跑这个 validator 的 Flow（solid / major）下报 `guarded, structural`，`quick` 下只报 `guarded`；`gateRefs` 留空——四道契约 Gate 都是 `builtin: declared` 默认不选，而引用一道未启用的 Gate 会被 `XFORGE_RULE_GATE_DISABLED` 直接拒绝 |

`design-decisions-need-a-human` 值得单看：它的 `approvalRefs` **同时列了两条策略**，
因为这两条分别只存在于 solid 和 major。列一条就会在另一个 Flow 下变成 `unenforceable`。

在 `quick` 下它压根不出现。它的 `scope.stages` 是 `design, check`，而 `quick` 的三段是
`propose / apply / verify`，`ruleApplies` 在算 coverage 之前就把它滤掉了——`governance.rules`
里没有这一条，不是有一条报着 `unenforceable`。（这份文档此前写的是后者。`unenforceable`
这一档当初正是为它设计的，而它从来走不到；真正走到那一档的是两条它不该管的 Rule。）

> `xforge/scaffold/rules/` 在这七类资源里是唯一**为项目留白**的：
> 随包的四条是示例与自我治理，你的工程标准要自己写。

### 5.4 `scope.paths` 有两个读者，读法不一样

**XForge 这一侧：`scope.paths` 不与仓库比对，与 Change 比对。**
`ruleApplies` 拿它和这个 Change 在自己 `change.yaml` 里声明的 `scope.paths` 做**前缀包含**判断
（剥掉 `/**` 之后，两个根相等、或其中一个是另一个的前缀，即算命中）。
命中才进 `state` 的 `context.rules`——**而那是 Rule 唯一到达 Agent 的通道**。
没命中的 Rule 不是被削弱，是**根本不在场**。

**宿主那一侧：它就是文件 glob。** 三个 Adapter 都把同一个列表投影成宿主原生的匹配键——
Claude 的 `paths:`、Copilot 的 `applyTo:`、Cursor 的 `globs:`——在那里它确实按文件匹配。

**所以这个列表必须同时说得通。** 随包的 `src/**` / `tests/**` 是对仓库形状的一个猜测：
在代码位于 `apps/*/src/**`、`packages/*/src/**` 的 monorepo 里，两侧同时落空——
宿主匹配不到文件，XForge 匹配不到 Change 声明的 scope，而 `doctor` 当时只看引用完整性，
一个字都不会说。一次实测的 Major Change 就是这样带着 `governance.rules: []` 走完全程，
而 `observable-requirements-are-tested`（severity `must`）一直在 manifest 里选着。

现在有两处会说话：

- `xforge doctor` 报 `XFORGE_DOCTOR_RULE_SCOPE_EMPTY`——某条 Rule 的 `scope.paths`
  **在本仓一个文件都匹配不到**（info，不是失败：scope 可以合法地指向尚不存在的路径）。
- `xforge state` / `check` 报 `XFORGE_RULE_OUT_OF_CHANGE_SCOPE`——本 Change 有哪些 `must` 级 Rule
  因为 scope 不相交而**不在它的指令上下文里**（info，整批一条：不适用常常是对的，
  一个只改文档的 Change 不需要被告知测试规则；缺的是「什么时候这件事是错的」的可见性）。

### 5.5 把结构纪律写成会红的断言

Rule 表达得了「哪些 Change 受某条纪律管」和「由哪个 Gate 兜底」，
**表达不了纪律本身**——比如「本仓所有 MCP tool 的输入 schema 必须是固定形状」，
这种判据在代码结构里，不在某个 Gate 的退出码里。

可用的手法只有一个，而且**不需要任何新能力**：**把纪律编码成一张必须逐项作答的表，
新增一项而不作答就编译不过或测试红。** 三种形态：

```ts
// 1. 封闭映射 + 逐项遍历断言：新增一种拒绝类型而不给错误码，测试红
const ERROR_CODE: Record<RejectionKind, string> = { ... };
for (const kind of ALL_REJECTION_KINDS) expect(ERROR_CODE[kind]).toBeDefined();

// 2. keyof 强制清单封闭：端口新增方法而不在清单里作答，编译不过
const REQUIRED: Record<keyof Tx, boolean> = { ... };

// 3. 注册期断言：违反即启动失败，而不是等到调用
registry.register(tool);   // 内部 assertNarrowSchema(tool.inputSchema)
```

第 3 种要额外小心一点，实测踩过：**验收这条防线的测试，很容易不验它自称验的东西**——
一次实跑里，测试构造非法输入期望 `register` 拒绝，但非法输入在**更早的 schema 生成阶段**
就抛了 `TypeError`，根本走不到 `register`，而裸的 `expect(...).toThrow()` 照单全收。
**反向验证是唯一可靠的检查**：把被测的那道防线短路掉，看断言是不是真的变红。

**要让「这个 Change 有没有遵守这条纪律」成为 `xforge check` 能回答的问题**，
现有机制已经够用，路径是：

1. 在 `xforge/scaffold/gates/` 下写一个项目自己的 Gate（`builtin: declared`）——
   `protected-files` **刻意不 deny 这个目录**；
2. `xforge verification declare --gate-name <它> --command '[...]' --by <人>` 声明它怎么跑；
3. 在 Rule 的 `enforcement.gateRefs` 引用它，Rule 的 `coverage` 于是变成 `verified`；
4. 由 Integrator 或人把它加进 Flow 的某个 stage——`xforge/flows/**` 是受保护的，这一步需要授权。

这条链路一直存在，只是没有一处文档把四步连起来写过。

---

## 6. PermissionPolicy 与 Hook

### 6.1 PermissionPolicy

```yaml
apiVersion: xforge.dev/v1alpha2
kind: PermissionPolicy
metadata: { name: protected-files, version: 1 }
spec:
  capability: fs.write     # fs.read | fs.write | shell | network | mcp | subagent | external.write
  effect: deny             # deny | ask | allow  —— deny 优先
  match:                   # 至少一项
    paths:       [...]     # 严格分段语义：* 不跨 /，** 跨 /
    commands:    [...]     # 宽松语义：* 跨 /
    tools:       [...]     # 宽松
    hosts:       [...]     # 宽松
    mcpServers:  [...]
  exceptActors: [integrator]
  reason: <必填>
```

**两套通配符语义是有意区分的**：路径是 `/` 分段的命名空间，命令行不是——
所以 `rm -rf *` 也会匹配 `rm -rf /tmp/x`。

随包两条：

| 策略 | capability | effect | 覆盖 |
| --- | --- | --- | --- |
| `protected-files` | `fs.write` | **deny** | `constitution.md`、`specs/**`、`lock.yaml`、`flows/**`、`.audit/**` |
| `protected-manifest` | `fs.write` | **ask** | `manifest.yaml` |

`manifest.yaml` 从 deny 名单里被移出来单独成策略，是因为 `xforge-scaffold` 必须编辑它
来选中 / 取消选中资源——**允许写，但必须由人确认**，绝不静默、绝不由 Worker 写。

刻意**不**拒绝的三处：`xforge/scaffold/**`（`xforge-scaffold` 合法地在那里写资源）、
`xforge/changes/**`（生命周期 Skill 通过正规 Change 在那里写内容）、`manifest.yaml`（见上）。
拒绝它们会破坏这些工作流，而不是加固它们。

> ⚠️ **这是给诚实 Agent 的护栏，不是结构性安全边界。**
> 强制它的 runtime Hook 只检查工具调用的**结构化路径参数**（比如编辑器工具的 `file_path`）。
> 一个 `shell` 调用如果间接写了这些路径——`cat >`、`tee`、`cp`、一个自己打开文件的脚本——
> 匹配的是整条命令串对 `match.commands` 的 glob，而不是它真正碰到的文件，因此**不会被抓住**。
> 对照 `xforge approve` 的反自我批准设计：那是**结构性**的（决定词只能来自实时终端提示，
> 永远不能来自 argv 或工具调用）。这条策略不是那种保证。

**要不要配自定义 PermissionPolicy，与其说看团队规模，不如说看有没有人在实时盯着。**
交互式、有人在看的会话里，编程工具自己就会弹权限确认；
无人值守或并行 Worker 执行时没人在盯——这时候 PermissionPolicy 恰恰是唯一还能拦住危险操作的东西。

企业 / 平台的 managed policy 是**上游层**，项目投影无法削弱它。

### 6.2 Hook

Hook 是编程工具原生事件与 XForge 逻辑之间的**接线**。分两个平面：

- **runtime**：由 Adapter 桥接平台的 session / prompt / tool / permission / subagent / stop 事件
- **workflow**：由 CLI 直接调用，覆盖 stage / gate / approval / archive / work-package / audit 投递

一次 `xforge hook dispatch` 里流过三样东西：

1. **实时 PermissionPolicy 评估**（相关事件发生时总会跑）；
2. **审计记录**；
3. **自定义 `scriptRef` 逻辑**——引用一个项目自有的 `kind: Script`（Node 或 Python），
   从 stdin 读事件 payload，自己也能给出 allow / ask / deny 意见，
   与 PermissionPolicy 的结果按同一套「**deny 压 ask 压 allow**」规则合并。

**Hook 不能创造 Gate 成功、Approval 或 Stage transition。**

> 随包的 `runtime-audit` Hook **默认不选中**：审计记录在 CLI 内部是无条件的，
> 而它的 `action.builtin: audit` 目前没有 dispatcher 分支，选中它不改变任何事。
> 它留在磁盘上，作为「等 builtin dispatcher 出现后可以重新选中」的示例。
>
> PermissionPolicy 仍会生成最小的 pre-tool 桥接——**该桥接只依赖 policy，与 Hook 选择无关**。

**Hook 的四个状态不能互相推断**：项目是否选中（manifest）、资源自身是否 `enabled`、
平台是否已 trust、运行时是否 active。`state.governance.hooks[]` 会同时报告
`selected` 与 `enabled`。

---

## 7. Audit

### 7.1 三层

```text
① xforge/.audit/events.jsonl          本地、gitignored、previousHash/hash 哈希链
② <change>/evidence/audit/index.json  可提交的事件索引与 digest
③ 可选远端 append-only HTTP sink       Bearer / HMAC，凭据只从环境变量取
```

本地追加使用目录锁与 JSONL 哈希链，篡改会破坏整条链而不只是一条记录。

### 7.2 一条 AuditEvent 记什么、不记什么

```json
{
  "eventType": "agent.tool.before",
  "plane": "runtime",
  "platform": "codex",
  "surface": "local",
  "actor": { "id": "worker", "provider": "codex", "role": "agent", "type": "agent" },
  "change": "credential-store", "flow": "major", "stage": "apply",
  "refs": { "policies": ["protected-files"], "rules": [], "gates": [] },
  "decision": "deny",
  "reason": "Shared governance files may be written only by the Integrator...",
  "outcome": "denied",
  "inputDigest": "sha256:...", "outputDigest": "sha256:...",
  "redaction": "strict",
  "coverage": { "observed": true, "gaps": [] },
  "previousHash": "sha256:...", "deliveryState": "delivered", "hash": "sha256:..."
}
```

**不记：** 真实文件内容、真实 shell 命令文本、真实工具参数、prompt、隐藏推理、
secret、完整环境、无上限的工具载荷。

> 这份记录证明的是**「确实发生过一次决策」以及「为什么」**（`refs` / `decision` / `reason`），
> 不泄露 Agent 当时在读写什么。

### 7.3 三个策略开关

```yaml
audit:
  requiredEventTypes: [gate.after, stage.entered, approval.decided]
  runtimeCoverage: optional | required
  remoteDelivery:  optional | required
```

> ⚠️ **`governance.audit` 与 `terminal.archive.auditPolicy` 必须保持一致。**
> `xforge audit verify` 读前者，archive 解析 `terminal.archive.auditPolicy ?? governance.audit`；
> 两者不一致时会出现「`audit verify` 说这个 Change 审计完整、archive 却拒绝」。

**为什么随包默认全是 `optional`：** 设成 `required` 会用 `audit:remote-pending` 挡住 archive，
直到每条 workflow 事件被 HTTP 接收端接受；而全新安装上 `XFORGE_AUDIT_ENDPOINT` 是未设置的。
于是一个默认项目会把一个 Major Change 推到 verify、收齐审批，然后**永远关不掉**——
`xforge audit retry` 清不了一个无处可投的队列。

远端投递是**企业 opt-in**：

```text
XFORGE_AUDIT_ENDPOINT      投递地址（未设置 = 所有事件停在 deliveryState: 'pending'）
XFORGE_AUDIT_TOKEN         Bearer
XFORGE_AUDIT_HMAC_SECRET   HMAC
```

先把 `manifest.audit.remote.endpointEnv` 指向真实 sink，再把两处 `remoteDelivery`
设成 `required`，或把该 assurance level 加进 `manifest.audit.remote.requiredFor`。

保留期在本地**报告**；真正的删除与不可变性由远端 sink 实施——刻意如此，避免静默重写本地链。

### 7.4 命令

```bash
xforge audit status                  # 按 eventType 计数、覆盖缺口、待投递数量
xforge audit status --change <id>
xforge audit verify --change <id>    # 哈希链完整性 + 该 Flow 要求的事件类型是否齐全
xforge audit export --change <id> --output report.json
xforge audit retry
```

`audit verify --change` 是真正卡住 Archive 的那个命令，**也可直接作为 CI protected check**。
欠账按 Change 计算，避免一个 Change 阻塞另一个。

---

## 8. 排障：`blockedBy` 词汇表

`state.governance.readyTransitions[].blockedBy` 的完整取值。

| 前缀 | 形态 | 含义 |
| --- | --- | --- |
| `transition-chain:` | `invalid` | 回执链本身坏了 |
| `transition:` | `ready-receipt-stale` | 收尾回执陈旧（内容动了，或**策略快照动了**） |
| `verification:` | `<gate>:undeclared` | 本 Flow 需要的 declared Gate，项目一条命令都没声明——**只在这个 Change 的第一次 transition 上出现** |
| `artifact:` | `<id>` | 该 Stage `produces` 的 Artifact 还不是 `done` |
| `work-package:` | `<id>:<status>` | 某个包不在 succeeded / integrated / reviewed |
| `tree:` | `unattributed-paths` | 树里有已提交改动，不属于任何 `write_paths`，也不在 `integrator_paths` 内 |
| `gate:` | `<id>:missing` / `:failed` / `:stale` | 缺失 / 失败 / 陈旧——三者的补救完全不同 |
| `condition:` | `<key>:<reason>` | 出口条件未满足 |
| `approval-policy:` | `<id>:missing` | Flow 引用了一个未定义的审批策略 |
| `approval:` | `<id>:rejected` / `:separation-of-duties` / `:missing-<n>` | 被拒 / 审批人是 implementer / 还差 n 人 |
| `audit:` | `<eventType>:missing` / `chain-invalid` / `remote-pending` | 事件缺失 / 链无效 / 远端积压 |

`condition:` 的 reason：

- 通用台账：`invalid-key`、`ledger-missing-expected-<x>`、`ledger-unreadable`、
  `ledger-subject-mismatch`、`entries-missing`、`undecided-<n>`、`status-<a>-expected-<b>`
- `independentReview` 专有：`review-missing`、`review-stale`、`unreviewed-<pkg>[+<pkg>…]`

### 8.1 四个带补救提示的 block

CLI 会为部分 block 给出 `blockRemedy` 诊断，**先读它再动手**：

**`transition:ready-receipt-stale`** 有两条分支，补救完全不同：

| 原因 | 出路 |
| --- | --- |
| **策略快照变了**（内容没动） | 把治理资源改回原样 → 重跑 `xforge check` → Change 用它**已有的审批**关掉 |
| **内容变了** | 恢复 Artifact 到原 revision 保住审批，或 `transition repair` 放弃审批重来 |

对前一种说「恢复 Artifact」是**不可能起作用的建议**——字节本来就是对的，
恢复它并不能把策略快照恢复回去。

**`gate:<id>:stale`** → 在最后一次写入之后跑 `xforge check --change <id>`。
（`:failed` 需要修那条 finding，`:missing` 需要第一次跑 Gate，两者都不适用这条建议。）

**`verification:<gate>:undeclared`** → `remedy.commands` 里每个未声明的 Gate 各一条
`xforge verification declare`，命令已代入 gate id，只留 `<program>` 给人填。
**一次全部声明完**：只声明一个，剩下的会在后面某一段再拦一次。
不要照抄 CLI 建议的命令——它读的是构建系统标记，不是这条命令验没验东西。

**`condition:independentReview:*`** → 见 [子 Agent 设计](sub-agent-design.md)。

### 8.2 `tree:unattributed-paths` 不是任何工作包的问题

它说的是**计划的声明**不完整：树里有已提交的改动，既不属于任何包的 `write_paths`，
也不被 `integrator_paths` 覆盖。

> 不要去审查那些 delivery——它们可以每一份都完全正确而这一条依然阻塞。
> 要改的是计划的声明，改完再重新记录受影响的 delivery。

---

## 9. 时序视角：谁在什么时候被叫醒

前面八节讲的是**静态语义**——每一个是什么、能证明什么。这一节讲**时序**：
Skill 如何与控制面握手、Flow 如何流转、以及这四个分别在哪一刻被调用。

### 9.1 两个时钟

这四个**不在一条流水线上**。它们跑在两个互不相通的时钟上：

```text
时钟 A · 事件驱动 —— 与 Flow 无关，一直在跑
└─ PermissionPolicy    每一次匹配的工具调用触发（经 Hook dispatch）
                       跟当前哪个 Stage、有没有活跃 Change 都无关

时钟 B · 推进驱动 —— 只在有人要求前进时才被叫醒
├─ Gate                xforge check 时执行，写 Evidence
└─ Approval            xforge approve 时产出，transition 时被清点

不在任何时钟上
└─ Rule                没有人「调用」它。每次算 state 时重新核对一遍它的声称
```

一次 `Write` 调用会被拿去比对 PermissionPolicy，不管 Agent 当时在 Propose、Apply，
还是根本没打开任何 Change。而 Gate 和 Approval 在同一时刻完全沉默。

### 9.2 Skill 与控制面的握手

**Skill 从不直接接触这四个。** 它只跟两样东西打交道：控制面返回的那份状态，
和两条 CLI 命令。这四个是控制面内部的判定器。

```text
Skill                        CLI / 控制面
  │
  │ ① xforge stage --change <id>            （进入）
  ├──────────────────────────►  resolveControlPlane()
  │                             ├ 算四层 revision
  │                             ├ 读回执链 → 重建 currentStage
  │                             ├ 读 Gate Evidence · 读 Approval receipt · 核对审计链
  │                             ├ 对每个候选目标算 blockedBy
  │                             └ 重算每条 Rule 的 coverage
  │ ◄──────────────────────────  ready Action + owes[] + stageDeclares
  │                              + blockedBy[] + rules[] + 诊断
  │
  │ ② 按 Action 自带的 instruction / outline 写 Artifact
  │   每写完一个重跑一次 ①
  │
  │ ③ xforge advance --change <id>          （离开）
  ├──────────────────────────►  a. Gate runner 跑本 Stage 声明的整组 Gate
  │                                → 写 evidence/*.json（绑定当刻 contentRevision）
  │                             b. 无人拒绝 → transition guard 逐项校验（见 §9.3）
  │ ◄──────────────────────────  通过 → 写回执；不通过 → blockedBy
```

> `advance` 里的 a 与 b 就是 `xforge check` 与 `xforge transition`，**记录不合并**：
> Gate Evidence 与回执分开落盘、分开审计。只想跑其中一半时，两条命令仍然单独可用。

**Flow 在这里的角色是「声明表」**：某个 Stage 要产出哪些 Artifact、要哪些 Gate、
出口卡哪些 condition / approval / auditEvent。控制面照着这张表逐条求值。
Skill 看不到这张表，它只看到求值之后的结果。

### 9.3 transition guard 的精确顺序

以下是 `core/control-plane.ts` 里构造 `blockedBy` 的**实际执行顺序**：

| # | 检查 | 失败时的 blockedBy |
| --- | --- | --- |
| 1 | 回执链本身是否有效 | `transition-chain:invalid` |
| 2 | 本 Flow 需要的 declared Gate 是否都已声明（**仅第一次 transition**） | `verification:<gate>:undeclared` |
| 3 | 本 Stage `produces` 的 Artifact 是否都 `done` | `artifact:<id>` |
| 4 | 工作包是否都到达 succeeded / integrated / reviewed | `work-package:<id>:<status>` |
| 5 | 树里有没有无归属的已提交改动 | `tree:unattributed-paths` |
| 6 | **Gate**：逐个读 Evidence 判三态 | `gate:<id>:missing` / `:failed` / `:stale` |
| 7 | **出口条件**：台账判定 | `condition:<key>:<reason>` |
| 8 | **Approval**：按策略清点有效 receipt | `approval:<id>:missing-N` / `:rejected` / `:separation-of-duties` |
| 9 | 必需审计事件是否齐全、链是否有效 | `audit:<type>:missing` / `audit:chain-invalid` |

**注意第 6 条：transition 不跑 Gate，它只读 Evidence。** Gate 是 `xforge check` 跑的。
这个分离正是 §3.4 那个时序陷阱的根源——先跑 Gate、再改文件、再跑下一个，
前一个的 `contentRevision` 就对不上了，于是 transition 读到 `stale`，
而每个 Gate 自己都写着 `passed`。

**PermissionPolicy 一次都不出现在这张表里。** 它不在推进路径上。

### 9.4 major 全程：6 次推进 + 1 次归档

| # | Stage | Skill | produces | gates | exit 卡什么 | reworkTo |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `propose` | xforge-propose | proposal · delta-specs | structure | — | — |
| 2 | `clarify` | xforge-clarify | clarifications · material-questions | — | `materialQuestions: resolved` | propose |
| 3 | `design` | xforge-design | design · contract-delta（`moduleContract: true` 时才欠）| — | — | propose · clarify |
| 4 | `check` | xforge-check | check-report · check-findings · constitution-check | structure · check-findings · constitution-check | **`approvals: [implementation-major]`**<br>`contractDecisions: resolved`（同样只在 `moduleContract: true` 时）| propose · clarify · design |
| 5 | `apply` | xforge-apply | （无，产出是代码） | — | — | propose · clarify · design · **check** |
| 6 | `verify` | xforge-verify | assurance | structure · unit-tests · security-scan | `verificationReceipt: passed`<br>`independentReview: complete` | apply |
| 7 | `ready-to-archive` | — | — | — | **合成 Stage**，不在 `flow.stages` 里 | 无（只能 `transition repair`） |
| — | `archive` | xforge-verify | — | 强制 Gate **重跑** | `approvals: [closing-major]` + 审计完整 | — |

几个只在 major 出现的东西，以及它们为什么只在这里：

| | 是什么 | 别的档为什么没有 |
| --- | --- | --- |
| `clarify` Stage | 材料性问题必须被具名的人决定，才能进设计 | solid / quick 的问题规模不值得单独一个 Stage |
| `security-scan` Gate | Verify 多一道 declared Gate | 只有 major 允许 critical impact |
| `independentReview` 条件 | 交付的工作必须有一次可归属的复核 | 它防的是「一个人设计 + 实现 + 自审 + 签字」，只在高风险下值这个成本 |
| `separationOfDuties: true` | 审批人不能是本 Change 的 implementer | quick / solid 是 false —— 单人项目仍然能推进 |

#### 四者同时出场的那一段：check 出口

```text
xforge-check                          CLI / 控制面
  │
  │ 1  xforge state
  │ ◄─────────────────────────────────  blockedBy(→apply):
  │                                       artifact:check-report
  │                                       artifact:check-findings
  │                                       artifact:constitution-check
  │                                       gate:check-findings:missing
  │                                       gate:constitution-check:missing
  │                                       approval:implementation-major:missing-1
  │
  │ 2  写 check-report.md            散文
  │    写 evidence/check-findings.yaml       台账 ← 被 check-findings Gate 读取
  │    写 evidence/constitution-check.yaml   台账 ← 被 constitution-check Gate 读取
  │
  │ 3  xforge check --change <id>        ⚠ 必须在最后一次写入之后、一次性跑
  ├─────────────────────────────────►  跑 [structure, check-findings, constitution-check]
  │ ◄─────────────────────────────────  三份 evidence/*.json，各自绑定 contentRevision
  │
  │ 4  xforge check --change <id>            ← RECONCILE 条目交给审批人
  ▼
—— 交给人 ——————————————————————————————————————————————————————
  │ 5  xforge approve --change <id> --for apply …
  ├─────────────────────────────────►  必须真实 TTY；同一次运行里写 receipt
  │                                     并追加 approval.decided 审计事件
  │ ◄─────────────────────────────────  绑定 governingRevision
  ▼
  │ 6  xforge transition --to apply
  ├─────────────────────────────────►  guard 逐项（§9.3 的顺序）：
  │                                      artifact × 3   done ✓
  │                                      gate × 3       passed 且当前 ✓
  │                                      approval:      链里有匹配事件 ✓
  │                                                     governingRevision 一致 ✓
  │                                                     role 在允许集合 ✓
  │                                                     SoD: approver ∉ implementers ✓
  │                                                     minApprovers 1 → valid 1 ✓
  │ ◄─────────────────────────────────  写 receipt  check → apply
```

同一段时间里，**PermissionPolicy 在另一个时钟上独立运行**：Agent 每一次读写文件、
每一次跑命令，都经 hook dispatch 比对一次，与它当前站在哪个 Stage 无关。

### 9.5 rework 与 revise

**rework 本身是一次受保护的 transition，`xforge-revise` 是到达之后干活的 Skill。**
两者是分开的，这一点经常被混。

```text
在 check 阶段发现 design 有一个 blocker：

  1  在 check-findings.yaml 里记这条 blocker
       severity: blocker      status: open
       reworkTo: design          ← blocker 处于 open 时必填

  2  xforge state
     ◄── gate:check-findings:failed
         readyTransitions:
           apply    blockedBy:[gate:check-findings:failed]
           propose  ready ✓  ┐
           clarify  ready ✓  ├ reworkTo 目标，不被任何 Gate / Approval 治理
           design   ready ✓  ┘

  3  xforge transition --to design      ← 这就是 rework，一次正规 transition
     ◄── 写回执 check → design
         ⚠ 副作用：implementation-major 绑在 check 出口 → 失效，必须重签

  ——— 交给 xforge-revise ———

  4  一致地修订受影响的 Artifact
     这是 revise 存在的全部理由：
       · 一个改动往往牵连多份 Artifact（改 design 可能要动 delta Specs）
       · 直接手改上游 Artifact，会让 Change 的其余部分静默地与它不一致
       · 修订改变 contentRevision → digest 链自动让依赖它的 Evidence 变 stale

  5  xforge state
     ◄── gate:structure:stale
         gate:check-findings:stale        ← 全部失效了，这是正确行为
         gate:constitution-check:stale

  6  交回 xforge-design 收尾，重走 design → check → apply
     在 check 里把那条 blocker 改成 status: resolved
     并填 resolvedBy（必须命中 KnownIdentities）
```

**为什么 `check` 也在 apply 的 `reworkTo` 里**（`major.yaml` 里专门留了注释）：
没有它，check 是 major 里唯一回不去的 Stage —— `legalTransitionTargets` 只给
「下一个 Stage + reworkTo」，而 apply 和 verify 都够不到 check。
结果是实现期发现的 Constitution 违规，只能靠改一份**根本不需要改**的 Design
来重新走过 Check。允许它并不放松什么：`implementation-major` 绑在 check 出口，
回去就失效、必须重签——**这与其他每个 rework 目标做的是同一笔交易。**

---

## 10. 第三条轨道：让约定活过单个 Change

前面九节讲的全部是**单个 Change 内部**的治理。有一件事它们结构上答不了，
而且不是因为漏了一个功能。

`core/revision.ts` 的 `contentInputPaths` 逐字如此：

```ts
const changeRoot = `${project.changesPath}/${changeId}`;
const paths = new Set<string>([`${changeRoot}/change.yaml`, `xforge/flows/${flow.metadata.name}.yaml`]);
for (const artifact of state.artifacts) for (const output of artifact.outputPaths) paths.add(`${changeRoot}/${output}`);
```

**它是 per-Change 的，而且只覆盖 Change 目录内的 Artifact 输出。**
于是两个 Change 可以各自完全合规、各自拿到人类审批，却对同一件事说了两句不同的话——
控制面没有任何一处会发现，因为跨 Change 的一致性从设计上就不在判定范围内。
Gate 也补不上：一道 Gate 跑在一个 Change 里，看到的就是一个 Change。

XForge 对这件事只有一个答案，而且用了两次：

```text
基线（跨 Change 存活，Agent 写不进去）   delta（Change 的 Artifact，被校验）   归档时合并
xforge/specs/**       ←────────────────  <change>/specs/**/*.md          syncSpecs: true
xforge/contracts/**   ←────────────────  <change>/contracts/**/*.md      syncContracts: true
```

两个实例，一套方案。§11 讲 Spec，§12 讲接口，§13 把两者摆在一起对照。

### 10.1 为什么 delta 必须是 Artifact，而不是直接改基线

这不是风格问题，有两处机制在同一个方向上：

1. **基线不在 `contentRevision` 的输入集合里。** 直接改 `xforge/specs/**` 或
   `xforge/contracts/**` **不会**让任何已收的审批失效——改完，审批照旧有效，
   而它授权的那份内容已经不是当初那份了。做成 Change 目录内的 Artifact 就自动正确。
2. **基线是写保护的。** `core/ownership-zones.ts` 的 `record` zone 同时收了
   `xforge/specs/`、`xforge/contracts/`、`xforge/.audit/`，三者都是 `agentWrite: 'deny'`；
   随包 `protected-files` 策略的 deny 列表由这张表推导，不是手写的第二份清单。
   同一张表还派生出升级事务范围与升级 merge prompt 的「## Never」清单，
   且 zone 属性是 `inTransaction: 'none'` / `neverTouch: true`——
   **一次脚手架回滚不会把项目的 Spec 与接口历史一起回滚回去。**

> 但请记住 §6.1 的那条限定：PermissionPolicy 是给诚实 Agent 的护栏，不是结构性边界。
> `cat > xforge/contracts/http.md` 这类间接写入不会被抓住。
> 真正的兜底在归档那一刻——基线只由 merge 推进，一次手改会在下一次合并时以冲突的形式暴露。

### 10.2 这套安排买到了什么

| 性质 | 靠什么成立 |
| --- | --- |
| 「改了」与「有人同意改」不再是同一件事 | 基线只由归档合并推进；delta 走完整的 Stage 治理 |
| 改动是可被审阅的最小单位 | delta 只说增删改了什么，不重述整份基线 |
| 记录不会被一次回滚抹掉 | `record` zone 的 `neverTouch: true` |
| 冲突在**审批之前**被发现 | `check` 跑一次「同一个 merge」的只读版本（§11.4、§12.8） |

---

## 11. SPEC 治理：产品必须做到什么

### 11.1 两个位置

```text
xforge/specs/<capability>/spec.md   基线（canonical Spec）：跨 Change 的唯一真源
  或 xforge/specs/<capability>.md

<change>/specs/<capability>/spec.md  delta：本 Change 对它的增量，是 Artifact
```

**文件名不是自由的。** 它的路径命名一个**能力（capability）**，
归档会把 delta 合并进同一相对路径下的基线文件——所以这里选的名字是一个长期标识符，
不是某一个 Change 的文件名。两种被接受的写法含义相同：
`specs/<capability>/spec.md` 与扁平的 `specs/<capability>.md`。
写成别的形状照样能解析，只是悄悄声明了一个没人打算要的能力——
`specs/root/spec.md` 声明的是一个叫 `root` 的能力。

> **先复用，再发明。** 两个 Change 给同一个行为起了两个名字，会合并成两份不同的基线文件，
> 而**没有任何东西会去比对它们**——需求级的冲突检查是按文件做的，这种撞名永远不会被报告。
> `xforge state` 会列出本项目已有的 canonical Specs。

### 11.2 delta 的形状

Artifact id 是 `delta-specs`，`generates: specs/**/*.md`，`validator: spec-delta`。
四个节，标题是**英文字面量，没有 i18n 表**（`core/spec-delta.ts` 的正则）：

```markdown
## ADDED Requirements
### Requirement: <REQ-ID> <name>
#### Scenario: <name>
- **WHEN** ...
- **THEN** ...

## MODIFIED Requirements
## REMOVED Requirements
## RENAMED Requirements
```

英文标题是一条真实的产品约束，也是既有的那条：**节标题是两个模块之间的线格式，不是散文**，
而 Flow 的 `outline` 就是告诉作者该敲哪几个词的地方。正文可以是中文。

`spec-delta` validator 会拒绝的 12 类问题（诊断码全部形如 `XFORGE_SPEC_DELTA_*`）：
文件为空、一个节都没有、节重复、节为空、Requirement 未命名 / 重名 / 落在节外、
Scenario 缺失 / 未命名 / 重名、缺 WHEN 或 THEN、RENAMED 的 from/to 不配对。

> **这就是 §5.2 里 `structural` 说的那种强制**：CLI 在进程内读到文档的那一刻就拒绝，
> 没有 Gate、没有 Evidence、没有任何绑定 revision 的东西可记。
> （`structural` 是 Rule coverage 的一档，而随包没有哪条 Rule 引用 `spec-delta`——
> 这个 validator 无论如何都会跑，与有没有 Rule 点名它无关。契约那边有，见 §12.10。）

### 11.3 合并键是「人写的标题」

`core/spec-merger.ts` 用 `### Requirement:` 后面那行标题作为合并键。
四条规则，都会以 `XFORGE_SPEC_MERGE_CONFLICT` 拒绝：

| delta 说 | 基线里 | 结果 |
| --- | --- | --- |
| ADDED | 已存在 | 冲突 |
| MODIFIED | 不存在 | 冲突，**并点名那个撞车的现有标题**（见下） |
| REMOVED | 不存在 | 冲突 |
| RENAMED `from → to` | `from` 不存在，或 `to` 已被占用 | 冲突 |

新能力（基线文件还不存在）只允许 ADDED，且**必须用 delta 节**——
不接受「整份 main Spec」的形状，否则等于让归档悄悄收下一份从没过过 Scenario 校验的文档。

合并把每一个 Requirement 块整体替换进基线的 `## Requirements` 节，
基线里该节之前与之后的内容原样保留。**删光了所有 Requirement，基线文件会被删除**
（`content: null`）。

> **合并键是人写的标题，所以改标题就是换了一个需求。**
> 这正是 MODIFIED 找不到时那条提示存在的理由：一次 Major 实跑里，`MCP-009` 在 delta 里
> 被改了标题以反映本次修订，它的兄弟 `MCP-005` 没有，而「两者表现不同」是当时唯一的线索。
> 裸消息（`Cannot modify missing requirement: X`）描述的是症状，不是原因——
> 原因是 X 和基线自己的标题是同一个需求的两个名字。
>
> 提示按**标题开头那个可引用的 id**（`MCP-009 …` 引作 `MCP-009`）去找，
> 所以**只有在项目真的给需求编号时才会出现**，而且它只是建议：
> 走 `## RENAMED Requirements` 改标题，和纠正一个笔误，是两种不同的意图，没有任何东西分得出来。
>
> 对照 §12：契约那边的键是机器打印的 id，**不匹配就是另一个元素，没有什么可提示的**。

### 11.4 冲突为什么在 `check` 就报，而不是等到归档

`validateSpecMergeFeasibility` 跑的是**同一个 merge**，只取它的拒绝、丢掉输出。
它存在的理由是一次真实事故：

> 归档路径在任何治理 block 存在时**都还没规划过 Spec mutation**——
> 而「收尾 transition 还没发生」和「收尾审批还没拿到」都是治理 block。
> 所以 `archive --dry-run` 问不出这个问题：合并计划只在别的一切都已通过之后才算。
> 一次 Major 实跑就这样带着**已经签好的 `closing-major`** 撞上 `XFORGE_SPEC_MERGE_CONFLICT`，
> 而唯一的退路 `transition repair` 会作废那份审批。
> 真正需要的检查是纯文本的：两个文件，无 Gate、无审批、无工作树。

两个读法共用一份实现，这是**承重的**：

```ts
type ConflictSink = (item: Diagnostic) => void;
const THROW_ON_CONFLICT: ConflictSink = (item) => { throw new XForgeError(item); };
```

`archive` 用 throw（第一个冲突就停，它在做事务），`check` 用收集（一次报完，省掉往返）。
**第二份「这份 delta 能不能合」的实现可以与治理归档的那份不一致，那会比没有检查更糟。**

`check` 报出来是**必要不充分**的：另一个 Change 可能先归档、挪动它刚刚比对过的基线，
所以 archive 仍然会重新判一次。这与每一道 Gate 对自己跑过的那个 revision 采取的姿态相同。

---

## 12. 接口治理：模块之间承诺了什么

### 12.1 基线是一份记录，不是方言文档

`xforge/contracts/` 下一个契约域一个 markdown 文件，逐条列出该域对外暴露的契约元素：

```markdown
# orders http

## Purpose

Established by archived XForge Changes.

## Elements

### Element: openapi:paths./orders.post
- module: api
- digest: sha256:…
下单。请求体见实现侧的 orders.openapi.yaml。

### Element: openapi:components.schemas.Order.properties.status
- module: api
- digest: sha256:…
```

它**不是** OpenAPI 文档、不是 `.proto`、不是 schema dump，而这正是关键：
**XForge 不理解任何方言，也不打算学。** 一份它能合并的基线，只能用双方共有的词汇来寻址——
也就是适配器打印出来的 `<kind>:<selector>`。方言文档留在实现那一侧，
由项目自己的 `contract-compat` 命令去比对两者。

这是 api-extractor 的 `.api.md`、cargo-public-api 那一派的「基线快照评审」，
区别是**把合并挪进了治理层**：被记录的接口面只通过一份被审阅过的 delta 前进。

> 这一条是落地时推翻设计稿的地方，理由很硬：`syncContracts` 面对一份 OpenAPI 文档
> **没有任何东西可以合并**。

### 12.2 契约元素 id（CEID）

```text
CEID := <kind> ":" <selector>

kind      适配器 id，形状与其它资源 id 相同：^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$
selector  方言自己的地址空间，XForge 视为不透明字符串；唯一要求是不含空白
整串上限  512 字符
```

selector 不透明是有意的：一个约束它形状的治理层，等于在替 OpenAPI 或 protobuf
决定它们可以给东西起什么名字。不含空白也是有意的——这个 id 要能原样当
markdown 标题、`refs` 条目、和报告里的一行，三处都不需要引号。

元素块里两条**约定行**（是散文约定，不是 schema，所以允许尾随注释）：

| 行 | 谁读 | 作用 |
| --- | --- | --- |
| `- module: <id>` | RC-7 | 与 Change 的 `scope.modules` 对照；工作包的写边界是从 scope.modules 推的 |
| `- digest: <value>` | 归档合并 | **唯一能让「修改」变得可判定的东西** |

`digest` 为什么存在，是量出来的：基线曾经只是 id 加散文，于是
`contract-compat` 与 `contract-drift` 只能做**集合运算**——新增、删除、改名都判得出来，
而**修改**（放宽一个枚举、改一个字段的类型、把可选字段变必填）是看不见的，
而那恰恰是最常见的破坏性变更。一次实跑把某个子元素的枚举放宽了，两道 Gate 都没看见。
digest 是**项目自己的适配器**认为的规范形态，XForge 一个字节都不计算，
只是给它一个能活过合并的位置，让下一次跑有东西可比。

### 12.3 contract-delta：Change 里唯一能说「接口变了」的地方

Artifact id 是 `contract-delta`，`generates: contracts/**/*.md`，`validator: contract-delta`。
三个节，同样是英文字面量：

```markdown
## ADDED Contract Elements
### Element: <kind>:<selector>
- module: api
- digest: sha256:…

## MODIFIED Contract Elements
(none)

## REMOVED Contract Elements
(none)

## Breaking Changes
## Consumer Impact
```

`(none)` 是**一条断言**，不是留空。空节与「没人走到这里」分不开；
`(none)` 说的是「这里确实什么都没有」，而合并就是这么读它的。
`## Breaking Changes` / `## Consumer Impact` 是给人读的节，
parser 遇到它们只是**结束上一个元素节**，永远不会把里面的散文读成元素。

**这个 Artifact 只有自报移动了接口的 Change 才欠**：

```yaml
requiredWhen:
  anyImpact: [moduleContract]
```

理由写在 Flow 注释里：本 Flow 的其它每个 Artifact 每个 Change 都欠，
而空 glob 等于「Stage 没做完」——这是第一个可以合法地什么都不欠的 Artifact，
为了一份写着「什么都没变」的文档把 Stage 卡住，是没有读者的摩擦。

`contract-delta` validator 拒绝的：文件为空、一个节都没有、节重复、
节既空又没写 `(none)`、节写了 `(none)` 却又列了元素（**自相矛盾，文档本身说不清哪个对**）、
元素未命名、id 超长、id 不是 `<kind>:<selector>`、同一个 id 在两个节里出现
（「既新增又删除」不是归档能执行的合并，两种顺序对结果的说法还不一致）、
元素落在三个节之外（归档会把它丢掉）。

**id 是跨文件比的，不是只在一份文件里比。** 一个 id 是全局地址，
而域文件只是这条记录碰巧住在哪里；只按文件校验，一个 Change 就能在两个域里声明同一个 id，
归档于是把它写进两份基线记录——`contract list` 会显示两次，
而后来一次 MODIFIED 只会打中它点名的那一份，另一份变陈旧且没有任何东西会说。

> **`generates` 用 glob 是有代价的，而且这个代价是认下的、不是忘了的。**
> 任何 `generates` 含 `*` 的 Artifact **完全跳过 marker 与 outline 校验**
> （`core/artifact-markers.ts` 的短路）。所以 glob 与一个 `contract-breaking` marker
> 不能同时存在，glob 赢了：一个域一个文件，才能让两个 Change 动两个域时不在同一份文件里相遇，
> 也才能让合并的目的地**从 delta 自己的路径推出来**，而不是从别处的约定推出来。
> 放弃掉的是 RC-4 读 `## Breaking Changes`、报告「声明了破坏性变更却没有任何 finding 引用它」的那条核对——
> 那条核对是真的，被实际观察到触发过。

### 12.4 默认给到什么，要选中什么

这是最容易误解的一处。契约治理被劈成了两半：

| 层 | 内容 | 需要配置吗 |
| --- | --- | --- |
| **零配置层**（`solid` / `major` 自带） | 被校验的 `contract-delta`（`structural`）· 写保护的基线（`guarded`）· `contractDecisions` 决策台账 · 归档时的合并 · RC-7 · `xforge contract list` / `status` · `moduleContract` / `contractImpact` 资格判定 | 否 |
| **选中层** | 四道 `builtin: declared` 的 Gate：`contract-lint` / `contract-compat` / `contract-drift` / `module-boundaries` | 是：登记 + 挂 Stage + `verification declare` |

**这两层治理的不是同一件事：**

- 零配置层完整地治理一次**已声明的**接口变更：一份被校验的 delta、一条 Worker 写不了的基线、
  每个破坏性变更都有具名人拍板、归档时的合并。
- 它**不**治理一次**未声明的**接口变更。一个 Change 移动了接口却自报
  `moduleContract: false`，它什么都不欠，零配置层的任何一处都不会说话。
  `contract-compat` 就是拿声明去和实际移动的东西对照的那道 Gate，
  而它按方言而异，所以是选中的。

随包还有一条 `solid-contract` 模板 Flow，放在 `xforge/scaffold/flows/`（**不是** `xforge/flows/`）。
它就是 `solid` 加五处改动：`contract-lint` 挂 design、`contract-compat` 与无条件的
`contractDecisions` 挂 check、`contract-drift` 与 `module-boundaries` 挂 verify。
它没有被放进 `xforge/flows/`，因为那个目录是**靠列目录读的**——放进去就是「项目在跑的 Flow」，
而一个没人选的 Flow 会在每个有在途 Change 的项目里被 `xforge doctor` 报为 unused。
把 `major` 做同样五处改动就得到 Major 版，没有单独随包。

> ⚠️ **切换 Flow 要在没有未归档 Change 的时候做。** 整份 Flow 对象是
> `policySnapshotDigest` 的输入，换 Flow 会挪动每个在途 Change 的 revision，
> 作废已经对着它收下的审批。

### 12.5 四道 Gate

| Gate | 挂在（`solid-contract`） | 判定什么 | 典型实现 |
| --- | --- | --- | --- |
| `contract-lint` | `design.gates` | 基线的风格与命名 | `spectral lint`、`buf lint` |
| `contract-compat` | `check.gates` | **delta 声称改了什么 vs 实际改了什么**，以及破坏性变更 | `oasdiff breaking`、`buf breaking`、`squawk` |
| `contract-drift` | `verify.gates` | 实现是否仍与它被治理的契约一致 | 重新 codegen 后 `git diff --exit-code`、specmatic、Pact |
| `module-boundaries` | `verify.gates` | `project.modules[].dependsOn` 的方向有没有被违反 | `depcruise --output-type err`、`nx lint`、ArchUnit |

**`contract-compat` 是整套安排真正压着的那一道。** 它回答一个不需要任何破坏性变更工具就能回答的问题：
每一个真正移动了的元素，是不是都写进了 contract-delta。一个顺手改了接口的 Agent
在这里被抓住，跟这个方言有没有兼容性检查工具无关。

`module-boundaries` 可以**单独选**：想要依赖方向被强制的项目，不必为此引入一整套契约基线。

四条实施上的坑，每一条都被实跑撞到过：

1. **必须挂 `stage.gates`，不能挂 `stage.exit.gates`。**
   `flowArchiveOperation` 算 `mandatoryGates` 时只读 `verify?.gates`，
   挂错位置，归档时的 Gate 重跑就不覆盖它。
2. **`spec.required: true` 要写上**，尽管 schema 把这个字段标为 deprecated / ignored。
   Gate 调度确实不读它；`core/verification.ts` 的**未声明检查**读它——
   设成 `false`，这道 Gate 就从 `undeclaredRequiredGates` 里消失，那条 info 提醒也随之消失。
3. **`--covers` 的坑，这是接入成本里最贵的一项。**
   每一道 declared Gate 都会拿项目根与每个声明模块根下的**构建系统标记**去算覆盖率，
   多于一个标记时，每条命令都必须点名它覆盖了哪些。而**「一道契约 Gate 覆盖了哪个 toolchain 标记」
   这个问题本身就是错的**——`contract-lint` 读的是整份契约基线，跟某个模块用什么构建系统毫无关系。
   诚实的声明方式是一次点名全部：

   ```bash
   xforge verification declare --gate-name contract-compat \
     --command '["node","scripts/xforge-contract.mjs","compat"]' \
     --covers '["package.json","src/api/package.json","src/web/package.json"]' --by <人>
   ```

   多模块项目不带 `--covers` 会失败于 `XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED`——
   那条错读起来像「缺一条测试命令」，而它不是。
   单模块项目有短路（`detectedCount === 1 && runs.length > 0`），什么都不用做。
4. **refuse 在 `blockedBy` 里长得跟真失败一模一样**，都是 `gate:<id>:failed`
   （`GateEvidence.status` 只有 `passed | failed` 两个值，没有 `refused`）。
   要在工具里区分，**看诊断码，不要看 `blockedBy`**：未声明会另发一条
   `XFORGE_VERIFICATION_NOT_DECLARED`，而且它的 `path` 指向 `xforge/manifest.yaml`。

`core/toolchain.ts` 的自动建议**只认 `unit-tests` 与 `security-scan` 两个 gate 名**，
四道契约 Gate 不会有任何建议命令——只能问人（这与 §3.2 是同一条纪律）。

### 12.6 `contractDecisions`：不写一行代码的「必须有具名人拍板」

破坏性变更的决定走**通用出口条件台账**——就是 §8 的 `condition:` 那套通用读取器，
这里是它作用在契约上的一个实例，**不需要写一行代码**：

```yaml
# <change>/evidence/conditions/contractDecisions.yaml
condition: contractDecisions
entries:
  - id: cbc-orders-legacy-status
    question: 删除 orders.legacy_status 会打断哪些消费者？是否走 expand-contract？
    decision: >-
      走 expand-contract：本 Change 只做 expand（新增 status 并双写），
      删除 legacy_status 放到下一个 Change，保留一个发布周期。
    decidedBy: zhang@example.com
    decidedAt: 2026-09-02T09:12:00Z
```

- **四个字段名是硬编码的，没有别名**：`question` / `decision` / `decidedBy` / `decidedAt`。
  `resolvedBy` / `approvedBy` 是**别的**台账（`check-findings` / `constitution-check`）的字段，
  在这里完全不被读。
- `decidedAt` 必须 `Date.parse` 得动；`decidedBy` 必须命中 `KnownIdentities`。
  「KnownIdentities 为空时静默放行」只在**一次提交都没有的仓库**里成立，
  任何有 git 历史的项目都不会踩到——实测里 `nobody-real` 被拒为 `undecided-1`。
- **写错 key 是静默的。** 通用台账读取器不 import 近似拼写提示那一套，
  conditions 台账里的错别字不会得到任何提示。
- `entries: []` 是一条断言：「本 Change 没有需要拍板的契约变更」。
- 在 `solid` / `major` 上，这个条件本身也带 `requiredWhen: { anyImpact: [moduleContract] }`——
  没声明接口变更的 Change 不欠它。要求每个 Change 都交一份 `entries: []`，
  是花掉一个回合去断言「无」，而 Stage 一直开着等这个回合。
  `solid-contract` 模板里它是无条件的。

失败形态见 §8 的 `condition:` 词汇表：缺 `decidedBy` → `undecided-1`（附 REMEDY 诊断），
文件不存在 → `ledger-missing-expected-resolved`。

### 12.7 资格：`moduleContract` 与 `contractImpact`

```yaml
# change.yaml
classification:
  moduleContract: true    # 本 Change 移动了模块之间的接口

# flow.yaml
policy:
  eligibleWhen:
    contractImpact: forbidden | allowed
  requiredWhen:
    anyImpact: [security, privacy, publicApi, dataMigration, moduleContract]
    #          ↑ 这是 schema 允许的全集，不是随包的值
```

> 随包 `major.yaml` 的 `requiredWhen.anyImpact` **只有前四个**，没有 `moduleContract`——
> 也就是说，默认配置下「移动了接口」不会把一个 Change 强制升到 Major，
> 它只是不能跑在 `quick` 上。想让任何接口变更都走 Major，把 `moduleContract`
> 加进 `major.yaml` 的这一行即可（这是 Flow 数据，不需要改代码）。

**`moduleContract` 刻意不在 `IMPACT_KEYS` 里**，这个区分是承重的：

```ts
const IMPACT_KEYS = ['security', 'privacy', 'publicApi', 'dataMigration'] as const;
const REQUIRABLE_IMPACT_KEYS = [...IMPACT_KEYS, 'moduleContract'] as const;
```

把它并进 critical impacts，一次编辑会同时点燃三处判定，而其中两处是错的——
`quick` 与 `solid` 都写 `criticalImpacts: forbidden`，
于是**专门用来治理接口变更的那条 Flow 会第一个失去承载接口变更的资格**。
「这是不是一个需要最强 Flow 的影响」和「这个 Change 有没有移动接口」是两个问题，
所以它们是两个键。

当前布局：

| Flow | `contractImpact` | 有 `contract-delta` Artifact 吗 | 归档 `syncContracts` |
| --- | --- | --- | --- |
| `quick` | **forbidden** | 无 | 无 |
| `solid` | allowed | 有（`requiredWhen`） | ✅ |
| `major` | allowed | 有（`requiredWhen`） | ✅ |
| `solid-contract`（模板） | allowed | 有（无条件） | ✅ |

`quick` 拒绝的**不是**「接口变更很危险」，而是一条结构性事实：
**它没有任何 Stage 产出 contract-delta，也没有任何东西会合并它**——
一个说自己移动了接口的 Change 在那里**没有地方可以说自己移动了什么**。

三处拦截点，诊断码是 `XFORGE_FLOW_TOO_WEAK` / `XFORGE_FLOW_REQUIRED_POLICY`：
`xforge check`、`xforge state`、以及 `xforge transition` 的**硬拦截**
（有 error 就早退，不写 receipt）。

> ⚠️ **`moduleContract` 是唯一没有旁证的资格键，这句话写在拒绝消息里。**
> risk、模块数、四个 critical impact 都能在 Change 的别处或仓库里被对照；
> 「这个 Change 有没有移动**模块之间的**接口」只因为作者这么说了才知道。
> 于是它产生的拒绝，是 Agent 可以通过编辑造成拒绝的那个输入来消解的一种，
> 而那个动作看起来**和纠正一个笔误一模一样**。
> 源码把这句话放在 `XFORGE_FLOW_TOO_WEAK` 的消息里（也就是 `xforge explain` 查得到的地方），
> 而不是放在 `xforge-propose` 正文里让十分之九从不设这个键的 Change 每次都读一遍。

RC-7（`core/reconcile/rules.ts`）把自报和 delta 摆在一起，**只陈述、不判决**，severity 恒为 `info`：

| 观察 | 诊断码 |
| --- | --- |
| delta 声明了 N 个元素，而 classification 没设 `moduleContract` | `XFORGE_RECONCILE_CONTRACT_IMPACT_UNDECLARED` |
| 自称移动了接口，而 delta 每一节都是 `(none)` | `XFORGE_RECONCILE_CONTRACT_DELTA_EMPTY` |
| delta 说某元素归模块 X，而 `scope.modules` 没列 X | `XFORGE_RECONCILE_CONTRACT_MODULE_OUT_OF_SCOPE` |

**完全没有 contract-delta 的 Change 这里一声不吭**，这是有意的：
不存在的文档不是一份与谁矛盾的记录，而大多数 Change 不碰接口——
一条对它们全都说话的规则，就是这个代码库在别处一律拒绝的「永远无法处置的诊断」。

### 12.8 归档：基线在这里前进，也只在这里前进

`terminal.archive.syncContracts: true`。合并规则（`core/contract-merger.ts`）：

| delta 说 | 基线里 | 结果 |
| --- | --- | --- |
| ADDED | 已记录 | 冲突：`XFORGE_CONTRACT_MERGE_CONFLICT`，提示改用 MODIFIED |
| MODIFIED | 未记录 | 冲突，提示改用 ADDED |
| REMOVED | 未记录 | 冲突 |
| 基线把同一个 id 记了两次 | | 冲突：合并说不清它指哪一块 |
| 域文件还不存在 | 有 MODIFIED 或 REMOVED | 冲突：对一份不存在的记录作出的声称 |

**删光了一个域的所有元素，那份基线记录文件会被删除。**

两个不拒绝、只提问的 warning，而且**只在 `check` 出现，归档路径会丢掉它们**——
到归档时，能回答这个问题的审批已经签完，在那里提出来只能挡住没人能再重新考虑的工作：

| 诊断码 | 说什么 |
| --- | --- |
| `XFORGE_CONTRACT_ANCESTOR_UNDECLARED` | delta 动了 `...Order.properties.status`，而基线也记着包含它的 `...Order`，delta 没提这个祖先。**XForge 不懂方言，看不出包含关系，它看得出的只是 id 前缀**——这足够提问，而提问就是它做的全部 |
| `XFORGE_CONTRACT_MODIFIED_DIGEST_UNCHANGED` | 声明为 MODIFIED，digest 却和基线记的一样。要么元素没变，要么 digest 是从基线抄过来而不是重算的 |

两个真实缺陷值得记住，它们决定了「全 `(none)` 的 delta」的处理方式：
**一份什么都没声明的 delta 原样返回基线，不规划任何 mutation。**
交给最后的比较去判会出两件事——`null` 的含义是「最后一个元素被删了，删掉这份记录」，
而一份本来就空的记录会从另一条路走到同一个零，
于是**最普通的那种 Change（每一节都写 `(none)`）会删掉一份它刚刚声明自己没在碰的受治理文件**；
而重新渲染会规范化空白，于是一份人手写的基线会以一次 `modify` 的形式回来，
被一个什么都没改的 Change 记进归档的 change list、`data.contracts`，
以及每一个其它在途 Change 的「代码已前进」。

**Spec 与契约的合并是同一次事务。** `commands/archive.ts` 给每条 mutation 打一个
`kind: 'spec' | 'contract'` 标记，两类走同一个备份 / 写入 / 回滚路径，
只在最后按 kind 拆成 `data.specs` 与 `data.contracts` 两份报告。
不能各写各的事务——那样会出现「Spec 合并成功、契约合并失败」的仓库状态，
对同一个 Change 说两件不同的事。

`check` 侧的 `validateContractMergeFeasibility` 与 Spec 那边同形同因（§11.4），
连注释都互相引用。

### 12.9 跨 Change：`xforge contract status`

```bash
xforge contract list   [--kind <dialect>]   # 基线现在记录了哪些元素
xforge contract status                      # 在途的几个 Change 各自打算怎么改它
```

`status` 回答的正是 §10 开头那个控制面结构上答不了的问题。
**它只报告，从不阻断，也从不 `ok: false`**：两个 Change 指着同一个元素不自动等于错——
一次迁移的 expand 与 contract 两半就是这个样子，而且是刻意排序的——
一个会拒绝它的 CLI，是在替一个它看不到答案的问题做决定。它能做的是**别让人在合并时才发现**。

`list` 存在的理由很具体：contract-delta 必须用基线**已经在用的** id 去寻址元素，
而**一个记错的 id 不会响亮地失败**——它会作为一个 ADDED 元素合并到你本想改的那个旁边，
基线于是长出一个近似重复项，而没有任何东西会去比对它们。

两个命令都是只读的，而且**旁边刻意没有一个写元素的命令**：
基线只通过归档一份被审阅过的 delta 前进，
一个能直接写元素的命令，就是给这份「价值全在于只有一个写者」的记录加上第二个写者。

> `--kind` 在这里是**契约方言**，不是 `state --kind` 的资源类型。
> 一个被过滤到空的域仍然会被列出来：「这个域没有 openapi 元素」和「这个域不存在」是两个答案。

### 12.10 Rule 与 coverage

随包 Rule `interfaces-are-contract-governed` **默认选中**，在跑 `contract-delta` validator 的
Flow（`solid` / `major` / `solid-contract`）下报 **`guarded, structural`**，`quick` 下只报 `guarded`。

```yaml
enforcement:
  gateRefs: []                       # 见下
  policyRefs: [protected-files]      # → guarded
  validatorRefs: [contract-delta]    # → structural
```

**`gateRefs` 为什么留空**：引用一个项目没有启用的 Gate 会被
`XFORGE_RULE_GATE_DISABLED` 直接拒绝（error）——这是把正确顺序讲成了一条拒绝：
项目先选中 Gate，再在这里点名它。而四道契约 Gate 全是 `builtin: declared`，
默认带着启用发出去会让每个项目在某个 Stage 出口被卡住。
想要更强的性质，两步，顺序不能反：

1. 把 Gate 加进 `manifest.yaml` 的 `scaffold.gates`，加进该跑它的 Stage，
   并 `xforge verification declare` 它的命令；
2. 把它加进这条 Rule 的 `gateRefs`。

`xforge state` 于是从 `structural` 变成 `verified`。

> ⚠️ **`verified` 是按「下一跳 transition」算的，不是按整条 Flow。**
> `control-plane.ts` 里那句判定只看**当前这一跳**所要求的 Gate 集合。
> 而这条 Rule 想引用的三道 Gate 分散在 design / check / verify 三个 Stage，
> **任何单一时刻都不可能三道同时在同一跳里**。这不是缺陷，是这个字段的定义——
> 但它意味着：一条横跨多个 Stage 的 Rule 不会在任意时刻显示 `verified`。
> 期待它在 check 阶段就报 `verified`，是一个写错了的预期。

`approvalRefs` 也是空的，理由同样具体：契约决定骑在 `contractDecisions` 台账
加上 Flow 本来就收的那道规划审批上；点名其中任何一条（`planning-solid` 只在 solid 有，
`implementation-major` 只在 major 有），都会让这条 Rule 在另一条 Flow 下报 `unenforceable`。

### 12.11 代价，以及什么时候不值得做

价值曲线由 **模块数 × 并发 Change 数 × 参与人数** 决定。**单人单模块项目是纯税收。**

零配置层的每 Change 增量，对一个不碰接口的 Change 是 **0**——
它不欠 delta、不欠台账，RC-7 一声不吭。对一个碰接口的 Change，是一个 Artifact 加一份台账。

选中层（四道 Gate）的一次性接入成本，一次真实试点量到的数字——
那次试点跑在 `syncContracts` 之前，当时还要自己写 Policy、Rule 与整条 Flow，
这三项现在随包，所以下表只留今天仍然要付的部分：

| 项 | 数量 |
| --- | --- |
| Gate 登记 + 挂 Stage | 4 |
| `xforge verification declare` | 4 条契约 Gate，每条都要带 `--covers` |
| 适配器脚本（`enumerate` / `lint` / `compat` / `drift`） | 1 个，约 190 行，无外部依赖 |
| 首次基线抽取 | 一个域文件、5 个元素 |

**最贵的一项不是基线抽取，是 `--covers`**（§12.5 第 3 条）。

首次基线抽取的正确起步方式是**基线快照流派**：先 `enumerate` 一次冻结现状，
只卡住新增的未声明变更，不追求契约本身正确
（对照 `dependency-cruiser --ignore-known`、ArchUnit 的 `FreezingArchRule`）。

三条不要忘的边界：

- **Gate 通过只证明「配置好的命令针对被记录的 revision 跑过了」**（§3.3）。
  `contract-compat` 绿了不代表接口设计对。不要因为「契约」听起来更硬就忘掉这条。
- **契约只治理跨模块接口**，模块内部一律不进。
  业界对 SDD 最锋利的批评是工具聚焦字段级细节、产出「结构正确但与真实意图不符」的东西；
  `project.modules[].dependsOn` 的依赖矩阵比 OpenAPI 的字段细节值钱得多。
- **契约工具话痨**（oasdiff、depcruise），而 declared Gate 的输出上限是**每条命令、每个流**
  独立的，N 条命令拼出来的 transcript 上界是 `N × 2 × maxOutputBytes`，
  且每次 `check` 都会在 Git 里留一个新 blob。把 `maxOutputBytes` 设小（8192–16384）。

---

## 13. 两者的对照

| | **Spec 治理** | **接口（契约）治理** |
| --- | --- | --- |
| 基线 | `xforge/specs/<capability>/spec.md` | `xforge/contracts/<domain>.md` |
| 基线是什么 | 产品**必须做到**什么 | 一个模块对另一个**承诺**什么 |
| delta Artifact | `delta-specs`，`specs/**/*.md` | `contract-delta`，`contracts/**/*.md` |
| validator | `spec-delta` | `contract-delta` |
| 节 | ADDED / MODIFIED / REMOVED / **RENAMED** Requirements | ADDED / MODIFIED / REMOVED Contract Elements |
| 合并键 | `### Requirement:` 的标题——**人写的** | `### Element:` 的 CEID——**机器打印的** |
| 键不匹配时 | 按标题开头的可引用 id 点名撞车的那个标题（项目给需求编号时才有） | 不匹配就是另一个元素，**没有什么可提示** |
| 谁欠这份 delta | 每个 Change（三条随包 Flow 都在 propose 产出） | 只有自报 `moduleContract: true` 的 Change |
| 归档开关 | `syncSpecs: true`（quick / solid / major 全有） | `syncContracts: true`（solid / major，quick 没有） |
| 默认强制 | CLI 进程内校验（无 Gate 无 Evidence）+ 基线写保护 | 同左，再加 `contractDecisions` 决策台账 |
| 有 Rule 在核实它吗 | 无随包 Rule 引用 `spec-delta` | `interfaces-are-contract-governed`，报 `guarded, structural` |
| 选中强制 | —— | 四道 `builtin: declared` Gate（升到 `verified`） |
| 跨 Change 冲突 | 无专门命令（同名能力撞车**不会被报告**，见 §11.1） | `xforge contract status`（只报告不阻断） |
| 「修改」可判定吗 | 是（整块文本替换） | 只在两侧都带 `- digest:` 时 |

**三条两边共享的不变量**，改任何一边之前先确认另一边也成立：

1. **同一个 merge 跑两遍，一份实现。** `check` 收集、`archive` 抛出，
   两者共用 `ConflictSink`。第二份实现会与治理归档的那份不一致，那比没有检查更糟。
2. **`(none)` / `entries: []` 是断言，空是缺失。** 空节与「没人走到这里」分不开。
3. **基线不由任何 Stage 推进，只由归档推进。** 一个 Change 可以带着一份没人合并的 delta
   走到归档——这在某个分支上是真实发生过的缺陷——所以合并是**关闭**的一部分，
   而不是某个 Stage 本该做完的事。

---

## 14. 一页速查

**判定权归属**

```text
Stage 现在在哪          ← transition receipt 链（不是文件存在与否）
Artifact 写完没有       ← ArtifactState.status
门开没开               ← readyTransitions[].blockedBy
一条 Rule 有没有牙齿    ← RuleCoverage.coverage
一次检查跑没跑          ← mandatoryGateEvidence[].command
一份审批还算不算数       ← governingRevision + 审计链里的 approval.decided 事件
一个包交付合不合格       ← 真实 diff + verify 退出码 + done_when_evidence 引用相等
产品现在承诺了什么       ← xforge/specs/**（归档合并推进，不是某个 Change 的 delta）
模块之间承诺了什么       ← xforge contract list（不是实现侧的方言文档）
在途的 Change 要怎么改它  ← xforge contract status（只报告，不阻断）
```

**三条「refuse ≠ fail」**

- Gate 拒绝（未声明验证命令）= 一个未被回答的问题，去问人，别猜
- `upgrade-scaffold` 拒绝（有未归档 Change）= 一个属于人的决定
- `ready-to-archive` 无可用 transition = Stage 层面已无可走，用 `transition repair`

**五个「不要手写」**

- `evidence/*.json`（Gate Evidence）
- `xforge/manifest.yaml`（用 `xforge verification declare` / `xforge-scaffold`）
- `verification-receipt.yaml` 的机器部分（用 `xforge verification draft-receipt`）
- delivery 记录的机器部分（用 `xforge work-package draft`）
- 两份基线 `xforge/specs/` 与 `xforge/contracts/`——它们**只由归档合并推进**；
  写保护是给诚实 Agent 的护栏，真正的兜底是下一次合并时的冲突

**三个「必须逐字」**

- `check` 的 `XFORGE_RECONCILE_*` 条目交给人类审批者时
- Reviewer 的结论转录进 `evidence/review/` 或 `evidence/agents/<pkg>/`
- `upgrade-scaffold` 报告里的 adoption count
