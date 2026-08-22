[English](extending-gates-rules-policies-hooks-approvals.md) | 简体中文

# 扩展 Gate、Rule、PermissionPolicy、Hook 与 Approval

本指南面向要给某个使用 XForge 的项目添加自定义 Gate、Rule、PermissionPolicy、
Hook 或 Approval policy 的人——重点是每一个的具体机制和完整 YAML 示例。想先
搞清楚每一个到底是什么、彼此怎么关联、跟项目开发语言有没有关系，先看
[Skills、Flows、Rules、Gates、Hooks、PermissionPolicies 与 Approvals](governance-concepts.zh-CN.md)；
Gate/Rule 和 Flow 具体如何配合，见
[扩展 Skills 与 Flows](extending-skills-and-flows.zh-CN.md)。

## Gate——确定性证明，而且确实是项目语言相关的

Gate 是一份 YAML 资源（`kind: Gate`），要么声明一个固定的 `command`（任意可
执行程序，任意语言），要么是唯一的特例 `builtin: structure`（CLI 自己进程内
的 schema/引用/资格校验逻辑，见下文）。不管是哪种，跑完之后产出的都是同一份
签名 Evidence 信封，写进 `<change>/evidence/<spec.evidence>`。

### 怎么接进去、怎么被调用

1. 写 `xforge/scaffold/gates/<id>.yaml`，在 `manifest.yaml` 的
   `scaffold.gates` 里登记 `<id>`。
2. 在某个 Flow 的 stage `gates: [...]` 列表（或者
   `terminal.archive.mandatoryGates`）里引用 `<id>`，让 `checkStructure()`
   知道它是必需的——一个没被登记或没被引用的 Gate 是死代码，永远不会跑。
3. 触发方式：Skill（或你手动）调用
   `xforge check --change <id> --gate <gate-id>`，或者作为
   `xforge archive` 的一部分，对每个 `mandatoryGates` 里的条目隐式跑一遍。
4. `runGate()` 把 `spec.command` 当成真实子进程跑（`spawn`，默认不过
   shell），捕获退出码/stdout/stderr（脱敏、按字节数截断），原子写入
   Evidence JSON——`gate`、`change`、`flow`、`stage`、`stateRevision`、
   `contentRevision`、`gitHead`、`runner.integrity`、`command`、
   `exitCode`、`status`、`digest`。后续的 Transition 或 Archive 只重新读
   这份文件，不会重新跑你的命令——它信的是这份带 digest 的记录。

### structure 是唯一不跑子进程的 Gate

`builtin: structure` 根本不跑命令。`xforge check` 走到要执行它的时候，CLI
自己的 `checkStructure()`（进程内 TypeScript：schema 有效性、Flow/Skill/Gate
之间的交叉引用、这个 Change 的分类是否满足所选 Flow 的资格、Lock 是否新鲜、
work-package DAG 是否安全）已经跑完并且确认没问题——这次 Gate 调用只是把这个
已经确定的"通过"结果包装成和其它 Gate 一样的签名 Evidence 信封，好让下游代码
（Transition、Rule 的 `coverage`、Archive）统一按同一套格式处理所有 Gate，不用
对这一个特殊对待。

### 示例：给一个 Python 项目加 lint Gate

```yaml
# xforge/scaffold/gates/lint.yaml
apiVersion: xforge.dev/v1alpha1
kind: Gate
metadata:
  name: lint
  version: 1
spec:
  stage: before-archive
  required: true
  command: [ruff, check, ., --quiet]
  workingDirectory: .
  timeoutSeconds: 120
  evidence: lint.json
```

```yaml
# manifest.yaml
scaffold:
  gates: [structure, unit-tests, lint]
```

```yaml
# xforge/flows/solid.yaml（节选）
stages:
  - id: verify
    gates: [structure, unit-tests, lint]
```

这里面没有任何 Node/npm 专属的东西——把 `[ruff, check, ., --quiet]` 换成
`[pytest]`、`[go, vet, ./...]`、`[cargo, clippy, --, -D, warnings]` 或者
`[mvn, -q, verify]`，机制完全一样。

### `builtin: declared`——由项目自己说明如何验证自己

