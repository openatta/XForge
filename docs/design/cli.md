# 命令行设计

> 依据：命令行文档全篇，主文档《一个 Change 的骨架》《上下文成本》《写入范围的权威》。
> 文件形状在 [规则文件设计](rule-files.md)，这里只讲**命令**：签名、读什么、写什么、前置条件、回什么、错了怎么说。
>
> 标着 **决定** 的可以推翻；`CLI-nn` 是可验收的断言。

---

## 0. 决定清单

| # | 决定 | 理由 |
| --- | --- | --- |
| **D1** | 五动词的命令名：读 `state`（位置）与 `show`（点名取材料，读的第二种形式）、验 `inspect`、产 `run`、证 `attest`、进 `advance`；装配 `init` `sync` `update`；执法 `xforge-enforce`（独立可执行）；元信息 `help` `version` `explain` | 一个动词一个词；`inspect` 避开与站名 `check`/`verify` 撞车。`show` 单独成词是为了调用方便，性质仍是读：不写盘、随时可调、答案只随树变 |
| **D2** | 默认输出 JSON 信封；`--text` 只改呈现 | 主要读者是 Agent |
| **D3** | 退出码：`0` 成功；`1` 成功执行但结论是「不能」（被挡、门失败、条件不满足）；`2` 用法错误；`3` 记录损坏或治理不可读（`失败朝安全`） | Agent 与 CI 都要靠退出码分流，三类补救不同 |
| **D4** | `--change <id>` 缺省时：恰有一个未归档 Change 就用它，否则 `XF-STATE-001` 要求指定 | 单 Change 的项目零参数；多 Change 不猜 |
| **D5** | `--scheme <id>` 选实现方案：不给就是默认方案，行为与目录布局与没有这个特性时完全一样；给了，实现侧的一切落在 `changes/<id>/<scheme>/`，规格侧共享。解析顺序 `--scheme` → 环境变量 `XFORGE_SCHEME` → 缺省。方案 id 是小写字母开头的字母数字与连字符，不能叫 `default`，不能撞 `specs`/`interfaces`/`ledgers`/`evidence`；第一次用 `state --scheme x` 就等于创建，位置在流程第一站，规格侧产出对它 `not-owed`，一次 `advance` 就到第一个实现侧的站 | 主文档《实现方案》；XIPD 的双路开发靠它 |
| **D6** | `state` 默认只回 0b；`state --orient` 回 0a + 1 + 0b（按 0a → 1 → 0b 排） | 控制面无会话状态，「第一次」由调用方决定 |
| **D7** | 站级审批与终局审批的 `attest approve` 记录事件，不移动；事件记下当时的站修订，批完再改产出审批作废（`approval-stale`）。交付即集成：`advance package --deliver` 在验证门当前且通过时直接落 `integrated`，没有人确认这一格（2026-09-17 用户决定：生成量太大，逐包人确认不现实，责任归到审批点；终局形态是 MCP 审批） | 主文档《两台状态机》《人的介入点》 |
| **D8** | 宿主执法按宿主分派（`claude` 与 `codex` 各一份协议文件，§4）；**宿主不支持的动作朝安全那一边倒** —— codex 的 `PreToolUse` 没有「问」，`ask` 在那里降级成 `deny`。没有钩子机制的宿主上，`sync` 只投影 Skill 与执行者，`state --orient` 的 0a 段带 `enforcement: unavailable` | 拦不住时要让 Agent 与人都知道拦不住，而不是假装拦得住 |
| **D9** | 卫生检查（声明了却没人用）作为 `inspect --hygiene` 存在，并由 `advance --archive` 在终局前跑一次 | 给它一个触发点，又不让顺利的 Change 主动调 `inspect` |
| **D10** | 拆除是独立命令 `xforge remove --confirm <project-name>`（`project-name` 是项目根目录名），删 `xforge/` 与全部宿主投影（Skill、执行者、钩子、`AGENTS.md` 标记块）；不带或带错确认是 `XF-ASSEMBLE-004`；日常命令没有这个开关 | 破坏性动作要显式确认 |
| **D11** | 「验」对 Skill 只做存在性检查（文件在、四节标题在、本地化区标记成对） | `不读散文的意思`；覆盖判定在 Skill 设计里由「本站承诺」条目化后再考虑 |
| **D12** | 「TTY + 非 CI + 没给相应的 flag」时 `init` 才探测本机宿主并交互勾选；其余情形一律不探测，用文档默认值。安装器自己的话用英文 | 探测是给人看的线索，不是策略：控制面不因本机装了什么而改变结果，CI 才可复现。交互只发生在有人按键的地方；英文是因为这些话出现在语言选择之前 |
| **D13** | 「装的事」与「记的事」分成两个命令：`doctor` 体检这台机器与这次装配（宿主在不在、投影新不新鲜、声明的能力兑没兑现、骨架完不完整、有没有残留），只读；找到的问题按 `blocking` 报（装配坏了不是「也许」是「不行」），版本落后是 `info`。记录本身的问题仍归 `inspect`（`XF-INSPECT-*`，退出码 3） | 两件事的补救完全不同：一个重装，一个改记录。混在一个命令里，退出码就没法分流，Agent 也只能猜该干嘛 |
| **D14** | `repair` 只做「重写一遍就对」的事：重投影、从载荷补回**缺失**的受管文件；宿主不在场、钩子跑不起来、升级在途、**被改过的**骨架正文一概不动，原样报出来。修完重跑检查，不看结果不算修好 | 会覆盖人写过的正文、会删文件、会改环境的事都不是「修复」，是决定；而一次没落盘的修复比不修更坏 —— 调用方会以为好了 |
| **D15** | codex 的钩子（`.codex/hooks.json` 的 `hooks.PreToolUse`）照投，`capabilities.enforcement` 记 `hook`；但「装了」与「会跑」之间隔着一步人的动作 —— **非托管钩子要在 `/hooks` 里过一遍才生效**（信任记在钩子定义的哈希上，改了就重新审），项目 `.codex/` 层没被信任时项目钩子根本不加载。这一步写进 `AGENTS.md` 标记块那句话里，不留给 `state --orient` 一句 `available` 去骗人 | 这个机制确实在（0.147 上 `apply_patch` 与 `Bash` 的 deny 实测拦得住），能力记 `none` 是另一种谎；但让人以为装完就拦住了同样是谎 |

---

## 1. 通用

### 1.1 信封

```json
{
  "ok": true,
  "verb": "advance",
  "change": "C-20260915-order-ledger",
  "scheme": "default",
  "result": { },
  "diagnostics": [
    {"code": "XF-ADVANCE-003", "severity": "blocking", "message": "门 unit-tests 的记录已过期",
     "remedy": {"command": "xforge run --gate unit-tests", "text": "重跑这道门"}}
  ],
  "changed": ["xforge/changes/C-…/evidence/receipts/0010-stage-transition.yaml"],
  "next": [
    {"command": "xforge state", "why": "看下一站欠什么"}
  ]
}
```

