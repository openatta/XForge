# XForge 实现现状分析（2026-08-09）

> 本文是一次独立代码走查的结论，不是团队自己的测试报告（那是
> `docs/TEST_REPORT_2026-08-09.md`）。方法：对照 `docs/` 设计文档逐条核对
> `xforge/src`、`xforge/schemas`、`scaffold/payload` 的实际实现，并抽样精读
> 而非逐行全覆盖。未在本机执行 `npm run verify`（当前环境无 `node`/`npm`），
> 结论依赖静态代码阅读 + 团队自报的测试报告交叉验证，未做独立重跑。

## 总体结论

XForge 是目前少见的"文档先行、代码基本追平文档"的项目：七层治理模型
（Constitution → Rule/PermissionPolicy → Flow/Transition → Hook →
Gate/Approval → Evidence/Audit）不是停留在设计稿里的概念，而是能在
`core/governance.ts`、`core/audit.ts`、`runners/gate.ts`、
`commands/transition.ts`、`commands/approve.ts` 中逐字对应找到实现。三个
Flow（quick/solid/major）的 YAML 与 Schema 精确匹配设计文档给出的审批策略
差异（Solid 单人审批、Major 双人+职责分离+仅企业签名）。这在"AI 治理框架"
这个赛道里是少见的扎实程度。

主要问题不在"有没有做"，而在**文档层内部的新旧版本没有清理干净**，以及
部分能力天然受限于宿主编码工具（Adapter degraded），这些限制虽然文档里
诚实报告了，但仍构成使用上的真实风险点。

---

## 1. 整体设计

**结论：概念分层清晰，且分层在代码里是真实边界，不是命名装饰。**

- `governance-control-plane-design.md` 定义的 "Agent Runtime Plane vs
  XForge Workflow Plane" 双执行面，在代码里体现为：Runtime Hook（Adapter
  生成的桥接文件）永远不能直接写 Stage 或 Gate Evidence，只能把事件交给
  `recordAudit`；Workflow 侧的 Transition/Gate/Archive 完全由 CLI 自己的
  `core/control-plane.ts`、`runners/gate.ts` 决定，不依赖任何平台 Hook 是否
  触发。这个边界在 `transition.ts`、`approve.ts`、`gate.ts` 中是硬编码的
  函数调用顺序，不是靠文档承诺。
- "Rule 被加载 ≠ 被执行"、"Agent 的 PASS ≠ Machine Gate"、"Agent 不能自我
  批准" 这几条治理红线，分别对应代码里：Gate Evidence 必须由
  `runGate()` 真实起子进程并写 digest 才能存在；`approve.ts` 在非交互模式
  下强制要求外部签名 receipt（`XFORGE_APPROVAL_INTERACTIVE_REQUIRED`），
  Agent 无法在非交互环境下伪造本地批准。这是设计承诺被代码真正堵死的证据，
  不是纸面声明。
- **风险点**：整体设计的"事实来源"目前分散在三份文档里——
  `XFORGE_PRODUCT_SPEC.md`（v0.1.0 基线，1489 行）、
  `governance-control-plane-design.md`（Protocol 2，当前权威）、
  `product-baseline.md`（一个只有 13 行的重定向说明）。新读者或新接入的
  Agent 如果直接从 `XFORGE_PRODUCT_SPEC.md` 逐节读下去而不先看顶部的
  重定向提示，会在 Flow 命名、Flow Schema 结构、Rule/Hook 模型三处得到
  过时甚至错误的理解（见第 7 节）。

---

## 2. 命令行设计

**结论：命令面与文档完全对齐，"资源导向而非 CRUD"的克制设计被严格执行。**

- `cli.ts` 中 `CommandName` 类型枚举的 15 个命令
  （help/version/init/state/install/sync/update/uninstall/check/
  transition/approve/audit/work-package/hook/archive）与
  `XFORGE_PRODUCT_SPEC.md` 第 5 节、`governance-control-plane-design.md`
  第 9 节列出的命令模型逐一对应，没有"文档写了但代码没做"或反过来的
  命令。
