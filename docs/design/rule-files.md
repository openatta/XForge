# 规则文件设计

> 依据：主文档《谁能写什么》《两条基线》《台账》《上下文成本》，脚手架文档全篇。
> 这份定**每一种文件的形状**：住在哪、字段是什么、谁写、控制面读什么、怎么校验。
> 命令怎么读写它们在 [命令行设计](cli.md)；Skill 正文在 [Skill 设计](skills.md)。
>
> 标着 **决定** 的可以推翻；`RF-nn` 是可验收的断言，迁移方案 S3 要求每条各有一个单元测试。
> 文件里的键一律英文，文档里用概念文档的中文名对照。

---

## 0. 决定清单

| # | 决定 | 理由 |
| --- | --- | --- |
| **D1** | 治理根目录固定为项目根下的 `xforge/`；机制级文件复制进项目（`xforge/scaffold/`），不从包里引用 | 升级事务要快照、分类、合并、回滚，对象必须在项目里 |
| **D2** | 审计链 `xforge/.audit/chain.jsonl` **提交进 git** | 不提交，新克隆与 CI 上审计链为空，署名核对退化；概念文档要求审计链是署名的权威 |
| **D3** | 阶段位置与工作包状态**不落盘**，每次从 receipt 链推导 | `重算的不能作判据` 的反向：位置本来就是链的函数，写一份 `state.yaml` 就是一份会漂的缓存 |
| **D4** | 内容修订 = 对一组文件按路径排序后逐个 `sha256(path + "\0" + bytes)` 再整体 sha256；证据绑定它，不绑提交 | 一次记账提交不该让门失效；绑内容才能判「过期」 |
| **D5** | 身份 = git 的 `user.name <user.email>`；`署名可引用不可编造` 的校验是：台账里的署名必须与审计事件里控制面从 git 读到的身份逐字相等 | 仓库真实记录的身份只有这一种来源；不发明账号体系 |
| **D6** | Requirement id 形如 `REQ-<domain>-<capability>-<nnn>`；接口元素 id 形如 `<kind>:<selector>`，`kind ∈ fn · type · endpoint · event · cli · schema` | 主文档《两条基线》定了形状，这里只定字面 |
| **D7** | 流程文件带 `eligibility`（这条流程接受的风险等级集合） | 三条流程是同一序列的三种长度，总要有东西说「哪种 Change 走哪条」；放在流程里而不是清单里，因为它是流程的性质 |
| **D8** | 投影策略只管 `xforge/` **之外**的路径；`xforge/` 之内由分发策略管 | 两套规则不重叠，执法不需要合并语义 |
| **D9** | 章程条目 = `## ` 标题；混装文档的条目区用 `<!-- xforge:entries:begin kind=… -->` / `<!-- xforge:entries:end -->` 划出；本地化区用 `<!-- xforge:local:begin -->` / `<!-- xforge:local:end -->` | 三种标记一个前缀，解析器一份 |
| **D10** | Change id 形如 `C-<yyyymmdd>-<slug>`；执行 id 形如 `EX-<yyyymmdd>-<6位随机>`；receipt id 形如 `R-<4位序号>`；门运行号是该门下的递增整数 | 可读、可排序、不依赖时钟精度 |

---

## 1. 治理根目录布局

```text
xforge/
  manifest.yaml                        清单                      宪法级
  constitution.md                      章程                      宪法级
  scaffold/                            机制级（受管，升级事务的作用域）
    integrity.yaml                       完整性清单（派生物：受管文件的校验和）
    flows/<flow>.yaml                    流程
    gates/<gate>.yaml                    门
    policies/<policy>.yaml               权限策略
    hooks/enforce.yaml                   执法钩子声明
    agents/xforge-executor.yaml          执行者定义
    skills/<skill>/SKILL_cn.md · SKILL.md
  specs/                               规格基线                  事实级
    index.yaml                           域层索引
    <domain>/index.yaml                  条目层索引
    <domain>/<capability>.md
  interfaces/                          接口基线                  事实级
    index.yaml
    <module>/index.yaml
    <module>/<file>.md
  changes/<change-id>/                 记录级
    ── 规格侧 · 全 Change 一份 ──
    change.yaml                          流程与分类声明
    proposal.md
    specs/<domain>/<capability>.md       规格 delta
    interfaces/<module>/<file>.md        接口 delta
    ── 实现侧 · 默认方案 ──
    scope.yaml                           作用域
    design.md
    assurance.md                         保证说明
    work-packages.yaml                   工作包计划
    ledgers/                             断言层（Agent 或人写）
      review-findings.yaml
      constitution-reply.yaml
      exit/<condition-id>.yaml
      verification-receipt.yaml
      deliveries/<package-id>.yaml
    evidence/                            证据层（只有控制面写）
      gates/<gate>/<run>.yaml · <run>.log
      receipts/<seq>-<kind>.yaml
      projections/<execution-id>.yaml
      audit-index.yaml
    archived.yaml                        归档标记（Change 级；任一方案归档时写：scheme、receipt、at）
    <scheme-id>/                         具名方案：上面实现侧那一整套（scope.yaml … evidence/）在这里各一份
  .audit/
    chain.jsonl                          审计链                    派生物
    chain.lock
  .upgrade/                            升级事务工作目录（在途时存在，即哨兵）
```

