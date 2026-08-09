# XForge 命令行使用指南（0.4.0 / Protocol 2）

`@xforge/cli 0.4.0` 同时提供投影生命周期命令和治理控制面命令。默认输出单个 Protocol 2 JSON envelope；加 `--text` 只改变展示，不改变退出码与语义。

## 1. 基本约定

```bash
xforge [--root <exact-project-root>] <command> [options] [--text]
```

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

## 3. 安装与同步

```bash
xforge install --dry-run
xforge install
xforge install --target codex

xforge sync --dry-run
xforge sync --verify-digests
xforge update --dry-run
xforge update
xforge uninstall --target cursor --dry-run
```

- `install` 首次创建或幂等协调选定 Target。
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

## 4. 结构检查与 Machine Gates

```bash
xforge check
xforge check --change add-login
xforge check --change add-login --gate structure
```

`check` 校验 schema、引用、Flow eligibility、路径、work-package/DAG/delivery 和 Lock freshness，并运行选定或当前阶段要求的 Gates。Gate Evidence 只能由 runner 写入；命令 argv、runner identity、revision、Git HEAD、输出摘要和 digest 都被记录。

LLM 写出的 Check report 或 `PASS` 不会成为 Machine Gate Evidence。

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

本地交互式决定：

```bash
xforge approve \
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
xforge approve \
  --change add-login \
  --for apply \
  --policy implementation-major \
  --receipt .tmp/approval-receipt.json
```

receipt 必须绑定当前 Change/Flow/Stage/transition/contentRevision/stateRevision/policySnapshot/Git HEAD，provider 与 role 必须被 policy 允许，HMAC 和 digest 每次加载都会复验。Major 默认要求两个不同 actor、不同角色的外部签名批准；Agent 不能自行产生有效 Approval。

## 7. Work-package dispatch

```bash
xforge work-package dispatch \
  --change add-login \
  --package T001 \
  --dry-run

xforge work-package dispatch --change add-login --package T001
```

只允许在 `apply` Stage 派发 ready package。返回 receipt 的 `executionId`、`stateRevision`、`policySnapshotDigest`、Git base/head 和 `auditCorrelationId` 必须随任务传给 Worker；delivery 必须回带对应的 snake_case 字段。静态 `work-packages.yaml` 仍只有八字段。

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

## 10. 内部 Hook dispatcher

Adapter 使用：

```bash
xforge hook dispatch --target codex --event agent.tool.before
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