- `severity ∈ blocking · warning · info`；`ok = false` 当且仅当存在 `blocking`。
- `changed` 列出本次落盘的每个路径；`验`与`读`永远为空数组。
- `next` 至多三条，每条是可直接执行的命令。
- `--field <json-path>` 只回信封里那一段（`窄是默认`）。

`CLI-01` 每个命令的每条输出都通过 `envelope.schema.json` 校验（product 层对每个命令的样例信封校验）。
`CLI-02` `ok=false` ⇔ 存在 `blocking` 诊断 ⇔ 退出码 `1`；退出码 `3` 时 `diagnostics` 至少一条 `code` 以 `XF-INSPECT-` 或 `XF-MODEL-` 开头。
`CLI-03` `state` 与 `inspect` 的信封 `changed` 恒为空，且进程对项目目录没有写系统调用（integration 层用只读挂载或 mtime 断言）。

### 1.2 进程

- 每次调用：定位治理根（环境变量 `XFORGE_ROOT` 指定的目录优先；否则从 `--cwd` 或进程 cwd 向上找 `xforge/manifest.yaml`）→ 读清单 → 按命令读它需要的文件 → 计算 → 落盘（如果写）→ 输出。没有缓存文件、没有守护进程。
- 一个 git worktree 里有自己检出的 `xforge/` 副本，那不是活的治理根。在 worktree 里跑的会话（一个方案、一个并行包）设 `XFORGE_ROOT` 指回主检出，`xforge` 与执法钩子都从它读；工作目录仍是 worktree，进站与派工用 `--workdir` 记下它。命令门在本方案的工作目录里跑，项目侧的输入修订也在那里算；治理侧的输入在治理根算。
- 写入走受治理写入：临时文件 + rename；一次命令的多份写入与审计事件放同一事务，任一失败整体回滚（`写必须能回退`）。
- 时间戳只出现在证据与审计里，不出现在 `state --orient` 的 0a 段。

`CLI-04` 任一写命令在写第二个文件前被杀，重启后 `inspect` 报干净（事务目录残留时报 `XF-INSPECT-006` 并给清理命令）。

### 1.3 位置怎么算

Stage 位置 = 该 (change, scheme) 最后一条 `stage-transition`/`rework`/`archive` receipt 的 `to`；没有 receipt 时是流程第一站。
归档是 Change 级：Change 根有 `archived.yaml`（任一方案归档时写，记方案与 receipt）就是 `archived`，别的方案的位置也报 `archived`，任何写动作都拒绝；终局审批的事件不分方案。老项目没有标记时，默认方案链上的 archive receipt 也算。
工作包状态 = 该包最后一条 `package-*` receipt 的 `to`；没有时是 `ready`。
`ready-to-archive` 是最后一站出站后的位置；`archived` 是 `archive` receipt 之后的位置。

---

## 2. 五个动词

### 2.1 `state` —— 读

```
xforge state [--change <id>] [--orient] [--field <path>]
```

读：清单、流程、声明、作用域、计划、台账、门运行记录、receipt 链、审计索引、基线域层索引（`--orient` 时）。写：无。

`result` 的 0b 段（默认）：

```json
{
  "position": {"stage": "check", "status": "in-stage"},
  "owed": [
    {"id": "review-findings", "kind": "ledger", "status": "pending", "path": "ledgers/review-findings.yaml"},
    {"id": "spec-delta", "kind": "artifact", "status": "not-owed", "because": "governance.spec=false"}
  ],
  "blockers": [
    {"token": "ledger-missing", "ref": "review-findings", "verb": "write", "remedy": {"text": "写它；下一次 advance 跑门时受理"}},
    {"token": "approval-missing", "ref": "stage", "verb": "attest", "remedy": {"command": "xforge attest approve --stage check"}}
  ],
  "packages": [{"id": "P-01", "state": "ready"}],
  "drafts": {"review-findings": "kind: review-findings\nentries: []\n"}
}
```

`--orient` 追加 0a 与 1 段，并把三段按 `orient.invariants`（0a）→ `orient.stage`（1）→ 上面的 0b 排序输出：

```json
{
  "orient": {
    "invariants": {
      "governance": {"spec": true, "interface": false, "assurance": true},
      "modules": [{"id": "core", "paths": ["src/core/**"]}],
      "flow": {"name": "solid", "stages": ["propose", "design", "check", "apply", "verify"],
               "graph": {"check": {"gates": ["structure", "ledgers", "constitution"], "exit": ["gate:ledgers", "ledger:review-findings", "approval:stage"], "rework_to": ["design", "propose"]}}},
      "spec_domains": [{"id": "auth", "title": "认证", "capabilities": ["login", "session"]}],
      "constitution": ["不做无测试的行为变更", "接口变更先写 delta 再写实现"],
      "declaration": {"id": "C-…", "flow": "solid", "risk": "medium", "impact": ["interface"]},
      "enforcement": "available",
      "call_skeleton": ["xforge state", "xforge attest …（若本站有人的介入点）", "xforge advance"]
    },
    "stage": {
      "id": "check",
      "skill": "xforge-check",
      "human": "tail",
      "isolate": true,                 // 由 human 推出：body → false，其余 true
      "produces": [],
      "ledgers": [{"kind": "review-findings", "path": "ledgers/review-findings.yaml", "draft": "…"}],
      "gates": ["structure", "ledgers", "constitution"],
      "dir": "xforge/changes/C-20260915-order-ledger",
      "upstream": [
        {"path": "proposal.md", "bytes": 4120, "headings": ["背景", "目标", "非目标", "为什么选这条流程", "影响面"], "changed_since_last_state": false},
        {"path": "design.md", "bytes": 9800, "headings": ["技术路径", "…"], "changed_since_last_state": true}
      ],
      "entries_in_touched_domains": [{"id": "REQ-auth-login-001", "title": "用邮箱与密码登录"}],
      "complete": true
    }
  },
  "position": "…", "owed": "…", "blockers": "…"
}
```

`orient.stage.complete: true` 是 `切片自称完整` 的实现：明说不需要再开流程文件。
`upstream[].changed_since_last_state` 的「上次」以最近一条 receipt 的 `revision` 为准（无会话状态）。

| 失败面 | 码 | 退出码 |
| --- | --- | --- |
| 找不到治理根 | `XF-STATE-002` | 3 |
| 多个未归档 Change 且未指定 | `XF-STATE-001` | 2 |
| 声明的 `risk` 不在流程 `eligibility` 内 | `XF-STATE-004` | 1 |
| 记录损坏（链断、schema 非法） | 转 `inspect` 的码 | 3 |

`CLI-05` `state` 对同一棵树连续调用两次，信封逐字节相同（0a 段确定性，且没有时间戳）。
`CLI-06` `orient.invariants` 的序列化大小与 Requirement 条目数无关（`第0级有界`）。
`CLI-07` 阻塞清单里每一项的 `verb` ∈ `write · run · attest · advance · inspect`，且 `remedy.command` 存在时是合法调用。

### 2.1a `show` —— 读的第二种形式：点名取材料

```
xforge show <ref> [--change <id>]
```