`RF-01` 上表每个路径都能由 `src/model/paths.ts` 的一个函数生成，代码里不出现字面路径。
`RF-02` 断言层与证据层是两个目录；`ledgers/` 下任何文件都允许手写，`evidence/` 与 `.audit/` 下任何文件都不允许。

### 1.1 写权限矩阵

| 路径 | 人 | Agent | 控制面 | 备注 |
| --- | --- | --- | --- | --- |
| `manifest.yaml` | 写 | 拒 | 只动 `scaffold.version`、`verification`，留审计 | 宪法级 |
| `constitution.md` | 写 | 拒 | 不写 | 标题是 id |
| `scaffold/**` | 只写本地化区 | 拒 | 升级事务 | 受管 |
| `specs/**` `interfaces/**` | 拒 | 拒 | 只有归档合并 | `基线只由归档推进` |
| `changes/*/{change.yaml,proposal.md,specs,interfaces,scope.yaml,design.md,assurance.md,work-packages.yaml}` | 写 | 写 | 只起草（不落盘） | 声明层 |
| `changes/*/ledgers/**` | 写 | 写 | 只起草（不落盘） | 断言层 |
| `changes/*/evidence/**` `.audit/**` | 拒 | 拒 | 写 | 证据 |
| 归档后的 `changes/<id>/**` | 拒 | 拒 | 拒 | `归档后不再变` |

`RF-03` 这张矩阵与分发策略 `protected-governance`（§4.3）逐格一致：矩阵里「拒」的格子，策略里都有一条 deny。

---

## 2. 宪法级

### 2.1 清单 `manifest.yaml`

```yaml
version: 1                          # 清单格式版本
scaffold:
  version: 1.0.0-alpha.1            # 脚手架版本锚点；升级事务推进
governance:
  spec: true
  interface: false
flow:
  default: solid
modules:
  - id: core
    paths: ["src/core/**"]
platforms: [claude, codex]
language: zh-CN
verification:                       # 人声明；由「证」的 verification 子命令写入，留审计
  commands:
    unit-tests: "npm test"
selected:                           # 项目选用的机制级资源；未列出的文件在但不生效
  flows: [quick, solid, major]
  gates: [structure, ledgers, constitution, unit-tests]
  policies: [protected-governance]
```

- **谁读**：五个提问者都读；执法每次工具调用读它取 `selected.policies`。
- **读取契约**：条目级。
- **不进清单**：任何「只有某一站才需要」的东西。
- Skill 不需要 `selected`：入口 Skill 与选用流程各站的 Skill 隐含选中。

`RF-04` 清单 schema 拒绝未知顶层键；`selected` 引用的资源文件不存在时，`inspect` 报 `XF-MODEL-002`。
`RF-05` `verification.commands` 只能通过 `attest verification` 写入，且该次写入在审计链留 `verification.declared` 事件；手改能被 `inspect` 检出（清单摘要与最近一次事件不符）。

### 2.2 章程 `constitution.md`

```markdown
# 章程

<!-- xforge:constitution -->
> 每个二级标题是一条章程的 id。改标题是治理变更：此前所有引用该条的台账将对不上。改正文不是。

## 不做无测试的行为变更
正文……

## 接口变更先写 delta 再写实现
正文……
```

- **读取契约**：混装。标题是条目（章程门与章程答复台账按它匹配），正文是散文。
`RF-06` 章程解析器返回标题的有序列表；重复标题是 `XF-MODEL-003`。

---

## 3. 机制级

### 3.1 流程 `scaffold/flows/<flow>.yaml`

判定图字段给控制面，写作材料字段给 Agent；**同一个文件，两类字段用注释分列**。

