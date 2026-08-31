# XForge 仓库与文件布局（File Protocol 2）

> 一个受治理的 Change 在推进过程中会产出十几种中间文件。这份文档回答的是：
> **每一个落在哪、归谁写、被谁读、被谁校验、以及它算不算证据。**
>
> 对应实现：`@xforge/cli 0.7.21`、`protocolVersion: "2"`、`xforge.dev/v1alpha2`。
>
> Protocol 2 的核心区分是：**Markdown 是人 / Agent 的规划表面，
> YAML / JSON 资源与 CLI receipt 才是机器权威。**

---

## 1. 项目根

`xforge/` 下住着三种生命周期完全不同的东西，平铺成一棵树是看不出来的。
所以按**归属域（ownership zone）**分组——这就是 `xforge/src/core/ownership-zones.ts` 里那张表，
`upgrade-scaffold` 的事务范围、PermissionPolicy 的 deny / ask 列表、
以及合并提示里那份「## Never」全部由它派生，不再是四份各自手工维护、彼此看不见的清单。

```text
xforge/
│
│  ── managed-source ──  CLI 发布的规范源。升级事务对整树快照、逐文件分类、可整树恢复
├── scaffold/                   ← 规范源，投影的输入
│   ├── skills/<id>/SKILL.md (+ SKILL_cn.md)
│   ├── agents/<id>.yaml + <id>.md (+ <id>_cn.md)
│   ├── rules/<id>.yaml
│   ├── policies/<id>.yaml
│   ├── hooks/<id>.yaml
│   ├── gates/<id>.yaml
│   └── mcp-servers/<id>.yaml
├── flows/*.yaml                ← Flow 定义（Agent 写入被 deny）
├── scripts/<id>/               ← Script 也是一等资源源，与上面两棵同进事务
│   └── script.yaml + entry
│
│  ── project-owned ──  项目自己写的。升级只推进 Manifest 里的版本锚点，别的一个字不动
├── manifest.yaml               ← 唯一的启用清单（Agent 写入要人确认）
├── constitution.md             ← 长期工程原则（Agent 写入被 deny）
├── architecture.md             ← 可选，跨 Change 的架构决策（≤50 行 / 6 条）
├── XFORGE.md                   ← 给 Agent 的项目引导
│
│  ── derived ──  输出而不是输入。不进事务，靠重新投影再生
├── lock.yaml                   ← CLI/Scaffold 身份与完整性（Agent 写入被 deny）
├── .state.json                 ← 运行期缓存，无权威，gitignored
│
│  ── record ──  发生过什么。升级既不读也不写它，任何方向都不
├── changes/<change-id>/        ← 见 §2
├── changes/archive/            ← 已归档的 Change
├── specs/                      ← 主 Specs（Agent 写入被 deny）
├── .audit/events.jsonl         ← 本地哈希链，gitignored
│
│  ── transient ──  升级自己的工作状态。它不在事务里，它就是事务
├── .upgrade/                   ← 整个目录 gitignored（CLI 往里写一份 .gitignore）
│   ├── incoming/               ← 新版 scaffold/ flows/ scripts/，原样待合并
│   ├── snapshot/               ← 暂存前的受管树整树，回滚点（Agent 写入被 deny）
│   ├── state.json              ← from/toVersion、时间戳、提交 id、前后摘要
│   ├── plan.json               ← 分类结果，机器读
│   ├── plan.md                 ← 同一份，人读
│   └── MERGE.md                ← 交给 Agent 的合并提示
├── UPGRADING.md                ← 在途哨兵，刻意可见（Agent 写入被 deny）
│
│  ── 不属任何 zone
└── upgrade-log.md              ← 追加式历史，必须活过每一次完成与回滚
```

### 1.1 五个域的性质

