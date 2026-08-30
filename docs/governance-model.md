# XForge 治理模型

> Skill、Flow、Rule、Gate、Hook、PermissionPolicy、Approval 这七个名词经常一起出现，
> 也经常被混着理解。这一页回答的是：**每一个到底能证明什么、由什么触发、
> 以及为什么 XForge 从不让其中一个顶替另一个。**
>
> 怎么新增它们见 [扩展指南](extension-guide.md)；整体架构见 [概念与架构](concepts-and-architecture.md)。

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

随包的五个 Gate：`structure`、`check-findings`、`constitution-check`（都是 builtin），
`unit-tests`、`security-scan`（都是 `builtin: declared`）。

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

### 5.2 coverage 的六个取值

```text
instructed    基线：只是一条写下来的指导
guarded       背后真有 PermissionPolicy
verified      背后真有 Gate
approved      背后真有 Approval
uncovered     这条 Rule 没有引用任何机制
unenforceable 它引用了机制，但在当前 Flow 下那个机制不存在
```

> **`unenforceable` 不是更弱的 `uncovered`，是另一句话。**
> `uncovered` 说这条 Rule 没有引用任何机制；`unenforceable` 说它引用了一个
> **在这个 Change 正在跑的 Flow 下并不存在**的机制——项目没有的 Gate，
> 或只有另一条 Flow 才定义的审批策略。

这个区分是补出来的。在有区分之前，第二种情况**读起来是 covered**，
因为非空的 `approvalRefs` 被当成了「有东西在强制它」的证明——
一条指向 `planning-solid` 的 `must` Rule 在 `major` 下报告为已治理，
而那里根本没有这条策略，什么都没在检查它。

`state` 里还有 `enforceableRefs` 字段：`gateRefs` / `approvalRefs` 中
**本 Flow 和本项目真的有**的那个子集。

### 5.3 随包的五条 Rule

| Rule | severity | enforcement | 说明 |
| --- | --- | --- | --- |
| `governance-assets-are-integrator-only` | must | policyRefs: `protected-files`, `protected-manifest` | 与两条策略的 `match.paths` 保持 1:1 对齐 |
| `observable-requirements-are-tested` | must | gateRefs: `unit-tests` | 只有散文证据的需求不算已验证 |
| `design-decisions-need-a-human` | must | approvalRefs: `planning-solid`, `implementation-major` | 两个都列，才能在 solid 与 major 下都可强制 |
| `prefer-small-explicit-contracts` | should | 无 | 明说「judgement guidance only」 |
| `design-within-the-declared-architecture` | should | 无 | 同上；文件不存在时说明一次并继续 |

`design-decisions-need-a-human` 值得单看：它的 `approvalRefs` **同时列了两条策略**，
因为这两条分别只存在于 solid 和 major。列一条就会在另一个 Flow 下变成 `unenforceable`。
而在 `quick` 下这条 Rule 只是指导——`xforge state` 会直接说 `coverage: unenforceable`，
而不是报告一个不可能触发的强制。

> `xforge/scaffold/rules/` 在这七类资源里是唯一**为项目留白**的：
> 随包的五条是示例与自我治理，你的工程标准要自己写。

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

### 8.1 三个带补救提示的 block

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

> 同样的内容有一份**图解版**：[`governance-timeline.html`](governance-timeline.html)，
> 在浏览器里打开更易读，也便于发给没读过这份文档的人。

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

**Skill 从不直接接触这四个。** 它只跟两样东西打交道：`xforge state` 的返回，
和几条 CLI 命令。这四个是控制面内部的判定器。

```text
Skill                        CLI / 控制面
  │
  │ ① xforge state --change <id>
  ├──────────────────────────►  resolveControlPlane()
  │                             ├ 算四层 revision
  │                             ├ 读回执链 → 重建 currentStage
  │                             ├ 读 Gate Evidence · 读 Approval receipt · 核对审计链
  │                             ├ 对每个候选目标算 blockedBy
  │                             └ 重算每条 Rule 的 coverage
  │ ◄──────────────────────────  nextActions[] + blockedBy[] + rules[]
  │
  │ ② 取当前 ready 的 Action，按它自带的 instruction / outline 干活
  │
  │ ③ xforge check --change <id>
  ├──────────────────────────►  Gate runner 跑本 Stage 声明的整组 Gate
  │ ◄──────────────────────────  写 evidence/*.json（绑定当刻 contentRevision）
  │
  │ ④ xforge transition --to <next>
  ├──────────────────────────►  transition guard 逐项校验（见 §9.3）
  │ ◄──────────────────────────  通过 → 写回执；不通过 → blockedBy
```