随包发布的 `unit-tests` 与 `security-scan` 曾经是 `npm test` 和 `npm audit`，
外面套一层守卫：没有 `package.json` 就直接 `exit(0)`——因为 npm 退出的是 254 /
ENOLOCK，而不是 runner 识别为「工具缺失」的 127。那层守卫消除了非 Node 项目上
永久的**假失败**，却换来了更糟的东西：一个报告 `passed` 却什么都没断言的 Gate，
以及随之而来的、唯一执行者就是该 Gate 的 must 级 Rule、引用其 digest 的
verification receipt，和一个 mandatory Gate 为空的 archive。

两个 Gate 现在都是 `builtin: declared`：运行项目为同名 Gate 声明的命令，
**没有声明就拒绝**：

```yaml
# xforge/manifest.yaml
verification:
  unit-tests:
    - command: [go, test, ./...]
      declaredBy: alex           # 必填
      declaredAt: 2026-08-17T05:00:00Z
  security-scan:
    - command: [govulncheck, ./...]
      declaredBy: alex
      declaredAt: 2026-08-17T05:00:00Z
```

`declaredBy` 之所以必填：没有任何机制能判断一条命令是否真的在验证什么——
`[echo, ok]` 和 `[go, build, ./...]` 都会 exit 0 而不做测试。它记录的是谁回答的，
与其他台账里 `decidedBy`、`approvedBy`、`resolvedBy` 是同一个做法。

**XForge 绝不猜测命令。** 未声明的 Gate 以 `XFORGE_VERIFICATION_NOT_DECLARED`
失败，并给出面向人的 `declare-verification` nextAction。当 CLI 认得某个构建标记
（`Cargo.toml`、`go.mod`、`pyproject.toml`、`pom.xml`、`build.zig`……）时，
nextAction 会带上候选命令；认不出时会直说认不出——但候选只是提问的起点，绝不是
可以直接采用的答案。这张标记表**刻意是不完整的**：表错了只会让提示变差，绝不会
让结果出错，所以一个没被认出的工具链**仍然会触发提问，而不是通过**。

含多种工具链的仓库必须逐个交代，因为「他们已有的那条命令大概也覆盖了它」正是本
机制要消灭的猜测：

```yaml
verification:
  unit-tests:
    - command: [cargo, test]
      covers: [Cargo.toml]
      declaredBy: alex
      declaredAt: 2026-08-17T05:00:00Z
    - notApplicable: web/package.json
      justification: 前端由其自身仓库的流水线验证
      declaredBy: alex
      declaredAt: 2026-08-17T05:01:00Z
```

记录下来的 `notApplicable` 是一个真正的答案：问题只问一次，此后不再问。
单一工具链的项目不需要 `covers`——没有歧义可消，提问只会变成噪音。

在此之前创建的项目仍带着占位 Gate，因为 `xforge/scaffold/**` 由 `init` 播种一次、
此后永不更新。执行 `xforge update` 时，仍然是随包占位符的 Gate 会被替换为
`builtin: declared` 形式，并报告 `XFORGE_VERIFICATION_GATE_MIGRATED`；
**项目自己改过的 Gate 一律不动。**

## Rule——声明的指导，被核验而不是被采信的覆盖率

一条 Rule（`kind: Rule`）声明 `severity: must|should`、一段 `instruction`
文本、一个 `scope`（modules/paths/stages），以及一个 `enforcement` 块，声称
由哪些 Gate/PermissionPolicy/Approval 来强制执行它
（`gateRefs`/`policyRefs`/`approvalRefs`）。关键是：**系统不会直接相信这个
声称**——每次算 `xforge state` 都会反向核实，产出一个 `coverage` 数组：

- `instructed`——基线，这条 Rule 适用并且被展示出来了。
- `guarded`——`policyRefs` 里有一条真的对应一个已加载的 PermissionPolicy。
- `verified`——`gateRefs` 里有一条真的是下一个候选 Transition 所要求的 Gate。
- `approved`——`approvalRefs` 里有一条真的有一份当前 revision 的
  `approve` receipt。