| zone | 进升级事务 | 可再生 | 升级永不碰 | Agent 直接写 |
| --- | --- | --- | --- | --- |
| `managed-source` | **整树快照** | 否 | 否 | `scaffold/` `scripts/` 开放；`flows/` deny |
| `project-owned` | 仅版本锚点 | 否 | 否 | `manifest.yaml` 要确认；`constitution.md` deny；其余开放 |
| `derived` | 不进 | **是**（重新投影） | 否 | `lock.yaml` deny；`.state.json` 开放 |
| `record` | 不进 | 否 | **是** | `changes/` 开放；`specs/` `.audit/` deny |
| `transient` | 不进（它就是事务） | 否 | 否 | `snapshot/` `UPGRADING.md` deny；`incoming/` 与计划文档开放（合并 Agent 要读） |

> **「升级碰不碰它」和「Agent 能不能写它」是两个问题，压成一个布尔值必然有一条路径答错。**
> `changes/` 在 `record` 域里——一次升级永远不读也不写它——而生命周期 Skills 整天经由
> 受治理的 Change 往里写；`scaffold/` 是最受管的一棵树，`xforge-scaffold` Skill 却正当地在里面创作。
> 前一列说的是升级事务，后一列说的是一次 Agent 的工具调用。

`flows/` 与 `scripts/` 和 `scaffold/` 同域，不是排版上的顺手：
Flow 与 Script 都是一等资源源，只是不住在 `scaffold/` 里面。
它们各自都曾因为「受管树」是一份手写清单而长期落在事务之外——
项目一辈子跑着 `init` 那天的那一份，而升级日志还在报告「计划点到的每个文件都已一致」，
说的是一份根本点不到它们的计划。

**`manifest.yaml` 显式选择每一个 Skill、Agent、Rule、PermissionPolicy、Hook、Gate、
McpServer 与投影目标。存在于 `scaffold/` 之下并不启用一个资源。**

生成的投影目录（`.claude/`、`.codex/`、`.cursor/`、`.opencode/`、`.agents/`、`.github/`）
和 `lock.yaml` 同属 `derived`：它们是**输出**，不是源。手改会被拒绝而不是合并。

---

## 2. 一个 Change 的目录

```text
xforge/changes/<change-id>/
├── change.yaml                          ← Flow + classification + scope
│
├── proposal.md                          ← Artifact（Propose）
├── specs/**/*.md                        ← Artifact，delta Specs（Propose）
├── clarifications.md                    ← Artifact（Clarify，仅 major）
├── design.md                            ← Artifact（Design）
├── check-report.md                      ← Artifact（Check）
├── assurance.md                         ← Artifact（Verify）
│
├── work-packages.yaml                   ← 可选，Apply 的即时执行资产
│
├── evidence/
│   ├── structure.json                   ← ⚙️ Gate Evidence
│   ├── check-findings.json              ← ⚙️ Gate Evidence
│   ├── constitution-check.json          ← ⚙️ Gate Evidence
│   ├── tests.json                       ← ⚙️ Gate Evidence（unit-tests）
│   ├── security.json                    ← ⚙️ Gate Evidence（security-scan）
│   │
│   ├── check-findings.yaml              ← 📒 台账（Artifact，Check 写）
│   ├── constitution-check.yaml          ← 📒 台账（Artifact，Check 写）
│   ├── conditions/<key>.yaml            ← 📒 台账（通用出口条件）
│   │   └── materialQuestions.yaml       ←    major Clarify 的那一份
│   ├── verification-receipt.yaml        ← 📒 出口条件（Verify 写，非 Artifact）
│   │
│   ├── agents/<package>/
│   │   ├── dispatch/*.json              ← 🧾 派工 receipt（CLI 写）
│   │   ├── <execution>.yaml             ← 📦 delivery 记录
│   │   └── review-<execution>.yaml      ← 📝 Reviewer 结论转录（按包形态）
│   ├── review/<name>.md                 ← 📝 Reviewer 结论转录（Change 级形态）
│   │
│   ├── audit/index.json                 ← 可提交的审计事件索引
│   └── receipts/transitions/*.json      ← 🧾 转换 receipt（CLI 写）
│
└── approvals/<policy>/*.json            ← 🧾 审批 receipt（CLI 写）
```