- `state`/`check` 承担了原本可能拆成 `list/show/status/validate/doctor`
  等一堆命令的职责，符合"统一查询入口"的设计初衷。
- 写命令的执行顺序（resolve state → dry-run plan → 校验 authority/approval
  → 执行 → 写 evidence/audit → 返回一份 JSON envelope）在 `transition.ts`
  和 `approve.ts` 里是真实的代码流程，不是文档描述的理想模型。
- **风险点**：命令行为的正确性目前主要靠"自己的测试报告"背书
  （70 单元/集成 + 14 产品黑盒 + 4 验收全部 PASS），本次审阅没有独立
  重跑验证这些数字，只验证了实现逻辑与文档的一致性。建议下次有 Node
  环境时独立跑一次 `npm run verify` 交叉确认。

---

## 3. Sub-agent / Skill / Flow 设计

**结论：这是本次审阅中实现质量最高的一块，Flow Schema、Skill 骨架、
Agent 职责边界三者互相自洽。**

- 三个 Flow 文件（`scaffold/payload/xforge/flows/{quick,solid,major}.yaml`）
  使用统一 `apiVersion: xforge.dev/v1alpha2` Schema，仅通过
  `artifacts`/`stages`/`governance.approvalPolicies` 的内容差异表达风险
  分级，没有为三档 Flow 写三套 CLI 分支逻辑——这正是
  `product-baseline.md` 4.3 节承诺的"同一 Schema，不同内容"。Solid 的
  `planning-solid`/`closing-solid` 是 1 人审批、无职责分离；Major 的
  `implementation-major`/`closing-major` 是 2 人、`separationOfDuties:
  true`、且 `providers` 只允许 `enterprise-hmac`（不允许本地交互审批）——
  与设计文档 6.4 节的风险分层表完全一致，且这个差异是 Schema 数据驱动的，
  不是代码里 if/else 出来的。
- 12 个工作流 Skill（explore/propose/clarify/design/check/apply/verify/
  revise/archive/scaffold/status/continue）每个 `SKILL.md` 只有
  30~55 行，统一采用 `Invariants / Authority / Execution / Evidence /
  Stop and rework` 骨架。抽查的 `xforge-propose`、`xforge-continue` 内容
  密度很高：明确写出"只允许写哪些文件"、"遇到什么情况必须停"、给出精确
  到字段名的最小合法 YAML 示例、要求每次写入前后都重新查询 `xforge
  state`。这是能真正约束 LLM 行为的指令风格，而不是背景说明式文档。
- 三个子 Agent 定义（`worker.md`/`integrator.md`/`reviewer.md`）职责边界
  写得很硬：Worker 明确"不能转换 Stage、不能签 Approval、不能写 Gate/
  Audit Evidence，绝不能只凭文字自称 succeeded"；抽样读的 `worker.md`
  只有 24 行，但把 blocked/failed 的判定条件、交付契约字段
  （base/head commit、changed_paths、done_when_evidence、
  state_revision、policy_snapshot_digest、audit_correlation_id）都列全了。
- **风险点**：
  1. `XFORGE_PRODUCT_SPEC.md` 4.3/4.4 节描述的 Flow ID 是 `prime` 而非
     `major`，Flow Schema 是 `artifacts + operations`（如
     `operations.archive.mandatoryGates`）而非实际使用的
     `stages + governance + terminal`。这份文档仍被 README 列为
     "Product specification" 链接目标，容易让人对着旧 Schema 抄示例。
  2. `XFORGE_PRODUCT_SPEC.md` 4.4 节承诺的 Skill 骨架是
     "Purpose/Preconditions/State Query/Allowed Writes/Procedure/
     Verification/Stop Conditions" 七段式，实际 Skill 用的是五段式
     `Invariants/Authority/Execution/Evidence/Stop and rework`。功能等价，
     但字面对不上，会让"照文档核对 Skill 完整性"的检查产生误判。

