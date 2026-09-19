# Live 测试设计

> 依据：迁移方案 D4 的 live 层；命令行设计《走查》；Skill 设计的 `SK-10` `SK-11` `CLI-29`。
> 一个真实模型读真实 Skill、驱动真实的 `xforge`，在一个接近真实的非 TS 项目上走完整个流程。
> 静态测试不能回答的两件事在这里回答：指令有没有到达 Agent；到达了有没有被照做。
>
> 标着 **决定** 的可以推翻；`LT-nn` 是可验收的断言。

---

## 0. 决定清单

| # | 决定 | 理由 |
| --- | --- | --- |
| **D1** | 测试项目 `invoicely`：Python 3，仅标准库，`python3 -m unittest discover -s tests` 验证 | 与 TS 工具链无关；门命令零依赖；旧线的非 Node 场景已证明这条路可走 |
| **D2** | 四个场景：`quick`、`solid`、`major`、`solid-rework`；三种注入故障不经模型 | 覆盖三条流程、返工路径、执法与损坏检测 |
| **D3** | 一个驱动、两套环境：引擎 A = 本机 Claude 凭据，继承本机环境（含代理）；引擎 B = 仓库 `.env` 里的 Anthropic 兼容网关，去掉本机的代理变量直连（`.env` 里显式写了才用）。A 先跑，B 最后跑 | 同一 `claude -p`，只换环境变量；B 的结果只说明 B；网关走代理比直连慢好几倍 |
| **D4** | 人由 harness 扮演：按 `xforge state` 的 `blockers` 做动词为 `attest` 的事 —— 一律批准、需署名的条目一律署名、材料问题取默认答案 | 不解析模型的话，只看控制面；确定性 |
| **D5** | 每轮 `claude -p` 的输入输出全部落盘：发出的提示、`stream-json` 全流、结束时的 `result`、以及独立 `CLAUDE_CONFIG_DIR` 下的会话转录（含子 Agent） | 分析产品用；主会话看不到的子 Agent 转录只在配置目录里 |
| **D6** | 用量只按 tokens 报：`input`、`output`、`cache_read`、`cache_creation`，按轮与按场景汇总；不算钱 | 用户要求 |
| **D7** | 验收套件（oracle）放在 harness 里，归档后拷进树跑；不进种子项目 | 提前放进去会让种子的 `unit-tests` 门红；模型要满足的是它，不是自己写的测试 |
| **D8** | 语言默认 `zh-CN`（Skill 的源语言）；`XF_LIVE_LANGUAGE=en` 可选 | 仓库规矩：跑我们真正写的那份 |
| **D11** | 治理组合 `XF_LIVE_GOVERNANCE=TT\|TF\|FT\|FF`，缺省 TT；计分时开着的基线归档后必须动过、关着的必须一字不变 | 「四种组合都支持」是设计目标之一；差异全在欠不欠与归档合并，每种跑一次够 |
| **D12** | 驱动方式 `XF_LIVE_DRIVER=orchestrated\|stepwise`，缺省 orchestrated：一句 `/xforge` 由入口 Skill 派执行者跑到底；stepwise 模拟用户自己逐站推进 —— harness 每轮先自己 `state --orient` 取 `orient.stage.skill`，提示只点名那一个站 Skill（没有 Change 时是 propose 站的），轮数上限 30 | 用户手工逐站推进是产品要支持的用法；两种驱动同一套 Skill，差价就是编排本身的开销 |
| **D13** | 标准矩阵（`scripts/live-matrix.mjs`）：引擎 A 跑 3 条流程 × 4 种治理组合 = 12 场，solid 一律用带植入故障的 `solid-rework`，另加一场 major TT 用 stepwise 驱动，共 13 场；引擎 B 只做最后验证，TT 与 FF 各跑 quick、solid，另加一场 solid FF 的 stepwise，共 5 场。英文投影不进矩阵，按需单跑 | 用户 2026-09-17 定的：治理组合要在流程间交叉才有覆盖；两种驱动各在一个引擎上留一场；英文只是翻译 |
| **D14** | `XF_LIVE_APPROVER=human\|mcp`，缺省 human：mcp 时 setup 往清单写一个假 MCP 审批者（`test/helpers/fake-mcp.mjs`，一律批准，把收到的请求记进 `mcp-requests.log`），harness 扮演的人不再批，模拟用户告诉模型「带 --via 的补救命令直接跑」 | 命令行设计 CLI-34：MCP 批与人批同形；live 层要看模型会不会按 `state` 的补救去跑 `--via` |
| **D9** | 结果目录 `test/.tmp/live/<engine>/<scenario>/<时间戳>/`，git 忽略；`summary.md` 是人读的，`summary.json` 是机器读的 | 与合并门无关；可反复跑 |
| **D10** | 每场景轮数上限 15；同一 `blocked` token 连续 3 轮判停 | 防止空转烧 token |