### 2.1 图例：五类东西，性质完全不同

| 记号 | 类别 | 唯一写者 | 能不能手写 |
| --- | --- | --- | --- |
| ⚙️ | **Gate Evidence**（`evidence/*.json`） | `xforge check` 的 Gate runner | **绝对不行** |
| 📒 | **台账**（Artifact 或出口条件，`.yaml`） | **Agent** | 必须由 Agent 写，没有 CLI 命令生成 |
| 🧾 | **Receipt** | 对应的 CLI 命令 | **绝对不行** |
| 📦 | **Delivery 记录** | Agent，机器已知的一半由 `work-package draft` 生成 | 半自动 |
| 📝 | **转录** | Main Agent 逐字转录 Reviewer 的返回 | 必须逐字，不得概括 |
| （无） | **散文 Artifact**（`.md`） | 对应 Stage 的 Skill | 是，那就是它的用途 |

> ⚠️ **`evidence/` 目录下同时住着 ⚙️ 和 📒，两者性质完全相反。**
> 「Gate Evidence」专指只能由 `xforge check` 生成的 `evidence/*.json`；
> `evidence/` 下的那些 `.yaml` 台账是 **Gate 读取的 Artifact**，必须由 Agent 撰写，
> 而且 Stage 缺了它们就出不去。

### 2.2 `change.yaml`

无包装对象，字段名与层级必须一致：

```yaml
flow: solid
classification:
  risk: medium          # low | medium | high
  security: false
  privacy: false
  publicApi: false
  dataMigration: false
scope:
  modules: [root]
  paths: [src/**]
```

必填：`flow`、`classification`（五个字段全要）、`scope`（`modules` + `paths`）。

### 2.3 `generates` 与 `writePath`

Flow 里 `artifacts[].generates` 是**相对 Change 目录**的；
`state` 返回的 `ArtifactState.writePath` 才是**从项目根算起**的路径。

> 之所以要有 `writePath`，是因为曾经有 Agent 在项目根跑 CLI，
> 把 `assurance.md` 当成项目根文件写在了根目录。
> 现在 `nextAction.writes` 由它构建，**目的地是被陈述的，不是被推断的**。

---

## 3. 台账：谁写、写什么、怎么判

三份 Stage 台账加一份出口条件，全部由 Agent 撰写，全部被机器判定。

### 3.1 `evidence/conditions/<key>.yaml`——通用出口条件

```yaml
condition: materialQuestions     # 若存在，必须等于 key
entries:                         # 必须存在
  - id: q-auth-scope
    question: <非空>
    impact:   <scope|risk|compatibility|acceptance>
    decision: <非空>
    decidedBy: <非空，命中 KnownIdentities>
    decidedAt: <非空，Date.parse 可解析>
status: resolved                 # 省略时默认 resolved，必须等于 expected
```

**三种「空」被严格区分：**

| 磁盘状态 | reason |
| --- | --- |
| 文件不存在 | `ledger-missing-expected-<expected>` |
| 存在但解析不了 | `ledger-unreadable` |
| 有文件但没有 `entries` 键 | `entries-missing` |
| **`entries: []`** | ✅ **通过——这是一条断言** |

最后一行是刻意的：以前拒绝空列表，结果每个「真的没什么要澄清」的 Major Change
只能靠**编一个问题、并把决定归到一个具名人头上**才能通过——正是台账要防的伪造。

**散文不参与判定。** `clarifications.md` 写得再完整，台账缺一个字段就是未解决。

### 3.2 `evidence/check-findings.yaml`