---

## 4. Rules / PermissionPolicy / Hooks / Gates / Audit 设计

**结论：这五个概念在 Schema 和运行时层面被真正分开，没有互相冒充。**

- `schemas/rule.schema.json` 用 `oneOf(legacy, current)` 同时兼容
  `v1alpha1`（`level: mandatory/advisory/scoped`）和 `v1alpha2`
  （`severity/instruction/scope/enforcement`），`core/governance.ts` 的
  `normalizeRule()` 把两者统一成同一内部形状，`legacyWritePolicy` 字段
  专门标记旧的 `integrator-only` 写策略——这是设计文档第 15 节"兼容策略"
  里承诺的迁移路径的真实实现，不是只写在文档里。
- `schemas/permission-policy.schema.json` 的 `capability`
  （fs.read/fs.write/shell/network/mcp/subagent/external.write）与
  `effect`（deny/ask/allow）字段和设计文档 4.2 节例子逐字一致；
  `effectivePolicyEffect()` 实现的 `deny > ask > allow` 合并顺序也和文档
  4.2 节的"固定合并规则"一致。
- Gate 执行（`runners/gate.ts`）的实现细节超出了一般"跑个命令"的粗糙
  实现：子进程环境变量白名单（只透传 PATH/HOME 等几个必需变量，不做
  完整环境透传）、stdout/stderr 按字节数上限截断、`redact()` 对
  password/token/secret 类字段和当前进程里匹配到的敏感环境变量值做替换、
  超时后 SIGTERM 再 SIGKILL 兜底、已存在 Evidence 的 digest 不匹配时拒绝
  覆盖（`XFORGE_EVIDENCE_CONFLICT`）。这些都是设计文档 7.3 节
  "Evidence freshness" 和 14 节"安全与信任"里要求的能力，且都能在代码里
  找到对应实现，不是空谈。
- `core/audit.ts` 实现了哈希链（`previousHash`/`hash` 每条事件用
  `stableStringify` + `sha256`）、跨进程写锁（`mkdir` 型互斥锁避免并发
  追加损坏 JSONL）、远程投递失败自动降级为 `spooled` 状态、
  `retryAuditDelivery()` 补发未成功事件。这精确对应设计文档 8.3/8.4 节的
  "三层存储"和"spool/retry"要求。
- **风险点**：
  1. `runtime-audit` Hook 默认"selected 但 disabled"，也就是说一个新装好
     的项目默认不会产生 PostToolUse 审计事件，除非用户显式启用——这是
     文档明确设计的默认值（避免未经信任就写审计），但对不熟悉这个约定的
     团队来说是一个容易被忽略的"审计其实没打开"的陷阱，建议
     `xforge state --text` 的可读输出里对这一点做更醒目的提示（可以进一步
     verify 一下现有实现是否已经足够醒目）。
  2. 团队自己在 `TEST_REPORT_2026-08-09.md` 的"剩余风险"里承认：Solid 配置
     了远端 Audit sink 但没配 endpoint/token 时，每个 runtime 事件都会
     产生本地 spool 记录，长会话场景下 pending 记录会快速增长，属于运维
     容量问题而非正确性问题。
  3. Hook 的"仓库级信任"模型本质上是自证的——一个能修改仓库的 Agent
     理论上也能修改 Hook 本身，设计文档 5.4/14 节已明确"仓库级 Hook 不构成
     最高保证，Major/受监管场景需要平台 managed policy 或 CI protected
     check"，这是诚实的范围声明，但意味着**信任边界最终落在宿主编码工具
     的平台层，而不是 XForge 自身**，采用方需要清楚这一点，不能误以为
     装了 XForge 就等于有了独立于宿主工具的沙箱。

---

## 5. Skill / Agent 文本能否真正"激活"LLM（吐出正确任务）

