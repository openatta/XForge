# XForge 子 Agent 设计

> 并行开发的协作协议：Main Agent 如何拆分与调度工作、子 Agent 如何交付、
> XForge 如何验证边界与证据。
>
> 对应实现：`@xforge/cli 0.7.21`，Protocol 2 工作包、dispatch binding、
> 交付校验与 Workflow Audit 均已实现。

---

## 1. 设计结论

XForge 的子 Agent 系统是一个**项目级、Git 原生、可验证的协作协议**，
而不是通用多 Agent 运行时。

**XForge 不创建模型进程。** 具体的进程创建、模型调用与执行沙箱仍由目标 AI 工具提供。
XForge 规定的是：什么样的拆分是合法的、边界在哪、以及交付要拿出什么证据。

只定义三种子 Agent：

| Agent | 职责 | tools.allow | 并发 | 模型 |
| --- | --- | --- | --- | --- |
| `worker` | 执行一个封闭的写入型工作包 | read, search, **write**, test | 3 | default |
| `integrator` | 单实例完成提交集成与共享文件修改 | read, search, **write**, test | 1 | reasoning |
| `reviewer` | 独立、**只读**地审查最终结果 | read, search, test | 1 | reasoning |

**Main Agent 自身承担 Coordinator 职责，不创建 `coordinator` 子 Agent，
也不把协调职责再次委派出去。Worker 不继续委派。**

测试与探索是**工作方式**而不是长期 Agent 类型：写测试由 Worker 加载相应 Skill 完成，
集成测试由 Integrator 运行。**调查代码与 Specs 不需要任何 Skill**——
阅读与检索是每个被投影目标的原生能力。

### 1.1 非目标

- 不实现通用调度服务、模型路由服务或常驻 Agent 运行时；
- 不保证不同 AI 工具具有等价的权限、委派与沙箱语义；
- **不用 Prompt 代替路径检查、测试、门禁与审批**；
- 不引入第二套 Specification / Plan / Tasks 事实源；
- **不使用 worktree 伪装对数据库、端口、缓存或外部服务的完全隔离。**

---

## 2. 逻辑结构

```text
Main Agent / Coordinator
│
├── Worker A ── worktree A ── commit A
├── Worker B ── worktree B ── commit B
├── Worker C ── worktree C ── commit C
│
├── Integrator ── integration worktree ── integrated commit
│
└── Reviewer ── review worktree ── 结论（文本，不写文件）

XForge 控制面
├── State revision / PermissionPolicy snapshot
├── 工作包校验 / Gate Runner
├── Transition Guard / Approval receipts
└── Workflow Audit / Evidence freshness
```

Main Agent 读取 XForge 状态、生成工作包 DAG、检查依赖与路径冲突、准备 worktree、
调度 ready 节点、验证 Worker 交付，并决定是否启动 Integrator 与 Reviewer。

**Main Agent 可以选择 ready Action、创建运行环境、请求 Transition，
但不能代表 CLI 把 Stage 标记完成，也不能代表人类或外部系统签发 Approval。**

---

## 3. 第一个决定：要不要工作包

Apply 的第一步不是拆包，是判断**直接串行 vs 持久工作包**：

| 形态 | 适用 | 代价 |
| --- | --- | --- |
| **短计划**（Main Agent 内部） | 单一小任务 | 没有 dispatch receipt、没有 delivery 记录，**worktree 写入边界从 CLI 强制降为口头约束** |
| **`work-packages.yaml`** | 复杂、长时、需恢复、多 Agent | 需要完整的三段协议 |

> **这件事不由 Flow 决定。** 按代码里真实的依赖图判断。
> `stages[].execution` 虽然在 schema 里，但 CLI 中没有任何一处读取它。

**在 major 下选短计划还有一个额外后果：** `independentReview` 条件将没有工作包可挂靠，
必须走 Change 级复核形态（见 §7.2）。`xforge check` 会在这个选择尚未落定时就把它说出来。

---

## 4. 工作包协议

