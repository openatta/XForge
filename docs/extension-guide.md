# XForge 扩展指南

> 一份文档覆盖全部九类可扩展资源：**Skill、Flow、Gate、Rule、PermissionPolicy、
> Hook、Approval、Agent、McpServer**（外加 Script）。
> 每一节的结构是：**放哪里 → schema 必填项 → 完整示例 → 运行时怎么被调用 → 陷阱**。
>
> 想先搞清楚它们各自是什么，见 [治理模型](governance-model.md)。

---

## 0. 三条贯穿全篇的规则

### 0.1 存在 ≠ 启用

**同步是由 `manifest.yaml` 驱动的，不是扫描目录。**
一个没有 manifest 条目的资源，哪怕文件完全合法，也永远不会被投影出去、不会被加载、不会生效。

```yaml
# xforge/manifest.yaml
scaffold:
  skills:     [xforge-propose, ..., my-skill]
  agents:     [worker, integrator, reviewer]
  rules:      [governance-assets-are-integrator-only, ...]
  policies:   [protected-files, protected-manifest]
  hooks:      []                       # 随包 runtime-audit 有意不选中
  gates:      [structure, check-findings, constitution-check, unit-tests, security-scan]
  mcpServers: [enterprise-approvals]
scripts:      [project-context]
```

`xforge doctor` 会扫描 dangling reference 与未被引用的扩展资源，
但它**只警告，从不阻塞**（可用 `--kind` 收窄）。

### 0.2 三步走

```bash
# 1. 在规范源里创建资源
#    在采用 XForge 的项目里：  xforge/scaffold/<kind>/...
#    在 XForge 本仓库贡献时：  scaffold/payload/xforge/scaffold/<kind>/...

# 2. 登记进 manifest.yaml（优先用 xforge-scaffold Skill，别手改）

# 3. 投影
xforge sync --dry-run
xforge sync
```

`xforge-scaffold` 这个 Skill 就是为了在一次受治理的操作里完成第 1–2 步而存在的。
`manifest.yaml` 受 `protected-manifest` 策略管辖（effect `ask`），手改会被要求确认，
而**一次实测里手写该块缩进少了一级，此后治理 dispatcher 再也读不了 Manifest，
于是拒绝了每一次工具调用——包括本可以修复它的那些。**

### 0.3 改治理资产会让在途 Change 失效

`policySnapshotDigest = hash(constitution + flow + rules + policies + hooks + gates)`，
而它是 `contentRevision` 与 `governingRevision` 的输入。

**所以本文档里任何一处编辑，都会让所有未归档 Change 的 Gate Evidence 变 stale、
Approval 不再计入有效集合。** 已归档的 Change 不受影响。

> **把治理资产的变更当成一次发布窗口：先清空 / 归档在途 Change → 再改 → 再开新 Change。**
> `xforge upgrade-scaffold` 在有未归档 Change 时直接拒绝，正是这个用意。

---

## 1. Skill

### 1.1 放哪里

```text
xforge/scaffold/skills/<skill-id>/
├── SKILL.md          英文，必需
├── SKILL_cn.md       中文，本地化时必需
├── agents/           可选，Skill 私有的子 Agent 提示
└── scripts/          可选
```

新增 Skill **不需要改任何代码**。

### 1.2 写作规范

> **完整规范见 [Skill 编写规范](skill-authoring.md)** —— 四类句子、CLI 调用的唯一写法、
> 强制复述清单、机器校验对照表。这里只保留新增一个 Skill 时必须先知道的部分。

**Frontmatter**

```yaml
---
name: my-skill
description: 一句话说清「产出什么、什么时候用」
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---
```

> ⚠️ frontmatter **只写宿主或 CLI 真的会读的字段**。不要写 `license:` 或 `metadata:` ——
> 归属信息在 `scaffold/NOTICE` 里写一次，逐文件重复会被产品契约测试拒绝。

**固定五个章节，顺序不变**

| 章节 | 内容 |
| --- | --- |
| `不变量` / Invariants | 行动前必须读取 / 必须成立的前提 |
| `权限` / Authority | 明确列出能写哪些路径，**以及明确列出相邻但不能碰的东西** |
| `执行` / Execution | 编号步骤 |
| `证据` / Evidence | 要报告什么、对照哪个 `doneWhen` / `requiredEvidence` |
| `停止与返工` / Stop and rework | 什么时候必须停下、由哪个 Skill 负责修 |