**结论：可以。这批 Skill/Agent 文本是为"驱动模型"而不是"给人看"设计的，
密度和精确度都达到了可执行指令的标准，而不是说明文档的标准。**

评估依据（抽样读取 `xforge-propose`、`xforge-continue`、`worker.md`，并
用设计文档第 10/11 节的"Skill 集成"要求做对照）：

- 每个 Skill 开头都要求先执行 `npx --no-install xforge state`，把"当前
  该做什么"这个决定权交给 CLI 返回的 `nextActions`，而不是让模型凭
  Markdown 记忆或对话历史推断阶段顺序——`xforge-continue` 原文明确写
  "Never hard-code Quick/Solid/Major order" / "Never infer the next step
  from Markdown or Flow familiarity"。这直接防止了 LLM 常见的"凭上下文
  编造流程状态"问题。
- `xforge-propose` 给出了精确到字段名、且明确标注"保留这个未包装结构"
  的最小合法 `change.yaml` 示例（`flow/classification/scope`）。这类
  "给最小合法样例而不是抽象描述"的写法，正是团队在
  `TEST_REPORT_2026-08-09.md` 失败重试记录第 2、4 条里踩过坑后加上的
  ——模型曾经因为"猜"契约形状而生成带多余包装层的非法 YAML，团队随后
  在 Skill 里补了精确示例并让 CLI 对 Schema 错误 fail-fast。这说明这批
  Skill 文本不是一次性写完的理想稿，而是经过至少一轮"真实 LLM 跑崩了再
  收紧措辞"的迭代，实战检验过其可激活性。
- 每个 Skill 都有明确的 "Authority" 段落列出"能写什么/不能写什么/不能
  替用户做什么决定"，以及 "Stop and rework" 段落列出具体的停止条件
  （material ambiguity、权限扩大、Gate 失败、revision 过期等）。这些
  停止条件是可判定的（依赖 CLI 返回的 diagnostic code），不是"如果觉得
  不对就停"这种模糊指令。
- Worker Agent 的交付契约要求"精确的非空 `done_when_evidence` 映射"、
  "绝不能只凭文字自称 succeeded"，且强制要求交付前先确认
  `state_revision`/`policy_snapshot_digest`/`audit_correlation_id`
  三个绑定字段——这把"防止模型自我报告成功"的治理要求直接写进了
  Prompt 层，与代码层的 revision 校验形成双重防线。
- `docs/TEST_REPORT_2026-08-09.md` 提供了目前能拿到的最有力证据：**真实
  Claude Code 引擎**用这套 Skill 文本完整跑通了一次 Solid 全流程
  （Propose→Design→Apply→Verify→Approval→Audit→Archive，98 turns，
  约 $3.67），且中途一次"测试通过但模型自报 PASS 掩盖了 Spec/实现契约
  不一致"的情况被正确拦截为 `model_behavior_failure`、未误判为成功。
  这是"Skill 文本能激活正确任务，且系统能识别激活失败"的直接实证，
  不是靠单元测试模拟出来的间接证据。
- **风险点**：
  1. 可激活性证据目前只覆盖了 Claude Code 一个引擎、Solid 一条 Flow、
     一个 Task Ledger 样例需求。Quick/Major 的模型行为评测和其余四个
     Adapter（Codex/Cursor/OpenCode/Copilot）的真实引擎验证，
     `TEST_DESIGN.md` 第 12 节明确列为 P1/P2 未完成项，不是本次审阅
     漏看，而是团队自己也承认还没做。
  2. Skill 文本假设模型会诚实调用 `xforge state`/`xforge check` 并如实
     报告 diagnostic，但这依赖底层模型的指令遵循能力；文本本身无法
     100% 防止模型"跳过查询直接下结论"，只能通过 CLI 侧的 revision/
     digest 校验事后拦截（即：激活失败时，兜底的是代码而不是 Prompt，
     这是合理的纵深防御设计，但意味着"Skill 写得好"不能单独构成保证）。

