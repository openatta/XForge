[English](extending-approvals-with-mcp.md) | 简体中文

# 用 MCP provider 扩展 Approvals

这是第二种 Approval 机制的参考文档：`mcp` 类型的 provider——`xforge
approve` 自己变成一个 MCP client，实时直接跟你们审批平台的 MCP server 对话，
而不是靠一个坐在 TTY 前的人。先看
[扩展 Gate、Rule、PermissionPolicy、Hook 与 Approval](extending-gates-rules-policies-hooks-approvals.zh-CN.md)
了解 Approval 一般是怎么绑定到 Flow 和 revision 上的，以及和这个机制并列的
`local` 路径。

## 什么时候该用这个

两种 provider type，两种信任模型——按 policy 挑，不是全局二选一：

| provider `type` | 谁/什么在做决定 | 信任边界 | 典型场景 |
|---|---|---|---|
| `local` | 坐在真实 TTY 前的人 | TTY 本身——它证明的是存在交互式会话，不是经过验证的身份 | 小团队、轻量流程的变更 |
| `mcp` | 你们的平台，实时 | MCP 连接本身（传输方式 + 认证 token） | 程序化/自动化评审——一个评估 Change 并做决定的 bot，或者你们平台本来就跑的人工审批流程，只是暴露成了 MCP |

如果你们的平台已经能暴露一个 MCP server，`mcp` 这条路径的好处是不需要任何人
手动构造并签名一份 JSON 文件——整个往返由 XForge 自己驱动。

## 为什么是提交+轮询两段式，不是一次阻塞调用

一个朴素的设计是：一个 `request_approval` MCP tool，XForge 发起调用后一直
挂着等，直到决定出来才返回。这个设计对"人类可能要几小时到几天才能做决定"的
场景完全不成立——没有哪个 MCP 传输愿意把连接开这么久，`timeoutSeconds` 也
没有什么合理的取值。

所以 `xforge approve --provider <id>` 每次调用只做一轮：

1. 连接到 MCP server。
2. 调 `submit_approval_request`——幂等，用 `governingDigest` 做键（就是
   已经用来把 receipt 绑定到某个 revision 上的那个 digest，参见 Approvals
   参考文档）。对同一个 Change/Flow/Stage/policy/revision 重复提交永远
   安全；你们平台应该认出这个 digest，不要重复开工单。
3. 调一次 `poll_approval`。
4. 如果还是 `pending`：什么都不写，返回一个成功的 envelope，`nextActions`
   里给出稍后要重跑的确切命令——`pending` 不是错误，只是还没跑完；不需要
   额外的"恢复轮询"机制，因为对一个已经在途的请求重新 `submit` 本来就是
   空操作。
5. 如果 `decided` 了：写一份 `ApprovalReceipt`（不带签名——见下面"信任
   模型"），往 audit chain 里追加对应事件，剩下的流程和 `local` provider
   路径完全一样。

轮询节奏（多久重跑一次）不是 XForge 该管的事——不管是 Agent 按自己的节奏
去看 `xforge state` 的 `pendingApprovals`，还是 CI 里的重试循环，还是人类
知道平台做完决定之后手动重跑一次命令，都一样接得上。

## 配置放哪

一个 `mcp` provider 由两部分组成：

**第一部分：一份 `McpServer` 资源**——独立的 YAML 文件，跟 provider 条目
分开，因为"怎么连上它、用哪个凭证"和"这个 provider 能满足哪条 policy"是两个
不同层面的事：

```yaml
# xforge/scaffold/mcp-servers/review-bot.yaml
apiVersion: xforge.dev/v1alpha2
kind: McpServer
metadata: { name: review-bot, version: 1 }
spec:
  transport: stdio            # 或者 "http"
  command: [node, review-bot-mcp/server.mjs]   # stdio 才需要
  # url: https://review-bot.internal/mcp       # http 才需要
  authTokenEnv: XFORGE_REVIEW_BOT_TOKEN
  timeoutSeconds: 30
```

和 Gate、Hook 一样，要在 `manifest.yaml` 的 `scaffold.mcpServers` 里登记——
没登记的 `McpServer` 文件永远不会被加载：

```yaml
# manifest.yaml
scaffold:
  mcpServers: [review-bot]
```

**第二部分：一条 `approvals.providers[]` 条目**，`type: mcp`，按名字引用
上面那份 `McpServer`，并声明这个 provider 被信任能以哪些角色批准：

```yaml
# manifest.yaml
approvals:
  providers:
    - id: review-bot
      type: mcp
      mcpServer: review-bot
      roles: [owner, maintainer]
```

