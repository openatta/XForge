# 1.0.0 live 基线

> 这是 XForge 1.0.0 发布前的完整 live 测试数据，是后续版本对比的基点。数字全部来自各次运行的 `summary.json`，没有手工修改。

## 版本与环境

| 项 | 值 |
|---|---|
| 版本 | `@xforge/cli` 1.0.0，git 标签 `v1.0.0`，提交 `60ff626`（分支 `v1.0.0`） |
| 被测代码 | 引擎 A 的运行在 `632c43b`…`f1af345` 之间的提交上，与 `60ff626` 的 `src/`、`scaffold/`、`schemas/`、`bin/` 逐字节相同（之间只改了 README、harness 与两份无代码路径的诊断字典）；三场 solid TT 在 `5e2f0f3` 上，与前者的差别只是删了那两份字典。引擎 B 的运行在 `f83efdc`/`256afdb` 上（harness 去掉了网关的代理变量，产品代码同上） |
| 日期 | 2026-09-17（UTC 03:51 – 07:30） |
| 引擎 A | 本机 Claude Code 凭据，`claude -p`，模型由 Claude Code 决定（`claude-haiku-4-5-20251001+claude-opus-5[1m]`），走本机代理 |
| 引擎 B | 仓库 `.env` 里的 Anthropic 兼容网关，模型 `deepseek-v4-flash`，不走代理直连 |
| 测试项目 | `invoicely`：Python 3 标准库的发票小工具，种子在 `test/live/scenarios/invoicely/seed/`，验证命令 `python3 -m unittest discover -s tests` |
| 场景 | `quick`（逾期标记，low）、`solid`（收款与部分结清，medium，两个包，cli 包需评审）、`solid-rework`（同 solid，design 出站前植入设计矛盾，期望 check 站返工恰好一次）、`major`（多币种与迁移，high，三个包） |
| 治理组合 | TT / TF / FT / FF = 规格基线开关 / 接口基线开关 |
| 驱动 | `orchestrated`：一句 `/xforge` 由入口 Skill 派执行者子 Agent 跑到底；`stepwise`：harness 扮演逐站手敲的用户，每轮只点名一个站 Skill |
| 语言 | Skill 用中文投影（`zh-CN`），一场 quick 用英文投影 |
| harness 参数 | 单轮超时 40 分钟；轮数上限 orchestrated 15、stepwise 30；位置与阻塞连续 3 轮不变判停滞；人由 harness 扮演：审批一律批准、需署名的一律署名、材料问题取默认答案、治理开关以 manifest 为准 |
| 验收 | 归档后把模型没见过的 oracle 套件拷进项目跑（quick 3 条、solid 4 条、major 4 条），再跑 `xforge inspect --hygiene`，再篡改一条 receipt 验 `inspect` 报链断 |
| 计分口径 | tokens 按 `claude -p` 报的 usage 逐轮累加：`input` 是未命中缓存的输入，`cache_read`/`cache_creation` 是缓存读写，`output` 是生成；只报 tokens，不折算费用 |

矩阵定义见 `docs/design/live-test.md` D13；复现命令：`node scripts/live-matrix.mjs --engine A`、`node scripts/live-matrix.mjs --engine B`。

## 引擎 A（20 场，全部归档）