- `uncovered`——`severity: must` 但 `gateRefs` 和 `approvalRefs` 都是空的：
  一条声称"必须"但没有任何机制真的在背后支撑的规则。

### 示例

```yaml
# xforge/scaffold/rules/no-console-log.yaml
apiVersion: xforge.dev/v1alpha2
kind: Rule
metadata:
  name: no-console-log
  version: 1
spec:
  severity: must
  instruction: >
    不要在提交的 src/** 代码里留下 console.log 调试语句。
  scope:
    paths: [src/**]
  enforcement:
    gateRefs: [lint]
    policyRefs: []
    approvalRefs: []
```

把上面加的 `lint` Gate（ruff/eslint 或任何你已经配好的工具）真的配置成会抓
`console.log`/`print` 调试语句，再把这条 Rule 登记进 `manifest.yaml` 的
`scaffold.rules`，这条 Rule 在 `xforge state` 里就会显示
`coverage: ['instructed', 'verified']`——因为 `lint` 真的是下一个 Transition
要求的 Gate 之一。如果同一条 Rule 的 `enforcement.gateRefs` 留空，
`xforge state` 就会诚实地报 `'uncovered'`——这条规则就只是一句 Agent 可能遵守
也可能不遵守的指导，不是系统验证过的东西。

Rule 是以指导文本的形式，通过 `xforge state` 的 `governance.rules` 输出到达
Agent 的；Skill 被期望读到适用的 Rule 并遵守（`xforge-design` 的 Invariants
里写着："Constitution, Rules, current architecture, and Specs constrain the
design"）。`coverage` 字段的作用就是保证这件事诚实——Agent（或者审阅
state 输出的人）一眼就能看出一条"must"级别的 Rule 到底是真的有机制背书，还
是只是好言相劝。

## PermissionPolicy——实时的 allow/ask/deny

一条 PermissionPolicy（`kind: PermissionPolicy`）声明一个 `capability`
（`fs.read`、`fs.write`、`shell`、`network`、`mcp`、`subagent`、
`external.write`）、一个 `effect`（`deny`/`ask`/`allow`），和一个 `match`
块（`paths`/`commands`/`hosts`/`tools`/`mcpServers`，都是通配符风格，还可以
加 `stages` 作用域和 `exceptActors`）。

### 实际是怎么被评估的——不是一份静态配置，是一次实时分发

每个被投影的编程工具都有自己原生的"动手之前先问一下"钩子机制（Claude Code 的
`PreToolUse`，Cursor 的权限钩子，等等）。`xforge init`/`install` 会给每个平台
写入原生钩子配置，让相关事件调用 `xforge hook ...`。这次 CLI
调用会跑 `executeHookDispatch()`，每次调用做的事：

1. 把平台的工具名归一化成 XForge 的能力分类（`bash`/`shell`/`exec_command`
   → `shell`；`write`/`edit`/`delete` → `fs.write`；`read`/`view` →
   `fs.read`；`task`/`subagent`/`spawn` → `subagent`；`web`/`fetch` 或带
   `url` 字段 → `network`；`mcp*` 类工具名 → `mcp`）。
2. 从工具自己的输入参数里提取具体动作对象（文件路径、shell 命令字符串、
   URL、子 Agent id）。
3. 找出所有 `capability` 匹配、且 `match` 模式通配符能匹配上这个动作对象的
   PermissionPolicy（同时尊重 `exceptActors` 和 `match.stages`）。
4. 把所有匹配到的 policy 合并成一个结果，`deny` 压过 `ask` 压过 `allow`
   （`effectivePolicyEffect`）——只要有一条匹配的 `deny`，不管同时匹配了多少
   条 `allow` 都不算数。
5. 把这个决定翻译成调用方平台期望的具体形状（Cursor 要
   `{permission, user_message, ...}`；GitHub Copilot 要
   `{permissionDecision, ...}`；Codex 没有原生的"ask"，所以专门把 `ask`
   降级成 `deny`），不管结果如何都记一条审计事件。
6. 如果分发器自己在产出决定之前就出错了，对 before/permission 类事件会
   **fail closed**（直接拒绝），而不是静默放行——这和 XForge 其它地方的
   fail-closed 默认行为一致。