### 4.1 静态字段

```yaml
apiVersion: xforge.dev/v1alpha1
kind: WorkPackagePlan
integrator_paths:                    # 装配面，可选
  - src/contracts/**
  - src/app/module-registry.ts
packages:
  - id: store-layer
    role: worker                     # worker（默认）| integrator
    goal: <一句话目标>
    depends_on: []
    inputs: [...]                    # 具体路径，不含通配符
    write_paths: [src/store/**]
    skills: [...]
    verify: [["cargo","test","-p","store"]]
    done_when: ["...", "..."]
```

**八个静态字段加一个 `role`。** 调度时另附 `change_id`、`execution_id`、`base_commit`、
dependency commits、branch、worktree 与 delivery mode——**这些不写回静态计划**。

### 4.2 `integrator_paths` 与 `role: integrator` 是配对的

`integrator_paths` 声明装配面：共享契约、模块清单、DI 根、配置装配点、迁移、
生成物与 lock 文件——**把各个包连接起来、因而不属于任何一个包的东西**。

> **一组路径不是一个节点。**
> 只声明 `integrator_paths` 而没有 integrator 包时，每个 worker 包都 `succeeded`，
> 控制面就报告 Apply 转换 ready——**而实际上什么都还没被装起来**，
> 而且每个 Gate 都同意，因为计划里没有任何东西声称还欠一次装配。
> **integrator 包就是那个声称。**

一旦声明了 `integrator_paths`，计划就必须同时带一个 `role: integrator` 包：
它依赖它所装配的那些包，`write_paths` 落在 `integrator_paths` 之内。
**任何 worker 包都不得声明其中的路径。**

没有 `integrator_paths` 时，集成过程中创建的文件不归属于任何人，
会让计划里**每一份** delivery 失效，唯一的绕法是把它记在一个并没有产生它的包名下。

### 4.3 `verify` 必须是 argv 数组

```yaml
verify: [["npm","test"], ["npx","eslint","src"]]     # ✅
verify: ["npm test && npx eslint src"]               # ❌ 直接拒绝
```

XForge 直接以 `argv[0]` 启动进程、其余项作为字面参数，**从不经过 shell**：
无法使用管道、重定向、串联或替换。

> 单字符串形式已废弃：不含 shell 元字符时兼容一个版本，含元字符时**直接拒绝**。
> 理由是——一个能到达 `sh -c` 的字符串，等于让 work-package plan
> （一个 Change 自己拥有、而 lockfile 覆盖不到的文件）组装任意命令。
> 确实需要 shell 的逻辑，写成 `write_paths` 内的脚本再调用。

**Worker 不得替换成等价命令。** 某条 `verify` 无法照原样运行时，
以 `blocked` 停止并说明原因。

### 4.4 让每条路径只有一个明确写者

收窄会吞掉其他包路径的父级 glob。**`write_paths` 边界最终由 CLI 对真实 diff 事后判定**
——Worker 不会因为没被隔离就逃出边界。

---

## 5. 三段协议

```text
① dispatch    xforge work-package dispatch --change <id> --package <pkg>
              ├─ 只允许 Apply Stage 的 ready 节点
              ├─ 整份计划校验无 error 才原子写入
              ├─ receipt 固定：executionId / stateRevision / policySnapshotDigest
              │                / gitBase / gitHead / auditCorrelationId
              └─ 同时写一条 work-package.dispatched 审计事件

② delivery    先跑 xforge work-package draft --change <id> --package <pkg>
              ├─ 回填机器已知的一半：execution id、两个 commit、changed_paths、
              │  每条声明的 verify 命令 + CLI 实际跑出的退出码
              ├─ 你只补：status、issues、每条 done_when_evidence 下的 evidence
              └─ 写入 <change>/evidence/agents/<pkg>/<execution>.yaml

③ acknowledge xforge work-package acknowledge ... --as integrator|reviewer --evidence <path>
              └─ ack receipt 绑定 deliveryDigest，无法被重放到另一份 delivery 上
```

