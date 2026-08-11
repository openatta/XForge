[English](governance-concepts.md) | 简体中文

# Skills、Flows、Rules、Gates、Hooks、PermissionPolicies 与 Approvals

这七个名词经常一起出现，也经常被混着理解。这一页是概念地图：每一个到底是
什么、由什么触发、想扩展它该去看哪份指南。具体的怎么做（schema、完整 YAML
示例、检查清单）见
[扩展 Skills 与 Flows](extending-skills-and-flows.zh-CN.md) 和
[扩展 Gate、Rule、PermissionPolicy、Hook 与 Approval](extending-gates-rules-policies-hooks-approvals.zh-CN.md)。

## 一览表

| | 主要职责 | 由什么触发 | 想做到……就扩展它 |
| --- | --- | --- | --- |
| **Skill** | 面向 Agent 的、某一类工作的执行指令 | 用户直接要求，或 Flow 的 stage graph 点名 | 新增一种能力 |
| **Flow** | Change 会走过的 stage graph，以及绑在上面的治理规则 | Propose 时选定，来自 manifest 默认值或显式覆盖 | 建模不一样的交付/风险流程 |
| **Rule** | 一条声明性指导，其"被强制执行"的声称会被核实，不是被采信 | 每次算 `xforge state` 都重新评估 | 让写下来的标准变得机制上诚实 |
| **Gate** | 确定性检查，产出签名、和 revision 绑定的 Evidence | `xforge check`、Transition 或 Archive 之前 | 加一个客观的正确性/质量检查点 |
| **Hook** | 编程工具原生事件到 XForge 逻辑的接线 | 每一次匹配的 Agent 工具调用或治理事件，实时 | 接入新事件，或插入自定义逻辑 |
| **PermissionPolicy** | 针对某个能力的 allow/ask/deny 决定 | 每一次匹配的工具调用，通过 Hook，实时 | 实时拦下某个具体的危险动作 |
| **Approval** | 人类或外部系统的决定，绑定在当前 revision 上 | Flow stage 声明的 `exit.approvals` | 嵌入一道真正的授权步骤 |

## 两条独立轨道，不是一条流水线

最容易踩的错误心智模型是"Gate → Rule → Policy → Approval"按顺序在每个 Stage
里挨个检查一遍。实际上是**两条互不相通的轨道**，外加一层横切的诚实性检查：

**阶段治理轨道**——只有 Gate 和 Approval。Flow 的某个 stage 声明它需要哪些
Gate（`gates: [...]`），以及哪些 Approval policy 卡在它的退出口
（`exit.approvals: [...]`，或者归档前的 `terminal.archive.approvals`）。
这些只在有东西要求推进的时候才评估——`xforge check`、`xforge transition`、
`xforge archive`——除此之外不会触发。大多数 stage 两者都没有；只有 Flow 作者
明确接上的那几个才有。

**实时运行时轨道**——PermissionPolicy 和（大部分）Hook。这些持续运行，每一次
匹配的 Agent 工具调用都会触发，跟 Change 当前走到哪个 Stage、甚至有没有活跃
的 Change 都没关系。一次 `Write` 调用会被拿去跟 PermissionPolicy 比对，不管
Agent 当时是在 Propose、Apply，还是根本没有打开任何 Change。

**Rule 横跨两条轨道之上，做的是核实，不是把关。** Rule 不会作为任何一条轨道
里的一个步骤被"检查"。它声明 `severity` + `instruction`，以及它声称由哪些
Gate/Policy/Approval 强制执行
（`enforcement.gateRefs`/`policyRefs`/`approvalRefs`），每次算
`xforge state` 都会拿这个声称去和当下的真实情况对照，产出 `coverage`：
`instructed`（基线）→ `guarded`/`verified`/`approved`（真的有 Policy/Gate/
Approval 在背后撑着）或者 `uncovered`（一条 `must` 级别的 Rule，背后什么机制
都没有）。Rule 从来不会自己拦下任何东西——它做的是把"写下来了"和"真的被强制
执行"之间的落差暴露出来，而不是藏起来。

## Skills

面向 Agent 的接口。每个 Skill 是一份 `SKILL.md`（+ `SKILL_cn.md`），固定五个
章节——Invariants、Authority、Execution、Evidence、Stop and rework。Skill 消费
`xforge state` 返回的当前 ready Action，并跟着这个 Action 自带的数据（
instruction/outline）走，不硬编码另一个 Skill 的步骤，也不写死某个 Flow 的
名字。默认自带 13 个：生命周期类的
（`xforge-propose`/`clarify`/`design`/`check`/`apply`/`verify`）、治理工具类
的（`xforge-revise`、`xforge-scaffold`），以及完全在 Change 生命周期之外的
（`xforge-explore`、`xforge-kanban`、`xforge-status`、`xforge-continue`，
再加上遗留兼容用的 `xforge-archive` shim）。

## Flows

Change 要走过的 stage graph，以及绑在上面的治理规则：每个 stage 归哪个 Skill
管、每个 stage 需要哪些 Gate 和 Approval、work-package 执行模式、审计策略。
默认自带三个——`quick`（Propose→Apply→Verify）、`solid`（加了 Design）、
`major`（加了 Clarify、Design、Check，以及更强的双签、双角色治理）。Flow
policy 可以让某个 Flow 对某种风险/影响分类变成**必选**（不只是可选），也可以
让某个 Flow **不合格**（Quick 拒绝跨模块或非低风险的工作）——这是结构上强制
的，不是靠 Agent 自己判断。

## Rules

机制见上面"两条独立轨道"。Rules 是这七个里唯一默认不带任何示例的——
`xforge/scaffold/rules/` 是空的，等项目自己去写标准。