许多内置 Skill 还有第六节「判断要点」，收录那些容易被漏掉的判断，不是必需的。

### 1.3 四条硬规则

1. **只跟着 Action 走，不跟着 Flow 名字走。** 消费 `xforge state` 返回的当前 ready Action，
   严格按它的 `instruction` / `outline` 执行。
   **绝不写 `if flow is quick/solid/major` 这类分支**，也不引用别的 Skill 内部的步骤。
2. **Authority 要收窄。** 精确写出能写哪些 Artifact 路径，并明确列出相邻但不能碰的
   （Proposal、Specs、Design、Evidence、Archive 等）——这样排序的权威来源始终是
   Flow 的 stage graph，而不是 Skill 自己的判断。
3. **中英文必须同步修改。** 任何对 `SKILL.md` 或 `SKILL_cn.md` 的修改，
   都必须在同一次改动里镜像到另一个文件——结构和语义一致，不是逐字翻译。
4. **不要把 Gate digest 写进 Artifact 正文。** 见 §0.3 与 [治理模型 §3.4](governance-model.md)。

### 1.4 陷阱：按 Flow 名字分支

```text
❌ Skill 散文里写「Solid 时…… Major 时……」
```

这比任何一种机制都脆弱——新增一个自定义 Flow（比如 `hotfix.yaml`）会被**静默处理错**，
因为这个 Skill 从没「听说过」它。

`xforge-design` 就是具体例子：`solid.yaml` / `major.yaml` 本身已经给 `design` artifact
准备了不同的 `instruction` / `outline`，所以 Skill 只需要说
「严格按当前 Action 的 instruction 和 outline 执行」。

### 1.5 检查清单

- [ ] `SKILL.md` + `SKILL_cn.md` 已创建，结构一致、语义镜像
- [ ] 五个标准章节齐全；Authority 精确列出能写 / 不能写
- [ ] 散文里没有按 Flow 名字分支
- [ ] CLI 调用只用[六动作写法](skill-authoring.md)，命令取自 `nextActions[].command`
- [ ] 对照 [Skill 编写规范 §5](skill-authoring.md) 的强制复述清单逐条确认
- [ ] 已登记进 `manifest.yaml` 的 `scaffold.skills`
- [ ] `xforge sync --dry-run` 已核对，再运行 `xforge sync`

---

## 2. Flow

### 2.1 放哪里

`xforge/flows/<name>.yaml`。加载方式是读取该目录下的每个文件，
再用 `flow.schema.json`（`v1alpha2`）校验。**没有任何 TypeScript 枚举挡着新文件。**

> ⚠️ `xforge/flows/**` 受 `protected-files` 策略（effect **deny**）管辖，
> 只有 Integrator、显式的 XForge 事务或 CLI 本身能写。
> Flow 的修改属于 `xforge init` 时期，不属于一个进行中的 Change。

### 2.2 schema 必填项

顶层必填：`apiVersion`、`kind`、`metadata`、`policy`、`artifacts`、`stages`、`terminal`。

| 位置 | 必填 | 约束 |
| --- | --- | --- |
| `metadata` | `name`、`version`、`description` | `name` 必须与文件名一致；id 形如 `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` |
| `policy` | `assuranceLevel`、`eligibleWhen` | **`assuranceLevel` 只能是 `quick`\|`solid`\|`major`** |
| `policy.eligibleWhen` | `risk`、`criticalImpacts` | 可选 `maxModules ≥ 1` |
| `policy.requiredWhen` | 至少一个属性 | `risk` 和 / 或 `anyImpact`（security/privacy/publicApi/dataMigration） |
| `artifacts[]` | `id`、`generates`、`description`、`instruction`、`outline` | 可选 `validator: spec-delta`、`markers` |
| `stages` | **至少 3 项** | 必须包含 `propose`、`apply`、`verify`；`id` 唯一 |
| `stages[]` | `id`、`skill`、`authority`、`requires`、`produces` | 可选 `revises`、`gates`、`reworkTo`、`exit` |
| `governance` | `approvalPolicies`、`audit`（整块可省） | `approvalPolicies` 可为 `[]` |
| `approvalPolicy` | `id`、`minApprovers`(1–10)、`roles`、`separationOfDuties`、`providers` | |
| `auditPolicy` | `requiredEventTypes`、`runtimeCoverage`、`remoteDelivery` | 后两者 `optional`\|`required` |
| `terminal.archive` | `handler`、`authority`（恒为 `archive-write`）、`requires`、`syncSpecs` | 可选 `approvals`、`auditPolicy` |