读：被点名的那一份。写：无。它是第 2 级材料的**唯一入口**（主文档《加载三级》与《能让控制面操作的就别开文件》）：
Agent 不开文件，让控制面按名字切片，切片自称完整，省略自报。

| ref | 回什么 |
| --- | --- |
| `stage:<id>` | 该站的写作材料：每份产出的 `outline` 与 `instructions`。判定图不重复发，`state --orient` 已有 |
| `doc:<path>[#<heading>]` | Change 目录里一份散文的全文，或某个二级标题下的那一段 |
| `spec:<REQ-id>` / `interface:<element-id>` | 基线里一条条目的正文（含 summary、breaking） |
| `constitution:<title>` | 章程一条的正文 |
| `gate:<name>[/<run>]` | 一次门运行的完整输出（缺省最近一次） |
| `ledger:<ref>` | 一份台账全文；交付记录按包点名 `ledger:delivery/<pkg>`；不合法的 ref 是 `XF-STATE-005`，不是内部错误 |
| `package:<id>` | 计划里这个包的条目、当前状态、交付记录全文、它的投影（执行 id、工作目录、是否在途） |
| `receipts` | 本方案的 receipt 链：id、kind、from → to、at；不含 inputs |
| `index:<domain>` | 索引条目层：该域下全部条目 id 与标题 |

`result`：`{"ref": "…", "content": …, "complete": true, "omitted": []}`。`#heading` 切片时 `omitted` 列出未发的其它标题（`省略自报`）；
找不到 → `XF-STATE-005`，remedy 指回 `state --orient`（只接受定向里出现过的名字，`名字不单飞` 的反向）。

`CLI-30` 具名方案走查（integration）：默认方案与一个具名方案各在自己的 worktree 里推进同一个 Change；具名方案的实现侧文件全在 `<scheme>/` 下，`show doc:` 按方案取；一方改文件不使另一方的门过期；执法按各自 worktree 的投影放行与拒绝；两方案共用一个工作目录时进站/派工拒绝 `XF-ADVANCE-010`；`state` 回 `schemes`；`inspect --all` 覆盖每个方案；一方归档后另一方位置报 `archived`。
`CLI-31` `XFORGE_ROOT` 与 `XFORGE_SCHEME` 都能替代参数：在 worktree 里不带参数调用得到的信封与在主检出里带 `--cwd`、`--scheme` 调用的一致。
`CLI-28` `show` 的每种 ref 都有 integration 测试；`omitted` 与文件里实际未发的标题集合相等。
`CLI-29` live 层：solid 场景执行者转录里，`xforge show` 的调用次数 ≥ 直接读 `xforge/changes/**` 文件的次数。

### 2.2 `inspect` —— 验

```
xforge inspect [--change <id> | --all] [--hygiene]
```

读：一切记录。写：无。不执行任何项目命令。

检查项（每项一个码）：

| # | 检查 | 码 |
| --- | --- | --- |
| 1 | receipt 链：`seq` 连续、`prev` 与 `hash` 逐环成立 | `XF-INSPECT-001` |
| 2 | 每份规则文件与记录文件通过 schema | `XF-INSPECT-002` |
| 3 | 台账署名与审计事件匹配（规则文件设计 §5.3） | `XF-INSPECT-003` |
| 4 | 审计链 `prev`/`hash`/`hmac` 成立；未设 HMAC 是提示 | `XF-INSPECT-004` |
| 5 | 基线索引与基线文件的 id 集合一致 | `XF-INSPECT-005` |
| 6 | 受治理写入事务残留 | `XF-INSPECT-006` |
| 7 | `refs` 悬空（引用的路径、id、门运行不存在） | `XF-INSPECT-007` |
| 8 | 投影 `opened_by` 指向的 receipt 存在；`closed_by` 非空时同样 | `XF-INSPECT-008` |
| 9 | `--hygiene`：清单 `selected` 里没有任何流程引用的门 / 策略；Skill 文件存在但没有流程引用；`scaffold/integrity.yaml` 与实际文件不符 | `XF-INSPECT-009` |
| 10 | Skill 存在性：流程引用的 Skill 文件在、四节标题在、本地化区标记成对（D11） | `XF-INSPECT-010` |

结果：`ok=true` 且退出码 0 表示干净；发现 1–8 任一项 → 退出码 3；仅 9/10 → 退出码 1。

`CLI-08` 对一棵人为改坏的树（改一个 receipt 字节、删一行审计、改一个台账署名），`inspect` 各自报出对应的码且退出码 3。
`CLI-09` 一个从 `propose` 走到 `archived` 的顺利 Change，全程没有任何 Skill 调用 `inspect`（live 层从转录里 grep）。

### 2.3 `run` —— 产

```
xforge run [--change <id>] [--gate <name>]... [--stage <id>] [--package <id>]
```

缺省：当前站声明的全部门。`--gate` 只跑指定的；`--package` 跑该包 `verify.gate` 指向的命令门，输入修订限定在该包的 `paths`。

对每道门：门的 `needs` 不满足 → 回 `not-owed` 不跑 → 算输入修订 → 若最近一次运行 `passed` 且修订相同，跳过并回 `current`（`--force` 强制重跑）→ 否则执行（命令门：跑命令，逐字写 `.log`；内置门：跑内置逻辑）→ 受理 `accepts` 里存在的台账 → 写运行记录。

`result`：

```json
{"gates": [
  {"gate": "structure", "run": 4, "result": "passed", "status": "current"},
  {"gate": "unit-tests", "run": 2, "result": "failed", "exit_code": 1,
   "log": "xforge/changes/C-…/evidence/gates/unit-tests/2.log",
   "tail": "  ✗ order idempotency (expected 409, got 201)\n  1 failing"},
  {"gate": "ledgers", "run": 3, "result": "failed",
   "accepted": [{"ledger": "constitution-reply", "verdict": "rejected", "reasons": ["缺条目「接口变更先写 delta 再写实现」"]}]}
]}
```

通过的门只给结论与运行号；失败的门给 `tail`（最后 40 行）与 `log` 路径（`大块给指针`）。`result.blockers` 是跑完之后本站的出口判定，读者不必紧接着再调 `state`。

| 失败面 | 码 | 退出码 |
| --- | --- | --- |
| 门命令未声明（清单 `verification.commands` 缺） | `XF-RUN-001`，remedy `xforge attest verification --command unit-tests="…"`（人做） | 1 |
| 命令超时 | `XF-RUN-002` | 1 |
| 门失败 | `XF-RUN-003` | 1 |
| 受理被拒 | `XF-RUN-004`（reasons 逐条） | 1 |

`CLI-10` 门命令永远不由 Agent 输入：`run` 没有任何参数能提供命令文本。
`CLI-11` `run` 的运行记录写入与 `.log` 写入在同一事务。

### 2.4 `attest` —— 证