```yaml
name: solid
title: 常规变更
eligibility:
  risk: [low, medium]               # D7：声明的 risk 必须落在这里
stages:
  - id: propose
    skill: xforge-propose
    human: body                     # body | tail | none；隔离与否由它推出：body → 不隔离，其余隔离
    produces:
      - id: change-declaration
        path: change.yaml
        side: spec
        needs: []
        read: entries
      - id: proposal
        path: proposal.md
        side: spec
        needs: []
        read: skeleton
        outline: ["背景", "目标", "非目标", "为什么选这条流程", "影响面"]
        # ── 写作材料 ──
        instructions: |
          写清为什么做、边界在哪……
      - id: spec-delta
        path: specs/
        side: spec
        needs: [spec]               # 治理依赖：governance.spec 关闭则「不欠」
        read: entries
    ledgers: []
    gates: [structure]
    exit:
      - {kind: gate, ref: structure}
    rework_to: []
  - id: design
    skill: xforge-design
    human: none
    produces:
      - {id: scope, path: scope.yaml, side: impl, needs: [], read: entries}
      - id: design
        path: design.md
        side: impl
        needs: []
        read: mixed
        outline: ["技术路径", "集成点", "失败模式", "迁移与回滚", "被否决的方案"]
        markers: [{kind: alternatives, min: 1}]
        instructions: |
          ……
      - {id: work-packages, path: work-packages.yaml, side: impl, needs: [], read: entries}
    gates: [structure, constitution]
    exit:
      - {kind: gate, ref: structure}
      - {kind: gate, ref: constitution}
    rework_to: [propose]
  - id: check
    skill: xforge-check
    human: tail
    produces: []
    ledgers: [review-findings, constitution-reply]
    gates: [structure, ledgers, constitution]
    exit:
      - {kind: gate, ref: ledgers}
      - {kind: ledger, ref: review-findings, requires: all-resolved}
      - {kind: attested, ref: review-findings}
      - {kind: attested, ref: constitution-reply}
      - {kind: approval, policy: stage}
    rework_to: [design, propose]
  - id: apply
    skill: xforge-apply
    human: tail
    produces: []
    ledgers: [delivery]
    gates: [unit-tests]
    exit:
      - {kind: packages, requires: all-integrated}
      - {kind: unclaimed-changes, requires: none}
    rework_to: [design]
  - id: verify
    skill: xforge-verify
    human: tail
    produces:
      - id: assurance
        path: assurance.md
        side: impl
        needs: [assurance]          # 保证层派生：任一基线治理才欠
        read: mixed
        outline: ["连贯性", "覆盖"]
        markers: [{kind: coverage, min: 1}]
    ledgers: [verification-receipt]
    gates: [structure, ledgers, unit-tests, spec-delta, interface-delta]
    exit:
      - {kind: gate, ref: ledgers}
      - {kind: gate, ref: unit-tests}
      - {kind: attested, ref: verification-receipt}
    rework_to: [apply, design]
archive:
  exit:
    - {kind: approval, policy: final}
approval_policies:
  stage: {min_approvers: 1, separation_of_duties: false}
  final: {min_approvers: 1, separation_of_duties: true}
```

出口条件的种类（控制面能判的全部）：

| kind | 判什么 | 挡住时的阻塞 token |
| --- | --- | --- |
| `gate` | 该门最近一次运行 `passed` 且 `revision` 等于当前输入的修订 | `gate-missing` / `gate-failed` / `gate-stale` |
| `ledger` | 台账存在、形状合法、`requires` 满足（`all-resolved`：无 `open` 条目） | `ledger-missing` / `ledger-open` |
| `attested` | 台账每个需署名的条目在审计链有对应事件（§5.3 匹配规则）；没有需署名条目时视为满足 | `attest-missing` / `attest-mismatch` |
| `approval` | 审计链里该 (change, scheme, stage) 的 `approval.decided` 满足策略，且事件的 `revision` 等于当前站修订；流程里 `scope: change` 的站（clarify）与终局审批按 Change 计，方案共享 | `approval-missing` / `approval-stale` / `approval-rejected` / `approval-sod` |
| `packages` | 计划里每个包到达 `integrated`（交付即集成） | `package-pending:<id>` |
| `unclaimed-changes` | 工作树相对基线提交的改动都落在某个包的 `paths` 内 | `unclaimed:<path>` |

每个产出是否**欠**：`needs ⊆ 打开的治理开关` 且（`side == spec` 仅默认方案欠；`side == impl` 每个方案欠）。不满足则状态是 `not-owed`，与 `pending` 严格区分（`不欠不是待写`）。门同理：门定义的 `needs` 不满足时该门 `not-owed`，`run` 跳过并如实报出。

quick 流程没有 `design` 站，`scope.yaml` 与 `work-packages.yaml` 由它的 `propose` 站产出（流程文件如此声明）；站产出什么由流程定，不由站名定。

`RF-07` 流程 schema：`stages[].id` 唯一；`rework_to` 只引用更早的站；`exit[].ref` 引用的门 / 台账 / 产出必须在本站声明。
`RF-08` `eligibility.risk` 非空；声明的 `risk` 不在其中时 `state` 报 `XF-STATE-004`。
`RF-09` 一份产出的 `read` 为 `skeleton` 或 `mixed` 时必须给 `outline`；为 `mixed` 时必须给 `markers`。
`RF-10` 控制面对 `instructions` 字段只做存在性检查，永不解析其内容。