`authority` 五档：`read-only` / `planning-write` / `assurance-write` /
`implementation-write` / `archive-write`。

> **你可以在一个新文件名下发布完全自定义的 stage graph 和治理策略，
> 但目前仍必须挂靠三档保证级别之一。** 真正独立的第四档需要改 schema。

### 2.3 已废弃、CLI 不再读取的字段

保留只为兼容 0.7.9 之前写的 Flow，随包 Flow 都省略了它们。
**声明它们能通过校验，也什么都不改变。**

| 字段 | 说明 |
| --- | --- |
| `policy.onUncertain` | 升级由 `eligibleWhen` / `requiredWhen` 决定 |
| `stages[].execution` | `xforge-apply` 按手头工作的真实依赖图决定计划形态 |
| `terminal.archive.evidencePolicy` | archive 总是绑定当前 revision |

### 2.4 最有价值的扩展点：自定义 exit condition

任何写在 `exit.conditions` 里的 `<key>: <expected>`，只要 key 匹配
`^[A-Za-z0-9][A-Za-z0-9._-]*$`，都会被同一个**通用台账读取器**判定——
**不需要写一行代码**。

```yaml
# xforge/flows/hotfix.yaml
- id: triage
  skill: xforge-clarify
  authority: planning-write
  requires: [propose]
  produces: [triage-notes]
  exit:
    conditions:
      incidentOwnerAssigned: resolved
```

```yaml
# <change>/evidence/conditions/incidentOwnerAssigned.yaml
condition: incidentOwnerAssigned
entries:
  - question: 谁负责这次事故的收尾与复盘？
    decision: 由 zhang 负责，复盘会在周五
    decidedBy: zhang@example.com     # 必须命中 KnownIdentities
    decidedAt: 2026-08-22T09:12:00Z
status: resolved                     # 省略时默认 resolved，必须等于 expected
```

判定顺序与失败 reason：

```text
文件都不存在（.yaml → .yml → .json）  → ledger-missing-expected-<expected>
存在但解析不了 / 不是对象              → ledger-unreadable
ledger.condition 存在且 ≠ key         → ledger-subject-mismatch
没有 entries 数组                     → entries-missing
有 entry 未 decided                   → undecided-<n>
(ledger.status ?? 'resolved') ≠ expected → status-<实际>-expected-<期望>
否则                                   → ✅ satisfied
```

「entry 已 decided」= `question` / `decision` / `decidedBy` / `decidedAt` 四个字段全非空，
`decidedAt` 能被 `Date.parse` 解析，且 `decidedBy` 命中 KnownIdentities。

**显式的 `entries: []` 是一条被接受的断言**（「本 Change 没有这类问题」），
与文件不存在、无法解析、缺 `entries` 键三种情况严格区分。

三个键走**特殊路由**，不读通用台账：

| key | 由什么判定 |
| --- | --- |
| `verificationReceipt` | `evidence/verification-receipt.yaml` + 当前 `contentRevision` + 实际通过的 Gate 集合 |
| `independentReview` | work-package 的 `acknowledgements.reviewedBy`，或无计划时 `evidence/review/` 下的 ack receipt |
| 其它任意 key | 通用台账读取器 |

### 2.5 `exit` 必须写成结构化形态

```yaml
# ✅ 结构化
exit:
  conditions: { materialQuestions: resolved }
  gates: [my-gate]
  approvals: [my-policy]
  auditEvents: [my.event.type]

# ❌ 旧形态，被 XFORGE_FLOW_EXIT_UNSTRUCTURED 拒绝
exit:
  materialQuestions: resolved
```

schema 的 `oneOf` 里仍留着裸映射形态，但**所有读取方都会忽略它**——
那曾经是一道无人查看的门。

### 2.6 Flow 差异该放在哪一层（按优先级）

1. **stage graph 里有没有这个阶段（优先）。** 不需要就别声明，不要让 Skill 自己判断要不要跳过。
2. **artifact 的 `instruction` / `outline`。** 同一个 Skill 服务多条 Flow 时用这个。
3. **结构化 `exit` 字段（最后手段）。** 只用于代码必须据此行动的行为；
   **用完要确认它真的出现在 `blockedBy` 里**——一道从不出现在那里的门，与不存在没有区别。