```
xforge attest approve   (--stage <id> | --archive) --decision approved|rejected [--note <text>]
xforge attest approve   (--stage <id> | --archive) --via <mcp-approver>     # 决定由清单里配置的 MCP 审批者给
xforge attest entry     <ledger-kind> <entry-id>        # 台账里一条需人署名的条目；finding <id> 是 entry review-findings <id> 的别名
xforge attest receipt
xforge attest verification --command <name>=<command>...
```

共同行为：从 git 读身份（`RF-26`）→ 校验前置 → 写审计事件（+ 审计索引）→ 事件成功后才做捎带的移动。

| 子命令 | 前置 | 事件 | 之后 |
| --- | --- | --- | --- |
| `approve --stage` | 位置在该站；策略 `separation_of_duties` 时 actor 不是实现者 —— 实现者 = `git log <baseline_commit>..HEAD -- <scope.paths>` 的作者集合 | `approval.decided {stage, revision}`（`revision` = 当时的站修订） | 不移动 |
| `approve --archive` | 位置是 `ready-to-archive` | `approval.decided {archive: true, revision}` | 不移动 |
| `approve … --via <id>` | 该审批策略 `allow` 含 `mcp`；清单 `mcp_approvers` 里有这个 id。控制面按配置起 stdio MCP 服务，`tools/call` 它的工具（缺省 `approve`），请求带项目 git 地址、Change、方案、流程、站或终局、当时的站修订、请求者的 git 身份、材料的 `show` 引用与台账摘要；答复必须是 `{approver, decision, note?}` | `approval.decided`，`actor` = `{name: approver, email: <approver>@<id>.mcp}`，另记 `via: mcp:<id>`、`requested_by`（请求者 git 身份）、`evidence`（答复的 sha256） | 不移动。**MCP 批了就是同意**：人数、职责分离、绑修订、`inspect` 对它与人批一视同仁；MCP 内部怎么审不是控制面的事 |
| `entry` | 台账里该条的 `conclusion` 是需署名的取值（规则文件设计 §5.2 表），`signer` 等于当前身份 | `finding.answered`（`review-findings`）/ `entry.decided`（`exit` 一族） | 无 |
| `receipt` | 验证收据台账每条 `signer` 等于当前身份；每条引用的门运行 `passed` 且当前 | `receipt.signed` | 无 |
| `verification` | 清单可写；命令非空 | `verification.declared` | 写清单 `verification.commands` |

诊断指向真正失败的那件事：`advance package --deliver` 因集成前置没过而失败时，码是 `XF-ADVANCE-*`（那一格的检查）；`attest` 因署名不成立时才是 `XF-ATTEST-001`。

`CLI-12` `attest` 的每个子命令成功时信封 `result` 只有 `{event: <hash>}` 与捎带移动的 receipt id（`正常就说正常`）。
`CLI-13` 把台账里的 `signer` 改成另一个名字后 `attest finding` 拒绝（`XF-ATTEST-001`），审计链不增行。
`CLI-14` `advance package --deliver` 在集成前置失败时：审计链不增行、receipt 不增环、诊断码属 `XF-ADVANCE-`。
`CLI-32` 交付即集成：`conclusion: succeeded` 的交付在验证门当前且通过、改动路径与工作树一致时，`--deliver` 直接落 `integrated` 并关闭包投影；门不当前拒绝 `XF-ADVANCE-003`。
`CLI-34` MCP 审批与人批同形：同一种事件、同样参与人数统计与修订绑定、`inspect` 同样验；事件带 `via`、`requested_by`、`evidence`。审批策略 `allow: [human|mcp]` 决定谁能批（缺省两者都行）：不允许的方式拒绝 `XF-ATTEST-003`；`--via` 指的 id 未配置拒绝 `XF-ATTEST-002`。`state` 的补救命令在允许 MCP 且配置了审批者时点名 `--via`。
`CLI-35` MCP 超时、起不来、报错或答复不合形状：`XF-ATTEST-004`，审计链不增行，审批保持缺失（不算否决）。
`CLI-33` 审批绑修订：站级或终局审批之后改了本站产出，出口条件报 `approval-stale`，重批后才满足；只有批在当前修订上的审批参与人数统计。

### 2.5 `advance` —— 进

```
xforge advance [--change <id>] [--no-run] [--workdir <path>]
xforge advance --rework-to <stage> --reason <text>
xforge advance package <id> --dispatch [--workdir <path>]
xforge advance package <id> --deliver
xforge advance --archive
```

**Stage 机（缺省形式）**：

1. 若不带 `--no-run`，先执行 `run`（本站全部门）；任一失败则停在这里，诊断是 `run` 的。
2. 逐条判本站 `exit`；任一不满足 → 退出码 1，`blockers` 同 `state`。
3. 写 `stage-transition` receipt（`inputs` 记本次依据的门运行、台账 digest、审计事件）。
4. 关闭本站投影（`closed_by`），为下一站写新的 `stage` 投影（`allow = scope.paths`，`workdir` = `--workdir` 或 cwd）。
5. `result` = 下一站的 1 级切片（同 `state --orient` 的 `orient.stage`），`complete: true`。

**返工**：`--rework-to` 必须在本站 `rework_to` 内；写 `rework` receipt；台账里被打回的条目由 Agent 用 `supersedes` 承接。

**工作包机**：

| 形式 | 前置 | 写 |
| --- | --- | --- |
| `--dispatch` | 位置在 `apply`；包在 `ready`；`depends_on` 全部 ≥ `integrated`；包 `paths` ⊆ 作用域（`XF-ADVANCE-006`） | 铸执行 id；`package-dispatch` receipt；`package` 投影；信封 `result.draft` = 交付记录骨架，`result.package` = 计划里这个包的条目 |
| `--deliver` | 包在 `running`；交付记录存在且 `signer` = 该执行 id；交付记录的 `paths_changed` 与 `git diff --name-only <baseline_commit>`（限定 `workdir`）一致，不一致拒绝 `XF-ADVANCE-009`；`conclusion: succeeded` 时还要该包验证门当前且通过（`XF-ADVANCE-003`） | `package-deliver` receipt（`inputs` 记核对过的路径列表），`to` = `integrated`（succeeded）或交付记录的 `conclusion`（failed / blocked）；集成时关闭包投影；信封 `result.blockers` = 登记之后本站的出口判定 |

**归档**：位置 `ready-to-archive`；`inspect --hygiene` 干净（D9）；终局审批满足；两条基线的 delta 合并 + 索引重建 + `archive` receipt + 审计索引冻结，同一事务。

| 失败面 | 码 |
| --- | --- |
| 出口条件不满足 | `XF-ADVANCE-001`（`blockers` 逐项） |
| 返工目标不合法 | `XF-ADVANCE-002` |
| 门记录过期 | `XF-ADVANCE-003` |
| 包依赖未满足 | `XF-ADVANCE-004` |
| 交付记录署名不是该执行 id | `XF-ADVANCE-005` |
| 包路径超出作用域 | `XF-ADVANCE-006` |
| 无归属改动 | 不是诊断码：是出口条件的 blocker `unclaimed:<path>`，每条路径一个 |
| 归档前卫生检查红 | `XF-ADVANCE-008` |
| 交付记录的改动路径与工作树不符 | `XF-ADVANCE-009` |