### 示例

```yaml
# xforge/scaffold/policies/no-force-push.yaml
apiVersion: xforge.dev/v1alpha2
kind: PermissionPolicy
metadata:
  name: no-force-push
  version: 1
spec:
  capability: shell
  effect: deny
  match:
    commands: ["*git*--force*", "*git*push*-f*"]
  reason: >
    强推会改写共享历史；请用普通 push 并解决冲突，或者明确要求人类来做强推。
```

登记进 `manifest.yaml` 的 `scaffold.policies`，跑一次 `xforge sync`，之后只要
某个已经接好 Hook 的平台上，被投影的 Agent 试图跑一条匹配的 shell 命令，该
平台自己的权限提示（或者静默拒绝，取决于该平台怎么展示
`hookSpecificOutput`）就会在命令真正执行**之前**触发，不是事后补救。

## Hook——把平台事件和 XForge 逻辑接起来

一个 Hook（`kind: Hook`）有一个 `event`（固定枚举——`agent.tool.before`、
`agent.permission.request`、`stage.entered`、`gate.after`、
`approval.decided`、`archive.after` ……）、一个 `plane`（`runtime` 对应实时
Agent 会话事件，`workflow` 对应治理生命周期事件）、一个 `failurePolicy`
（`deny`/`ask`/`stop`/`spool`/`warn`——Hook 调用本身失败时怎么办），和一个
`action`。

### 现在实际能跑的是什么

`action.builtin: policy` 和 `action.builtin: audit` 是目前两条真正跑通的路径。
实际情况是：`xforge hook` 的分发器在相关调用上**总是**会去解析匹配的
PermissionPolicy，**总是**会记一条审计事件——一个 Hook 资源真正的作用是**声明
某个平台事件应该触发 `xforge hook`，以及失败时用什么 `failurePolicy`**，而不
是"选择每个 Hook 各自不同的运行时行为"。`runtime-audit.yaml`（作为未选择、
disabled 的示例随包提供——目前没有任何 dispatcher 会执行它的 `builtin: audit`
action）就是具体的形态示例：

```yaml
apiVersion: xforge.dev/v1alpha2
kind: Hook
metadata: { name: runtime-audit, version: 1 }
spec:
  enabled: false
  plane: runtime
  event: agent.tool.after
  action: { builtin: audit }
  failurePolicy: spool
  timeoutSeconds: 10
  matcher: "*"
```

把它启用（`enabled: true`，登记进 `manifest.yaml` 的 `scaffold.hooks`，跑
`xforge sync`）之后，每个被投影的平台在每次工具调用之后都会去调用
`xforge hook`，记录一份 Agent 活动的审计轨迹——不只是 Change/Flow/Gate 治理
事件。

### 自定义 Hook 逻辑——scriptRef Hook

`action.scriptRef` 指向一个项目自有的 `kind: Script` 资源（`runtime: node`
——JS 或 TS，进程内转译，不需要构建步骤——或者 `runtime: python`，通过
`python3`/`XFORGE_PYTHON` 调用）。每次 `xforge hook dispatch` 被调用时，分发器
会查出所有 `enabled: true` 且 `event` 与本次触发匹配的 Hook 资源，通过
`runProjectScript()` 运行每一个引用的 Script，再把结果和内置
PermissionPolicy 检查的结果合并成同一个最终决定——`deny` 压过 `ask` 压过
`allow` 压过"没有意见"，和合并多条匹配的 Policy 是同一套规则。

**分发器和你的脚本之间的约定**：本次触发事件的 payload 会作为一份 JSON 文档
通过 stdin 传给脚本（tool 名字、tool input、actor、能解析出来的话还有
change/flow/stage）。脚本要参与决策，就往 stdout 打印一行 JSON——
`{"decision": "allow"|"ask"|"deny"|null, "reason": "..."}`——分发器会读 stdout
里最后一行能解析成 JSON 的内容。像 `agent.tool.after` 这类非阻断性事件本来就
没有"要不要放行"这回事，脚本不打印决策行完全没问题，就是没有意见。