```yaml
findings:
  - id: CHK-001
    severity: blocker | warning | suggestion
    summary: <什么地方不对>
    refs: [<artifact 或 spec 路径>]
    status: open | resolved
    reworkTo: <stage id，blocker 处于 open 时必填>
    resolvedBy: <blocker 转 resolved 时必填，须命中 KnownIdentities>
```

**审查没有发现问题时写显式的空列表。** Stage 在有未解决 blocker 时出不去。

### 3.3 `evidence/constitution-check.yaml`

```yaml
principles:
  - principle: <constitution.md 里逐字的 `## ` 标题>
    status: compliant | violation | not-applicable
    references: [<Requirement id | 真实存在的路径 | gate:<name>>]   # 至少一条
    justification: >-      # violation 与 not-applicable 必填，用块标量
      ...
    approvedBy: <具名人，violation 必填>
```

按文档顺序为每个 `## ` 标题写一条。**至少一条机器可定位的 `references`：**
本 Change delta Specs 中的 Requirement id、**仓库里任意真实存在的路径**
（先按 Change 相对解析，再按项目相对解析——`xforge/constitution.md` 和
`xforge/architecture.md` 都是合法引用，对架构类与治理类原则往往正是最恰当的），
或 `gate:<name>`（该 Change 已有通过的 Gate Evidence）。

> **只写 `compliant` 而不引用任何东西，正是这个 Gate 要拒绝的笼统声明。**
> **approval receipt 也不能顶替**：receipt 记录的是有人批准了某次 transition，
> 而不是本 Change 为何满足该原则。这一点在治理原则上最容易踩到——
> 那里 receipt 是最顺手的证据——应当引用本 Change 实际做过的事。

每条 `justification` 都用块标量书写（`justification: >-`，正文缩进另起一行）：
普通标量遇到「冒号加空格」或以 `[`、`{` 开头即失效。

### 3.4 `evidence/verification-receipt.yaml`

**它不是 Artifact，是 Verify 的 `verificationReceipt` 出口条件。**

为什么刻意不是 Artifact：`contentRevision` 会摘要每个 Artifact 的输出路径，
而 Gate Evidence 绑定的是 Gate 运行时的 `contentRevision`。
如果 receipt 是 Artifact，**写它就会让被它引用的 Gate 失效**——这里不存在不动点。

生成方式：

```bash
xforge verification draft-receipt --change <id>
```

把结果里的 `receipt` 写到上述路径，**只补一个字段**：

```yaml
status: passed   # 唯一由你填写的字段：你对「本 Stage 已验证这项工作」的断言
```

> 该命令刻意不产出 `status`——由 XForge 计算这个字段，
> 就等于让它替你决定这份 receipt 本身要记录的那件事。

**两条硬规则：**

- **引用只写 Gate 名，绝不写 digest。** 每个 per-run digest 都会随正常推进而变化，
  抄下来的那一刻起就在失效。
- **work-package 交付写在 `workPackageDeliveries`**（`package`、`delivery`、`dispatch`、
  `status`、`verifyCommand`、`exitCode`），写成 `gates` 的一行会被
  `gate-unverifiable-<name>` 拒绝。

本 Stage 每个通过的 Gate 都要引用一次——不得遗漏、不得引用其它 Stage 的 Gate。
之后若再改动任何 Artifact，必须重跑 Gate 并重新 draft。
不要加 `evidence:` 这一行，没有任何代码会读它。

### 3.5 身份校验：`decidedBy` / `resolvedBy` / `approvedBy`

三个字段名做同一件事——把一个决定归属到一个人。它们对照同一个集合：

```text
KnownIdentities = { 本 Change 全部 receipt 上的 approver.id }
                ∪ { Change 目录的 Git author email }
                ∪ { Change 目录的 Git author 显示名 }
```

刻意的两处宽松：接受显示名也接受 email；接受本 Change 任意 receipt 上的任意审批人，
不限于当前策略的（决定澄清问题的人，常常不是签收尾审批的人）。