### 5.1 派发前检查

在创建任何 worktree **之前**，让 CLI 校验：ID / DAG、`inputs`、`skills`、Change scope、
保护路径、依赖 commits、`verify` 命令、ready 集合。

### 5.2 CLI 对 delivery 的复核项

| 检查 | 内容 |
| --- | --- |
| dispatch binding | `state_revision` / `policy_snapshot_digest` / `audit_correlation_id` 必须回带且一致 |
| commit ancestry | head 必须由 base 可达 |
| **实际 diff** | `base...head` 的真实改动 |
| `write_paths` 边界 | 真实 diff 必须落在声明范围内 |
| verify 命令 | **逐条、按序、完全一致**；退出码为零 |
| `done_when` | 每条被 `done_when_evidence` **精确一次**映射到非空证据 |

### 5.3 `done_when_evidence` 的前缀匹配

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
>
> 另一个方向的陷阱：一份每条都填了引用的映射**看起来像**证据，
> 但引用本身可能和它要证明的结论无关——比如一条日志只证明某个函数执行过，
> 不证明它产出了正确结果。**接受之前要看引用实际展示了什么，不能只看是不是都填了。**

---

## 6. DAG 与状态

### 6.1 包状态机

```text
blocked ──依赖满足──► ready ──dispatch──► running ──delivery──► succeeded
                                                                   │
                                     acknowledge --as integrator ──► integrated
                                     acknowledge --as reviewer  ──► reviewed
```

`state.change.workPackages` 还报告：`ready[]`、`waves[]`（按层分组）、
`parallelCandidates[]`、`protectedWritePaths[]`、`unattributedPaths[]`，
以及每个包的 `acknowledgements: { reviewedBy, integratedBy }`。

### 6.2 `tree:unattributed-paths`

> ⚠️ **这不是任何工作包的问题**，无论同时还有什么被阻塞。

它说的是：树里有**已提交的**改动，既不属于任何 `write_paths`，也不被 `integrator_paths` 覆盖。
这是**树的属性和计划声明的属性**，不是某个包的属性——所以它挂在 plan 上而不是包上。

> 不要去审查那些 delivery——它们可以每一份都完全正确而这一条依然阻塞。
> **要改的是计划的声明**，改完再重新记录受影响的 delivery。

### 6.3 并行的两条判断边界

**① `write_paths` 不相交是必要条件，不是充分条件。**

两个工作包的 `write_paths` 可以完全不重叠，却仍然争用同一个端口、数据库、缓存 key，
或某个 `write_paths` 里根本没写出来的生成物 / lock 文件。
**派工前要核实的是实际资源隔离，不是 glob 不相交；模块数或路径数一致，不代表两者互相独立。**

**② 粒度两个方向都有失败模式。**

- 拆得太细 → 协调与 Integrator 开销上升，放大出现未声明共享写入的概率
- 拆得太粗 → 掩盖包内部真正的依赖关系，压掉本可并行的空间

**粒度应该按代码里真实的依赖图来定，不是把任务列表平均分成几份。**

---

## 7. 三个角色的职责

### 7.1 Worker

**边界**

- 只能修改分配 worktree 中匹配 `write_paths` 的文件；
- 不得写工作包计划、Evidence、Constitution、主 Specs、approvals、Archive，
  以及共享契约 / 迁移 / 生成物 / lock 等 Integrator 独占路径；
- **不得继续委派**；
- 即使宿主 runtime 无法原生强制，也必须遵守生效的 PermissionPolicy；
- **绝不转换 Stage、签发 Approval 或手写 Gate / Audit Evidence。**

**流程**

1. 按 dispatch receipt 确认 Change ID、execution ID、base commit、branch、worktree、
   State revision、policy snapshot digest、audit correlation ID；