**失败处理由这个 Hook 自己的 `failurePolicy` 决定，不是写死的规则**：脚本
退出码非 0、超时、或者没打印出能解析的决策行时——`failurePolicy: deny` 或
`stop` 会被当成 `deny`，`failurePolicy: ask` 会被当成 `ask`，
`spool`/`warn` 则当成"没有意见"（永远不阻断）——`spool` 这种情况下，审计事件的
`outcome` 会被记成 `spooled`，让一个尽力而为的脚本 Hook 失败时可追溯，但不会
挡住任何 Agent 动作。

```yaml
# xforge/scaffold/hooks/deny-generated-secrets.yaml
apiVersion: xforge.dev/v1alpha2
kind: Hook
metadata: { name: deny-generated-secrets, version: 1 }
spec:
  enabled: true
  plane: runtime
  event: agent.tool.before
  action: { scriptRef: secret-pattern-scan }
  failurePolicy: deny
  timeoutSeconds: 5
  matcher: "Write|Edit"
```

```yaml
# xforge/scripts/secret-pattern-scan/script.yaml
apiVersion: xforge.dev/v1alpha1
kind: Script
metadata: { name: secret-pattern-scan, version: 1 }
spec:
  runtime: node
  entry: main.mjs
  arguments: []
  workingDirectory: .
  timeoutSeconds: 5
  input: JSON payload on stdin
  output: one JSON decision line on stdout
  sideEffects: none
```

```js
// xforge/scripts/secret-pattern-scan/main.mjs
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  const content = payload.tool_input?.content ?? '';
  const looksLikeAKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content);
  process.stdout.write(`${JSON.stringify({
    decision: looksLikeAKey ? 'deny' : null,
    reason: looksLikeAKey ? 'Content matches a private key pattern.' : undefined,
  })}\n`);
});
```

把 `secret-pattern-scan` 登记进 `manifest.yaml` 顶层的 `scripts` 列表（注意不是
`scaffold` 下面），把 `deny-generated-secrets` 登记进 `scaffold.hooks`，跑
`xforge sync`，之后每个被投影平台的 `Write`/`Edit` 工具调用在真正执行前都会先
跑这个脚本——一个 Gate 表达不了（Gate 是在 `check`/`archive` 检查点跑，不是在
每次工具调用前）、单纯 PermissionPolicy 模式匹配也做不到（它检查的是工具调用
的具体内容，不只是路径或命令字符串）的、真正自定义且能拒绝的检查。

## Approval——人类或外部系统的授权，绑定在某个 revision 上

和另外四个不一样，Approval 不是一份独立的项目自有 YAML 文件。一条 policy 是
内联声明在某个 Flow 的 `governance.approvalPolicies` 里的（`id`、
`minApprovers`、`roles`、`separationOfDuties`、`providers`），再从某个 stage
的 `exit.approvals` 或者 `terminal.archive.approvals` 里引用它。运行时真正产
出的是一份 `ApprovalReceipt`——JSON，绑定在这个 Change 当前确切的
`stateRevision`/`contentRevision`/`policySnapshotDigest`/`gitHead` 上；之后
任何一次编辑都会让它失效。两条批准路径产出的 receipt 都不带签名；每份
receipt 只有在项目自己的防篡改 audit hash chain 里能找到匹配事件时才算有效
——详见下面"信任模型"。

### 实际是怎么被调用的

`xforge approve --change <id> --for <transition-id|archive> --policy <id> ...` 有
两条路径：

1. **本地交互式**——要求真实 TTY（`process.stdin.isTTY &&
   process.stdout.isTTY`），而且只有这条 policy 的 `providers` 里包含
   `local` 才能用。CLI 自己跑一个基于 `readline` 的对话，现场询问批准人
   身份、角色、决定词（approve/reject）和理由，全部在终端里现场输入——
   不再有需要读回去的确认/挑战码，也没有一项来自命令行 flag：
   `--actor`/`--role`/`--reason` 只是给对话框预填的建议，从不作为权威依据；
   `--attestation human` 也只是一个意图提示，本身不构成决定。刻意做成不能
   自动化。stdin 和 stdout 都必须是 TTY，并且刻意没有提供任何 manifest 开关
   来放宽这一点。要准确理解它证明了什么：存在一个交互式会话、并且有东西回答了
   提问——它**不**证明回答者是人（pty 同样能通过）。所以它的作用是让"无人值守
   的自我批准"变成一个刻意且留痕的动作，而不是让它不可能。需要比这更强的属性
   的 policy 就不该列出 `local`，而应改用 `mcp` provider——那里的决定由一个
   密钥和端点都在 Agent 写不到的地方的系统做出。