**集合为空时（全新 Change、无提交、无 receipt），任何非空名字都通过**——
否则新仓库的第一个 Change 会被自己的空历史卡死。

> 但这个通过是**暂时的**。一次实测里，两个强制 Gate 报 `passed`，据此写完了 Check report，
> 然后提交——**同样的内容立刻被拒绝**，因为提交本身建立了那个比对集合。
> 「绿」在那里不代表名字是好的，只代表当时还不存在能说它不好的东西。
> Gate 现在会附一条 warning 明说这一点。**一开始就写真实身份。**

---

## 4. Receipt 家族

四种 receipt，全部由 CLI 写，构成可校验的链。

### 4.1 Transition receipt —— 状态机的真身

`<change>/evidence/receipts/transitions/*.json`

```text
receiptId / sequence / change / flow / from / to
contentRevision / stateRevisionBefore / policySnapshotDigest / gitHead
previousReceiptDigest              ← 链
transitionedAt / actor
approvals[] / gates[]              ← 这次转换消费了哪些
auditHead / digest
```

**当前 Stage 是从这条链重建的，不是从 artifact 存在与否推断的。**

### 4.2 Approval receipt

`<change>/approvals/<policy>/*.json`

绑定 `governingRevision`（老 receipt 退回 `stateRevision`）、`policyId`、`transition`、
`approver`、`decision`、`reason`。

**不带签名。** 信任来自审计链里有一条匹配的 `approval.decided` 事件，且每次 state 加载都复验。

`attestation: { method: 'cli-terminal', respondedAt }` 只有 CLI 自己的终端对话能设置，
永远不能从命令行提供。

### 4.3 Work-package dispatch receipt

`<change>/evidence/agents/<package>/dispatch/*.json`

```text
change / packageId / executionId
stateRevision / policySnapshotDigest
gitBase / gitHead / auditCorrelationId
issuedAt / digest
```

只允许 Apply Stage 的 ready 节点，且**整份计划校验无 error 后**才原子写入。

### 4.4 Ack receipt（integrator / reviewer）

绑定 `deliveryDigest`——**无法被重放到另一份 delivery 上**。

---

## 5. Work package

### 5.1 静态计划

`<change>/work-packages.yaml`

```yaml
apiVersion: xforge.dev/v1alpha1
kind: WorkPackagePlan
integrator_paths:                  # 可选：装配面
  - src/contracts/**
packages:
  - id: store-layer
    role: worker                   # worker（默认）| integrator，每个计划至多一个 integrator
    goal: <目标>
    depends_on: []
    inputs: [...]                  # 具体路径，不能带通配符
    write_paths: [src/store/**]
    skills: [...]
    verify: [["cargo","test","-p","store"]]
    done_when: ["...", "..."]
```

八个静态字段加 `role`；`integrator_paths` 在计划顶层。

**`verify` 必须是 argv 数组。** XForge 直接以 `argv[0]` 启动进程、其余项作为字面参数，
**从不经过 shell**：没有管道、重定向、串联、替换。
单字符串是废弃形态，含 shell 元字符时**直接拒绝**——理由是一个能到达 `sh -c` 的字符串，
等于让 work-package plan（一个 Change 自己拥有、而 lockfile 覆盖不到的文件）组装任意命令。

### 5.2 Delivery 记录

`<change>/evidence/agents/<package>/<execution>.yaml`

```yaml
execution_id, recorded_at
status: succeeded | blocked | failed
package_id, base_commit, head_commit
changed_paths: [...]
validation: [{ command, exit_code }]
issues: [...]
done_when_evidence: [{ criterion, evidence: [...] }]
state_revision, policy_snapshot_digest, audit_correlation_id
```

先跑 `xforge work-package draft` 取回机器已知的那一半——execution id、两个 commit、
`changed_paths`、每条声明的 `verify` 命令与 CLI 实际跑出来的退出码。
**这些不要手抄。** 你只补 `status`、`issues` 与每条 `done_when_evidence` 下的 `evidence` 列表。