`CLI-15` 一次成功的 `advance` 恰好新增一条 receipt（`stage-transition`）与两份投影变更（关一开一）；`--no-run` 时若门记录过期则拒绝并给 `XF-ADVANCE-003`。
`CLI-16` `advance` 的 `result` 与随后 `state --orient` 的 `orient.stage` 逐字节相同。
`CLI-17` 归档事务在合并中途失败时，基线、索引、receipt、审计索引都不变。

---

## 3. 转换表

### 3.1 Stage 机

| from | to | 写者 | 前置 |
| --- | --- | --- | --- |
| `<stage_i>` | `<stage_i+1>` | `advance` | 本站 `exit` 全满足 |
| `<stage_i>` | `<stage_j>`，j < i | `advance --rework-to` | `stage_j ∈ rework_to` |
| 最后一站 | `ready-to-archive` | `advance` | 同第一行 |
| `ready-to-archive` | `archived` | `advance --archive` | 终局审批、卫生检查、合并成功 |

### 3.2 工作包机

| from | to | 写者 | 前置 |
| --- | --- | --- | --- |
| `ready` | `running` | `advance package --dispatch` | 依赖满足、路径在作用域内 |
| `running` | `integrated` | `advance package --deliver`（`conclusion: succeeded`） | 交付记录合法、署名匹配、路径与工作树一致、验证门当前且过 |
| `running` | `failed` / `blocked` | `advance package --deliver` | 交付记录合法、署名匹配 |
| `failed` / `blocked` | `running` | `advance package --dispatch`（重新派工，新执行 id） | 同第一行 |

`succeeded` 与 `reviewed` 两格已取消（交付即集成），只出现在旧记录里；`review: required` 保留为给审批人看的信息。

`CLI-18` 转换表之外的任何 (from, to) 组合被拒绝 `XF-ADVANCE-001`，且不写任何文件。

---

## 4. 执法 `xforge-enforce`

```
xforge-enforce --host claude        # 读 stdin 载荷，写 stdout 决策；退出码恒 0（决策在输出里）
xforge-enforce --host codex
```

算法：

1. 按 `--host` 分派到宿主协议（`src/enforce/hosts/`，一个宿主一个文件）：解析宿主载荷 → `{tool, action ∈ read|write|edit|shell, paths[], command?, cwd}`。解析失败 → **deny**（`失败朝安全`）；`--host` 认不出 → **deny**，理由里点名那个宿主。
   - `claude`：`tool_name` + `tool_input.file_path`；`Write`→write，`Edit`/`MultiEdit`/`NotebookEdit`→edit，`Bash`→shell，其余读工具→read。
   - `codex`：同一个 `PreToolUse` 载荷里 `tool_name` 是 `Bash`（命令在 `tool_input.command`）或 `apply_patch`（**补丁正文**在 `tool_input.command`）—— `apply_patch` 的写入目标从正文的 `*** Add|Update|Delete File:` 与 `*** Move to:` 行里取，取不到任何一个 → 解析失败（一次看不见目标的写入不许悄悄过去）。两者都进下面同一套求值；`apply_patch` 归 `edit`。
   - 认不出的工具（MCP 工具、宿主将来新增的）归 `other`：策略只能选 `read|write|edit|shell` 四类，`other` 因此谁也选不中 —— 执法的边界就是这四类，别把它读成「什么都拦得住」。
2. 从 `cwd` 向上找治理根；找不到 → **allow**（不是 XForge 项目）。
3. 读清单 `selected.policies` 与每份策略文件；任一读不出 → **deny**，附 `XF-ENFORCE-003` 与出路（§4.1）。
4. 分发策略求值（规则文件设计 §3.3）；`deny` 则回。
5. 若 `action ∈ write|edit` 且路径在项目根之内、`xforge/` 之外（项目外的路径不归投影管）：收集 `changes/*/evidence/projections/*.yaml` 与 `changes/*/<scheme>/evidence/projections/*.yaml` 中 `closed_by == null` 且 `workdir` 等于 `cwd` 或是 `cwd` 的祖先的投影；有 → 路径必须匹配它们 `allow` 的交集，否则 **deny** `XF-ENFORCE-002`；无 → 不施加。
6. 输出宿主格式，**放行 = 什么都不说**（退出码 0 + 空 stdout = 这次调用照常走它自己的审批与沙箱）：claude 与 codex 的 `PreToolUse` 拒的形状相同，`{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "…"}}`。
   - **一个钩子的本分是拦与升级，不是放行**：claude 的 `permissionDecision: allow` 会跳过它自己的审批提示（用户的 deny / ask 规则照样生效，但默认会问一句的那些就不问了）—— 装上执法不该顺手把人的默认提醒关掉。所以两个宿主放行时都什么都不说。
   - **`ask` 是宿主能力，不是策略效果**：codex 的 `PreToolUse` 没有「问」这一步 —— 回 `permissionDecision: ask` 会被它记成钩子失败然后**继续执行**，等于静默放行。所以在那里 `ask` 降级成 `deny`，理由里写明这一步要人点头（`拦不住别假装拦得住`）。claude 有 `ask`，照原样回。

### 4.1 出路

治理不可读时仍放行的调用（`拒绝要留出路`）：`read` 动作；`shell` 命令且命令是 `xforge help|version|explain|state|show|inspect|init|sync` 之一（精确匹配首词与子命令；`inspect` 在列是因为 `XF-ENFORCE-003` 的出路就是它；不含 `run` `attest` `advance` `update`）。

`CLI-19` 执法进程的模块加载集合不含 `src/verbs` 等（迁移方案 `MG-03`）；在空载荷、坏 YAML、缺清单三种输入下都输出 deny。
`CLI-46` codex 载荷走同一套求值：`apply_patch` 正文里每个 `*** Add|Update|Delete File:` / `*** Move to:` 目标都当写入目标（受保护路径与在途投影都按它判），`Bash` 与 claude 同路；`--host` 认不出、`apply_patch` 正文里一个目标也取不到，两种都 deny。
`CLI-47` codex 上 `ask` 降级成 `deny`（理由里写明要人点头）；claude 上仍是 `ask`。
`CLI-49` 放行时两个宿主的 stdout 都是空的（退出码 0）：执法只否决或升级，不放行 —— 别把宿主自己的审批提示关掉。
`CLI-20` 冷启动到输出决策的时间在基准机上 < 80 ms（integration 层量，超出报警不阻塞；数字进 README）。
`CLI-21` 对同一载荷，执法输出是纯函数（没有时间戳、没有随机数）。

---

## 5. 装配

### 5.1 `init`

```
xforge init [--flow <name>] [--platform <name>]... [--language zh-CN|en]
```

从零建 `xforge/`：复制载荷到 `scaffold/`（含 `integrity.yaml`）、生成清单（治理开关默认关、默认流程 `solid`）、空章程模板、空基线索引。已初始化时幂等：只补缺失文件，不覆盖，不改清单。然后执行一次 `sync`。