### 3.2 门 `scaffold/gates/<gate>.yaml`

```yaml
name: unit-tests
kind: command                        # command | builtin
command:
  from: manifest                     # 取 manifest.verification.commands.unit-tests
inputs: ["src/**", "test/**"]        # 修订绑定的输入
timeout_seconds: 600
---
name: ledgers
kind: builtin
builtin: ledgers                     # structure | ledgers | constitution | spec-delta | interface-delta | interface-compat
accepts: [review-findings, constitution-reply, exit, verification-receipt, delivery]
inputs: ["${impl}/ledgers/**"]     # ${impl} = 本方案实现侧目录；${change} 只用于规格侧
---
name: spec-delta
kind: builtin
builtin: spec-delta
needs: [spec]                        # 治理依赖：关着就 not-owed，run 跳过
inputs: ["xforge/changes/${change}/specs/**", "xforge/specs/**"]
```

内置门各判什么：

| builtin | 判 |
| --- | --- |
| `structure` | 本站每份欠着的产出存在；`skeleton`/`mixed` 的 `## ` 标题集合与 `outline` 精确相等；`markers` 出现次数 ≥ `min` |
| `ledgers` | 本站声明的台账存在、schema 合法、`refs` 全部可定位；受理它们 |
| `constitution` | 章程答复台账的 `id` 集合 = 章程标题集合；`violates` 条目有署名 |
| `spec-delta` | delta 的操作块合法，`MODIFIED`/`REMOVED` 的 id 在基线里存在，`ADDED` 的不存在 |
| `interface-delta` | 同上，另判 `breaking` 字段存在 |
| `interface-compat` | `breaking: true` 的元素在声明的影响面里有 `interface` |
| `unclaimed-changes` | 由 `packages` 出口条件调用，不单独成门 |

门运行记录 `evidence/gates/<gate>/<run>.yaml`：

```yaml
gate: ledgers
run: 3
at: 2026-09-15T10:00:00Z
revision: 5f2a…                       # D4 对 inputs 的修订
result: passed                        # passed | failed
exit_code: 0
log: 3.log                            # 命令门才有；逐字输出
accepted:                             # 受理结果
  - {ledger: review-findings, digest: 9c1e…, verdict: accepted}
  - {ledger: constitution-reply, digest: 77b0…, verdict: rejected, reasons: ["条目「接口变更先写 delta」缺失"]}
```

`RF-11` 门运行记录由 `run` 写、`state` 读；`state` 判「当前」的唯一依据是 `revision` 与此刻输入修订相等。
`RF-32` 门 `inputs` 里 `xforge/changes/${change}` 代入 Change 根（规格侧，方案共享），`${impl}` 代入本方案的实现侧目录（默认方案两者是同一目录）；`structure`、`ledgers`、`constitution` 用 `${impl}`，规格与接口的门用 `${change}`。默认方案算修订时排除具名方案的子目录。效果：一个方案改自己的文件，不使另一个方案的门过期。
`RF-33` `structure` 门核对 `scope.yaml#scheme` 等于被寻址的方案；作用域骨架按方案给。
`RF-31` 门运行记录记下这次绑定的 `inputs`（`${change}`、`${impl}` 已代入）；判「当前」只在输入集相同的运行里找最近一次 —— 站级运行（整树）与包级运行（包路径）是两个修订空间，互不作对方的「当前」。判定依赖站的内置门（`structure`、`ledgers`、`constitution`）还记下 `stage`，「当前」要求站也相同：propose 站通过的 structure 不算 design 站的当前，哪怕 Change 目录一字未改（否则产出写错了地方、目录没变，站就能空着出去）。运行号仍是该门下统一递增。
`RF-30` 任何门的 `inputs` 都不包含验证收据文件本身：签名会改它，而收据证明的正是这些门；`structure` 也不含 `ledgers/**`（台账是 `ledgers` 门的事）。
`RF-12` `accepts` 列出的台账，受理结果只出现在门运行记录里，不写回台账文件。

### 3.3 权限策略 `scaffold/policies/<policy>.yaml`

```yaml
name: protected-governance
rules:
  - effect: deny
    tools: [write, edit, shell]        # 宿主中立的动作类：read | write | edit | shell
    paths:
      - "xforge/.audit/**"
      - "xforge/changes/*/evidence/**"
      - "xforge/specs/**"
      - "xforge/interfaces/**"
      - "xforge/scaffold/**"           # 本地化区由人写，不经 Agent 工具
      - "xforge/manifest.yaml"
      - "xforge/constitution.md"
    message: "证据与基线只有控制面写。诊断 XF-ENFORCE-001。"
  - effect: deny
    tools: [shell]
    commands: ["git push", "git reset --hard", "rm -rf xforge"]
```