### 2.7 Artifact `markers`

`outline` 规定 Artifact 必须有哪些 `## ` 小节；`markers` 规定其中某个小节**意味着什么**——
正是这一点让 `check` 的核对规则能够算出答案，而不必请人读完散文再为它背书。

```yaml
- id: design
  outline: |
    ## Decisions and alternatives
    ## Test strategy
  markers:
    - id: verification-coverage
      section: Test strategy
      role: requirement-coverage
    - id: rejected-alternative
      section: Decisions and alternatives
      role: decision-alternative
      pattern: ['**Rejected alternative:', '**被否决的替代方案：']
      minOccurrences: 1
```

三种 `role`：

| role | 含义 |
| --- | --- |
| `requirement-coverage` | 该小节是记录 Requirement 覆盖的地方；某条 Requirement 出现在同一文件别处但不在该小节内，仍可被报告 |
| `decision-alternative` | 匹配 `pattern` 的条目是被否决的替代方案，逐字引用进简报 |
| `declared-gap` | 匹配 `pattern` 的条目把问题推给后续 Stage；简报会报告没有任何 finding 引用它的那些 |

**`pattern` 是列表**，因为 Flow 单一来源而它治理的散文是本地化的：
同一个 Flow 同时治理用英文和用中文写作的项目，只写一种语言的条目标记会在另一种语言下静默失效。

两种严重级别是刻意区分的：marker 指向不存在的小节是 **warning**（`outline` 一向是指导，
把缺失小节升级为错误会让 markers 出现之前就已合法的 Change 失败）；
`minOccurrences` 未达标是 **error**（那是 Flow 明确要求某小节至少承载 N 个条目，
只有主动声明的项目才会走到那里）。因此随包 Flow 只声明 `requirement-coverage`，不设 `minOccurrences`。

**依赖某个 marker 的规则，在 Flow 未声明该 marker 时什么也不报告，绝不退化为猜测。**

### 2.8 `outline` 由谁检查：默认没有人，除非你开

`outline` 默认是写作指引，不是要求。一次实测中，Proposal 缺少 `quick.yaml` 声明的一个小节，
从 Propose 一路到归档看到的都是 `Structural validation passed.`

要让它被检查，在那个 Artifact 上写 `validator: outline`：

```yaml
artifacts:
  - id: proposal
    # ... generates / description / instruction 照常
    validator: outline        # 缺小节时报 XFORGE_ARTIFACT_OUTLINE_SECTION_MISSING
    outline: |
      ## 背景
      ## 方案
```

**这是 warning，不阻塞 Change**：它告诉你有小节没写，锚在那些小节上的 marker 或引用会取不到东西。
只查遗漏 —— `outline` 没列的额外 `##` 小节不报告。

随包的三个 Flow **都没有声明 `validator: outline`**，能力与采用决策是分开的：
`quick` 的 `proposal` 声明了 6 个小节、`assurance` 5 个，一旦开启，每个 Change 都得把它们写全。
那是项目自己的取舍，不该由随包默认替它做主。

**如果你需要某个小节是硬性必需、缺了就让 Change 失败，仍然要给它一个带 `minOccurrences` 的
marker。那是唯一会让 Change 失败的机制。**

### 2.9 让 Flow 可被选用

```yaml
# 项目默认
flow: solid                 # xforge/manifest.yaml
# 或单个 Change 覆盖
flow: hotfix                # <change>/change.yaml
```

`xforge-propose` 默认静默继承 manifest 的默认值，除非用户明确要求换一个 Flow。

### 2.10 检查清单

- [ ] `metadata.name` 与文件名一致
- [ ] `stages` 含 `propose` / `apply` / `verify`，`id` 唯一，至少 3 项
- [ ] `policy.assuranceLevel` 挂对档
- [ ] 内容深度差异写在 `artifacts[].instruction` / `outline`，不是 Skill 散文
- [ ] 运行时行为差异写成结构化 `exit` 字段，不是按 Flow 名字做字符串判断
- [ ] **新声明的每道门都确认真的出现在 `blockedBy` 里**
- [ ] 自定义 condition 的台账路径、`condition:` 字段、`status` 三者对得上
- [ ] `governance.approvalPolicies` 里定义了 `exit.approvals` / `terminal.archive.approvals` 引用的每个 id
- [ ] 引用的 provider 在 `manifest.approvals.providers` 里存在
- [ ] **`governance.audit` 与 `terminal.archive.auditPolicy` 一致**
- [ ] 记住：改 Flow YAML（含改注释）会让所有使用它的活跃 Change 的 revision 漂移