2. 实现前读取所有 `inputs` 文件并加载全部声明的 `skills`；
3. 实现满足 `goal` 和所有 `done_when` 的**最小**变更，并在 `write_paths` 内加确定性测试；
4. 从分配 worktree 根目录**严格按声明、按顺序**运行全部 `verify`；
5. 原生模式下提交，返回固定 delivery contract。

**停止条件**：inputs 缺失或冲突、依赖漂移、写边界不足、必须修改共享文件、
材料性歧义、秘密信息、未批准迁移 → `blocked`；实现或验证失败 → `failed`。

> **绝不只凭自然语言报告 `succeeded`。**

### 7.2 Integrator

**什么时候启动**：有多个 commits、共享契约、迁移、生成物 / lock 文件，
或需要集中集成验证时——**最多一个**。

**边界**

- 是声明的共享路径的**唯一写入者**；
- 不得静默重写已完成的 Worker 模块；
- **不得用冲突解决掩盖规格、契约或路径规划错误**——
  发现未声明的 Worker diff 重叠时，那是**规划失败**：停止并返回 Main Agent 重新规划；
- 绝不批准例外、转换 Stage 或手写 Evidence。

**它的 `role: integrator` 包与 worker 包一样派工、一样交付**——
装配同样要有 delivery、真实 diff 和通过的 `verify`。

保存集成证据后运行 `xforge work-package acknowledge ... --as integrator --evidence <path>`。

### 7.3 Reviewer

**Reviewer 没有 `write` 授权，这是刻意的。**

设计取舍在 `reviewer.yaml` 的注释里写得很清楚：

> `tools.allow` 是**能力级**的，不是按路径限定的——没有办法说
> 「可以写，但只能写 `evidence/agents/<package>/` 下面」。
> 一个 write 授权会让 Reviewer 有能力碰它正在审查的那份实现，
> 而那正是让它的结论值钱的唯一属性。

所以：**Reviewer 只读，由 Main Agent 逐字转录它的结论。**

```text
按包形态：  <change>/evidence/agents/<package>/review-<execution>.yaml
            → xforge work-package acknowledge --as reviewer --evidence <该路径>

Change 级： <change>/evidence/review/<name>.md      ← 必须在这个目录下才能随 Change 归档
            → xforge review acknowledge --change <id> --evidence <该路径>
            （没有 --by，actor 取自环境）
```

> **这里有一个必须说明的取舍：写下这份记录的，正是被审查的一方。**
> 让它保持诚实的不是「不可能被改动」，而是——这份转录是**提交到 Git 并被审计链覆盖的**，
> 被改写或概括之后可以事后归因。
>
> 需要 Reviewer 的记录对实现者不可触碰的项目，需要一个 write-capable 的 review Agent
> 加一条限定到其证据目录的 PermissionPolicy——那是一次**有意的本地改动**，不是随包默认。

**Reviewer 返回什么，被记录的就是什么。** 不要因为「别人会补全」而概括自己的发现。
返回 `pass` 或 `changes-required`；每项 finding 必须包含 severity、
可操作的文件或 Requirement 位置、原因和建议修复；没有实质问题时明确说明。

**Reviewer 的 `pass` 只是 assurance，不是 Machine Gate Evidence、Approval receipt
或 transition / archive 权限。**

---

## 8. `independentReview`：major 的强制复核

major 在 Verify 出口声明 `independentReview: complete`。

**它存在的理由是一次真实的失败**：major 声明了三处语义审查、也随包发了 reviewer 子 Agent，
但**从来没有任何东西真正要求过一次复核**——`succeeded` 本身就满足了控制面。
一次实测的 Major 运行（risk / security / privacy / publicApi 全为真）
在零 Reviewer 确认的情况下完成了，一个执行者审查了设计、实现和它自己的 check report。
它自己抓到了自己的错误——**而那恰恰是问题所在**：那个结果依赖执行者的自觉，
而不依赖 Flow 保证的任何东西。

### 8.1 两种判定形态