2. **`mcp` provider**——`xforge approve --provider <id>`，`<id>` 指
   `manifest.yaml` 的 `approvals.providers` 里的一条，唯一存在的形状是
   `{ id, type: mcp, mcpServer: <id>, roles: [...] }`。XForge 会对登记好的
   `McpServer` 依次调用 `submit_approval_request` 和 `poll_approval`；轮询
   结果是 `pending` 的话，返回的是一个成功的 envelope，`nextActions` 里
   给出稍后要重跑的命令——不是错误。完整契约见
   [用 MCP provider 扩展 Approvals](extending-approvals-with-mcp.zh-CN.md)。

Receipt 在**每一次**算 `xforge state` 时都会被重新验证，不是在 approve 那一
刻验证完就缓存起来——批准之后再改这个 Change，receipt 就会失效
（`XFORGE_APPROVAL_STALE`，或者 audit-chain 校验不通过）。

### 示例：定义一条 policy

```yaml
# xforge/flows/major.yaml（节选）
governance:
  approvalPolicies:
    - id: implementation-major
      minApprovers: 2
      roles: [owner, maintainer, security]
      separationOfDuties: true
      providers: [enterprise-approvals]
```

```yaml
# manifest.yaml
approvals:
  providers:
    - id: enterprise-approvals
      type: mcp
      mcpServer: enterprise-approvals
      roles: [owner, maintainer, security]
```

`minApprovers` 数的是当前 revision 下有效 `approve` receipt 里**不同的
approver id**——一个人签两次批准不了需要 2 个批准人的要求，无论他把身份写成
什么拼法、走哪个 provider。`roles` 是资格过滤器：角色不在列表里的 receipt
根本不计入。

`separationOfDuties: true` 是另一个维度，它**不比较角色**。它要求批准人不是
本 Change 的 **implementer**——implementer 取自 Change 目录以及每个
work-package delivery 区间的 Git author（见 `core/revision.ts` 的
`changeImplementers`）。两个没写过这些代码的 maintainer 满足它；写了代码的
那个人不满足，无论他挂什么角色。"数不同角色"是更早的规则，两种情况都判错了
——它允许 Change 的作者自己批准，却拒绝两个不同 maintainer 这种最常见的
真实复核形态。

注意上面的 `enterprise-approvals` 只是一个名字/形状示例——背后并没有一个
能直接用的默认 `McpServer` 资源。不先按
[用 MCP provider 扩展 Approvals](extending-approvals-with-mcp.zh-CN.md)
登记一个真实的 `McpServer` 就直接用它，会以 `XFORGE_APPROVAL_MCP_SERVER_MISSING`
失败关闭——跟 `runtime-audit` Hook 以未选择且 disabled 的状态出厂是同一个套路。

### 信任模型——为什么不需要签名

`local` 和 `mcp` receipt 都不带 `signature` 字段。真正让 receipt 可信的，是
项目自己的防篡改 audit hash chain，而不是每份 receipt 各自的密码学签名：
每一次成功的 `xforge approve` 都会在同一次运行里先写 receipt 文件，再往
audit chain 里追加一条匹配的 `approval.decided` 事件，然后才返回。加载
receipt 时——`xforge/src/core/control-plane.ts` 里的
`loadApprovalReceipts`——每一份都会被拿去跟 chain 核对，不区分 provider
类型，用的是 `approvalVerifiedInChain()`（`xforge/src/core/audit.ts`）。
一份从未真正经过 `xforge approve` 产出的 receipt 文件（手工复制、从旧分支
恢复等等），在 chain 里找不到匹配事件，会被 `XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN`
拒绝——这是一个非阻断级别的发现，不会意外冻结无关的 transition，但这份
receipt 本身永远不算有效。在没有本地（被 gitignore 掉的）audit 日志的机器
上——比如一个新 clone 或者 CI 机器——同样的检查会退回去比对已提交的、每个
Change 自带的 `evidence/audit/index.json`。