清单已经存在时（重入）不问任何问题：没有要做的决定，提问只是噪音。

### 5.2 `sync`

```
xforge sync [--platform <name>]... [--depth auto|shallow|full]
```

把 `scaffold/` 的当前状态投影到宿主原生位置。深度自判：首次 → full；只有本地化区变了 → shallow（只重投影 Skill）；结构变了（流程 / 清单 `selected`）→ full。

| 宿主 | 投影 |
| --- | --- |
| `claude` | `.claude/skills/<skill>/SKILL.md`（按清单 `language` 选源）；`.claude/agents/xforge-executor.md`；`.claude/settings.json` 的 `hooks.PreToolUse` 加 `xforge-enforce --host claude`（标记块内） |
| `codex` | `.codex/skills/<skill>/SKILL.md`；`AGENTS.md` 标记块内的入口说明；`.codex/hooks.json` 的 `hooks.PreToolUse` 加 `xforge-enforce --host codex`（D15：装了还要人在 `/hooks` 里过一遍） |

生成物带头注释「由 xforge sync 生成，改 `xforge/scaffold/` 后重跑」；手改被下一次 sync 覆盖并在信封 `diagnostics` 里 `warning` 报出。

两份钩子落点的**共有文件**（`.claude/settings.json`、`.codex/hooks.json`）按同一个规矩办：能解析成 JSON 对象就在里面按命令串增删我们的钩子条目，**解析不了就一个字节都不动** —— 那是别人写的文件，覆盖它等于把里面的钩子删了。不动它，投影里就没有我们的钩子命令，`doctor` 的能力检查（§5.5 第 3 项）会说这件事。

`CLI-22` `sync` 两次连跑，第二次 `changed` 为空。
`CLI-23` 共有文件（`AGENTS.md`、`.claude/settings.json`、`.codex/hooks.json`）标记块之外的内容逐字节保留。
`CLI-48` 宿主共享钩子文件（`.claude/settings.json`、`.codex/hooks.json`）解析不了时，投影原样保留、一个字节不写；此时该宿主声明了执法钩子却没装上，`doctor` 报 `XF-DOCTOR-003`。

### 5.3 `update`

```
xforge update            # 暂存：快照 scaffold/ → .upgrade/snapshot/，铺开新版到 .upgrade/incoming/，逐文件分类
xforge update --status   # 在途状态与分类结果
xforge update --finish   # 推进 scaffold.version，写 scaffold.upgraded 事件（含 kept 列表），删 .upgrade/
xforge update --rollback # 从快照整树恢复，删 .upgrade/
```

`upgrade` 是 `update` 的旧名（`1.0.1` 已发布，改名不能把用户绊倒）：照跑，信封末尾多一条 `XF-ASSEMBLE-005` 的 deprecation 诊断。命令名只有 `update` 进帮助文本与诊断的 `remedy`。

分类：`unchanged`（校验和 = 旧完整性清单）→ 直接替换；`local-zone-only`（`RF-16`）→ 移植；`modified`（项目改过区域之外）→ 留在 `incoming/`，信封列出，人合并；`new` → 复制但不加进清单 `selected`。

`.upgrade/` 存在时，除 `update --*`、`state`、`show`、`inspect`、`doctor`（只读）、`help`、`version`、`explain` 之外的命令拒绝（`XF-ASSEMBLE-001`），哨兵可见。
没有可升级的版本是 `XF-ASSEMBLE-002`；没有在途升级却 `--finish` / `--rollback` 是 `XF-ASSEMBLE-003`。`--payload <dir>` 与 `--to <version>` 可指定新版载荷与目标版本（离线升级与测试用）。
新版里没有、项目里还有的文件分类为 `orphan`，留着不动，由人决定。`--finish` 的审计事件记 `kept`：留给人的文件里最终没有采用新版正文的那些。

`CLI-24` 对一个填了本地化区的 Skill 文件升级：新版正文 + 旧本地化区，逐字节可预测；对改了正文的文件：留 `incoming/`，不覆盖。

### 5.4 探测与交互选择

`init` 要建清单，清单里有两个值只能由人来定：装到哪些宿主、Skill 用哪种语言。它们的来源按「有没有人坐在终端前」分岔：

| 情形 | 值从哪来 |
| --- | --- |
| `stdin` 与 `stderr` 都是 TTY，且没有 `CI` 环境变量 | 交互：探测本机装了哪些宿主，列出来让人勾 |
| 其余（管道、CI、Agent 调用） | 不询问也不探测：用 flag，没有 flag 就用文档默认值（`claude` / `zh-CN`） |
| 给了 `--platform` 与 `--language` | 不问：flag 是先把答案说出来的路 |

**探测是线索，不是判决。** 三路证据，从强到弱：会话环境变量（在谁的会话里跑，谁就确定在场）、用户级配置目录（`~/.claude`、`~/.codex`）、`PATH` 上的可执行文件。探测结果**只用来画那张列表**，不参与任何决策 —— 非交互路径不因本机装了什么而改变结果，同一份 CI 配置在哪台机器上都得到同一份清单。

列表（先是宿主，多选；再是语言，单选）。八十列上长这样 —— 备注一行装得下就同行，装不下就缩进到下一行，不切半句：

```
? Select the hosts to install into   (↑/↓ move · space toggle · enter confirm)
❯ [✓] Claude Code    found: claude on PATH
      Skills, an isolated executor, and the enforcement hook.
  [ ] Codex CLI      not detected
      Skills, an AGENTS.md entry point and the enforcement hook; no isolated executor here.
```

- 探测不到的项**灰掉且不可勾选**（`ESC[2m`；`NO_COLOR` 下退化成纯文本），光标也停不上去。
- 备注跟在标签后面：一句话说清这个宿主投影什么、不投影什么（`HostProvider.note`）。
- **一个宿主都没勾，回车不往下走**：`At least one tool must be selected.` 一个都没探测到时理由换成 `Nothing detected. Install one, or pass --platform <name> to choose anyway.` —— 出路写在提示里，因为这是同一个死胡同。
- 语言一项必答，光标停在清单当前值上。
- 安装器自己的话一律**英文**：它出现在语言选择之前，没有可依据的语言。
- 列表画在 **`stderr`**：`stdout` 只有一个东西 —— 信封。
- `Ctrl-C` / `Esc` 取消，`XF-ASSEMBLE-006`，退出码 1；取消是人的决定，不是错误。

`CLI-36` 交互答完后写进清单的 `platforms` / `language` 与用 flag 给出时逐字节相同 —— 交互只改「值从哪来」，不改值本身。
`CLI-37` 全程不往 `stdout` 写一个字节（`xforge init > out.json` 拿到的仍是干净信封）。
`CLI-38` `NO_COLOR` 下重绘不出现任何转义序列（除了光标移动）。

### 5.5 `doctor`

```
xforge doctor [--platform <name>]...
```

读：清单、脚手架的每份文件、宿主投影位置、本机（探测，同 §5.4）。写：无。不执行任何项目命令。
`--platform` 限定查哪些宿主，缺省是清单里的那些；给了清单外的名字是用法错误（退出码 2）。