| 场景 | 治理 | 驱动 | 结果 | 外层轮 | 内部轮 | 返工 | oracle | input | output | cache_read | cache_creation | xforge 调用 | show 调用 | 直读 changes/** | design 整读 | 工具调用 | 执法 deny | inspect | 篡改检测 | 用时（分） | 人的动作 | 运行目录 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quick | TT | orchestrated · en | archived | 4 | 28 | 0 | 3/3 | 54 | 15611 | 604052 | 73552 | 31 | 3 | 3 | 0 | 41 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 5 | 9 | `2026-09-17T05-56-46-627Z` |
| quick | TT | orchestrated | archived | 4 | 27 | 0 | 3/3 | 52 | 17640 | 548386 | 76584 | 32 | 2 | 6 | 0 | 39 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 5 | 9 | `2026-09-17T05-55-22-267Z` |
| quick | TF | orchestrated | archived | 4 | 27 | 0 | 3/3 | 52 | 15923 | 605365 | 79868 | 32 | 2 | 4 | 0 | 40 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 5 | 8 | `2026-09-17T06-07-31-132Z` |
| quick | FT | orchestrated | archived | 4 | 26 | 0 | 3/3 | 50 | 14755 | 561989 | 70348 | 32 | 2 | 5 | 0 | 39 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 5 | 8 | `2026-09-17T06-07-31-447Z` |
| quick | FF | orchestrated | archived | 5 | 35 | 0 | 3/3 | 68 | 17804 | 804220 | 88762 | 38 | 2 | 3 | 0 | 44 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 5 | 7 | `2026-09-17T05-56-37-446Z` |
| solid | TT | orchestrated | archived | 7 | 45 | 0 | 4/4 | 90 | 34317 | 1015953 | 128678 | 57 | 6 | 6 | 0 | 69 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 31 | 18 | `2026-09-17T03-51-22-124Z` |
| solid | TT | orchestrated | archived | 7 | 44 | 0 | 4/4 | 84 | 26989 | 893002 | 146956 | 56 | 6 | 8 | 0 | 70 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 10 | 17 | `2026-09-17T04-25-14-635Z` |
| solid | TT | orchestrated | archived | 7 | 41 | 0 | 4/4 | 80 | 29475 | 900788 | 118407 | 55 | 6 | 9 | 0 | 68 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 10 | 16 | `2026-09-17T04-25-16-023Z` |
| solid | TT | stepwise | archived | 11 | 64 | 0 | 4/4 | 124 | 35110 | 1440746 | 203786 | 54 | 4 | 4 | 0 | 62 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 9 | 18 | `2026-09-17T05-56-49-876Z` |
| solid | TF | orchestrated | archived | 7 | 43 | 0 | 4/4 | 84 | 33107 | 975953 | 119176 | 52 | 5 | 10 | 0 | 64 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 11 | 15 | `2026-09-17T06-01-08-686Z` |
| solid | FT | orchestrated | archived | 7 | 39 | 0 | 4/4 | 74 | 28341 | 801869 | 122421 | 50 | 5 | 10 | 0 | 61 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 10 | 17 | `2026-09-17T05-56-43-425Z` |
| solid-rework | TT | orchestrated | archived | 8 | 50 | 1 | 4/4 | 98 | 39083 | 1137208 | 152309 | 67 | 6 | 9 | 0 | 81 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 12 | 16 | `2026-09-17T05-55-25-123Z` |
| solid-rework | TF | orchestrated | archived | 8 | 46 | 1 | 4/4 | 90 | 36452 | 1010416 | 138842 | 55 | 4 | 8 | 0 | 70 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 11 | 13 | `2026-09-17T06-07-29-416Z` |
| solid-rework | FT | orchestrated | archived | 8 | 50 | 1 | 4/4 | 98 | 35278 | 1098186 | 141289 | 67 | 5 | 4 | 0 | 80 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 12 | 19 | `2026-09-17T06-07-31-804Z` |
| solid-rework | FF | orchestrated | archived | 8 | 51 | 1 | 4/4 | 100 | 34188 | 1150576 | 140325 | 55 | 4 | 7 | 0 | 72 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 10 | 14 | `2026-09-17T06-12-24-456Z` |
| major | TT | orchestrated | archived | 8 | 49 | 0 | 4/4 | 94 | 34825 | 1033340 | 134369 | 58 | 5 | 9 | 0 | 74 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 12 | 23 | `2026-09-17T05-55-28-336Z` |
| major | TT | stepwise | archived | 14 | 88 | 0 | 4/4 | 174 | 62897 | 2232842 | 305122 | 75 | 6 | 9 | 0 | 91 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 16 | 26 | `2026-09-17T06-12-28-449Z` |
| major | TF | orchestrated | archived | 7 | 46 | 0 | 4/4 | 88 | 32323 | 973856 | 119772 | 52 | 5 | 7 | 0 | 65 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 11 | 19 | `2026-09-17T06-12-32-380Z` |
| major | FT | orchestrated | archived | 8 | 51 | 0 | 4/4 | 100 | 36058 | 1135269 | 132033 | 67 | 5 | 13 | 0 | 81 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 13 | 22 | `2026-09-17T06-18-25-573Z` |
| major | FF | orchestrated | archived | 8 | 43 | 0 | 4/4 | 84 | 29547 | 875873 | 124116 | 51 | 4 | 9 | 0 | 63 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 11 | 20 | `2026-09-17T06-19-29-760Z` |

合计：output 609723，cache_read 19799889，cache_creation 2616715，input 1738。

未计入的一场：`solid`（`2026-09-17T03-51-23-400Z`）停在 apply: plan-missing,unclaimed:design.md,unclaimed:scope.yaml,unclaimed:work-packages.yaml。原因是 design 执行者把产出写到了项目根而不是 Change 目录，而当时门的当前判定不看站，propose 站通过的 structure 记录被当成 design 站的当前，站空着出去了。这个洞在 `5e2f0f3` 修了（门记录按站钉住），之后的所有运行都在修复后的代码上。

## 引擎 B（5 场，全部归档）

| 场景 | 治理 | 驱动 | 结果 | 外层轮 | 内部轮 | 返工 | oracle | input | output | cache_read | cache_creation | xforge 调用 | show 调用 | 直读 changes/** | design 整读 | 工具调用 | 执法 deny | inspect | 篡改检测 | 用时（分） | 人的动作 | 运行目录 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quick | TT | orchestrated | archived | 4 | 79 | 0 | 3/3 | 124348 | 48911 | 1933952 | 0 | 78 | 3 | 24 | 0 | 169 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 15 | 9 | `2026-09-17T06-44-28-182Z` |
| quick | FF | orchestrated | archived | 4 | 83 | 0 | 3/3 | 134831 | 64849 | 2165248 | 0 | 75 | 7 | 21 | 0 | 152 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 22 | 7 | `2026-09-17T06-44-28-804Z` |
| solid | TT | orchestrated | archived | 6 | 103 | 0 | 4/4 | 142019 | 81367 | 3345536 | 0 | 126 | 6 | 64 | 3 | 302 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 33 | 13 | `2026-09-17T06-44-26-366Z` |
| solid | FF | orchestrated | archived | 8 | 129 | 0 | 4/4 | 244299 | 157603 | 3766016 | 0 | 162 | 12 | 51 | 2 | 335 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 46 | 25 | `2026-09-17T06-44-27-050Z` |
| solid | FF | stepwise | archived | 11 | 382 | 0 | 4/4 | 485486 | 293128 | 13812352 | 0 | 306 | 8 | 63 | 5 | 484 | 0 | 0 | 退出码 3，XF-INSPECT-001 | 42 | 12 | `2026-09-17T06-44-28-491Z` |

合计：output 645858，cache_read 25023104，cache_creation 0，input 1130983。

## 读法与结论

- **全部 25 场归档、oracle 全过、执法 deny 全零、inspect 全干净、篡改全部检出。** 返工场景四种治理组合都恰好返工一次。四种治理组合在三条流程上交叉全过，关着的基线一字未动、开着的都合并了。
- **引擎 A 的成本基线**：quick 4–5 轮 / 15–18k output / 31–38 次 xforge 调用；solid（含返工）7–8 轮 / 28–39k / 50–67 次；major 7–8 轮 / 30–36k / 51–67 次。同配置两次之间的波动约 ±20%，比这个小的差别不能当结论。
- **stepwise 比 orchestrated 贵**：major TT 从 34.8k / 58 次到 62.9k / 75 次，solid 从 32k 到 35k。手敲逐站不隔离上下文，站越多越贵；它的价值是可控，不是省。
- **引擎 B 比引擎 A 贵 2–4 倍**（同场景 output），stepwise 下到 8 倍（solid FF 293k）。原因是这个模型一站里步数多、爱翻源码找答案；子代理隔离对它的价值比对 Claude 更大。
- **英文投影与中文投影在 quick 上没有可见差别**（15.6k 对 17.6k，31 次对 32 次）。

## 附录：逐轮数据

#### claude · quick · TT · orchestrated · en（`2026-09-17T05-56-46-627Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 24 | 6789 | 305636 | 35747 | 13 | 104 |
| 2 | 8 | 2675 | 68535 | 13777 | 4 | 59 |
| 3 | 16 | 5701 | 174865 | 20517 | 8 | 104 |
| 4 | 6 | 446 | 55016 | 3511 | 3 | 14 |

人的动作（harness 扮演）：轮1 attest delivery P-01 integrate；轮2 attest delivery P-02 integrate；轮3 attest verification-receipt#structure；轮3 attest verification-receipt#ledgers；轮3 attest verification-receipt#unit-tests；轮3 attest verification-receipt#spec-delta；轮3 attest verification-receipt#interface-delta；轮4 attest approve --archive --decision；轮4 advance --archive

#### claude · quick · TT · orchestrated（`2026-09-17T05-55-22-267Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 20 | 6426 | 239108 | 34439 | 11 | 104 |
| 2 | 10 | 2849 | 90124 | 15014 | 5 | 61 |
| 3 | 12 | 5437 | 118320 | 19435 | 6 | 91 |
| 4 | 10 | 2928 | 100834 | 7696 | 5 | 42 |

人的动作（harness 扮演）：轮1 attest delivery P-01 integrate；轮2 attest delivery P-02 integrate；轮3 attest verification-receipt#structure；轮3 attest verification-receipt#ledgers；轮3 attest verification-receipt#unit-tests；轮3 attest verification-receipt#spec-delta；轮3 attest verification-receipt#interface-delta；轮4 attest approve --archive --decision；轮4 advance --archive

#### claude · quick · TF · orchestrated（`2026-09-17T06-07-31-132Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`package-pending:P-02`；基线变动：规格 变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 26 | 7449 | 367116 | 39388 | 14 | 114 |
| 2 | 8 | 2523 | 68753 | 13788 | 4 | 64 |
| 3 | 12 | 5428 | 120080 | 17632 | 6 | 102 |
| 4 | 6 | 523 | 49416 | 9060 | 3 | 12 |

人的动作（harness 扮演）：轮1 attest delivery P-01 integrate；轮2 attest delivery P-02 integrate；轮3 attest verification-receipt#structure；轮3 attest verification-receipt#ledgers；轮3 attest verification-receipt#unit-tests；轮3 attest verification-receipt#spec-delta；轮4 attest approve --archive --decision；轮4 advance --archive

#### claude · quick · FT · orchestrated（`2026-09-17T06-07-31-447Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`package-pending:P-02`；基线变动：规格 不变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 24 | 6498 | 319516 | 35930 | 13 | 107 |
| 2 | 8 | 2477 | 68489 | 13636 | 4 | 66 |
| 3 | 12 | 5222 | 119012 | 17181 | 6 | 94 |
| 4 | 6 | 558 | 54972 | 3601 | 3 | 16 |

人的动作（harness 扮演）：轮1 attest delivery P-01 integrate；轮2 attest delivery P-02 integrate；轮3 attest verification-receipt#structure；轮3 attest verification-receipt#ledgers；轮3 attest verification-receipt#unit-tests；轮3 attest verification-receipt#interface-delta；轮4 attest approve --archive --decision；轮4 advance --archive

#### claude · quick · FF · orchestrated（`2026-09-17T05-56-37-446Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`package-pending:P-02`；基线变动：规格 不变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 28 | 6729 | 422057 | 39124 | 15 | 78 |
| 2 | 14 | 3004 | 140446 | 17728 | 7 | 73 |
| 3 | 8 | 2459 | 68207 | 11804 | 4 | 61 |
| 4 | 12 | 4942 | 118671 | 16644 | 6 | 78 |
| 5 | 6 | 670 | 54839 | 3462 | 3 | 16 |

人的动作（harness 扮演）：轮2 attest delivery P-01 integrate；轮3 attest delivery P-02 integrate；轮4 attest verification-receipt#structure；轮4 attest verification-receipt#ledgers；轮4 attest verification-receipt#unit-tests；轮5 attest approve --archive --decision；轮5 advance --archive

#### claude · solid · TT · orchestrated（`2026-09-17T03-51-22-124Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 28 | 11665 | 405799 | 47122 | 15 | 249 |
| 2 | 10 | 3696 | 95480 | 16041 | 5 | 46 |
| 3 | 16 | 5863 | 167469 | 17624 | 7 | 1280 |
| 4 | 8 | 2984 | 70620 | 12304 | 4 | 83 |
| 5 | 4 | 734 | 28968 | 8665 | 2 | 19 |
| 6 | 14 | 6306 | 148475 | 18880 | 7 | 133 |
| 7 | 10 | 3069 | 99142 | 8042 | 5 | 40 |

人的动作（harness 扮演）：轮1 resolve open findings；轮1 attest approve --stage check；轮2 attest review-findings#F-001；轮2 attest review-findings#F-002；轮2 attest review-findings#F-003；轮2 attest review-findings#F-004；轮2 attest review-findings#F-005；轮3 attest delivery P-01 integrate；轮4 attest delivery P-02 integrate；轮5 attest delivery P-02 review；轮6 attest verification-receipt#structure；轮6 attest verification-receipt#ledgers；轮6 attest verification-receipt#unit-tests；轮6 attest verification-receipt#spec-delta；轮6 attest verification-receipt#interface-delta；轮6 attest verification-receipt#interface-compat；轮7 attest approve --archive --decision；轮7 advance --archive

#### claude · solid · TT · orchestrated（`2026-09-17T04-25-14-635Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 26 | 4989 | 339700 | 58597 | 15 | 176 |
| 2 | 8 | 3620 | 68087 | 15278 | 4 | 51 |
| 3 | 14 | 5425 | 145228 | 19616 | 7 | 115 |
| 4 | 8 | 3101 | 67283 | 12398 | 4 | 73 |
| 5 | 4 | 414 | 29109 | 8796 | 2 | 15 |
| 6 | 14 | 6145 | 146346 | 19166 | 7 | 119 |
| 7 | 10 | 3295 | 97249 | 13105 | 5 | 53 |

人的动作（harness 扮演）：轮1 resolve open findings；轮1 attest approve --stage check；轮2 attest review-findings#F-001；轮2 attest review-findings#F-002；轮2 attest review-findings#F-003；轮2 attest review-findings#F-004；轮3 attest delivery P-01 integrate；轮4 attest delivery P-02 integrate；轮5 attest delivery P-02 review；轮6 attest verification-receipt#structure；轮6 attest verification-receipt#ledgers；轮6 attest verification-receipt#unit-tests；轮6 attest verification-receipt#spec-delta；轮6 attest verification-receipt#interface-delta；轮6 attest verification-receipt#interface-compat；轮7 attest approve --archive --decision；轮7 advance --archive

#### claude · solid · TT · orchestrated（`2026-09-17T04-25-16-023Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 28 | 10917 | 407704 | 45769 | 15 | 222 |
| 2 | 8 | 3419 | 69503 | 14844 | 4 | 58 |
| 3 | 14 | 5219 | 144375 | 19095 | 7 | 106 |
| 4 | 8 | 2909 | 71056 | 12570 | 4 | 71 |
| 5 | 4 | 602 | 29110 | 8827 | 2 | 19 |
| 6 | 12 | 6022 | 123597 | 13558 | 6 | 132 |
| 7 | 6 | 387 | 55443 | 3744 | 3 | 19 |

人的动作（harness 扮演）：轮1 resolve open findings；轮1 attest approve --stage check；轮2 attest review-findings#F-001；轮2 attest review-findings#F-002；轮2 attest review-findings#F-003；轮3 attest delivery P-01 integrate；轮4 attest delivery P-02 integrate；轮5 attest delivery P-02 review；轮6 attest verification-receipt#structure；轮6 attest verification-receipt#ledgers；轮6 attest verification-receipt#unit-tests；轮6 attest verification-receipt#spec-delta；轮6 attest verification-receipt#interface-delta；轮6 attest verification-receipt#interface-compat；轮7 attest approve --archive --decision；轮7 advance --archive

#### claude · solid · TT · stepwise（`2026-09-17T05-56-49-876Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-missing`, `ledger-missing`, `gate-stale`, `attest-missing`, `package-pending:P-01`, `package-pending:P-02`；基线变动：规格 变 · 接口 变；报了下一步 Skill 的轮数 11/11

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 18 | 6088 | 216669 | 37346 | 10 | 71 |
| 2 | 12 | 5483 | 140817 | 26438 | 6 | 63 |
| 3 | 12 | 5568 | 156663 | 29365 | 6 | 65 |
| 4 | 10 | 1971 | 106471 | 10683 | 5 | 29 |
| 5 | 8 | 1305 | 78450 | 7380 | 4 | 24 |
| 6 | 14 | 2632 | 147360 | 14324 | 7 | 85 |
| 7 | 12 | 2405 | 121407 | 14206 | 6 | 80 |
| 8 | 8 | 779 | 70623 | 10484 | 4 | 19 |
| 9 | 6 | 572 | 54879 | 4687 | 3 | 15 |
| 10 | 16 | 6911 | 266609 | 39479 | 9 | 79 |
| 11 | 8 | 1396 | 80798 | 9394 | 4 | 25 |

人的动作（harness 扮演）：轮2 attest approve --stage check；轮3 resolve open findings；轮4 attest review-findings#F-001；轮4 attest review-findings#F-002；轮4 attest review-findings#F-003；轮4 attest review-findings#F-004；轮4 attest review-findings#F-005；轮6 attest delivery P-01 integrate；轮7 attest delivery P-02 integrate；轮8 attest delivery P-02 review；轮10 attest verification-receipt#structure；轮10 attest verification-receipt#ledgers；轮10 attest verification-receipt#unit-tests；轮10 attest verification-receipt#spec-delta；轮10 attest verification-receipt#interface-delta；轮10 attest verification-receipt#interface-compat；轮11 attest approve --archive --decision；轮11 advance --archive

#### claude · solid · TF · orchestrated（`2026-09-17T06-01-08-686Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 26 | 11712 | 397657 | 48664 | 14 | 225 |
| 2 | 8 | 3464 | 70035 | 15243 | 4 | 50 |
| 3 | 14 | 5367 | 152158 | 12249 | 7 | 111 |
| 4 | 8 | 2816 | 70979 | 12470 | 4 | 75 |
| 5 | 4 | 387 | 29127 | 8799 | 2 | 12 |
| 6 | 14 | 6343 | 154372 | 13604 | 7 | 123 |
| 7 | 10 | 3018 | 101625 | 8147 | 5 | 43 |

人的动作（harness 扮演）：轮1 resolve open findings；轮1 attest approve --stage check；轮2 attest review-findings#F-001；轮2 attest review-findings#F-002；轮2 attest review-findings#F-003；轮2 attest review-findings#F-004；轮3 attest delivery P-01 integrate；轮4 attest delivery P-02 integrate；轮5 attest delivery P-02 review；轮6 attest verification-receipt#structure；轮6 attest verification-receipt#ledgers；轮6 attest verification-receipt#unit-tests；轮6 attest verification-receipt#spec-delta；轮7 attest approve --archive --decision；轮7 advance --archive

#### claude · solid · FT · orchestrated（`2026-09-17T05-56-43-425Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 不变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 24 | 10587 | 340041 | 47107 | 13 | 211 |
| 2 | 8 | 3239 | 69923 | 15089 | 4 | 50 |
| 3 | 12 | 4948 | 117666 | 17125 | 6 | 107 |
| 4 | 8 | 2712 | 70799 | 12271 | 4 | 68 |
| 5 | 4 | 484 | 29138 | 8675 | 2 | 13 |
| 6 | 12 | 5813 | 126482 | 12898 | 7 | 121 |
| 7 | 6 | 558 | 47820 | 9256 | 3 | 13 |

人的动作（harness 扮演）：轮1 resolve open findings；轮1 attest approve --stage check；轮2 attest review-findings#F-001；轮2 attest review-findings#F-002；轮2 attest review-findings#F-003；轮2 attest review-findings#F-004；轮2 attest review-findings#F-005；轮3 attest delivery P-01 integrate；轮4 attest delivery P-02 integrate；轮5 attest delivery P-02 review；轮6 attest verification-receipt#structure；轮6 attest verification-receipt#ledgers；轮6 attest verification-receipt#unit-tests；轮6 attest verification-receipt#interface-delta；轮6 attest verification-receipt#interface-compat；轮7 attest approve --archive --decision；轮7 advance --archive

#### claude · solid-rework · TT · orchestrated（`2026-09-17T05-55-25-123Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 26 | 11646 | 417249 | 51017 | 14 | 222 |
| 2 | 16 | 6158 | 179626 | 22432 | 8 | 91 |
| 3 | 8 | 3117 | 71450 | 12915 | 4 | 43 |
| 4 | 12 | 5147 | 118260 | 17083 | 6 | 99 |
| 5 | 8 | 2956 | 71062 | 12541 | 4 | 74 |
| 6 | 4 | 472 | 28985 | 8690 | 2 | 12 |
| 7 | 14 | 6249 | 148510 | 19138 | 7 | 120 |
| 8 | 10 | 3338 | 102066 | 8493 | 5 | 50 |

人的动作（harness 扮演）：轮1 rework-to design；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮3 attest review-findings#F-002；轮4 attest delivery P-01 integrate；轮5 attest delivery P-02 integrate；轮6 attest delivery P-02 review；轮7 attest verification-receipt#structure；轮7 attest verification-receipt#ledgers；轮7 attest verification-receipt#unit-tests；轮7 attest verification-receipt#spec-delta；轮7 attest verification-receipt#interface-delta；轮7 attest verification-receipt#interface-compat；轮8 attest approve --archive --decision；轮8 advance --archive

#### claude · solid-rework · TF · orchestrated（`2026-09-17T06-07-29-416Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 24 | 10954 | 354210 | 46679 | 13 | 194 |
| 2 | 16 | 6362 | 179998 | 22479 | 8 | 87 |
| 3 | 8 | 3324 | 71083 | 12946 | 4 | 48 |
| 4 | 12 | 5593 | 121965 | 18091 | 6 | 105 |
| 5 | 8 | 2996 | 71189 | 12484 | 4 | 67 |
| 6 | 4 | 546 | 29145 | 8881 | 2 | 13 |
| 7 | 12 | 6079 | 127342 | 13358 | 6 | 115 |
| 8 | 6 | 598 | 55484 | 3924 | 3 | 15 |

人的动作（harness 扮演）：轮1 rework-to design；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮4 attest delivery P-01 integrate；轮5 attest delivery P-02 integrate；轮6 attest delivery P-02 review；轮7 attest verification-receipt#structure；轮7 attest verification-receipt#ledgers；轮7 attest verification-receipt#unit-tests；轮7 attest verification-receipt#spec-delta；轮8 attest approve --archive --decision；轮8 advance --archive

#### claude · solid-rework · FT · orchestrated（`2026-09-17T06-07-31-804Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 不变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 30 | 10893 | 434598 | 46564 | 16 | 229 |
| 2 | 16 | 5988 | 178600 | 21578 | 8 | 100 |
| 3 | 6 | 1373 | 48011 | 10205 | 3 | 20 |
| 4 | 12 | 5052 | 119918 | 16906 | 6 | 110 |
| 5 | 10 | 2908 | 92317 | 12405 | 5 | 77 |
| 6 | 4 | 511 | 29144 | 8671 | 2 | 13 |
| 7 | 12 | 5768 | 126307 | 12618 | 6 | 118 |
| 8 | 8 | 2785 | 69291 | 12342 | 4 | 38 |

人的动作（harness 扮演）：轮1 plant design fault (late)；轮1 rework-to design；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮3 attest review-findings#F-002；轮3 attest review-findings#F-003；轮3 attest review-findings#F-004；轮3 attest review-findings#F-005；轮4 attest delivery P-01 integrate；轮5 attest delivery P-02 integrate；轮6 attest delivery P-02 review；轮7 attest verification-receipt#structure；轮7 attest verification-receipt#ledgers；轮7 attest verification-receipt#unit-tests；轮7 attest verification-receipt#interface-delta；轮7 attest verification-receipt#interface-compat；轮8 attest approve --archive --decision；轮8 advance --archive

#### claude · solid-rework · FF · orchestrated（`2026-09-17T06-12-24-456Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 不变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 30 | 10701 | 458965 | 48019 | 16 | 197 |
| 2 | 16 | 5664 | 175990 | 21559 | 8 | 84 |
| 3 | 10 | 3526 | 96036 | 14187 | 5 | 52 |
| 4 | 12 | 4938 | 125441 | 11561 | 6 | 99 |
| 5 | 8 | 2630 | 70763 | 12231 | 4 | 75 |
| 6 | 6 | 849 | 47694 | 11609 | 3 | 15 |
| 7 | 12 | 5342 | 120557 | 17651 | 6 | 78 |
| 8 | 6 | 538 | 55130 | 3508 | 3 | 14 |

人的动作（harness 扮演）：轮1 rework-to design；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮3 attest review-findings#F-002；轮3 attest review-findings#F-003；轮4 attest delivery P-01 integrate；轮5 attest delivery P-02 integrate；轮6 attest delivery P-02 review；轮7 attest verification-receipt#structure；轮7 attest verification-receipt#ledgers；轮7 attest verification-receipt#unit-tests；轮8 attest approve --archive --decision；轮8 advance --archive

#### claude · major · TT · orchestrated（`2026-09-17T05-55-28-336Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-01`, `package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 20 | 6266 | 253395 | 36495 | 11 | 74 |
| 2 | 22 | 8160 | 272916 | 29429 | 12 | 205 |
| 3 | 10 | 3875 | 95925 | 16346 | 5 | 53 |
| 4 | 12 | 5731 | 127347 | 12286 | 6 | 107 |
| 5 | 8 | 3423 | 71352 | 13175 | 4 | 118 |
| 6 | 4 | 527 | 29112 | 8973 | 2 | 13 |
| 7 | 12 | 6136 | 127768 | 13567 | 6 | 128 |
| 8 | 6 | 707 | 55525 | 4098 | 3 | 16 |

人的动作（harness 扮演）：轮1 attest exit/material-questions#Q-001；轮1 attest exit/material-questions#Q-002；轮1 attest exit/material-questions#Q-003；轮1 attest exit/material-questions#Q-004；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮3 attest review-findings#F-002；轮3 attest review-findings#F-003；轮3 attest review-findings#F-004；轮3 attest review-findings#F-005；轮4 attest delivery P-01 integrate；轮5 attest delivery P-01 review；轮5 attest delivery P-02 integrate；轮6 attest delivery P-02 review；轮7 attest verification-receipt#structure；轮7 attest verification-receipt#ledgers；轮7 attest verification-receipt#unit-tests；轮7 attest verification-receipt#spec-delta；轮7 attest verification-receipt#interface-delta；轮7 attest verification-receipt#interface-compat；轮8 attest approve --archive --decision；轮8 advance --archive

#### claude · major · TT · stepwise（`2026-09-17T06-12-28-449Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-failed`, `ledger-missing`, `gate-stale`, `gate-missing`, `attest-missing`, `package-pending:P-01`, `package-pending:P-02`, `package-pending:P-03`；基线变动：规格 变 · 接口 变；报了下一步 Skill 的轮数 12/14

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 18 | 8574 | 245921 | 38160 | 10 | 98 |
| 2 | 10 | 3514 | 97847 | 18455 | 5 | 43 |
| 3 | 8 | 1004 | 75520 | 16115 | 4 | 19 |
| 4 | 16 | 15358 | 253760 | 41149 | 8 | 159 |
| 5 | 18 | 9495 | 331003 | 44980 | 9 | 107 |
| 6 | 10 | 1930 | 106692 | 10341 | 5 | 29 |
| 7 | 10 | 1685 | 104501 | 8934 | 5 | 27 |
| 8 | 14 | 3910 | 152591 | 16022 | 7 | 89 |
| 9 | 14 | 3637 | 147728 | 15361 | 7 | 101 |
| 10 | 12 | 3523 | 127997 | 16248 | 6 | 163 |
| 11 | 10 | 1193 | 101153 | 14654 | 5 | 24 |
| 12 | 6 | 848 | 55549 | 5078 | 3 | 18 |
| 13 | 20 | 7177 | 356161 | 44110 | 10 | 79 |
| 14 | 8 | 1049 | 76419 | 15515 | 4 | 19 |

人的动作（harness 扮演）：轮2 attest exit/material-questions#Q-001；轮2 attest exit/material-questions#Q-002；轮2 attest exit/material-questions#Q-003；轮2 attest exit/material-questions#Q-004；轮2 attest exit/material-questions#Q-005；轮2 attest exit/material-questions#Q-006；轮4 attest approve --stage check；轮5 resolve open findings；轮6 attest review-findings#F-001；轮6 attest review-findings#F-002；轮6 attest review-findings#F-003；轮6 attest review-findings#F-004；轮6 attest review-findings#F-005；轮8 attest delivery P-01 integrate；轮9 attest delivery P-02 integrate；轮10 attest delivery P-02 review；轮10 attest delivery P-03 integrate；轮11 attest delivery P-03 review；轮13 attest verification-receipt#structure；轮13 attest verification-receipt#ledgers；轮13 attest verification-receipt#unit-tests；轮13 attest verification-receipt#spec-delta；轮13 attest verification-receipt#interface-delta；轮13 attest verification-receipt#interface-compat；轮14 attest approve --archive --decision；轮14 advance --archive

#### claude · major · TF · orchestrated（`2026-09-17T06-12-32-380Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-01`；基线变动：规格 变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 20 | 6587 | 247536 | 34421 | 11 | 86 |
| 2 | 18 | 8256 | 206000 | 27504 | 10 | 214 |
| 3 | 10 | 4287 | 98977 | 16542 | 5 | 56 |
| 4 | 14 | 5366 | 152568 | 12119 | 7 | 142 |
| 5 | 4 | 542 | 29132 | 8771 | 2 | 14 |
| 6 | 16 | 6584 | 184080 | 16369 | 8 | 121 |
| 7 | 6 | 701 | 55563 | 4046 | 3 | 16 |

人的动作（harness 扮演）：轮1 attest exit/material-questions#Q-001；轮1 attest exit/material-questions#Q-002；轮1 attest exit/material-questions#Q-003；轮1 attest exit/material-questions#Q-004；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮3 attest review-findings#F-002；轮3 attest review-findings#F-003；轮3 attest review-findings#F-004；轮3 attest review-findings#F-005；轮4 attest delivery P-01 integrate；轮5 attest delivery P-01 review；轮6 attest verification-receipt#structure；轮6 attest verification-receipt#ledgers；轮6 attest verification-receipt#unit-tests；轮6 attest verification-receipt#spec-delta；轮7 attest approve --archive --decision；轮7 advance --archive

#### claude · major · FT · orchestrated（`2026-09-17T06-18-25-573Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-01`, `package-pending:P-02`；基线变动：规格 不变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 22 | 6631 | 312301 | 40255 | 12 | 76 |
| 2 | 20 | 7341 | 239266 | 26899 | 10 | 236 |
| 3 | 10 | 3881 | 103373 | 10465 | 5 | 55 |
| 4 | 12 | 5150 | 126001 | 11631 | 6 | 113 |
| 5 | 8 | 3205 | 71190 | 12792 | 4 | 106 |
| 6 | 4 | 758 | 29133 | 8818 | 2 | 16 |
| 7 | 14 | 6149 | 152712 | 13196 | 7 | 128 |
| 8 | 10 | 2943 | 101293 | 7977 | 5 | 41 |

人的动作（harness 扮演）：轮1 attest exit/material-questions#Q-001；轮1 attest exit/material-questions#Q-002；轮1 attest exit/material-questions#Q-003；轮1 attest exit/material-questions#Q-004；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮3 attest review-findings#F-002；轮3 attest review-findings#F-003；轮3 attest review-findings#F-004；轮3 attest review-findings#F-005；轮4 attest delivery P-01 integrate；轮5 attest delivery P-01 review；轮5 attest delivery P-02 integrate；轮6 attest delivery P-02 review；轮7 attest verification-receipt#structure；轮7 attest verification-receipt#ledgers；轮7 attest verification-receipt#unit-tests；轮7 attest verification-receipt#interface-delta；轮7 attest verification-receipt#interface-compat；轮8 attest approve --archive --decision；轮8 advance --archive

#### claude · major · FF · orchestrated（`2026-09-17T06-19-29-760Z`）

模型：`claude-haiku-4-5-20251001+claude-opus-5[1m]`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-01`, `package-pending:P-02`；基线变动：规格 不变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 14 | 5352 | 159987 | 34114 | 8 | 63 |
| 2 | 20 | 7945 | 234277 | 26592 | 10 | 235 |
| 3 | 8 | 1750 | 73476 | 14509 | 4 | 29 |
| 4 | 12 | 5022 | 125939 | 11718 | 6 | 135 |
| 5 | 8 | 3055 | 71320 | 12685 | 4 | 77 |
| 6 | 4 | 446 | 29156 | 8736 | 2 | 12 |
| 7 | 12 | 5444 | 126466 | 12193 | 6 | 77 |
| 8 | 6 | 533 | 55252 | 3569 | 3 | 15 |

人的动作（harness 扮演）：轮1 attest exit/material-questions#Q-001；轮1 attest exit/material-questions#Q-002；轮2 resolve open findings；轮2 attest approve --stage check；轮3 attest review-findings#F-001；轮3 attest review-findings#F-002；轮3 attest review-findings#F-003；轮3 attest review-findings#F-004；轮3 attest review-findings#F-005；轮3 attest review-findings#F-006；轮3 attest review-findings#F-007；轮4 attest delivery P-01 integrate；轮5 attest delivery P-01 review；轮5 attest delivery P-02 integrate；轮6 attest delivery P-02 review；轮7 attest verification-receipt#structure；轮7 attest verification-receipt#ledgers；轮7 attest verification-receipt#unit-tests；轮8 attest approve --archive --decision；轮8 advance --archive

#### gateway · quick · TT · orchestrated（`2026-09-17T06-44-28-182Z`）

模型：`deepseek-v4-flash`；阻塞过的 token：`package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 55777 | 31173 | 1571072 | 0 | 58 | 371 |
| 2 | 23800 | 7716 | 142336 | 0 | 8 | 163 |
| 3 | 22624 | 5634 | 113408 | 0 | 7 | 178 |
| 4 | 22147 | 4388 | 107136 | 0 | 6 | 176 |

人的动作（harness 扮演）：轮1 attest delivery P-01 integrate；轮2 attest delivery P-02 integrate；轮3 attest verification-receipt#structure；轮3 attest verification-receipt#ledgers；轮3 attest verification-receipt#unit-tests；轮3 attest verification-receipt#spec-delta；轮3 attest verification-receipt#interface-delta；轮4 attest approve --archive --decision；轮4 advance --archive

#### gateway · quick · FF · orchestrated（`2026-09-17T06-44-28-804Z`）

模型：`deepseek-v4-flash`；阻塞过的 token：`package-pending:P-02`；基线变动：规格 不变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 47481 | 28187 | 1268608 | 0 | 43 | 841 |
| 2 | 42488 | 22086 | 706560 | 0 | 29 | 236 |
| 3 | 22588 | 9333 | 96128 | 0 | 6 | 216 |
| 4 | 22274 | 5243 | 93952 | 0 | 5 | 42 |

人的动作（harness 扮演）：轮1 attest delivery P-01 integrate；轮2 attest delivery P-02 integrate；轮3 attest verification-receipt#structure；轮3 attest verification-receipt#ledgers；轮3 attest verification-receipt#unit-tests；轮4 attest approve --archive --decision；轮4 advance --archive

#### gateway · solid · TT · orchestrated（`2026-09-17T06-44-26-366Z`）

模型：`deepseek-v4-flash`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 变 · 接口 变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 52103 | 29764 | 1735936 | 0 | 54 | 754 |
| 2 | 911 | 878 | 52736 | 0 | 1 | 405 |
| 3 | 967 | 899 | 25856 | 0 | 1 | 181 |
| 4 | 43704 | 33624 | 1319552 | 0 | 36 | 315 |
| 5 | 23573 | 6629 | 141440 | 0 | 7 | 260 |
| 6 | 20761 | 9573 | 70016 | 0 | 4 | 56 |

人的动作（harness 扮演）：轮1 resolve open findings；轮1 attest approve --stage check；轮2 attest delivery P-01 integrate；轮3 attest delivery P-02 integrate；轮4 attest delivery P-02 review；轮5 attest verification-receipt#structure；轮5 attest verification-receipt#ledgers；轮5 attest verification-receipt#unit-tests；轮5 attest verification-receipt#spec-delta；轮5 attest verification-receipt#interface-delta；轮5 attest verification-receipt#interface-compat；轮6 attest approve --archive --decision；轮6 advance --archive

#### gateway · solid · FF · orchestrated（`2026-09-17T06-44-27-050Z`）

模型：`deepseek-v4-flash`；阻塞过的 token：`gate-stale`, `attest-missing`, `package-pending:P-02`；基线变动：规格 不变 · 接口 不变

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 59855 | 32337 | 2091520 | 0 | 55 | 714 |
| 2 | 29542 | 48942 | 659456 | 0 | 18 | 705 |
| 3 | 21326 | 5415 | 65280 | 0 | 4 | 279 |
| 4 | 29880 | 19642 | 223360 | 0 | 14 | 123 |
| 5 | 23011 | 5107 | 136448 | 0 | 7 | 203 |
| 6 | 21520 | 8045 | 70144 | 0 | 4 | 273 |
| 7 | 31708 | 21252 | 238720 | 0 | 14 | 136 |
| 8 | 27457 | 16863 | 281088 | 0 | 13 | 319 |

人的动作（harness 扮演）：轮1 resolve open findings；轮1 attest approve --stage check；轮2 attest delivery P-01 integrate；轮3 attest delivery P-02 integrate；轮4 attest delivery P-02 review；轮5 attest verification-receipt#structure（失败）；轮5 attest verification-receipt#ledgers（失败）；轮5 attest verification-receipt#unit-tests（失败）；轮5 attest verification-receipt#spec-delta（失败）；轮5 attest verification-receipt#interface-delta（失败）；轮5 attest verification-receipt#interface-compat（失败）；轮6 attest verification-receipt#structure（失败）；轮6 attest verification-receipt#ledgers（失败）；轮6 attest verification-receipt#unit-tests（失败）；轮6 attest verification-receipt#spec-delta（失败）；轮6 attest verification-receipt#interface-delta（失败）；轮6 attest verification-receipt#interface-compat（失败）；轮7 attest verification-receipt#structure（失败）；轮7 attest verification-receipt#ledgers（失败）；轮7 attest verification-receipt#unit-tests（失败）；轮7 attest verification-receipt#spec-delta（失败）；轮7 attest verification-receipt#interface-delta（失败）；轮7 attest verification-receipt#interface-compat（失败）；轮8 attest approve --archive --decision；轮8 advance --archive

#### gateway · solid · FF · stepwise（`2026-09-17T06-44-28-491Z`）

模型：`deepseek-v4-flash`；阻塞过的 token：`gate-missing`, `ledger-missing`, `gate-stale`, `attest-missing`, `package-pending:P-01`, `package-pending:P-02`；基线变动：规格 不变 · 接口 不变；报了下一步 Skill 的轮数 9/11

| 轮 | input | output | cache_read | cache_creation | 内部轮 | 用时（秒） |
|---|---|---|---|---|---|---|
| 1 | 40646 | 14313 | 615936 | 0 | 24 | 164 |
| 2 | 51810 | 29535 | 1483904 | 0 | 39 | 209 |
| 3 | 69893 | 80829 | 4791808 | 0 | 87 | 583 |
| 4 | 46476 | 31295 | 770048 | 0 | 40 | 235 |
| 5 | 42261 | 26074 | 866432 | 0 | 35 | 165 |
| 6 | 3548 | 3580 | 109184 | 0 | 5 | 148 |
| 7 | 48885 | 25459 | 1149440 | 0 | 34 | 365 |
| 8 | 36639 | 17731 | 563968 | 0 | 25 | 115 |
| 9 | 29214 | 9653 | 309248 | 0 | 13 | 63 |
| 10 | 65359 | 20469 | 1876352 | 0 | 37 | 290 |
| 11 | 50755 | 34190 | 1276032 | 0 | 43 | 211 |

人的动作（harness 扮演）：轮2 attest approve --stage check；轮3 resolve open findings；轮4 attest review-findings#F-001；轮4 attest review-findings#F-002；轮6 attest delivery P-01 integrate；轮7 attest delivery P-02 integrate；轮8 attest delivery P-02 review；轮10 attest verification-receipt#structure；轮10 attest verification-receipt#ledgers；轮10 attest verification-receipt#unit-tests；轮11 attest approve --archive --decision；轮11 advance --archive


## 补记：oracle 加强后的试跑（2026-09-17，提交 `22ae66a`）

发布验证之后，oracle 从 quick 3 / solid 4 / major 4 条加到 5 / 7 / 7 条（边角用例，先对参考实现验过），并加了 LT-07：规格治理开着时，Change 规格 delta 里每条 Requirement 必须被模型自写的测试或 `assurance.md` 的覆盖表引用，缺一条判失败。产品代码与 1.0.0 相同。四场试跑（两个引擎各跑 quick 与 solid-rework）：

| 引擎 | 场景 | 结果 | 外层轮 | 内部轮 | 返工 | oracle | REQ 覆盖 | input | output | cache_read | cache_creation | xforge 调用 | 工具调用 | 执法 deny | 用时（分） | 运行目录 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | quick | archived | 3 | 21 | 0 | 5/5 | 3/3 | 40 | 13216 | 462787 | 60291 | 22 | 27 | 0 | 4 | `2026-09-17T07-37-33-382Z` |
| A | solid-rework | archived | 9 | 52 | 1 | 7/7 | 4/4 | 102 | 38201 | 1137732 | 136422 | 64 | 83 | 0 | 12 | `2026-09-17T07-37-36-154Z` |
| B | quick | archived | 4 | 86 | 0 | 5/5 | 3/3 | 139425 | 69843 | 2199040 | 0 | 90 | 208 | 0 | 19 | `2026-09-17T07-37-39-393Z` |
| B | solid-rework | archived | 6 | 114 | 1 | 7/7 | 3/3 | 192462 | 87448 | 3417344 | 0 | 165 | 424 | 0 | 49 | `2026-09-17T07-37-42-806Z` |

读法：加强后的用例两个模型都全过，覆盖检查全满，A 的成本与上面的基线一致。这四场的 oracle 口径与基线的 25 场不同（用例更多），比较归档与否和成本可以，比较 oracle 通过数不可以。