**Flow 在这里的角色是「声明表」**：某个 Stage 要产出哪些 Artifact、要哪些 Gate、
出口卡哪些 condition / approval / auditEvent。控制面照着这张表逐条求值。
Skill 看不到这张表，它只看到求值之后的结果。

### 9.3 transition guard 的精确顺序

以下是 `core/control-plane.ts` 里构造 `blockedBy` 的**实际执行顺序**：

| # | 检查 | 失败时的 blockedBy |
| --- | --- | --- |
| 1 | 回执链本身是否有效 | `transition-chain:invalid` |
| 2 | 本 Stage `produces` 的 Artifact 是否都 `done` | `artifact:<id>` |
| 3 | 工作包是否都到达 succeeded / integrated / reviewed | `work-package:<id>:<status>` |
| 4 | 树里有没有无归属的已提交改动 | `tree:unattributed-paths` |
| 5 | **Gate**：逐个读 Evidence 判三态 | `gate:<id>:missing` / `:failed` / `:stale` |
| 6 | **出口条件**：台账判定 | `condition:<key>:<reason>` |
| 7 | **Approval**：按策略清点有效 receipt | `approval:<id>:missing-N` / `:rejected` / `:separation-of-duties` |
| 8 | 必需审计事件是否齐全、链是否有效 | `audit:<type>:missing` / `audit:chain-invalid` |

**注意第 5 条：transition 不跑 Gate，它只读 Evidence。** Gate 是 `xforge check` 跑的。
这个分离正是 §3.4 那个时序陷阱的根源——先跑 Gate、再改文件、再跑下一个，
前一个的 `contentRevision` 就对不上了，于是 transition 读到 `stale`，
而每个 Gate 自己都写着 `passed`。

**PermissionPolicy 一次都不出现在这张表里。** 它不在推进路径上。

### 9.4 major 全程：6 次推进 + 1 次归档

| # | Stage | Skill | produces | gates | exit 卡什么 | reworkTo |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `propose` | xforge-propose | proposal · delta-specs | structure | — | — |
| 2 | `clarify` | xforge-clarify | clarifications · material-questions | — | `materialQuestions: resolved` | propose |
| 3 | `design` | xforge-design | design | — | — | propose · clarify |
| 4 | `check` | xforge-check | check-report · check-findings · constitution-check | structure · check-findings · constitution-check | **`approvals: [implementation-major]`** | propose · clarify · design |
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

## 10. 一页速查

**判定权归属**

```text
Stage 现在在哪          ← transition receipt 链（不是文件存在与否）
Artifact 写完没有       ← ArtifactState.status
门开没开               ← readyTransitions[].blockedBy
一条 Rule 有没有牙齿    ← RuleCoverage.coverage
一次检查跑没跑          ← mandatoryGateEvidence[].command
一份审批还算不算数       ← governingRevision + 审计链里的 approval.decided 事件
一个包交付合不合格       ← 真实 diff + verify 退出码 + done_when_evidence 前缀匹配
```

**三条「refuse ≠ fail」**

- Gate 拒绝（未声明验证命令）= 一个未被回答的问题，去问人，别猜
- `upgrade-scaffold` 拒绝（有未归档 Change）= 一个属于人的决定
- `ready-to-archive` 无可用 transition = Stage 层面已无可走，用 `transition repair`

**四个「不要手写」**

- `evidence/*.json`（Gate Evidence）
- `xforge/manifest.yaml`（用 `xforge verification declare` / `xforge-scaffold`）
- `verification-receipt.yaml` 的机器部分（用 `xforge verification draft-receipt`）
- delivery 记录的机器部分（用 `xforge work-package draft`）

**三个「必须逐字」**

- `check` 的 `XFORGE_RECONCILE_*` 条目交给人类审批者时
- Reviewer 的结论转录进 `evidence/review/` 或 `evidence/agents/<pkg>/`
- `upgrade-scaffold` 报告里的 adoption count