**`done_when_evidence` 的前缀匹配规则**（最容易写错的一处）：
每条证据必须**以**该 delivery 的某个 `changed_paths` 路径原文、
或它真实跑过的某条 `verify` 命令原文**开头**。只有这段前缀参与匹配。

```text
✅ src/store/mod.rs — 定义 CredentialRepo
✅ path: src/store/mod.rs -- 定义 CredentialRepo
✅ cargo test -p store — 覆盖 REQ-014 的三个场景
❌ src/store/mod.rs:166 — …          （带行号，不是路径原文）
❌ test_credential_roundtrip 通过     （以测试函数名开头）
❌ 已实现凭据仓储                       （散文）
```

解释写在 ` — ` 或 ` -- ` 之后，也接受 `path:` / `command:` 前缀。

> **不同判据要引不同证据。** 一条命令支撑一份 delivery 里的每一条判据，
> 就说明它没有在区分它们，CLI 会指出这一点。

CLI 的复核项：dispatch binding、commit ancestry、`base...head` 的**实际 diff**、
`write_paths` 边界、verify 命令**逐条按序完全一致**、退出码、
每条原始 `done_when` 被 `done_when_evidence` **精确一次**映射到非空证据。

---

## 6. 审计

三层，各自的定位不同：

| 层 | 路径 | 进 Git | 作用 |
| --- | --- | --- | --- |
| ① 本地链 | `xforge/.audit/events.jsonl` | ❌ gitignored | `previousHash` / `hash` 哈希链，篡改破坏整条链 |
| ② 可提交索引 | `<change>/evidence/audit/index.json` | ✅ | 事件索引与 digest，随 Change 归档 |
| ③ 远端 sink | HTTP append-only | — | Bearer / HMAC，凭据只从环境变量取 |

默认 `redaction: strict`——只保存身份 / 关联元数据、revision、`refs`、`decision`、
`outcome`、`inputDigest` / `outputDigest`、`redaction`、`coverage`、`previousHash`、
`deliveryState`。**不保存完整 prompt、隐藏推理、secret、环境或无上限输出。**

投递失败写 spool receipt，重试是显式的。投递事件的 `inputDigest` 指向原始事件 hash。
**欠账按 Change 计算**，避免一个 Change 阻塞另一个。

保留期在本地**报告**；破坏性过期与不可变性由远端 sink 实施——刻意如此，避免静默重写本地链。

---

## 7. 归档之后

```text
xforge/changes/<change-id>/     →    xforge/changes/archive/<change-id>/
```

`syncSpecs: true` 时，delta Specs 在同一次原子事务里合并进 `xforge/specs/`。

**归档后的 Change 不再被控制面评估。** 这意味着后续对 Flow / Rule / Policy / Gate /
Constitution 的修改（它们会改变 `policySnapshotDigest`）**不影响已归档的 Change**——
它们的 transition receipt 仍然是「当时确实发生了什么」的真实记录。

未归档的 Change 则会全部受影响：Gate Evidence 变 stale、Approval 不再计入有效集合。
这是 `xforge upgrade-scaffold` 在有未归档 Change 时直接拒绝的原因。

---

## 8. Git 提交边界：哪些必须提交、哪些应该 ignore

这套设计对「什么进 Git」是有明确意图的，而且**依据写在源码注释里**：

> `/* Fresh clone / CI: the chain file is gitignored, the committed index is not. */`
> —— `core/audit.ts::approvalVerifiedInChain`

一条判定原则：**凡是「在一台从没跑过这个流程的机器上、必须还能回答同一个问题」的东西，
都必须提交。** 本地链是可再生的缓存，committed index 是它的持久投影。

### 8.1 必须提交