---

## 1. 种子项目 `invoicely`

```text
seed/
  invoicely/  __init__.py  models.py  core.py  store.py  cli.py  __main__.py
  tests/      test_core.py  test_cli.py
  README.md
  xforge-seed/
    constitution.md
    specs/billing/{customers,invoices}.md + index.yaml   specs/index.yaml
    interfaces/invoicely-api/{core,cli}.md + index.yaml  interfaces/index.yaml
```

能力：客户、发票（行项、税率、总额）、JSON 文件存储、命令行。规格基线 4 条 Requirement，接口基线 7 个元素（4 个 `fn:`、3 个 `cli:`）。
治理开关两条都开；清单声明模块 `core`（`invoicely/**`）与验证命令 `unit-tests`。

`LT-01` 种子自身 `python3 -m unittest discover -s tests` 全绿；`xforge inspect --all --hygiene` 干净。

## 2. 四个场景

| 场景 | 流程 | 需求（`requests/<scenario>.md`，即给模型的话） | 期望 |
| --- | --- | --- | --- |
| `quick` | quick | 逾期标记：`is_overdue(invoice, today)`；`invoice list --overdue [--today]` | archived，0 次返工，oracle 全过 |
| `solid` | solid | 收款：`record_payment`、`invoice_balance`，状态 open / partial / paid，`payment add`；两个包（core → cli），cli 包需评审 | archived，0 次返工，oracle 全过 |
| `major` | major | 多币种：`Money`、汇率表、`invoice_total` 改返回 `Money`（破坏性）、存量数据迁移；两条材料问题 | archived，返工 ≤ 1，oracle 全过，`interface-compat` 记录里有破坏性元素 |
| `solid-rework` | solid | 与 `solid` 同一需求；design 出站后 harness 往 `design.md`《失败模式》追加「部分收款后发票状态记为 paid」 | check 站有发现指向它；harness 触发 `advance --rework-to design`；第二遍通过；返工恰好 1 |

三种注入故障（harness 直接操作，任一场景归档后或中途）：

| 故障 | 注入 | 期望 |
| --- | --- | --- |
| 交付记录路径不符 | 派工后 harness 自己写一份 `paths_changed` 多一项的交付记录并 `advance package --deliver` | `XF-ADVANCE-009`，receipt 不增 |
| 写出包范围 | 模型在 apply 站期间（转录里）任何对包 `paths` 之外的写入 | 钩子 deny，转录含 `XF-ENFORCE-002`；场景不因此失败，只计数 |
| 记录损坏 | 归档后改一个 receipt 的一个字节 | `inspect` 退出码 3，`XF-INSPECT-001` |

`LT-02` 每个 oracle 先对参考实现（`reference/<scenario>/`）全绿，再对模型的树跑。product 层测试把参考实现覆盖到种子上跑 oracle，保证 oracle 本身不坏。

## 3. 驱动

一轮 = 一次 `claude -p`：

```
CLAUDE_CONFIG_DIR=<run>/claude-config  cwd=<project>
claude -p "<第一轮：需求 + 用 /xforge 推进；之后：/xforge>" \
  --output-format stream-json --verbose --permission-mode bypassPermissions [--model $ANTHROPIC_MODEL]
```

- 钩子照常生效（`sync` 写进 `.claude/settings.json`）；入口 Skill 派 `xforge-executor` 子 Agent 走 Agent 工具。
- 一轮结束后 harness 跑 `xforge state`：`archived` → 结束；否则按 D4 处理 `attest` 类阻塞，再开下一轮。`solid-rework` 里，check 站出现 `open` 发现且 `design.md` 仍含植入句 → `advance --rework-to design`。
- 引擎 A：环境里删掉全部 `ANTHROPIC_*` 与 `CLAUDE_CODE_*` 覆盖；引擎 B：从 `.env` 读 `export K=V`，只透传这批变量。