求值：对一次工具调用，收集所有命中规则；`deny` > `ask` > `allow`；没有命中 → `allow`。`shell` 命令先判读写：命令行没有写入迹象（重定向、`tee`、`sed -i`、`rm/mv/cp`、改工作树的 git 子命令）、喂给解释器的代码也没有写文件的迹象（`open(...,'w')`、`write_text`、`writeFile`、`unlink` 之类）的命令是读，读不拦；解释器本身不算写。有写入迹象的，只从命令行本身（不含 heredoc 正文）抽出提到的治理路径按 glob 匹配，带 `*` 的路径按静态前缀保守比对。

`RF-13` 策略 schema：`effect ∈ deny|ask|allow`；`paths` 与 `commands` 至少一项；`paths` 是相对项目根的 glob。

### 3.4 投影策略 `changes/<id>/evidence/projections/<execution-id>.yaml`

派生物，`advance` 写。

```yaml
execution: EX-20260915-a7k2q9
kind: package                         # stage | package
change: C-20260915-order-ledger
scheme: default
stage: apply
package: P-01                         # kind=package 才有
workdir: /Users/me/work/order-ledger  # 绝对路径；并行包、具名方案各用自己的 worktree（会话里设 XFORGE_ROOT 指回主检出）
opened_by: R-0009
closed_by: null                       # 在途 = null；出站 / 交付时填 receipt id
allow: ["src/core/**", "test/core/**"]
```

执法语义（D8）：对 `workdir` 内、`xforge/` 之外的写：命中在途投影的 `allow` → allow；不命中 → deny `XF-ENFORCE-002`。同一 `workdir` 多份在途投影：`allow` 取交集。没有在途投影：不施加投影规则。

`RF-14` 在途投影的判定只看 `closed_by == null`，不看时间。
`RF-36` 清单 `mcp_approvers` 只配 MCP 服务（`id`、`server: {command, args?, env?}`、`tool?`、`timeout_seconds?`），不配人：人的身份就是 git 身份；配了 MCP 就是信了它，审批人 id 由它自己回。流程审批策略可带 `allow: [human, mcp]`。审计事件 `approval.decided` 可带 `via`、`requested_by`、`evidence` 三个字段，hash 覆盖它们。
`RF-35` 流程里 `scope: change` 的站，其审批事件对该 Change 的每个方案可见（与终局审批同一规则）；缺省 `scope: scheme`。
`RF-34` 同一 Change 的两个方案不能共用工作目录：进站、返工、派工时若 `--workdir` 与另一方案的在途投影 `workdir` 相同或互相包含，拒绝 `XF-ADVANCE-010`。
`RF-15` `stage` 投影的 `allow` 来自 `scope.yaml#paths`；`package` 投影的 `allow` 来自 `work-packages.yaml#packages[id].paths`，且必须是前者的子集（不是则 `advance --dispatch` 拒绝，`XF-ADVANCE-006`）。

### 3.5 执法钩子声明 `scaffold/hooks/enforce.yaml`

```yaml
name: enforce
events: [pre-tool-use]
command: "xforge-enforce --host ${platform}"
```

宿主投影把它写到宿主原生位置（命令行设计 §5）。

### 3.6 执行者定义 `scaffold/agents/xforge-executor.yaml`

```yaml
name: xforge-executor
description: 隔离执行一个 Stage 或一个工作包；输入是简报，输出是三种回报之一
tools: [read, write, edit, shell]
prompt_file: ../skills/xforge/executor-prompt_cn.md
```

Skill 设计定它的正文。

### 3.7 完整性清单 `scaffold/integrity.yaml`

```yaml
scaffold_version: 1.0.0-alpha.1
files:
  flows/solid.yaml: sha256:…
  skills/xforge-design/SKILL_cn.md: sha256:…   # 校验和对本地化区之外的内容计算
```

`RF-16` 带本地化区的文件，校验和对「去掉 `local:begin…end` 之间内容」的文本计算，所以填写本地化区不算「项目改过」。

---

## 4. 事实级：两条基线

### 4.1 规格文件 `specs/<domain>/<capability>.md`

```markdown
# 登录

<!-- xforge:entries:begin kind=requirements -->
### Requirement: REQ-auth-login-001 · 用邮箱与密码登录
- **WHEN** 提交合法邮箱与密码
- **THEN** 返回会话令牌

### Requirement: REQ-auth-login-002 · 连续失败锁定
……
<!-- xforge:entries:end -->
```

### 4.2 规格 delta `changes/<id>/specs/<domain>/<capability>.md`