| 形态 | 判定 | 失败 reason |
| --- | --- | --- |
| **有 work-package plan** | 每个 succeeded / integrated / reviewed 的包都必须有 `acknowledgements.reviewedBy` | `unreviewed-<pkg>[+<pkg>…]` |
| **无 plan（短计划）** | 读 `evidence/review/` 下的 ack receipt | 没有 → `review-missing`；不覆盖当前 `contentRevision` → `review-stale` |

无 plan 的形态**原本是直接豁免的**，理由是「它的语义审查由 Check Stage 承担」。
这个理由站不住：**Check 跑在实现之前，它审查的是设计**，交付的代码没有任何人审查过。
而短计划正是 `xforge-apply` 明确允许的形态——于是它成了唯一什么都不要求的形态。

### 8.2 它强制什么、不强制什么

> **强制的是「有复核、且可归属」，不是「复核者真的独立」。**

receipt 上写着一个 actor，而**一次会话可以填任何 actor**——
所以拒绝「reviewer 等于 integrator」等于强制一个 CLI 观察不到的属性。
两个名字（`reviewedBy` / `integratedBy`）都报告在 State 里，让签字的人自己看。

### 8.3 与审批的分工

| | 回答的问题 |
| --- | --- |
| `independentReview` | **有没有被评审、被谁评审** |
| `implementation-major` / `closing-major` | **谁授权它继续** |

这也是 major 的审批策略是 `minApprovers: 1` 而不是 2 的理由之一：
把 `minApprovers` 调回 2 是在重复第一个问题，而不是加强第二个。
真正在这两条策略上承重的是 `separationOfDuties: true`——审批人不是 implementer。

---

## 9. Adapter 降级

**并行只在下列条件全部满足时才真正激活：**

1. 至少两个节点依赖已满足；
2. `write_paths` 不相交；
3. 数据库 / 端口 / 缓存 / 账号 / 生成物等共享资源**可隔离**；
4. Adapter 的 Agent 投影与 runtime 的子 Agent 执行**都报告为 `native`**。

> ⚠️ **`agents: native` 与 `subagent: native` 说明的是**
> 「XForge 已把 Agent 定义写出去」和「该目标存在子 Agent 机制」，
> **不等于**你的 runtime 会把 `worker` / `integrator` / `reviewer` 列为可选类型。
>
> 要查 runtime 自己的列表；若没有，就把投影出来的契约**逐字带进 prompt**，
> 并在报告中写明**边界是由 prompt 传递的**。

Adapter 为 `degraded` 或 `unsupported` 时，Main Agent **顺序执行**工作包，
或按声明的 degraded patch 流程交付，并**明确报告未获得并行 / worktree 隔离**——
**不得声称已激活子 Agent。**

无论哪种情况，`write_paths` 边界最终都由 CLI 对真实 diff 事后判定。

---

## 10. 与 Flow 和 Skill 的关系

- **工作包是 Apply 的即时执行资产，不是新 Stage，也不是第二份规格事实源。**
- Main Agent 全程以 `state.change.governance.currentStage`、当前 `stateRevision`、
  `policySnapshotDigest` 与 typed `nextActions` 为准；
  **不得直接改 Stage、Transition / Approval receipt 或核心 Audit。**
- 现实推翻 Proposal / Specs / Design 时，**不得静默改写治理事实**——
  返回 Action 指定的 rework Stage，经由 `xforge-revise` 一致地修订。
- 所有实现完成后运行 `xforge check --change <id>`，
  请求 `xforge transition --change <id> --to verify`，再交给 `xforge-verify`。

---

## 11. 速查

**四个「Worker 绝不做」**

- 不转换 Stage
- 不签发 Approval
- 不手写 Gate / Audit Evidence
- 不继续委派

**三个「不是证据」**

- Worker 的自然语言报告
- checkbox
- 自报退出码

**两个「必须逐字」**

- Reviewer 的结论转录
- `verify` 命令在 delivery 里的记录（逐条、按序、完全一致）

**一个最常见的误判**

> `write_paths` 不相交 ≠ 可以并行。要核实的是**实际资源隔离**。