---

## 3. Gate

### 3.1 schema

```yaml
apiVersion: xforge.dev/v1alpha1        # 或 v1alpha2
kind: Gate
metadata: { name: my-gate, version: 1 }
spec:
  required: true          # 已废弃，被忽略——但仍是必填字段
  timeoutSeconds: 900     # 必填
  evidence: my-gate.json  # 必填，写到 <change>/evidence/<这个名字>
  # 二选一：
  builtin: declared       # structure | check-findings | constitution-check | declared
  # 或
  command: ["pytest", "-q", "tests/"]
```

必填：`required`、`timeoutSeconds`、`evidence`，外加 `builtin` 与 `command` 恰好其一。

> ⚠️ **`spec.required` 与 `spec.stage` 已废弃，CLI 不读它们。**
> Gate 的调度完全由 Flow 的 `stage.gates` / `stage.exit.gates` 与 archive 终态决定，
> 控制面会在这些列表里的任何一个 Gate 未通过时阻塞。
> **`required: false` 不会禁用一个 Gate，只会看起来像能禁用。**
> 新 Gate 应当省略 `stage`。

### 3.2 挂上去

```yaml
# 在 Flow 的 stage 上
- id: verify
  gates: [structure, unit-tests, my-gate]
# 或在出口上
  exit:
    gates: [my-gate]
```

**声明一个 Gate 却不在任何 Flow 里引用它，等于它不存在**（`doctor` 会警告）。

### 3.3 运行时

Gate runner **不使用 shell**（除非 Gate 显式声明）；环境变量最小化；
输出有大小上限并做 secret 脱敏。Evidence 记录 runner 完整性、argv / cwd、
revision / Git、时间、退出码、digest。

### 3.4 `builtin: declared` 与项目声明

```bash
xforge verification declare \
  --gate-name unit-tests \
  --command '["cargo","test","--workspace"]' \
  --by <回答这个问题的人>

# 有意不覆盖的工具链：
xforge verification declare \
  --gate-name security-scan \
  --not-applicable <marker> --justification <理由> --by <人>
```

命令会写好 manifest 里的块、自动填 `declaredAt`，**宁可拒绝也不会产出一份加载不了的 Manifest**。

**不得猜测，也不得因为 CLI 给了建议就采用它**——工具链检测读的是构建系统标记，
判断不了一条命令是否真的在验证什么；在一个没有任何测试的仓库上，
一条测试命令照样能让这个 Gate 变绿而什么都没断言。

### 3.5 陷阱

- **必须在最后一次写入之后一次性跑完 Gate**（见 [治理模型 §3.4](governance-model.md)）。
- **Gate 名字要进 `verification-receipt.yaml` 的 `gates`，digest 不要进。**
  work-package 交付写在 `workPackageDeliveries`，写成 `gates` 的一行会被
  `gate-unverifiable-<name>` 拒绝。

---

## 4. Rule