## Gates

一次确定性检查：要么是固定的 `command`（任意语言、任意工具链——`npm test`、
`pytest`、`go vet`，你项目实际跑什么都行），要么是唯一的特例
`builtin: structure`（CLI 自己进程内的 schema/引用/资格校验逻辑，为了统一，
包装成和其它 Gate 一样的 Evidence 形状）。默认自带的每个 Flow 在 Verify 阶段
至少都要求 `structure` + `unit-tests`；`major` 再加 `security-scan`。在这七
个里，Gate 是最接近"没得选"的基线——没有哪个默认 Flow 会在归档前跳过正确性
检查。

## Hooks

编程工具原生事件（`PreToolUse`、会话开始、权限请求）和 XForge 逻辑之间的
接线。`xforge init`/`install`/`sync` 会把启用的 Hook 资源投影进每个平台自己
的原生 Hook 配置，接到调用 `npx --no-install xforge hook dispatch --target
<platform> --event <event>` 上。这一次分发调用里流过三样东西：

1. **实时 PermissionPolicy 评估**（相关事件发生时总会跑——见下面
   PermissionPolicy 部分）。
2. **审计记录**（`builtin: audit`，或者不管怎样每次分发都会隐式记录——见下面
   "审计里实际记了什么"）。
3. **自定义 scriptRef 逻辑**——一个 Hook 可以引用一个项目自有的
   `kind: Script`（Node 或 Python），从 stdin 读事件 payload，自己也能给出
   一个 allow/ask/deny 的意见，和 PermissionPolicy 的结果按同一套"deny 压
   ask 压 allow"规则合并。

### 审计里实际记了什么

每次分发调用都会写一条哈希链接的 `AuditEvent`（`previousHash` 把每条事件和
前一条链起来，篡改会破坏整条链，不只是一条记录）。真正去读这份记录时要看的
字段：

```json
{
  "eventType": "agent.tool.before",
  "plane": "runtime",
  "platform": "codex",
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

注意**没有**记什么：真实的文件内容、真实的 shell 命令文本、真实的工具参数。
默认（`redaction: strict`）只记 `inputDigest`/`outputDigest`（哈希值）——这份
记录证明的是"确实发生过一次决策"以及"为什么"（`refs`、`decision`、
`reason`），不会泄露 Agent 当时到底在读写什么。

用这些命令读这份记录：

```bash
npx --no-install xforge audit status                 # 按 eventType 计数、覆盖缺口、待远端投递数量
npx --no-install xforge audit status --change <id>    # 限定到某个 Change
npx --no-install xforge audit verify --change <id>     # 哈希链完整性 + 该 Change 所属 Flow 要求的事件类型是否齐全
npx --no-install xforge audit export --change <id> --output report.json   # 完整的脱敏事件列表，供外部审阅
```

`audit verify` 是真正卡住 Archive 的那个命令——对于 `remoteDelivery:
required` 的 Flow（默认是 Major），如果必需事件还没投递到配置好的远端接收
端，Archive 会被挡住，直到 `audit retry` 清空积压或者远端恢复。

## PermissionPolicy

一个 `capability`（`fs.read`/`fs.write`/`shell`/`network`/`mcp`/
`subagent`/`external.write`）、一个 `effect`（`deny`/`ask`/`allow`），和一个
`match` 模式。通过上面说的 Hook 分发实时评估，每一次匹配的工具调用都会触发
——不绑定任何 Stage。要不要配自定义 PermissionPolicy，与其说看团队规模，不如
说看有没有人在实时盯着：交互式、有人在看的会话，编程工具自己就会弹权限确认；
无人值守或并行 Worker 执行的时候没人在盯，这时候 PermissionPolicy 恰恰是唯一
还能拦住危险操作的东西。默认自带一条（`protected-files`，拒绝除 Integrator
外任何人写 `constitution.md`/`specs/**`/`manifest.yaml`/`lock.yaml`），
保护 XForge 自己的治理文件不被意外自我损坏。

## Approval

人类或外部系统的决定，产出一份签名的 `ApprovalReceipt`，绑定在当前确切的
`stateRevision`/`contentRevision`/`gitHead` 上——之后任何一次编辑都会让它
失效。产出方式有两种：本地交互式（`--attestation human`，要求真实 TTY，
刻意做成不能自动化——Agent 不能自我批准）或者外部签名 receipt
（`xforge approve --receipt <path>`，用登记在 `manifest.yaml` 的
`approvals.providers` 里的共享密钥做 HMAC-SHA256，不需要 TTY 就能验证）。
默认自带的每个 Flow 归档前都至少要求一次 Approval，连 Quick 也不例外——严格
程度随 Flow 变化（Quick：一个本地确认人；Major：两个不同角色的外部签名人，
`separationOfDuties` 靠数不同角色而不是数不同 receipt 来强制）。在这七个里，
Approval 是"要不要"在默认配置下基本不算可选项的那一个——只有力度是可以调的。

## 接下来去哪看

- [扩展 Skills 与 Flows](extending-skills-and-flows.zh-CN.md)——新增一个
  Skill、新增一个 Flow，以及 Flow 相关的差异该放在哪一层。
- [扩展 Gate、Rule、PermissionPolicy、Hook 与 Approval](extending-gates-rules-policies-hooks-approvals.zh-CN.md)
  ——schema、完整 YAML 示例，以及每一个在运行时到底是怎么被调用的。
- [治理控制平面设计](governance-control-plane-design.md)——这套模型背后更
  深的设计理由和取舍，如果你想知道"为什么"而不只是"是什么"。