这替换掉了更早的设计：本地批准配一个需要读回去的确认/挑战码，外部批准靠一个
共享密钥做的 HMAC 签名来认证。这两者都被去掉了：确认码本来就是对已经公开
可得的数据（change id、flow、policy、revision——通过 `xforge state` 谁都能
读到）做的一个纯确定性运算，任何有仓库写权限的人（Agent 默认就有）不需要碰
一次终端就能算出来它，它并没有提供真正的防伪造能力，只是强行要求"存在一次
现场对话"——而交互式 TTY 这个要求本身就已经保证了这一点。上面的 audit-chain
校验才是真正替代它们的东西：它验证的是这份 receipt 确实来自一次真实的
`xforge approve` 调用，而不是让 receipt 自己证明自己。

## 检查清单

新增 Gate：
- [ ] 已创建 `xforge/scaffold/gates/<id>.yaml`；已登记进 `manifest.yaml` 的
      `scaffold.gates`
- [ ] 已在需要它的 Flow stage（或 `terminal.archive.mandatoryGates`）里引用
      ——没被引用的 Gate 永远不会跑
- [ ] `command` 是你项目自己工具链的调用，退出码语义清晰；不要把治理判断
      藏在人类可读的输出文本里

新增 Rule：
- [ ] `enforcement.gateRefs`/`policyRefs`/`approvalRefs` 指向的 Gate/Policy/
      Approval 真实存在，且真的适用于这条 Rule 声称的场景——核对
      `xforge state` 的 `coverage` 输出是不是你期望的那样，而不是
      `uncovered`
- [ ] `scope`（modules/paths/stages）收窄到指导内容实际需要的范围

新增 PermissionPolicy：
- [ ] `capability` + `match` 模式已经用真实会出现的工具调用参数（一个路径、
      一条 shell 命令字符串、一个 host）验证过
- [ ] `effect: deny` 是刻意使用的——记住它会压过所有匹配到的 `allow`，不管
      有多少条
- [ ] 已登记进 `manifest.yaml` 的 `scaffold.policies`，已跑 `xforge sync`

新增 Hook：
- [ ] 用 `action.scriptRef` 时：脚本有意见就往 stdout 打印一行
      `{"decision", "reason"}` JSON；没意见就什么都不打印（或者打印一行不带
      `decision` 的内容）
- [ ] `failurePolicy` 是刻意选择的（治理关键事件用 `deny`/`stop`，失败不该
      挡住 Agent 的尽力而为/建议性检查用 `spool`/`warn`）
- [ ] `enabled: true`，已登记进 `manifest.yaml` 的 `scaffold.hooks`；对应的
      Script 也已登记进 `manifest.yaml` 顶层的 `scripts`

新增 Approval policy：
- [ ] `minApprovers`/`roles`/`separationOfDuties` 匹配真实的授权要求——记住
      满足 `minApprovers` 靠的是不同的 approver **id**，不是 receipt 数量；
      `roles` 只决定谁有资格；`separationOfDuties` 排除的是本 Change 的
      implementer，不是"角色相同"的人
- [ ] `providers` 和 `manifest.yaml` 的 `approvals.providers` 里真实登记的
      条目对得上——如果是 `mcp` provider，它的 `mcpServer` 要指向一个真正
      登记过的 `McpServer` 资源，而不只是一个理想中的 id
- [ ] 已在正确的 stage 的 `exit.approvals` 或者 `terminal.archive.approvals`
      里引用——没人引用的 policy 永远拦不住任何东西
- [ ] 如果是 `mcp` provider：先在测试项目里跑通至少一次真实的批准/拒绝往返
      （比如用测试里的 `approveCurrentRevision` helper）核对过，再接进任何
      真的会拦住 transition 的地方；`--dry-run` 不会追加 audit 事件，也不
      返回 receipt，没法用来比对