```markdown
# 登录

## ADDED
### Requirement: REQ-auth-login-003 · 支持通行密钥
……

## MODIFIED
### Requirement: REQ-auth-login-002 · 连续失败锁定
……（整条替换）

## REMOVED
### Requirement: REQ-auth-login-001
```

归档合并：按 id，`ADDED` 插入、`MODIFIED` 整条替换、`REMOVED` 删除；输出重写整个 capability 文件并重建两层索引。

### 4.3 接口文件与 delta

```markdown
# order-core

<!-- xforge:entries:begin kind=elements -->
### Element: fn:createOrder · 创建订单
summary: (input: NewOrder) => Order；幂等键必填
### Element: endpoint:POST /orders · 创建订单
summary: 201 返回 Order；409 幂等冲突
<!-- xforge:entries:end -->
```

delta 与规格同形，`MODIFIED`/`REMOVED` 的元素多一行 `breaking: true|false`。

### 4.4 索引（两层，归档合并产出，提交）

```yaml
# specs/index.yaml —— 域层，常驻
domains:
  - id: auth
    title: 认证
    capabilities: [{id: login, path: auth/login.md}, {id: session, path: auth/session.md}]
```

```yaml
# specs/auth/index.yaml —— 条目层，按域取
entries:
  - {id: REQ-auth-login-001, capability: login, title: 用邮箱与密码登录}
  - {id: REQ-auth-login-002, capability: login, title: 连续失败锁定}
```

`RF-17` 索引与基线文件由同一次归档合并在同一个受治理写入里落盘；`inspect` 比对索引与文件的 id 集合，不等是 `XF-INSPECT-005`。
`RF-18` 域层索引大小与条目数无关（只随域与能力数增长）。

---

## 5. 记录级

### 5.1 声明层

**流程与分类声明 `change.yaml`**（规格侧，无受理事件）

```yaml
id: C-20260915-order-ledger
title: 订单台账
flow: solid
risk: medium                          # low | medium | high
impact: [interface]                   # 列表；空列表 = 断言无影响。取值：interface | security | data-migration | infra
baseline_commit: 3f9c…                # 开 Change 时的 HEAD；工作包的基线提交从它起
```

**作用域 `scope.yaml`**（实现侧）

```yaml
scheme: default
paths: ["src/**", "test/**"]
```

**工作包计划 `work-packages.yaml`**（实现侧）

```yaml
packages:
  - id: P-01
    title: 领域模型
    depends_on: []
    paths: ["src/core/**", "test/core/**"]
    verify: {gate: unit-tests}        # 引用一道命令门；该包交付后 run --package 跑它
    criteria:
      - {id: C-1, text: "Order 幂等键冲突返回 409"}
    review: none                      # none | required
```

`RF-19` `packages[].paths` ⊆ `scope.paths`；`depends_on` 无环；`verify.gate` 是已选用的命令门。

### 5.2 断言层：台账一个形状

统一 schema（`ledger.schema.json`）：

```yaml
kind: <见下表>
conclusion: <可选，整体断言>
entries:
  - id: <标识>
    conclusion: <本条判定>
    refs: [<可定位：条目 id、路径#锚、门名、摘要>]
    signer: "Name <email>"            # 仅需人负责的结论；与审计事件核对
    at: 2026-09-15T10:00:00Z          # 与 signer 成对
    note: <自由文本，控制面不读>
    supersedes: R-0007                # 返工后重新决定时才有
```

五类的词汇：

| kind | 文件 | `id` | `conclusion` 取值 | `refs` 至少含 | 需署名的条目 |
| --- | --- | --- | --- | --- | --- |
| `review-findings` | `ledgers/review-findings.yaml` | `F-nnn` | `open` / `resolved` / `rejected` | 涉及的产出路径或 Requirement id | `resolved` / `rejected`（决定者） |
| `constitution-reply` | `ledgers/constitution-reply.yaml` | 章程标题 | `complies` / `violates` / `n-a` | Requirement id、路径或门名 | `violates`（批准者） |
| `exit` | `ledgers/exit/<condition-id>.yaml` | 条目 id（如 `Q-nnn`） | 由条件定义（材料问题：`answered` / `deferred`） | 承接的返工 receipt | 全部（决定者） |
| `verification-receipt` | `ledgers/verification-receipt.yaml` | 门名 | `passed` | 门运行记录路径 | 全部（签署者） |
| `delivery` | `ledgers/deliveries/<package>.yaml` | 执行 id | `succeeded` / `failed` / `blocked` | 改动路径、验证门运行 | 全部（执行者 = 执行 id，不是人） |

**交付记录**是混合体，起草填机器已知部分：