然后像其它 provider 一样，从某个 Flow 的 approval policy 里引用这个
provider id——不需要改 Flow schema，用的还是 `local` provider 已经在用的
那个 `governance.approvalPolicies[].providers` 列表：

```yaml
# xforge/flows/solid.yaml（节选）
governance:
  approvalPolicies:
    - id: planning-solid
      minApprovers: 1
      roles: [owner, maintainer]
      separationOfDuties: false
      providers: [local, review-bot]
```

用这个命令跑：

```bash
xforge approve --change <id> --for <stage|archive> --policy planning-solid --provider review-bot
```

## `McpServer` 字段参考

| 字段 | 是否必填 | 含义 |
|---|---|---|
| `transport` | 是 | `stdio`（XForge 把你的 server 当子进程拉起）或者 `http`（XForge 通过 Streamable HTTP 连一个 URL） |
| `command` | `stdio` 时必填 | argv 数组——第一个元素是可执行文件，其余是参数 |
| `cwd` | 否 | 拉起子进程的工作目录，相对项目根目录；默认就是项目根目录 |
| `url` | `http` 时必填 | MCP 端点地址 |
| `authTokenEnv` | 是 | 存放凭证的环境变量名。始终必填——哪怕是 `stdio`：你本地拉起的这个 server 仍然可能需要代表你去认证到平台下游的某个东西 |
| `timeoutSeconds` | 是 | 单次 RPC 调用的超时（分别应用于 `submit_approval_request`、`poll_approval`，以及最初的连接握手） |

**token 是怎么传过去的：**
- `stdio`——作为 `XFORGE_MCP_TOKEN` 环境变量传给被拉起的子进程（在继承
  XForge 自己其余环境变量的基础上）。你的 server 认这个固定的变量名，不需要
  知道 XForge 自己 `authTokenEnv` 起的名字。
- `http`——作为每次请求的 `Authorization: Bearer <token>` 头传过去。

**连接重试：** 如果连接（或者连上之后的某次调用）失败，XForge 会把整轮——
连接、提交、轮询——重试最多 3 次，中间有短暂退避，然后以
`XFORGE_APPROVAL_MCP_CONNECTION_FAILED` 退出。之所以是重试整轮而不只是重连
这一步，是因为 `submit_approval_request` 本来就按 `governingDigest` 幂等，
`poll_approval` 又是纯读，重复跑没有副作用。

## MCP server 必须实现的接口

两个 tool，名字固定，不协商——这是刻意做成不可配置的，这样就只有一份契约要
实现、要写文档。输入输出都是纯 JSON：**参数就是 tool call 的 `arguments`
对象，结果是一个 `text` 类型的 content item，它的 `text` 是一段 JSON
字符串**（不是 `structuredContent`——坚持用纯文本 content 装 JSON，意味着
任何语言的任何 MCP server SDK 都能实现，不需要额外去协商输出 schema）。

### `submit_approval_request`

输入：

```json
{
  "change": "add-feature",
  "flow": "solid",
  "stage": "design",
  "transition": "apply",
  "policyId": "planning-solid",
  "revision": {
    "stateRevision": "...", "contentRevision": "...", "policySnapshotDigest": "...",
    "gitBase": "...", "gitHead": "..."
  },
  "governingDigest": "<sha256 hex——幂等键>",
  "roles": ["owner", "maintainer"],
  "reason": ""
}
```

输出：任意 JSON 对象（XForge 除了确认调用成功之外不会解释它的内容）——
`{"accepted": true}` 就够了。用 `governingDigest` 当你们平台的去重键：如果
这个 digest 对应的请求已经在途，把这次调用当空操作处理，返回同样的确认。

### `poll_approval`

输入：

```json
{ "governingDigest": "<sha256 hex>" }
```

输出——还在等：

```json
{ "status": "pending" }
```

输出——已决定：

```json
{
  "status": "decided",
  "decision": "approve",
  "approver": { "id": "alice@example.test", "role": "owner" },
  "reason": "Looks good.",
  "expiresAt": "2026-09-01T00:00:00Z"
}
```

`decision` 是 `"approve"` 或者 `"reject"`。`approver.role` 必须同时在
`approvals.providers[]` 条目和被满足的那条 Flow policy 的角色列表里——不满足
的话 XForge 会以 `XFORGE_APPROVAL_ROLE_FORBIDDEN` 拒绝这个决定，什么都不写；
建议你们平台自己也做这个检查，让角色配错这件事在"告诉人类他的批准生效了"之前
就先失败。`expiresAt` 可选；填了的话，过了这个时间点 `xforge state` 就不再
把由此产生的 receipt 计入有效批准。

