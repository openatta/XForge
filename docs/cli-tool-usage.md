# XForge 命令行使用指南（0.7.16 / Protocol 2）

`@xforge/cli 0.7.16` 同时提供投影生命周期命令和治理控制面命令。默认输出单个 Protocol 2 JSON envelope；加 `--text` 只改变展示，不改变退出码与语义。

这些命令的正常调用方是 AI Agent，不是人类临时手敲。人类或 CI 只负责一次性执行
`npm install --save-dev --save-exact @xforge/cli@<version>`；此后每一次调用都
是 Agent 按已安装 Skill 里给出的原文，发出 `xforge ...`。

## 1. 基本约定

```bash
xforge [--root <exact-project-root>] <command> [options] [--text]
```

- 裸的 `xforge` 就是正确写法：CLI 是全局安装的，可执行文件在 `PATH` 上。找不到
  时表现为 command-not-found，这正是"锁定版本缺失要响亮失败"原本要的效果。
- 版本保证不再由 `npx --no-install` 承担，而由 XForge 自己承担：
  `xforge/manifest.yaml` 钉住版本，CLI 每次运行都比对，不一致时降级为 Portable
  模式并拒绝写入（`XFORGE_CLI_IDENTITY_MISMATCH`）。
- 项目本地安装仍受支持，是第三条路径，也是唯一仍应写 `npx --no-install` 的地方
  ——npx 是因为 `node_modules/.bin` 不在 `PATH` 上，`--no-install` 是因为 npm 上
  另有一个无关的 `xforge` 包，普通 `npx` 会把它拉下来运行。
- `--root` 使用精确根目录，不向父目录回退。
- 读取命令可展示 Portable 状态；写命令要求 Manifest、Lock、CLI version/protocol/integrity 完全匹配。
- `--dry-run` 对支持它的命令保持零写入。
- 退出码 `0` 表示 envelope `ok=true`；诊断含 error 时退出 `1`。内部 blocking Hook 失败时使用非零并输出平台 deny。

## 2. 查询状态

```bash
xforge state
xforge state --change add-login
xforge state --kind policies
xforge state --target codex --text
```

Change 状态包括：

- 当前 Stage、content/state/policy revision 与 Transition receipt chain；
- ready/blocked Transitions 及 blockers；
- pending Approval；
- Rule 的 instructed/guarded/verified/approved/uncovered coverage；
- PermissionPolicy 是否适用，Hook 是否 selected/enabled；
- Audit chain、远端欠账和 coverage gaps；
- work-package ready set 与 delivery 校验；
- typed `nextActions`，包含可直接执行的 argv。

`state` 不写项目；不要用 Markdown checkbox 或会话记忆替代它。

不带 `--change` 的 `xforge state` 也是只读报表类 Skill（如 `xforge-kanban`）的
合法用法之一，例如只读取 `project.modules` 做分组；这属于项目结构查询，不代表
Change/Flow/Gate 生命周期查询。

## 3. npm 安装、初始化与投影

```bash
npm install --save-dev --save-exact @xforge/cli@0.7.16

xforge init --dry-run
xforge init
xforge init --language en
xforge init --language zh-CN

# 新项目可一步完成 Scaffold 初始化和单 Target 投影
xforge init --target codex --dry-run
xforge init --target codex

# 已初始化项目增加 Target
xforge install --target claude --dry-run
xforge install --target claude

xforge sync --dry-run
xforge sync --verify-digests
xforge update --dry-run
xforge update
xforge uninstall --target cursor --dry-run
```

- `init` 只从已安装 npm 包读取 Scaffold，校验 descriptor、完整 inventory、摘要、
  symlink/path 边界与 CLI/Protocol 版本；不接受源码、Git 或 HTTP Scaffold 输入。
- 首次 `init` 的语言优先级为 `--language` / `XFORGE_LANGUAGE`、系统 locale、交互式
  二选一。无法检测且没有 TTY 时 fail closed，并要求显式传入 `--language en` 或
  `--language zh-CN`。英语是默认资源，中文资源使用 `_cn.md`（Skill 展示元数据为
  `_cn.yaml`）；Skills、子 Agents 和 Constitution 都是双语，其他 Scaffold 资产
  始终为英语。
- `init --target` 会在首次写入前同时预检 Scaffold 和目标 Adapter 路径。
- `install` 为已初始化项目首次创建或幂等协调选定 Target；不指定 `--target` 时处理
  Manifest 中全部 Target。
