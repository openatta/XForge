# XForge 命令行使用指南（0.6.1 / Protocol 2）

`@xforge/cli 0.6.1` 同时提供投影生命周期命令和治理控制面命令。默认输出单个 Protocol 2 JSON envelope；加 `--text` 只改变展示，不改变退出码与语义。

## 1. 基本约定

```bash
npx --no-install xforge [--root <exact-project-root>] <command> [options] [--text]
```

- `--root` 使用精确根目录，不向父目录回退。
- 读取命令可展示 Portable 状态；写命令要求 Manifest、Lock、CLI version/protocol/integrity 完全匹配。
- `--dry-run` 对支持它的命令保持零写入。
- 退出码 `0` 表示 envelope `ok=true`；诊断含 error 时退出 `1`。内部 blocking Hook 失败时使用非零并输出平台 deny。

## 2. 查询状态

```bash
npx --no-install xforge state
npx --no-install xforge state --change add-login
npx --no-install xforge state --kind policies
npx --no-install xforge state --target codex --text
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
npm install --save-dev --save-exact @xforge/cli@0.6.1

npx --no-install xforge init --dry-run
npx --no-install xforge init
npx --no-install xforge init --language en
npx --no-install xforge init --language zh-CN

# 新项目可一步完成 Scaffold 初始化和单 Target 投影
npx --no-install xforge init --target codex --dry-run
npx --no-install xforge init --target codex

# 已初始化项目增加 Target
npx --no-install xforge install --target claude --dry-run
npx --no-install xforge install --target claude

npx --no-install xforge sync --dry-run
npx --no-install xforge sync --verify-digests
npx --no-install xforge update --dry-run
npx --no-install xforge update
npx --no-install xforge uninstall --target cursor --dry-run
```

- `init` 只从已安装 npm 包读取 Scaffold，校验 descriptor、完整 inventory、摘要、
  symlink/path 边界与 CLI/Protocol 版本；不接受源码、Git 或 HTTP Scaffold 输入。
- 首次 `init` 的语言优先级为 `--language` / `XFORGE_LANGUAGE`、系统 locale、交互式
  二选一。无法检测且没有 TTY 时 fail closed，并要求显式传入 `--language en` 或
  `--language zh-CN`。英语是默认资源，中文资源使用 `_cn.md`（Skill 展示元数据为
  `_cn.yaml`）；只有 Skills 和子 Agents 双语，其他 Scaffold 资产始终为英语。
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
生成的 Hook 使用 `npx --no-install xforge`，缺少项目本地精确包时直接失败，不通过
网络下载替代 CLI。

## 4. 结构检查与 Machine Gates

```bash
npx --no-install xforge check
npx --no-install xforge check --change add-login
npx --no-install xforge check --change add-login --gate structure
```

`check` 校验 schema、引用、Flow eligibility、路径、work-package/DAG/delivery 和 Lock freshness，并运行选定或当前阶段要求的 Gates。Gate Evidence 只能由 runner 写入；命令 argv、runner identity、revision、Git HEAD、输出摘要和 digest 都被记录。

LLM 写出的 Check report 或 `PASS` 不会成为 Machine Gate Evidence。

## 5. Stage Transition

```bash
npx --no-install xforge transition --change add-login --to design --dry-run
npx --no-install xforge transition --change add-login --to design
```

CLI 只允许 Flow 声明的下一 Stage 或 rework Stage，并检查当前 revision 的 Artifact、exit condition、Gate、Approval 和 Audit chain。成功后在：

```text
<change>/evidence/receipts/transitions/
```

写入 hash-linked receipt。Agent/Skill 只能请求 Transition，不能直接修改 Stage。

## 6. Approval

本地交互式决定：

```bash
npx --no-install xforge approve \
  --change add-login \
  --for apply \
  --policy planning-solid \
  --actor alice@example.com \
  --role owner \
  --decision approve \
  --reason "Design reviewed" \
  --attestation human
```

该模式必须连接 TTY，是仓库级自证明，适合 Quick/Solid 的本地协作，不是企业身份保证。

外部签名 receipt：

```bash
export XFORGE_APPROVAL_HMAC_SECRET='provided-out-of-band'
npx --no-install xforge approve \
  --change add-login \
  --for apply \
  --policy implementation-major \
  --receipt .tmp/approval-receipt.json
```

receipt 必须绑定当前 Change/Flow/Stage/transition/contentRevision/stateRevision/policySnapshot/Git HEAD，provider 与 role 必须被 policy 允许，HMAC 和 digest 每次加载都会复验。Major 默认要求两个不同 actor、不同角色的外部签名批准；Agent 不能自行产生有效 Approval。

## 7. Work-package dispatch

```bash
npx --no-install xforge work-package dispatch \
  --change add-login \
  --package T001 \
  --dry-run

npx --no-install xforge work-package dispatch --change add-login --package T001
```

只允许在 `apply` Stage 派发 ready package。返回 receipt 的 `executionId`、`stateRevision`、`policySnapshotDigest`、Git base/head 和 `auditCorrelationId` 必须随任务传给 Worker；delivery 必须回带对应的 snake_case 字段。静态 `work-packages.yaml` 仍只有八字段。

成功 delivery 还必须用 `done_when_evidence` 将每一条静态 `done_when` 精确映射到
至少一项实现、测试、契约或 Gate Evidence。集成和独立审查不是 `check` 的隐式副作用，
必须分别提供范围内证据并显式确认：

```bash
npx --no-install xforge work-package acknowledge \
  --change add-login --package T001 --as integrator \
  --evidence xforge/changes/add-login/evidence/agents/T001/integration.md

npx --no-install xforge work-package acknowledge \
  --change add-login --package T001 --as reviewer \
  --evidence xforge/changes/add-login/evidence/agents/T001/review.md
```

工作包状态链为 `ready → running → succeeded → integrated → reviewed`，失败与阻塞
保持显式；`state` 同时返回静态 DAG `waves` 和当前 `parallelCandidates`，供宿主原生
子 Agent runtime 调度。

## 8. Audit

```bash
npx --no-install xforge audit status
npx --no-install xforge audit status --change add-login
npx --no-install xforge audit verify --change add-login
npx --no-install xforge audit export --change add-login
npx --no-install xforge audit export --change add-login --output reports/add-login-audit.json
npx --no-install xforge audit retry
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
npx --no-install xforge archive --change add-login --dry-run
npx --no-install xforge archive --change add-login
```

Archive 要求 Stage 已为 `ready-to-archive`，Gate/Approval/Audit/Transition receipts 均绑定当前 revision。执行时重新运行 mandatory Gates，重新规划 Specs merge 和 move，最后原子提交。任何 Gate failure、stale receipt、Spec conflict、远端审计欠账或用户文件冲突都会停止事务。

Archive 是 repository closure，不等于 deploy/release 授权。

## 10. 内部 Hook dispatcher

Adapter 使用：

```bash
npx --no-install xforge hook dispatch --target codex --event agent.tool.before
```

事件 JSON 从 stdin 输入，stdout 只返回目标平台要求的决定 JSON。它不是普通 CRUD 接口。before/permission 处理失败时 fail closed；after/audit-only 失败按 Hook failure policy spool/warn。

Codex 当前不支持 PreToolUse `ask`，因此 XForge 在 Codex bridge 中保守映射为 deny；平台未暴露的工具/Cloud surface 会记录 coverage gap，而不是伪装成完整审计。

## 11. 推荐闭环

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