**doctor 看「装的事」，`inspect` 看「记的事」。** 投影对不对得上、宿主在不在、骨架是不是被人改过 —— 补救是重装；receipt 链断没断、台账署没署名 —— 补救是改记录。退出码因此不同：doctor 的失败是 `blocking`（`ok: false`，退出码 1），记录坏了是 `XF-INSPECT-*`（退出码 3）。doctor 不替 `inspect` 跑一遍，只在 `next` 里指过去。

装配坏了不是「也许」，是「不行」：清单说有执法钩子却跑不起来，就该让调用方停下来办这件事 —— 所以这些说法按 `blocking` 报，不是 `warning`（`warning` 的语义是「能走，但你知道一下」）。

| # | 检查 | 码 | 为什么值得查 |
| --- | --- | --- | --- |
| 1 | 宿主在场：清单 `platforms` 里的每个宿主，本机探测得到 | `XF-DOCTOR-001` | 选中了一台本机没有的宿主，投影写得再对也没人读 |
| 2 | 投影新鲜：`sync` 会写的每份文件与盘上逐字节一致 | `XF-DOCTOR-002` | 手改过投影，或上次 `sync` 之后脚手架变了 |
| 3 | 能力兑现：声明了执法钩子的宿主，钩子真装进了宿主共享文件（投影里有那条命令），且钩子命令的第一个词能在本机解析到 | `XF-DOCTOR-003` | 「`enforcement: available`」不能是句空话（D8）：装不上与跑不起来同样是句空话 |
| 4 | 骨架完整：`scaffold/integrity.yaml` 里的文件都在、本地化区之外没被改过；载荷该有的钩子文件在；清单语言对应的 Skill 源文件在 | `XF-DOCTOR-004` | 载荷缺 `SKILL_cn.md` 时 `sync` 会**静默**不投影那个 Skill（`loadSkills` 跳过读不出的） |
| 5 | 残留：`.upgrade/` 还在；宿主投影目录里 xforge 前缀的、当前没人认领的文件 | `XF-DOCTOR-005` | 一次没走完的升级，或 Skill 下线后留在宿主里的孤儿 |
| 6 | 版本：清单 `scaffold.version` 与本次载荷版本 | `XF-DOCTOR-006`（`info`） | 只提示，不改退出码 —— 项目可以刻意停在旧脚手架 |

探测只有一处实现（§5.4）：`init` 拿它画列表，`doctor` 拿它做体检 —— 同一个问题只有一个答案。与 `init` 不同的是，`doctor` **不问有没有 TTY**：它本来就是人来叫的，探测是它的正事，不进清单、不改结果。

`result`：

```json
{"results": [
  {"id": "host", "status": "ok"},
  {"id": "projection", "status": "fail", "detail": ".claude/settings.json 与 sync 会写的不一致"},
  {"id": "version", "status": "info", "detail": "脚手架 1.0.0，本次载荷 1.0.1"}
],
 "problems": 1}
```

每项要么 `ok`，要么带上 `status` 与 `detail`；`problems` 是 `fail` 的项数。有一项 `fail` → `ok: false`、退出码 1；只有 `info` 或全 `ok` → `ok: true`、退出码 0。

`next` 只指真能修的那一步：投影漂移与残留给 `xforge sync`，骨架与版本给 `xforge update`。宿主不在、钩子跑不起来是这台机器的事，没有命令可给 —— 那就什么都不指，别拿 `inspect` 凑数。

`doctor` 只读，所以**升级在途时照跑**（§5.3 的哨兵名单里有它）：「现在什么状态」正是它要回答的问题。

`CLI-39` 刚 `init` 完、没人动过的树：六项全 `ok`，`changed` 为空，退出码 0。
`CLI-40` 手改一个投影文件（往 `.claude/skills/xforge/SKILL.md` 里加一个字）→ `XF-DOCTOR-002`，退出码 1；`sync` 之后这一项回 `ok`。
`CLI-41` `doctor` 的 `changed` 恒为空，且跑完之后项目里每个文件的 mtime 与内容都不变（快照比对）。

### 5.6 `repair`

```
xforge repair [--platform <name>]...
```

读：同 `doctor`（清单、脚手架、投影位置、本机）。写：只写两样 —— 宿主投影、脚手架里**缺失**的受管文件。

`doctor` 说，`repair` 做：同一张检查表、同一次探测、同一份投影算法。`repair` 不另算一遍 —— 两处实现迟早会各说各话。

**只修「重写一遍就对」的事，其余原样报出来。**

| # | 检查项 | 修不修 | 怎么修 / 为什么不动它 |
| --- | --- | --- | --- |
| 1 | 宿主不在场 | 不修 | 装宿主不是 xforge 的事 |
| 2 | 投影漂移 | **修** | 按当前脚手架重投影（与 `sync` 同一份实现） |
| 3 | 能力兑不了现 | 不修 | `PATH` 是环境与安装方式的事，要人来改 |
| 4 | 骨架不完整 | **只补缺的** | 从载荷补回缺失的受管文件（校验和对得上才补）；**改过的一个字不动** —— 那是有人写过的正文，覆盖它得先问人（`update` 会把它分到 `incoming/` 让人合并） |
| 5 | 残留 | 不修 | 在途升级要选收尾还是回退；孤儿文件删不删是人的决定 |
| 6 | 版本落后 | 不修 | 那是 `update` 的事，而且它不是「坏」 |

补骨架与重投影在**同一个事务**里，要么都成要么都不动。顺序是依赖定的：投影从脚手架算出来，所以先补骨架 —— 补回去的 Skill 与钩子在同一轮里就能投出去。

可修的项**无条件跑一遍**，不是「哪项报错才修哪项」：重投影是「投影 = 脚手架的函数」的重算，本来就不该只在出错时发生。少了这一遍，一个刚补回来的 Skill 要等到下一次 `sync` 才投影出去 —— 而 `repair` 刚说过它修好了。

`repair` 不接 `--payload`：载荷就是这支 CLI 自带的 `scaffold/`。补一份别处的载荷是「升级」，不是「修复」。

**修完重跑一遍检查**，不看结果不算修好 —— 一次没落盘的修复比不修更坏，调用方会以为好了。重跑是**重算现场再查**，不是拿修之前算好的那份投影重比：修之前的投影里没有刚补回来的那个 Skill，拿它当判据，孤儿检查会把刚投出去的 Skill 目录说成没人认领。

`result` 与 `doctor` 同一个形状（同一个 `results`，同一个 `problems`），多一个 `repaired`（从「有问题」变成「没问题」的项）与一个 `unfixable`（**没解决的**：修不了的与修了没成的，每项一句为什么）：

```json
{"repaired": ["projection"],
 "unfixable": [{"id": "host", "why": "装宿主不是 xforge 的事"}],
 "results": [{"id": "host", "status": "fail", "detail": "宿主 claude 本机探测不到（清单里选中了它）"},
             {"id": "projection", "status": "ok"}],
 "problems": 1}
```