---

## 6. 测试系统设计

**结论：六层测试架构（L0 静态/供应链 → L1 单元 → L2 组件集成 → L3 CLI
黑盒 → L4 隔离项目场景 → L5 真实引擎 E2E）划分清楚，且明确把"确定性
发布门"和"真实模型行为验证"隔离开，避免了"AI 治理工具的测试反而依赖
AI 输出稳定性"这个常见陷阱。**

- `TEST_DESIGN.md` 第 1 节的判定原则很关键："模型输出不是通过凭据"——
  唯一被接受的 oracle 是 exit code、Protocol 2 envelope、文件摘要、Git
  diff、Machine Gate Evidence、Approval/Transition receipt 和 Audit
  hash chain。这条原则在代码里也确实被遵守：`runGate()` 不接受模型
  自称的结果，`approve.ts` 不接受未签名的本地断言。
- `tests/ACCEPTANCE_MATRIX.md` 把每一个产品能力点映射到具体测试文件
  （例如"work-package 八字段/DAG/原子派工/共享写路径边界"对应
  `work-packages.test.ts` + `control-plane.test.ts`），覆盖矩阵是可
  审计的，不是一句"测试很全"的空话。
- L5 真实引擎层要求区分 `product_failure` / `model_behavior_failure` /
  `provider_failure` / `environment_blocked` 四类失败，并且不计入发布门
  ——这个设计选择本身就是对"LLM 输出天然不确定"这一事实的诚实承认，
  避免把模型的偶发失误误记成产品缺陷，也避免反过来把产品缺陷洗白成
  "模型偶尔犯错"。
- Live-engine runner 有整场预算上限（9 美元）、单次请求上限（3 美元）、
  每阶段最多两次重试、超时（900 秒）、"未知费用 fail-closed"、以及必须
  显式确认 behavioral isolation——这是少见的、真正考虑了"真实调用模型
  会花钱、会失控"这个工程现实的测试基础设施设计，而不是简单包一层
  API 调用。
- **风险点**：
  1. 本次审阅**没有独立复跑**任何一层测试，所有通过率数字（70/70、
     14/14、4/4）均来自团队 2026-08-09 当天的自测报告，属于"自证"而非
     "他证"。建议下次有 Node.js 环境时至少独立跑一遍 `npm run verify`
     和 `npm run test:product`，作为交叉验证。
  2. L5 真实引擎覆盖面窄（见第 5 节风险点 1），且团队自己在
     `TEST_DESIGN.md` 第 12 节列出 P1（Major 双签+remote audit 场景、
     Quick 升级行为评测、CLI 参数组合表、真实平台 Hook trust 测试）和
     P2（跨平台 sandbox launcher、多模型统计、性能基线、长时 soak、
     真实企业审批 provider）均为未完成，这意味着当前"能证明系统按设计
     工作"的范围仍局限于 Claude Code + Solid + 单一样例项目。
  3. Windows 环境目前只覆盖到"路径和 CLI 黑盒层"（L1-L3 附近），未见
     Windows 下的 L4/L5 场景验证，跨平台一致性证据比 macOS/Linux 弱。

---

## 7. 跨维度的文档卫生问题（建议优先处理）

这是本次审阅中唯一一类"代码没问题、但文档结构本身有维护债务"的发现，
集中在 `XFORGE_PRODUCT_SPEC.md`：

| 问题 | 具体表现 | 影响 |
|---|---|---|
| Flow 命名过时 | 文档写 `quick/solid/prime`，实际是 `quick/solid/major` | 新读者或 Agent 可能按 `prime` 去找文件/Skill，找不到 |
| Flow Schema 过时 | 文档示例是 `artifacts + operations`（v1alpha1 风格），实际是 `stages + governance + terminal`（v1alpha2） | 照抄文档示例写自定义 Flow 会产生 Schema 校验失败 |
| Rule/Hook 章节标注为待办但已完成 | 4.7/4.8 节写"本节是 Protocol-1 当前模型，vNext 将……"，但 vNext（Protocol 2）已经是当前实现且已完成 P0-P4 | 容易让人误以为 Rule/PermissionPolicy 分离、双平面 Hook 还没做 |
| 权威文档定位模糊 | README 把 `XFORGE_PRODUCT_SPEC.md` 列为"Product specification"链接，但该文档顶部又说 Protocol 2 部分应以另外两份设计文档为准 | 读者不清楚该把哪份当第一入口 |