```yaml
kind: delivery
entries:
  - id: EX-20260915-a7k2q9             # 起草
    package: P-01                       # 起草
    baseline_commit: 3f9c…              # 起草
    paths_changed: [src/core/order.ts]  # 执行者填；交付登记时控制面按 git diff 核对，核对结果记进 receipt，不回写台账
    revision: 8a1d…                     # 可选；控制面在交付登记的 receipt 里记它算出的修订，不要求执行者填
    conclusion: succeeded               # 执行者填
    refs: [evidence/gates/unit-tests/4.yaml]
    criteria:                           # 执行者填
      - {id: C-1, evidence: "test/core/order.test.ts#idempotency"}
    remaining: []                       # 执行者填
    signer: EX-20260915-a7k2q9
    at: …
```

`RF-20` 五类台账共用一个 schema，`kind` 决定 `conclusion` 的枚举与 `refs` 的最少种类（用 `if/then` 表达）。**缺署名不是形状错误**：台账由 Agent 写，它不知道谁来签；`signer` / `at` 由人在登记前补上，缺失由出口条件 `attested` 报 `attest-missing`，门不因此拒绝受理。交付记录例外：执行者知道自己的执行 id，必须署名。
`RF-21` 有 `signer` 的条目必须有 `at`；`signer` 是执行 id 时必须匹配 `EX-…` 格式并存在对应的派工 receipt。
`RF-22` 台账 `digest` = 文件内容的 sha256；门运行记录与 receipt 引用台账时记 digest，不记路径以外的东西。

### 5.3 证据层

**receipt `evidence/receipts/<seq>-<kind>.yaml`**

```yaml
id: R-0009
seq: 9
kind: package-dispatch                # stage-transition | rework | package-dispatch | package-deliver | archive（package-integrate / package-review 只在旧记录里）
at: 2026-09-15T10:00:00Z
change: C-20260915-order-ledger
scheme: default
prev: 4b7e…                           # 上一环 hash；第一环 null
from: ready                           # 状态机移动的两端
to: running
subject: {package: P-01}              # stage 移动时是 {stage: check}
execution: EX-20260915-a7k2q9         # dispatch 才有
workdir: /Users/me/work/order-ledger  # dispatch 与 stage 进站才有
inputs:                               # 这次移动依据了什么
  gates: [{gate: ledgers, run: 3, revision: 5f2a…}]
  ledgers: [{kind: review-findings, digest: 9c1e…}]
  audit_events: [c0ff…]
revision: 5f2a…                       # 移动那一刻的内容修订
hash: 1e9b…                           # 对上述全部字段的规范序列化求 sha256
```

`RF-23` `hash` 覆盖 `prev`，链上任一环改动都会让后一环校验失败；`inspect` 逐环验。
`RF-24` `seq` 在 (change, scheme) 内连续递增；缺号是 `XF-INSPECT-001`。

**审计链 `.audit/chain.jsonl`**，一行一个事件：

```json
{"seq":57,"at":"2026-09-15T10:02:00Z","kind":"approval.decided",
 "change":"C-20260915-order-ledger","scheme":"default",
 "subject":{"stage":"check"},
 "actor":{"name":"Han Shan","email":"han@example.com"},
 "decision":"approved","refs":[],"note":"",
 "prev":"a91c…","hash":"c0ff…","hmac":null}
```

| kind | subject | 对应的人的介入点 |
| --- | --- | --- |
| `approval.decided` | `{stage, revision}` 或 `{archive: true, revision}`；MCP 批时另有 `via`、`requested_by`、`evidence` | 审批一次转换或归档（人或 MCP） |
| `finding.answered` | `{ledger: review-findings, entry: F-003, digest}` | 回答一条已存在的发现 |
| `entry.decided` | `{ledger: exit/<condition-id> \| constitution-reply, entry, digest}` | 出口条件台账与章程答复里需人负责的条目（同一介入点的另一种台账） |
| `receipt.signed` | `{ledger: verification-receipt, digest}` | 签署验证收据 |
| `delivery.confirmed` | `{package, step, digest}` | 旧记录：确认一份交付（2026-09-17 取消，交付即集成） |
| `verification.declared` | `{command: unit-tests, manifest_digest}` | 声明验证命令 |
| `scaffold.upgraded` | `{from, to, kept: [...]}` | 装配留审计（不是介入点） |

**署名匹配规则**（`署名可引用不可编造`）：台账条目 `(signer, at)` 必须存在一个事件，其 `actor` 渲染为 `"name <email>"` 与 `signer` 逐字相等、`subject.digest` 等于该台账当时的 digest 且 `kind` 与台账种类对应。**有事件而对不上**（署名或台账内容在登记后变了）是损坏 `XF-INSPECT-003`（阻塞）；**一个事件都没有**只是还没登记，`inspect` 提示、出口条件 `attested` 报 `attest-missing`。人填完署名到跑 `attest` 之间的那一刻不是损坏。