- `sync` 只处理 localized canonical source 变化；Target/Adapter identity 变化会要求 `update`。
- `update` 完整重投影并迁移安装记录；没有安装记录时不会静默充当 `install`。
- `uninstall` 只删除 ownership 中且 digest 仍匹配的 generated file。
- 未知目标文件、用户修改和 ownership 冲突均 fail closed。

Protocol 2 的治理投影可能生成：

```text
.claude/settings.json
.codex/rules/*.rules
.codex/hooks.json
.cursor/hooks.json
.github/hooks/xforge.json
opencode.json
.opencode/plugins/xforge-governance.ts
```

这些文件属于 Adapter 输出，不直接编辑。安装成功不等于平台已信任或 runtime 已激活项目 Hook。
生成的 Hook 使用裸的 `xforge`，与全局安装形态一致。Hook 由宿主进程派生，运行
在 XForge 无法控制的环境里，所以应答的不一定是本项目钉住的那个 CLI——
`hook dispatch` 因此先比对身份，不一致时明确拒绝并说明是版本不符，而不是把它
表现成一个费解的资源加载错误。

## 4. 结构检查与 Machine Gates

```bash
xforge check
xforge check --change add-login
xforge check --change add-login --gate structure
```

`check` 校验 schema、引用、Flow eligibility、路径、work-package/DAG/delivery 和 Lock freshness，并运行选定或当前阶段要求的 Gates。Gate Evidence 只能由 runner 写入；命令 argv、runner identity、revision、Git HEAD、输出摘要和 digest 都被记录。

LLM 写出的 Check report 或 `PASS` 不会成为 Machine Gate Evidence。

## 4b. 审批决策简报

```bash
xforge brief --change add-login
xforge brief --change add-login --text
```

`brief` 回答"这次审批该不该放行"，而不是"这个设计对不对"。它只读不写，不产生 receipt，也不记 audit。

只有当前 Stage 声明了 `exit.approvals`（或处于 `ready-to-archive` 且 archive 需要审批），或存在未关闭的 blocking finding 时，简报才有内容；其余情况返回 `decision.applicable: false`，因为那里没有人需要做的决定，多发一份简报只会增加阅读量。

输出分三层，每一条都带 `provenance`：

- `computed` — 由结构化数据算出（Requirement/Scenario 计数、findings 与宪法账本状态、分级与范围、Stage 时间线与返工次数、各次 transition 的 Git head）。同一 `contentRevision` 上重复运行逐字节相同。
- `extracted` — 按 Flow `outline` 声明的 `## ` 标题从 Artifact 原文切片，一字未改，带 `path` 与 `line`。
- `authored` — 人或模型写的判断，只能经 `--attach-triage <path>` 提交，且每条必须用 `basis` 引用本次简报里真实存在的 `computed`/`extracted` id，否则以 `XFORGE_BRIEF_UNANCHORED_CLAIM` 拒绝。

`reconciliation` 是单独一组 `computed` 条目，陈述**记录声称的事**与**文件里实际有的事**之间的差异，只说差异，不判断对错：

| 规则 | 代码 |
|---|---|
| 结案未兑现：finding 记为 `resolved`，但它引用的 Requirement 没进入它引用的 Artifact（有 `requirement-coverage` marker 时限定在该小节内） | `XFORGE_BRIEF_RESOLUTION_UNVERIFIED` |
| 需求无锚点：delta Spec 里的 Requirement 未被本 Change 任何其他 Artifact 引用 | `XFORGE_BRIEF_REQUIREMENT_UNANCHORED` |
| 覆盖缺口：Requirement 未出现在 Flow 声明的 `requirement-coverage` 小节内 | `XFORGE_BRIEF_REQUIREMENT_UNCOVERED` |
| 自述缺口无决议：`declared-gap` 条目把问题推给后续 Stage，却没有任何 finding 引用它 | `XFORGE_BRIEF_DECLARED_GAP_UNRESOLVED` |
| 引用不可解析：宪法账本的 `references` 既不是本 Change 的 Requirement，也不是存在的路径或已通过的 Gate | `XFORGE_BRIEF_REFERENCE_UNRESOLVABLE` |

后三条依赖 Flow 的 `markers` 声明（见 `docs/extending-skills-and-flows.md`）；Flow 没有声明对应 marker 时，规则一律沉默，绝不猜测哪个小节是哪个意思。