这些问题团队自己在 `product-baseline.md` 和 `XFORGE_PRODUCT_SPEC.md`
顶部都做了重定向说明，**不是被隐藏的问题**，但重定向说明只有几行，很容易
被跳过。建议的最小修复（不需要重写全文）：把 `XFORGE_PRODUCT_SPEC.md`
里已被 Protocol 2 取代的具体章节（尤其是 4.3 Flow 示例、4.7 Rules、
4.8 Hooks）直接删除示例代码块，只保留一句"已由 X 文档取代"，避免旧
Schema 示例被当作当前可用示例复制使用。

---

## 8. 优先级建议清单

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | 清理 `XFORGE_PRODUCT_SPEC.md` 中与 Protocol 2 冲突的 Flow/Rule/Hook 示例 | 唯一发现的"会误导实现"的问题，修复成本低（删文字，不改代码） |
| P0 | 找一台有 Node 20+ 的机器独立跑一次 `npm run verify` | 本次审阅未能独立验证团队自报的测试通过率 |
| P1 | 补齐 Quick/Major 的真实引擎行为评测、以及 Codex/Cursor/OpenCode/Copilot 至少一次真实引擎 smoke | 当前"系统按设计工作"的实证只覆盖 Claude+Solid 一条路径 |
| P1 | 在 `xforge state --text` 输出中更醒目地提示 `runtime-audit` Hook 默认禁用 | 默认关闭的审计能力是最容易被用户误以为"已经在审计"的一点 |
| P2 | 补 Windows 下的 L4/L5 场景验证 | 当前跨平台证据集中在 macOS/Linux |
| P2 | 评估远端 Audit 未配置 endpoint 时的本地 spool 增长治理（团队已自识别） | 长会话运维容量问题 |

---

## 附：本次审阅直接读取/核对过的关键文件

`README.md`、`docs/XFORGE_PRODUCT_SPEC.md`（节选）、
`docs/product-baseline.md`、`docs/governance-control-plane-design.md`、
`docs/adapter-matrix.md`、`docs/TEST_DESIGN.md`、
`docs/TEST_REPORT_2026-08-09.md`、`tests/ACCEPTANCE_MATRIX.md`、
`tests/README.md`、`xforge/src/cli.ts`、`xforge/src/core/governance.ts`、
`xforge/src/core/audit.ts`、`xforge/src/runners/gate.ts`、
`xforge/src/commands/transition.ts`、`xforge/src/commands/approve.ts`、
`xforge/schemas/rule.schema.json`、
`xforge/schemas/permission-policy.schema.json`、
`scaffold/payload/xforge/flows/{quick,solid,major}.yaml`、
`scaffold/payload/xforge/scaffold/skills/{xforge-propose,xforge-continue}/SKILL.md`、
`scaffold/payload/xforge/scaffold/agents/worker.md`，以及仓库 git tag
历史（v0.1.0–v0.6.0）。未逐行核对的部分：五个 Adapter 实现细节
（`src/adapters/*.ts`）、`work-package.ts`/`hook.ts`/`install/*`/
`state-reader.ts`/`checker.ts` 等命令与核心模块的完整实现、
`docs/flows-and-skills-design.md`（1007 行）与
`docs/sub-agent-system-design.md`（460 行）的全文、以及全部 12 个
Skill 和 3 个 Agent 的中文版本文本。这些属于"未反驳但也未独立验证"的
范围，不构成本文任何结论的依据。