`LT-03` harness 的每一次 `xforge` 调用都记进 `xforge-commands.log`（命令、退出码、信封）。
`LT-08` mcp 审批模式下，归档的场景审计链里带 `via` 的审批事件数 ≥ 该流程的审批点数（quick 1、solid 2、major 3）；summary 记 `mcp_approvals`。
`LT-07` 归档后，规格治理开着的场景核对 Change 规格 delta 里每条 `REQ-…`：必须在模型自写的测试（`tests/**`）或 `assurance.md` 的覆盖表里出现；缺一条判失败，一条都没有也判失败（开着治理却没写 delta）。规格治理关着时不适用。oracle 每场景至少 5 条，含边角（状态 partial 也算逾期、精确结清、两位小数、只认直接汇率、混币种报表）。
`LT-06` stepwise 驱动：每轮提示恰好点名一个站 Skill（`/xforge-<站>`），名字来自 harness 自己的 `state --orient`；summary 记每轮结果文本里有没有 `/xforge-` 开头的下一步提示（`next_skill_hints`），只报不判。
`LT-04` 一轮的落盘：`turn-N.prompt.txt`、`turn-N.stream.jsonl`、`turn-N.result.json`；运行结束时把 `claude-config/projects/**` 拷到 `sessions/`，Change 目录拷到 `change/`。

## 4. 计分

`summary.json`：

```json
{"engine":"claude","scenario":"solid","language":"zh-CN","model":"<result 里报的>",
 "outcome":"archived","turns":7,"reworks":0,"oracle":{"passed":9,"failed":0},"inspect_exit":0,
 "tokens":{"input":…, "output":…, "cache_read":…, "cache_creation":…, "per_turn":[…]},
 "observations":{"show_calls":5,"direct_change_reads":0,"design_full_reads":1,"enforce_denies":0,"blocked_tokens":["…"]}}
```

判定：`outcome`、`reworks` 与场景期望精确比较；oracle `failed == 0`；`inspect_exit == 0`。观测项只报不判（`CLI-29`、`SK-11` 在这里取数）。

`LT-05` `summary.md` 里没有货币字段。
`LT-09` 跑完一整个场景之后，那棵真树上的 `xforge doctor` 干净：没有非 `info` 的诊断，退出码 `0`。装配面在合成的临时项目上对不算数 —— 要在模型真动过的树上也对。
`LT-10` 那一次 `doctor` 的 `changed` 为空：它是「验」，写盘就是它自己坏了。
`LT-11` 往一份投影里注入一处漂移，`repair` 一次把它收敛：`changed` 非空、之后的 `doctor` 没有非 `info` 的诊断、退出码 `0`。
三条的判定都在 `test/live/harness/assembly.ts` 的纯函数里（`readAssembly` / `assemblyProblems`），product 层直接喂样例信封测它；真机那一层只负责调命令与搬字段。

## 5. 落点

```text
test/live/
  harness/   env.ts（引擎环境）  setup.ts（种子 + init + 基线）  engine.ts（一轮 claude -p 与落盘）
             human.ts（D4）  oracle.ts  faults.ts  score.ts  run.ts（循环）
  scenarios/invoicely/  seed/  requests/  reference/{quick,solid,major}/  oracle/test_{quick,solid,major}.py
  invoicely.live.ts    # 读 XF_LIVE_ENGINE / XF_LIVE_SCENARIO / XF_LIVE_LANGUAGE / XF_LIVE_GOVERNANCE / XF_LIVE_DRIVER
```

用法：`XF_LIVE_ENGINE=claude XF_LIVE_SCENARIO=quick npm run test:live`。不设场景则按 quick → solid → solid-rework → major 顺序全跑。
结果目录名带上非缺省的开关：`solid`、`solid-FF`、`solid-stepwise`、`solid-FF-stepwise`。

## 6. 追溯

| 断言 | 兑现处 |
| --- | --- |
| `CLI-09` 顺利的 Change 不调 `inspect` | 转录 grep，`observations` |
| `CLI-26` 走查 | 每场景 `xforge-commands.log` + 模型的调用序列 |
| `CLI-29` `show` ≥ 直接读 | `observations.show_calls` / `direct_change_reads` |
| `SK-10` 两宿主产出相同 | 本版只跑 claude；codex 留待其宿主可非交互驱动 |
| `SK-11` 设计文档整读 ≤ 1 | `observations.design_full_reads` |
| `隔离是优化不是语义` | 子 Agent 转录在 `sessions/` 里可核对每站是否独立会话 |