尚未到期的 Artifact 不参与引用与覆盖判定：在 design 审批处检查 verify 阶段才写的 `assurance.md`，报告的缺失没有意义。

`--text` 分区呈现三层且永不交错，并固定打印"未覆盖"清单——签这份简报不等于审阅了 Scenario 正文、Check 散文和 Flow outline 未声明的小节。

## 5. Stage Transition

```bash
xforge transition --change add-login --to design --dry-run
xforge transition --change add-login --to design
```

CLI 只允许 Flow 声明的下一 Stage 或 rework Stage，并检查当前 revision 的 Artifact、exit condition、Gate、Approval 和 Audit chain。成功后在：

```text
<change>/evidence/receipts/transitions/
```

写入 hash-linked receipt。Agent/Skill 只能请求 Transition，不能直接修改 Stage。

## 6. Approval

本地交互式决定，必须在真实 TTY 里运行：

```bash
xforge approve \
  --change add-login \
  --for apply \
  --policy planning-solid \
  --actor alice@example.com \
  --role owner \
  --reason "Design reviewed" \
  --attestation human
```

`--actor`/`--role`/`--reason` 只是给终端对话框预填的建议，不是权威依据；
`--attestation human` 也只是意图提示，本身不构成决定。CLI 自己的
`readline` 对话会现场询问批准人身份、角色、决定（approve/reject）和理由
——不再有需要读回去的确认码。该模式是仓库级自证明，适合 Quick/Solid 的本地
协作，不是企业身份保证。

`mcp` provider（对接外部审批平台，实时提交+轮询）：

```bash
xforge approve \
  --change add-login \
  --for apply \
  --policy implementation-major \
  --provider enterprise-approvals
```

`--provider` 必须是 `manifest.yaml` 的 `approvals.providers` 里登记的
`type: mcp` 条目，指向一个已注册的 `McpServer` 资源；role 必须被 policy 允许。
`local`/`mcp` 两种 receipt 都不带签名——是否有效靠的是项目自己的防篡改
audit hash chain 里有没有一条匹配的 `approval.decided` 事件，每次加载都会
复验。轮询结果是 `pending` 时返回成功 envelope，`nextActions` 里给出稍后
重跑的命令，不是错误。Major 默认要求两个不同 actor、不同角色的批准；Agent
不能自行产生有效 Approval。

## 7. Work-package dispatch

```bash
xforge work-package dispatch \
  --change add-login \
  --package T001 \
  --dry-run

xforge work-package dispatch --change add-login --package T001
```

只允许在 `apply` Stage 派发 ready package。返回 receipt 的 `executionId`、`stateRevision`、`policySnapshotDigest`、Git base/head 和 `auditCorrelationId` 必须随任务传给 Worker；delivery 必须回带对应的 snake_case 字段。静态 `work-packages.yaml` 仍只有八字段。

成功 delivery 还必须用 `done_when_evidence` 将每一条静态 `done_when` 精确映射到
至少一项实现、测试、契约或 Gate Evidence。集成和独立审查不是 `check` 的隐式副作用，
必须分别提供范围内证据并显式确认：

```bash
xforge work-package acknowledge \
  --change add-login --package T001 --as integrator \
  --evidence xforge/changes/add-login/evidence/agents/T001/integration.md

xforge work-package acknowledge \
  --change add-login --package T001 --as reviewer \
  --evidence xforge/changes/add-login/evidence/agents/T001/review.md
```

工作包状态链为 `ready → running → succeeded → integrated → reviewed`，失败与阻塞
保持显式；`state` 同时返回静态 DAG `waves` 和当前 `parallelCandidates`，供宿主原生
子 Agent runtime 调度。

## 8. Audit

```bash
xforge audit status
xforge audit status --change add-login
xforge audit verify --change add-login
xforge audit export --change add-login
xforge audit export --change add-login --output reports/add-login-audit.json
xforge audit retry
```

- `status` 汇总 event classes、coverage gaps、remote pending 和本地 retention 状态。
- `verify` 验证全局 hash chain，并按 Change Flow 检查 required events、runtime coverage 和 remote delivery；适合作为 CI protected check。
- `export` 生成规范化、脱敏数据；带 `--output` 时属于 managed write。
- `retry` 重送尚未远端成功的原始事件，并写 delivery receipt。

远端配置只引用环境变量名：