### 4.1 schema

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Rule
metadata: { name: public-api-safety, version: 1 }
spec:
  severity: must | should            # 必填
  instruction: >-                    # 必填
    Public API changes require compatibility evidence.
  scope:                             # 必填（三个子项都可选）
    modules: [core]
    paths:   [src/api/**]
    stages:  [design, check, verify]
  enforcement:                       # 必填
    gateRefs:     [unit-tests]       # 必填（可为 []）
    policyRefs:   []                 # 必填（可为 []）
    approvalRefs: [implementation-major]   # 可选
```

### 4.2 运行时

**Rule 不会作为任何一条轨道里的一个步骤被「检查」。**
每次算 `xforge state` 时，拿 `enforcement.*Refs` 的声称去和当下的真实情况对照，产出 `coverage`：

```text
instructed → guarded / verified / approved → uncovered / unenforceable
```

`unenforceable` 与 `uncovered` 的区别见 [治理模型 §5.2](governance-model.md)。

### 4.3 三条写作建议

1. **列出所有 Flow 里的等价策略。** `design-decisions-need-a-human` 的 `approvalRefs`
   同时列了 `planning-solid` 和 `implementation-major`，因为这两条分别只存在于 solid 和 major。
   **列一条就会在另一个 Flow 下变成 `unenforceable`。**
   一个命不中任何策略的 ref 会被**忽略**而不是计数。
2. **与它声称的策略保持 1:1 对齐。** `governance-assets-are-integrator-only` 的
   `scope.paths` 与 `protected-files` / `protected-manifest` 的 `match.paths` 精确对齐——
   一条 Rule 声称一个策略不覆盖的路径，会把它误报为 guarded。
3. **只是判断指导就明说。** `prefer-small-explicit-contracts` 和
   `design-within-the-declared-architecture` 的 instruction 里直接写着
   「Judgement guidance only; XForge does not claim to enforce it」。
   **诚实地标 `uncovered`，好过假装被强制。**

---

## 5. PermissionPolicy

### 5.1 schema

```yaml
apiVersion: xforge.dev/v1alpha2
kind: PermissionPolicy
metadata: { name: no-prod-migrations, version: 1 }
spec:
  capability: shell        # fs.read|fs.write|shell|network|mcp|subagent|external.write
  effect: deny             # deny | ask | allow
  match:                   # 必填，至少一项
    paths:      [db/migrations/**]
    commands:   ["*flyway*migrate*", "psql*production*"]
    tools:      [...]
    hosts:      ["*.prod.internal"]
    mcpServers: [...]
  exceptActors: [integrator]
  reason: >-               # 必填
    Production migrations are executed by a human, never by an Agent.
```

必填：`capability`、`effect`、`match`（≥1 项）、`reason`。

### 5.2 两套通配符语义

| 字段 | 语义 |
| --- | --- |
| `paths` | **严格分段**：`*` 不跨 `/`，`**` 跨 `/`，`?` 匹配一个非 `/` 字符，支持 `[...]`，匹配 dotfile |
| `commands` / `tools` / `hosts` | **宽松**：`*` 匹配任意字符串，**会跨 `/`** |

区分是有意的：路径是 `/` 分段的命名空间，命令行不是——所以 `rm -rf *` 也会匹配 `rm -rf /tmp/x`。

### 5.3 合并规则

**deny 压 ask 压 allow。** 自定义 `scriptRef` Hook 的意见按同一套规则参与合并。
企业 / 平台的 managed policy 是**上游层**，项目投影无法削弱它。

### 5.4 边界：这是护栏，不是安全边界

强制它的 runtime Hook 只检查工具调用的**结构化路径参数**。
一个 `shell` 调用如果间接写了这些路径（`cat >`、`tee`、`cp`、一个自己打开文件的脚本），
匹配的是整条命令串对 `match.commands` 的 glob，而不是它真正碰到的文件，**不会被抓住**。

对照 `xforge approve` 的反自我批准设计：那是**结构性**的（决定词只能来自实时终端提示）。
这条策略不是那种保证——把它当成一个诚实 Agent 会遵守的护栏，
背后由 `constitution-check` Gate、Git history 和审计链做事后归因。

### 5.5 什么时候真的需要它

**与其说看团队规模，不如说看有没有人在实时盯着。**
交互式、有人在看的会话里，编程工具自己就会弹权限确认；
无人值守或并行 Worker 执行时没人在盯——这时候 PermissionPolicy 恰恰是唯一还能拦住危险操作的东西。

---

## 6. Hook（与 Script）

### 6.1 schema

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Hook
metadata: { name: my-hook, version: 1 }
spec:
  enabled: true            # 必填
  plane: runtime           # 必填：runtime | workflow
  event: agent.tool.before # 必填
  action:                  # 必填，二选一
    scriptRef: my-script   # 引用一个 kind: Script
    # 或
    builtin: audit         # audit | policy
  timeoutSeconds: 10       # 必填
  failurePolicy: deny      # 必填：deny | ask | stop | spool | warn
  matcher: "*"
```

### 6.2 事件全集（v1alpha2）

**runtime 平面**（由 Adapter 桥接平台事件）

```text
agent.session.start   agent.session.end     agent.prompt.submit
agent.tool.before     agent.tool.after
agent.permission.request   agent.permission.result
agent.subagent.start  agent.subagent.stop   agent.turn.stop
```

**workflow 平面**（由 CLI 直接调用）

```text
change.created
stage.entering   stage.entered   stage.rework
gate.before      gate.after
approval.requested   approval.decided
archive.before   archive.after
```

### 6.3 Script

```yaml
apiVersion: xforge.dev/v1alpha1
kind: Script
metadata: { name: my-script, version: 1 }
spec:
  runtime: node          # node | python
  entry: main.ts
  arguments: []
  workingDirectory: .
  timeoutSeconds: 30
  input: 事件 payload from stdin
  output: allow/ask/deny 意见 JSON on stdout
  sideEffects: none
```

八个字段全是必填。Script 登记在 manifest 顶层的 `scripts:` 而不是 `scaffold.*` 下。

### 6.4 陷阱

- **Hook 不能创造 Gate 成功、Approval 或 Stage transition。**
- **四个状态不能互相推断**：manifest 是否选中、资源自身 `enabled`、
  平台是否已 trust、运行时是否 active。
- **随包 `runtime-audit` 有意不选中**：审计记录在 CLI 内部是无条件的，
  而它的 `builtin: audit` 目前没有 dispatcher 分支，选中它不改变任何事。
- **PermissionPolicy 不依赖 Hook 选择**：CLI 仍会生成最小 pre-tool 桥接。

---

## 7. Approval

### 7.1 在 Flow 里定义策略

```yaml
governance:
  approvalPolicies:
    - id: my-gate-approval
      minApprovers: 1          # 1–10
      roles: [owner, maintainer, security]
      separationOfDuties: true
      providers: [local, enterprise-approvals]
```

五个字段全是必填。

### 7.2 挂到某个门上

```yaml
- id: check
  exit:
    approvals: [my-gate-approval]      # 解锁 check → 下一 Stage
# 或
terminal:
  archive:
    approvals: [my-gate-approval]      # 解锁归档
```

### 7.3 语义要点

| | |
| --- | --- |
| `roles` | **资格过滤器**——谁有资格审批 |
| `separationOfDuties` | **审批人 ≠ implementer**（Change 目录与各 delivery 区间的 Git author）。**它不比较角色。** |
| `minApprovers` | 数**不同的 `approver.id`**（trim + 小写），**不含 provider**——同一个人走两条路径仍是一个人 |
| `providers` | `local` 或 manifest 里登记的 provider id |

**`minApprovers: 1` + `separationOfDuties: true` 是自洽且推荐的组合**：
一个人，且这个人不能是写这段代码的人。

### 7.4 `--for` 填什么

`--for` 填的是该审批**所解锁的那次 transition**——Flow 里的目标 Stage id，
或字面量 `archive`。**永远从 `state.nextActions[].command` 里原样取**，不要照 usage 自己拼。

`XFORGE_APPROVAL_TRANSITION_UNKNOWN` / `_UNAPPROVABLE` 表示参数错了**且什么都没写入**
——改参数，不要重跑，更不要再请人签一次。`xforge approve --dry-run` 不需要终端、
也不惊动审批人，就能先校验一遍。

### 7.5 接企业审批系统（MCP provider）

**第一步：定义 McpServer 资源**

```yaml
apiVersion: xforge.dev/v1alpha2
kind: McpServer
metadata: { name: my-approvals, version: 1 }
spec:
  transport: stdio                       # stdio | http
  command: ["my-approval-mcp-server"]    # transport: stdio 时必填
  # url: https://approvals.internal/mcp  # transport: http 时必填
  authTokenEnv: MY_APPROVALS_TOKEN       # 必填
  timeoutSeconds: 30                     # 必填
```

**第二步：登记为 provider**

```yaml
# xforge/manifest.yaml
approvals:
  providers:
    - id: my-approvals
      type: mcp
      mcpServer: my-approvals
      roles: [owner, maintainer, security]
```

**第三步：在 Flow 的策略里引用**

```yaml
providers: [local, my-approvals]
```

**第四步**：把 token 放进环境变量，`xforge sync`，再验证。

随包的 `enterprise-approvals` 是**故意跑不通**的占位（`command` 指向一个不存在的程序）。
未替换前 `xforge approve --provider enterprise-approvals` 会以
`XFORGE_APPROVAL_MCP_TOKEN_MISSING` 大声失败，而不是静默假装工作。

**遇到 provider 配置类错误要停止，不要对同一个 provider 反复重试：**
`XFORGE_APPROVAL_PROVIDER_FORBIDDEN`、`XFORGE_APPROVAL_MCP_SERVER_MISSING`、
`XFORGE_APPROVAL_MCP_TOKEN_MISSING`、`XFORGE_APPROVAL_MCP_CONNECTION_FAILED`
——**provider 未配置，不是决定仍在等待。**

### 7.6 建议：把 `local` 留在 providers 里

除非你确定外部系统已经就绪，否则把 `local` 与外部 provider 并列。
否则新项目在接入外部审批系统之前会被完全锁死——`local` 并不放松标准，
它只改变决定被捕获的地方。

---

## 8. Agent

### 8.1 schema

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Agent
metadata: { name: worker, version: 2 }
spec:
  role: Isolated work-package implementation worker   # 必填
  instructions: worker.md                             # 必填，同目录的 md 文件
  skills: [xforge-apply]                              # 必填
  tools:                                              # 必填
    allow: [read, search, write, test]
  delegation:                                         # 必填
    callableBy: [main]
    maxConcurrency: 3
  model:                                              # 必填
    class: default        # default | reasoning
    fallback: default
```

`instructions` 指向的 md 文件同样成对本地化（`worker.md` / `worker_cn.md`）。

### 8.2 随包三个

| Agent | tools.allow | maxConcurrency | model.class | skills |
| --- | --- | --- | --- | --- |
| `worker` | read, search, **write**, test | 3 | default | `xforge-apply` |
| `integrator` | read, search, **write**, test | 1 | reasoning | `xforge-apply`, `xforge-verify` |
| `reviewer` | read, search, test（**无 write**） | 1 | reasoning | `xforge-verify` |

**Reviewer 没有 `write` 授权是刻意的，不是疏漏。** 见 [子 Agent 设计](sub-agent-design.md)。

### 8.3 陷阱

- **`tools.allow` 是能力级的，不是按路径限定的。** 没有办法说「可以写，但只能写
  `evidence/agents/<package>/` 下面」。需要按路径限定时，要配一条 PermissionPolicy。
- **`agents: native` 不等于 runtime 会列出你的 Agent。** Adapter 报告 `native` 只说明
  「XForge 已把 Agent 定义写出去」和「该目标存在子 Agent 机制」——
  要查 runtime 自己的可选类型列表；没有就把投影出来的契约逐字带进 prompt，
  并在报告中写明**边界是由 prompt 传递的**。

---

## 9. 一页速查：想做 X，改哪里

| 你想…… | 改这里 | 需要写代码吗 |
| --- | --- | --- |
| 新增一种 Agent 能力 | `scaffold/skills/<id>/SKILL.md` + manifest | 否 |
| 换一套交付流程 | `xforge/flows/<name>.yaml` | 否 |
| 让某类 Change 必须走某 Flow | `policy.requiredWhen` | 否 |
| 禁止某类 Change 走某 Flow | `policy.eligibleWhen` | 否 |
| 加一道客观检查 | `scaffold/gates/<id>.yaml` + stage 的 `gates` | 否 |
| 让项目自己声明验证命令 | `xforge verification declare` | 否 |
| **加一道「必须有人拍板」的门** | `exit.conditions.<key>` + `evidence/conditions/<key>.yaml` | **否** |
| 加一道审批 | `governance.approvalPolicies` + `exit.approvals` | 否 |
| 接企业审批系统 | `scaffold/mcp-servers/<id>.yaml` + `manifest.approvals.providers` | 否 |
| 实时拦截危险动作 | `scaffold/policies/<id>.yaml` | 否 |
| 在工具事件上插逻辑 | `scaffold/hooks/<id>.yaml` + `kind: Script` | 是（脚本） |
| 把标准写下来并让它诚实 | `scaffold/rules/<id>.yaml` | 否 |
| 定制子 Agent 行为 | `scaffold/agents/<id>.yaml` + `<id>.md` | 否 |
| 记住跨 Change 的架构决策 | `xforge/architecture.md`（唯一写者 `xforge-architect`） | 否 |
| 支持一个新编程工具 | Adapter | **是**（改 CLI） |
| 第四档保证级别 | `flow.schema.json` | **是** |

**贯穿所有行：放进 `scaffold/` 不等于启用，必须登记进 `manifest.yaml`。**