| 路径 | 为什么 |
| --- | --- |
| `change.yaml` | Flow / classification / scope，一切的起点 |
| `proposal.md` · `design.md` · `check-report.md` · `assurance.md` · `clarifications.md` | Artifact，进 `contentRevision` |
| `specs/**/*.md` | delta Specs，归档时合并进主 Specs |
| `evidence/check-findings.yaml` · `constitution-check.yaml` · `conditions/*.yaml` | 📒 台账**就是 Artifact**，进 `contentRevision` |
| `evidence/verification-receipt.yaml` | Verify 的出口条件 |
| **`evidence/receipts/transitions/*.json`** | **Stage 由这条链重建**。ignore 掉 = 新 clone 完全不知道这个 Change 走到哪了 |
| **`approvals/<policy>/*.json`** | 没有它就没有审批 |
| **`evidence/audit/index.json`** | **本地链是 gitignored 的，这份committed index 是新 clone / CI 上唯一能核验审批与 ack 的东西** |
| `work-packages.yaml` | 计划本身；`tree:unattributed-paths` 判定要用它 |
| `evidence/agents/**/dispatch/*.json` | 派工 receipt，delivery 校验要对照它 |
| `evidence/agents/**/<execution>.yaml` | delivery 记录 |
| `evidence/review/*.md` · `agents/**/review-*.yaml` | Reviewer 结论转录；**必须随 Change 一起归档** |

### 8.2 应该 ignore（随包已经这样做了）

```gitignore
xforge/.audit/               # 随包的 xforge/.audit/.gitignore 内容是 `*` + `!.gitignore`
xforge/.upgrade/             # 同法：CLI 暂存时往里写一份自己的 .gitignore
**/xforge/.state.json
**/.xforge-archive-*
```

`xforge/.upgrade/` 是一次升级的在途工作区——待合并的新版树、回滚快照、分类结果——
合并做完就整个消失，提交它等于把一个中间状态永久留在历史里。
**`xforge/UPGRADING.md` 刻意不在这份清单里**：它是那次升级唯一可见的痕迹，
一次没走完的升级应当在目录列表和 `git status` 里都扎眼，而不是藏在一个点开头的目录中。

`xforge/.audit/events.jsonl` 是**本地哈希链**——它是可再生的运行时缓存，
而它的持久投影是每个 Change 的 `evidence/audit/index.json`。

> 有一条刻意的「全无审计数据」逃生口：一个从未提交过 `evidence/audit/index.json` 的
> clone 完全没有审计数据，那里 committed receipt 就是唯一幸存的真相，拒绝它会重新造成
> 这份 receipt 当初被引入所要修复的损失。它**不能**被用来把一份伪造 receipt 混过一条真链：
> 它要求这个 Change 在本地链上**没有任何**事件、**且没有**committed index 文件。
> 一份存在但 digest 校验失败的 index 算作「有审计数据」——**篡改的 index 失败关闭，
> 而不是解锁这条逃生口。**

### 8.3 唯一真正的体积来源：Gate Evidence

`evidence/*.json` 里其它字段都很小，只有两项能撑大文件：

```ts
stdout: string    // 上限 MAX_GATE_OUTPUT_BYTES = 65_536
stderr: string    // 同上
```

**即每次 Gate 运行最多 128 KiB。** 但要分清哪些 Gate 真会撑到这个量级：

| Gate | 典型体积 |
| --- | --- |
| `structure` | 极小（stdout 就是一句 `Structural validation passed.`） |
| `check-findings` · `constitution-check` | 极小（进程内 builtin） |
| **`unit-tests` · `security-scan`（`builtin: declared`）** | **可以顶到上限**——一个话多的测试 runner 很容易吐满 64 KiB |

工作树里每个 Gate 只有**一个固定路径**的文件（`xforge check` 是覆盖写，不是追加），
所以工作树不会膨胀。**膨胀发生在 Git 历史里**：每提交一次重跑过的 Evidence，
就多一个 blob。一个反复 `check` 十几次的 Major Change，可能留下十几份 128 KiB 的快照。