```yaml
audit:
  redaction: strict
  localRetentionDays: 30
  remote:
    endpointEnv: XFORGE_AUDIT_ENDPOINT
    tokenEnv: XFORGE_AUDIT_TOKEN
    hmacSecretEnv: XFORGE_AUDIT_HMAC_SECRET
    timeoutSeconds: 5
    requiredFor: [major]
```

凭证和值不得进入 Manifest、Lock、Evidence 或 generated Hook 文件。远端失败会 spool；要求 remote delivery 的 Major 在欠账清零前不能归档。

## 9. Archive

```bash
xforge archive --change add-login --dry-run
xforge archive --change add-login
```

Archive 要求 Stage 已为 `ready-to-archive`，Gate/Approval/Audit/Transition receipts 均绑定当前 revision。执行时重新运行 mandatory Gates，重新规划 Specs merge 和 move，最后原子提交。任何 Gate failure、stale receipt、Spec conflict、远端审计欠账或用户文件冲突都会停止事务。

Archive 是 repository closure，不等于 deploy/release 授权。

## 10. 扩展健康检查

```bash
xforge doctor
xforge doctor --kind gates
xforge doctor --strict --text
```

`doctor` 是只读、advisory 命令，从不因发现问题而阻塞（除非显式加 `--strict`）：

- 不带 `--kind` 时做一次全量扫描，覆盖 Skills/Rules/Gates/Hooks/PermissionPolicies/Flows/Approval
  policies；带 `--kind <skills|rules|gates|hooks|policies|flows|approvals>` 时只报告该类。
- `danglingReferences`：复用 `check` 已有的结构校验（Flow 引用不存在或未启用的 Gate/Skill、Rule
  引用不存在的 module/Gate/Approval policy、Hook 引用不存在的 Script、Agent 允许未知 caller 等）。
- `deadCode`：已启用但没有任何 Flow Stage/Stage exit/archive terminal 引用的 Gate，或某个 Flow
  声明了却从未在任何 Stage exit/archive terminal 中被引用的 Approval policy——两者都意味着永远不会
  运行，属于强信号。
- `uncited`：已启用但没有被任何 Flow Stage 引用的 Skill（内置的 7 个 standalone Skill 除外），或
  没有被任何 Rule 的 `enforcement.policyRefs` 引用的 PermissionPolicy——两者仍然生效（Skill 可被
  直接调用，PermissionPolicy 对匹配的工具调用仍然实时生效），只是未与其他资源建立关联，属于弱信号，
  需要人工判断是否是有意为之。
- `unusedFlows`：既不是 Manifest 默认 Flow、也没有被任何当前活跃 Change 使用的 Flow 文件，最弱信号。
- Hook 没有反向引用检查：当前 schema 没有任何字段可以合法地"引用"一个 Hook，因此 Hook 只出现在
  `danglingReferences`（例如引用了不存在的 Script）中，不会出现在 `uncited`/`deadCode` 里。
- 所有发现都以 `severity: warning` 出现在 `diagnostics` 中，`ok` 默认为 `true`；只有显式传入
  `--strict` 且存在任何发现时，`ok` 才会变为 `false`、退出码变为 `1`。

`doctor` 只读，不产生任何写入；它检测的是"引用完整性"和"引用惰性"，不检测 Adapter 投影本身——
sync/update/install 已经把用户扩展的 Skill/Rule/PermissionPolicy/Hook 同步到已选定 Target 各自的
目录，`doctor` 帮助确认这些扩展是否仍然被 Flow/Rule 实际引用、是否引用了已被删除的资源。

## 11. 内部 Hook dispatcher

Adapter 使用：

```bash
xforge hook dispatch --target codex --event agent.tool.before
```

事件 JSON 从 stdin 输入，stdout 只返回目标平台要求的决定 JSON。它不是普通 CRUD 接口。before/permission 处理失败时 fail closed；after/audit-only 失败按 Hook failure policy spool/warn。

Codex 当前不支持 PreToolUse `ask`，因此 XForge 在 Codex bridge 中保守映射为 deny；平台未暴露的工具/Cloud surface 会记录 coverage gap，而不是伪装成完整审计。

## 12. 推荐闭环

```text
state
→ 创建当前 Stage Artifact
→ check / Gate
→ 人类或外部系统 approve（如需要）
→ transition
→ apply / revision-bound work-package dispatch
→ verify / Gate
→ transition ready-to-archive
→ closing approve + audit verify
→ archive --dry-run
→ archive
→ state
```