`RF-25` 事件 `hash` 覆盖 `prev`；设置了 `XFORGE_AUDIT_HMAC` 环境变量时 `hmac` 非空且校验；未设置时 `inspect` 报 `XF-INSPECT-004`（提示级，不阻塞）。
`RF-26` `actor` 由控制面从 git 读，命令行没有任何参数能覆盖它。

**审计索引 `evidence/audit-index.yaml`**：本 Change 相关事件的 `{hash, kind, at}` 列表，每次 `attest` 追加，归档时冻结。让归档后的 Change 目录自包含。

---

## 6. 诊断码字典 `diagnostics/<code>.yaml`

随 CLI 包发布，不在项目里。

```yaml
code: XF-ADVANCE-003
title: 门记录过期
meaning: 门最近一次运行绑定的修订不等于当前输入的修订。
remedy:
  command: "xforge run --gate ${gate}"
  text: 重跑这道门；「进」默认会捎带。
variants:                             # 事故记忆：撞上才看到
  - seen: 只改了测试文件也会过期
    note: unit-tests 的 inputs 含 test/**，这是刻意的。
```

码的格式 `XF-<AREA>-<NNN>`，`AREA ∈ MODEL · STATE · INSPECT · RUN · ATTEST · ADVANCE · ENFORCE · ASSEMBLE`。

`RF-27` 代码里出现的每个诊断码在 `diagnostics/` 有文件，反之亦然（product 层测试双向比对）。
`RF-28` 每份字典文件的 `remedy.command` 若非空，必须是本 CLI 的合法调用形式（用参数解析器干跑校验）。

---

## 7. 读取契约总表

| 文件 | 档 | 控制面读什么 |
| --- | --- | --- |
| 清单 | 条目级 | 全部字段 |
| 章程 | 混装 | 标题列表；正文不读 |
| 流程 / 门 / 策略 / 钩子 / 执行者 | 条目级 | 判定图字段；`instructions` 只查存在 |
| Skill | 骨架级 | 文件在不在、四节标题在不在、本地化区标记成对 |
| 基线与索引 | 条目级 | id、标题、摘要、`breaking` |
| `change.yaml` `scope.yaml` `work-packages.yaml` | 条目级 | 全部字段 |
| 规格 / 接口 delta | 条目级 | 操作块与 id |
| 提案 | 骨架级 | `## ` 标题集合 |
| 设计 / 保证说明 | 混装 | 标题集合 + 标记区内的条目 |
| 五类台账 | 条目级 | 统一形状 |
| 门运行记录 / receipt / 投影 / 审计 | 条目级 | 自己写自己读 |

`RF-29` 骨架级的标题匹配是精确字符串匹配（去首尾空白），不做模糊匹配；给标题加限定语会让 `structure` 门红，这是刻意的。

---

## 8. 追溯

| 不变量 | 兑现处 |
| --- | --- |
| `写权限二分` | §1.1 矩阵、`RF-02` `RF-03` |
| `署名可引用不可编造` | D5、§5.3 匹配规则、`RF-26` |
| `有门能判的不走证` | §3.2 `accepts`、`RF-12` |
| `一次调用一个进程` | D3 位置不落盘 |
| `失败朝安全` | §3.3 shell 字符串包含匹配；§3.4 交集 |
| `receipt 成链` | §5.3 receipt、`RF-23` `RF-24` |
| `写入范围只有策略执法` | §3.3 §3.4、D8、`RF-15` |
| `寻址到方案` | §1 `<scheme-id>/` 保留；receipt 与投影带 `scheme` |
| `归档唯一例外` | §3.1 `archive.exit`；§5.3 `approval.decided` 的 `{archive: true}` |
| `规格侧共享` | §1 规格侧文件不带方案 |
| `基线只由归档推进` | §1.1 矩阵、`RF-17` |
| `机制对称主题独立` | §4 两条基线同形、无映射表 |
| `保证层派生` | §3.1 `needs: [assurance]` |
| `台账一个形状` | §5.2、`RF-20` |
| `不欠不是待写` | §3.1 欠的判定、`not-owed` 状态 |
| `不读散文的意思` | `RF-10` `RF-29`、§7 |
| `散文要有不可约判断` | §3.1 solid 只产提案、设计、保证说明三份散文 |
| `重算的不能作判据` | D3、`RF-17`（索引由合并产出）、§3.4 投影由派工产出 |
| `第0级有界` | `RF-18` |
| `不变量段确定性` | 域层索引无时间戳；命令行设计 `state --orient` 的 0a 段引用它 |
| `归档后不再变` | §1.1 矩阵最后一行 |
| `本地化区只能加` | D9 标记、`RF-16` |