### 8.4 建议：压体积，而不是 ignore

**不建议 ignore `evidence/*.json`。** 代价是三层的：

1. **在途**：另一台机器或 CI clone 之后所有 Gate 报 `gate:<id>:missing`，
   必须重跑 `xforge check`——对 declared Gate 意味着重跑整套测试；
2. **归档时**：archive 的 plan 阶段要校验「Transition 引用的 Gates 仍有效」，Evidence 不在就过不去；
3. **归档后**：这是最大的损失——归档记录里再也没有「当时到底跑了什么命令、退出码是多少、
   针对哪个 revision」的凭据。**那正是这套证据体系的全部意义。**

**推荐做法：调小输出上限。** Gate schema 有 `spec.maxOutputBytes`（范围 1024 – 1048576）：

```yaml
# xforge/scaffold/gates/unit-tests.yaml
spec:
  builtin: declared
  timeoutSeconds: 900
  evidence: tests.json
  maxOutputBytes: 8192        # 64 KiB → 8 KiB
```

理由：真正有审计价值的是 `command` / `argv` / `exitCode` / `contentRevision` /
`runner.integrity` / `digest`，**不是那 64 KiB 的测试输出**。
把两个 declared Gate 都压到 8 KiB，单次 Evidence 从 ~128 KiB 降到 ~16 KiB，
量级下降一个数量级，而 Gate 证明的东西一点没少。

> ⚠️ 改 Gate 定义会改变 `policySnapshotDigest`——按发布窗口处理（见[扩展指南 §0.3](extension-guide.md)）。

如果确实要更激进，还有一个折中：**只对 `security-scan` 这类输出最大、
但结论只看退出码的 Gate 把 `maxOutputBytes` 压到最小值 1024**，
`unit-tests` 保留较大的输出以便事后定位失败。

---

## 9. 版本与兼容

- CLI 信封：`protocolVersion: "2"`
- 当前资源：`apiVersion: xforge.dev/v1alpha2`（Gate、Script、WorkPackagePlan 仍是 `v1alpha1`）
- **CLI 与 Scaffold source 都固定为 `@xforge/cli` 的 npm 精确版本。**
  Protocol 2 不接受 Git checkout、HTTP Scaffold 或 source-built 安装身份。
- Protocol 1 的 Flow / Rule / Agent 资源可在迁移期读取。
  声明的 CLI 身份不匹配的 Protocol 1 项目运行在 Portable 模式，
  受管的 install / check / transition / approval / archive 写入被拒绝。
- **Protocol 1 的 Gate Evidence 不会被提升为当前证据。** 重跑该 Gate 会产生
  Protocol 2 的、绑定 revision 的证据。
- Protocol 2 的输出不会静默降级为 Protocol 1。

---

## 10. 失败模式速查

| 情况 | 行为 |
| --- | --- |
| Manifest / Lock / CLI 不匹配 | Portable 读取，受管写入失败关闭 |
| Artifact / Flow / Policy / Gate / Git 陈旧 | Transition / Archive 拒绝 |
| receipt 在审计链里找不到匹配事件 | Approval 无效，**不降级到 local** |
| runtime Hook dispatcher 在 before / permission 崩溃 | deny |
| audit-only 的 after 事件失败 | spool / warn |
| 远端审计投递失败 | 本地 spool；`remoteDelivery: required` 时 archive 与 CI verify 失败直到重试成功 |
| 生成文件被用户修改 | sync / update / uninstall 报冲突，**不覆盖** |
| 未声明验证命令 | Gate **拒绝**（不是失败），去问人 |
| 有未归档 Change 时 upgrade-scaffold | **拒绝**，除非 `--with-active-changes` |
| 受管路径有未提交改动时 upgrade-scaffold | **拒绝**，要求先提交；`--allow-dirty` 放行并记下「这次没有提交兜底」 |