## 信任模型——为什么不需要签名

这条路径产出的 receipt，`approver.type` 是 `"external-system"`，
`approver.provider` 是你的 provider id，但没有 `signature` 字段——`mcp`
receipt 和 `local` receipt 一样，从来不签名。

这不是为了图方便硬凑出来的一个更弱的信任等级，它跟 `local` receipt 本来
就有的"靠来源担保信任"模型完全一样。真正让这两种 receipt 都可信的，是
项目自己的防篡改 audit hash chain，而不是每份 receipt 各自的签名：每一次
成功的 `xforge approve` 都会在同一次运行里先写 receipt 文件，再往 audit
chain 里追加一条匹配的 `approval.decided` 事件，然后才返回。之后加载
receipt 时——不管是 `local` 还是 `mcp` provider——`loadApprovalReceipts`
都会调用 `approvalVerifiedInChain()`，确认 chain 里存在一条 digest 对得上
的独立记录事件。一份从未经过 `xforge approve` 就出现在磁盘上的 receipt
文件（手工复制进来的、从旧分支恢复的，等等），在 chain 里找不到对应事件，
即便其它字段都对，也会被 `XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN` 拒绝。在没有
本地（被 gitignore 掉的）audit 日志的机器上——比如一个新 clone 或者 CI
runner——同样的检查会退回去比对已提交的、每个 Change 自带的
`evidence/audit/index.json`。

对 `mcp` 来说，这个决定本身也是实时认证的：它是通过 XForge 信任的连接
（`McpServer` 资源是项目自有、纳入版本控制的配置）同步拿到的，用的是受保护
环境变量里的凭证，跟写 receipt、写 audit 事件是同一次进程调用——不存在"先
离线伪造一份 receipt 再摆到该放的位置"这种空档，因为 audit chain 校验会
拒绝它。

## 怎么激活它，同时不用教每个 Agent 认识它

刻意地，这个功能没有新增 Skill，也没有往 prompt/Constitution 里加任何文字
——那样会让每次会话的上下文都变重，为了一个大多数 Flow 永远不会用到的机制。
取而代之，`xforge state` 的 `governance.pendingApprovals[]` 每一项都带了一个
`providers` 数组——`[{ "id": "local", "type": "local" }, { "id":
"review-bot", "type": "mcp" }]`——这样 Agent（或者人类）光靠读已经是机器
可读的 `xforge state` 输出，就能发现 `--provider review-bot` 这个选项存在，
跟它已经在从 `nextActions` 里读出该跑哪条确切的 `xforge approve ...`
命令是同一个机制。不需要往某次会话里预加载任何文档，这个能力是数据，不是
散文。

## 检查清单

新增 `mcp` Approval provider：
- [ ] `McpServer` 资源已创建，已登记进 `manifest.yaml` 的
      `scaffold.mcpServers`——没登记的 `McpServer` 文件永远不会被加载，
      `--provider` 会报 `XFORGE_APPROVAL_MCP_SERVER_MISSING`（跑一次
      `xforge doctor` 能在真正调用 `approve` 之前，静态抓出
      `providers[].mcpServer` 拼错的情况——报 `XFORGE_APPROVAL_MCP_SERVER_UNKNOWN`；
      登记了但没被任何 provider 引用的 `McpServer` 也会在那里以 `uncited`
      的形式出现）
- [ ] `approvals.providers[]` 条目按名字引用它，`roles` 跟你们平台在
      `poll_approval` 里实际会返回的角色对得上
- [ ] 已经从 Flow policy 的 `providers` 列表里引用（可以和 `local` 并存，
      也可以单独用）——跟其它 provider 一个规矩：没被引用的永远不会拦住
      或满足任何东西
- [ ] `authTokenEnv` 在 `xforge approve --provider` 实际运行的地方（开发者
      本机、CI，或者两者）都指向一个真实、已赋值的环境变量
- [ ] 你的 server 完整实现了 `submit_approval_request`（按
      `governingDigest` 幂等）和 `poll_approval`（`pending` 要立刻返回，
      不能阻塞），跟上面的规格一模一样——用一次真实的
      `xforge approve --provider <id>` 跑过验证，不能只是孤立地单元测过
- [ ] 先手动跑通两种结果各一次（批准一次、拒绝一次），确认角色校验和写出的
      receipt 都符合预期，再让它真正去卡一个 transition