修不了的项**沿用 `XF-DOCTOR-*` 的码**：同一个发现，换个命令报出来不该换个名字，补救也还是同一条。`XF-REPAIR-*` 只留给「修的时候才可能出的事」：载荷里没有可信的副本（`XF-REPAIR-001`）、修完之后还是不一致（`XF-REPAIR-002`）。

还剩 `fail` → `ok: false`、退出码 1；全修好 → 退出码 0。修不了不等于失败：把话说清楚，`repair` 就完成了它的活。

`repair` 写盘，所以升级在途时被哨兵拦住（`XF-ASSEMBLE-001`）—— 与只读的 `doctor` 相反。

`CLI-42` 手改一个投影文件后 `repair`：退出码 0，`repaired` 为 `["projection"]`，`changed` 列出那个文件，内容回到与 `sync` 逐字节相同。
`CLI-43` 删掉一个受管文件（`scaffold/gates/ledgers.yaml`）后 `repair`：文件按载荷补回，校验和与完整性清单一致，退出码 0。
`CLI-44` 在本地化区之外改过一个受管文件后 `repair`：那个文件**逐字节不变**，`XF-DOCTOR-004` 原样报出，退出码 1 —— 补缺不覆盖。
`CLI-45` 清单里选中、本机却没有的宿主：`repair` 退出码 1，`repaired` 为空，`unfixable` 说出为什么（装宿主不是 xforge 的事），没有人被假装的修复骗到。

---

## 6. 元信息

- `help [command]`：静态文本。
- `version`：CLI 版本、协议版本；在项目里时附清单的脚手架版本。
- `explain <code>`：读 `diagnostics/<code>.yaml`，回 meaning、remedy、variants。不需要项目目录。
- `payloadDir()`：本 CLI 自带的载荷目录（包根下的 `scaffold/`）—— 版本从 `package.json` 来，载荷从它旁边来。`init` / `update` / `repair` 都从这一处取，`update --payload` 是它唯一的覆盖口。

`CLI-25` `explain` 在非项目目录里可用；对每一个字典文件都能回。

---

## 7. 走查

调用只计命令行；「写」是 Agent 或人的动作，不计。

### 7.1 quick（规格关、接口关、默认方案、一个包）

| 站 | 调用 | 写下 | 人的介入 |
| --- | --- | --- | --- |
| `propose` | `state --orient` | `change.yaml` `proposal.md` `scope.yaml` `work-packages.yaml`（quick 的 propose 站产出后两份；规格 delta `not-owed`） | 与人来回（不隔离） |
| | `advance`（跑 `structure`；出站；回下一站 `apply` 的切片） | R-0001、apply 站投影 | |
| `apply` | `advance package P-01 --dispatch` | R-0002、投影 EX-1、交付骨架在信封里 | |
| | 执行者写代码、`ledgers/deliveries/P-01.yaml` | | |
| | `run --package P-01` | 门 `unit-tests` 运行 1 | |
| | `advance package P-01 --deliver` | R-0003（`running → integrated`，关闭 EX-1 投影） | |
| | `advance` | R-0004（`apply → verify`） | |
| `verify` | `state`（0b） | `ledgers/verification-receipt.yaml` | |
| | `attest receipt` | 事件 2 | 签署收据 |
| | `advance`（跑 `structure` `ledgers` `unit-tests`；`assurance.md` 因保证层关而 `not-owed`） | R-0006（→ `ready-to-archive`） | |
| 终局 | `attest approve --archive --decision approved` | 事件 3 | 终局审批 |
| | `advance --archive`（`inspect --hygiene`；无 delta 可合并；索引不变） | R-0007、审计索引冻结 | |

命令行调用 12 次，人的介入 3 次（介入点五处里的三处）。

### 7.2 solid（规格开、接口开、一个包需评审）

| 站 | 调用 | 备注 |
| --- | --- | --- |
| `propose` | `state --orient` · `advance` | 写声明、提案、规格 delta、接口 delta（两份都欠） |
| `design` | `state --orient` · `advance` | 写 `scope.yaml` `design.md`（混装，替代方案 ≥1）`work-packages.yaml`；门 `structure` `constitution`（`constitution` 门此站只验章程可读；答复台账在 check 站） |
| `check` | `state --orient` · `attest finding F-001`… · `attest approve --stage check` · `advance` | 写 `review-findings` `constitution-reply`；发现由人答复；站级审批 |
| `apply` | 同 quick | `review: required` 只是给终局审批人看的信息 |
| `verify` | `state` · `attest receipt` · `advance` | 写 `assurance.md`（欠）、收据；门含 `spec-delta` `interface-delta` |
| 终局 | `attest approve --archive` · `advance --archive` | 合并两份 delta，重建两条索引 |

### 7.3 major

在 solid 之上多 `clarify` 站：`state --orient` → 写 `ledgers/exit/material-questions.yaml`（澄清没有散文产出）→ 每条问题由人 `attest entry exit/material-questions Q-001`… → `advance`（门 `ledgers` 受理；出口条件 `attested`）。终局审批 `separation_of_duties: true`。

`CLI-26` 三条走查各有一个 integration 测试逐行复现：每一步的调用、退出码、`changed` 列表精确断言。
`CLI-27` quick 走查里 `inspect` 只被 `advance --archive` 内部调用一次。

---

## 8. 追溯

| 不变量 / 规则 | 兑现处 |
| --- | --- |
| `写权限二分` | `CLI-10`；`attest` 只写审计，台账由人 / Agent 写 |
| `署名可引用不可编造` | `RF-26` 的调用方 §2.4；`CLI-13` |
| `有门能判的不走证` | §2.3 受理；`CLI-09` |
| `一次调用一个进程` | §1.2 |
| `写必须能回退` | §1.2 事务；`CLI-04` `CLI-11` `CLI-17` |
| `失败朝安全` | §4 第 1、3 步；`CLI-19` |
| `拒绝要留出路` | §4.1 |
| `receipt 成链` | §2.5 步骤 3；`CLI-15` |
| `捎带合调用不合记录` | §2.4 `delivery` 行、§2.5 步骤 1；`CLI-14` |
| `写入范围只有策略执法` | §4 第 5 步；§2.5 投影的开与关 |
| `归档唯一例外` | §2.5 归档、§3.1 最后一行 |
| `重算的不能作判据` | §1.3 位置从链推导；§2.5 投影只在派工 / 进站时写 |
| `第0级有界` `不变量段确定性` | `CLI-05` `CLI-06` |
| `上下文成本一等约束` | §1.1 `--field`、§2.3 `tail`、`CLI-12` `CLI-20` |
| 裁剪八条 | `state`→`名字不单飞`（每个 id 带 title/path）；`show`→`切片自称完整` + `省略自报`；`inspect`→`出错给出路`；`run`→`大块给指针`；`attest`→`正常就说正常`；`advance`→`切片自称完整`（`complete: true`） |
| `能让控制面操作的就别开文件` | §2.1a `show` 覆盖脚手架文档《能让控制面操作的，就不要让 Agent 开文件》那张表的每一行 |
