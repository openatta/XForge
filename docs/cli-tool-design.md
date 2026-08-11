# XForge CLI 设计（0.7.4 / Protocol 2）

状态：P0–P4 已实现。ADR 0002 是 Rules、PermissionPolicy、Hooks、Transitions、Approvals 和 Audit 的当前决策。

## 1. CLI 的权威边界

CLI 是无常驻服务的控制面，负责五类确定性事务：

1. 解析 Manifest/Lock/Flow/Change 和当前 revision；
2. 投影 canonical Skills/Agents/Rules/Policies/Hooks；
3. 执行 Machine Gate、Transition 和 Archive；
4. 验证 Approval、work-package delivery 和 receipt chain；
5. 写规范化 Audit、远端 delivery receipt 和可提交索引。

Skill/Agent 解释意图、生成规划或 assurance 内容，但不能把自然语言结论升级为 Gate、Approval、Transition 或 Audit 完整性事实。

## 2. 命令模型

| 命令 | 读写 | 核心结果 |
| --- | --- | --- |
| `help`, `version` | read | CLI/protocol/build identity |
| `init` | conditional write | 校验 npm 内置 Scaffold，初始化项目，可选单 Target 投影 |
| `state` | read | resolved project/Change/governance + typed nextActions |
| `install` | write | 首次/幂等 Target 投影、Lock、ownership |
| `sync` | write | localized canonical source reconciliation |
| `update` | write | full projection/identity migration |
| `uninstall` | write | digest-safe managed-only cleanup |
| `check` | conditional write | structure diagnostics and real Gate Evidence |
| `approve` | write | interactive local or verified external Approval receipt |
| `transition` | write | guarded Stage transition receipt |
| `work-package dispatch` | write | revision-bound dispatch receipt and audit |
| `audit status/verify` | read | chain, policy, coverage and delivery status |
| `audit export/retry` | conditional write | redacted export or delivery receipts |
| `archive` | write | G1–G4 validation, Specs merge and atomic move |
| `doctor` | read | 全量或按 `--kind` 扫描 dangling reference 与未被引用的扩展资源，只警告，从不阻塞 |
| `hook dispatch` | internal | platform Hook response plus runtime audit |

所有普通命令返回一个 Protocol 2 envelope。所有写命令遵循：

```text
load exact root and npm identity
→ resolve canonical resources/current state
→ compute content/state/policy revisions
→ produce plan and diagnostics
→ enforce authority/guards
→ atomic write
→ append audit and update change index
→ return envelope
```

## 3. State 与 Transition

当前 Stage 来自 transition receipts，而不是 artifact checkbox。State revision：

```text
policySnapshot = hash(constitution + flow + rules + policies + hooks + gates)
contentRevision = hash(change inputs + policySnapshot + Git HEAD)
stateRevision = hash(contentRevision + currentStage + transitionHead)
```

Transition guard 检查当前 Stage 的：

- `produces` Artifacts；
- 结构化 exit conditions；
- Gate Evidence status/freshness；
- Approval policy、provider、role、人数和职责分离；
- required audit events 与本地链完整性；
- Apply → Verify 时的 work-package deliveries。

成功 receipt 记录 Gate/Approval digests、previous receipt digest 和 audit head。Rework 使用 Flow 声明的 `reworkTo`，同样只能通过 CLI。

## 4. Approval 安全模型

Local 模式要求 TTY、`--attestation human` 和显式 actor/role/decision/reason。它只能证明“有人通过本机 CLI 作出仓库内声明”，不能证明企业身份。

External 模式要求 Manifest provider、环境变量中的 HMAC key、允许的 role，以及绑定当前 revision 的 receipt。导入时和每次 state/control-plane load 时都复验 schema、digest、signature、subject 和 freshness。无效 receipt 不进入有效 approvals 集合。

Major 只接受 external provider，默认两个不同 actor 且角色分离。Agent/Reviewer 不能通过生成 JSON 获得有效批准权。

## 5. Gate 与 Archive G4

Gate runner 不使用 shell，除非 Gate 显式声明；环境变量最小化，输出有大小上限和 secret redaction。Evidence 记录 runner integrity、argv/cwd、revision/Git、时间、退出码、digest。

Archive 在 plan 和 execution 两次检查 terminal governance：

- Stage 必须 `ready-to-archive`；
- ready transition receipt 的 content/policy/Git 仍当前；
- Transition 引用的 Gates 仍有效，execution rerun 后也接受 ready-state evidence；
- Closing Approval 当前；
- required audit classes 存在、链有效、无禁止的 coverage/remote gap；
- Specs merge 和 move 没有路径/目标冲突。

Gate rerun 后重新 plan，再执行原子事务。任何中间错误保持 Change 未归档。

## 6. Rule、PermissionPolicy 与 Hook

`Rule` 只产生 instruction 与 coverage links。`PermissionPolicy` 是独立 Kind，匹配 capability/resource/stage/actor 并返回 allow/ask/deny。XForge dispatcher 使用 deny 优先；平台 managed deny 是更高层，不被项目输出覆盖。

Hook 分两平面：

- Workflow：由 CLI 直接调用，覆盖 stage/gate/approval/archive/work-package/audit delivery；
- Runtime：由 Adapter bridge 接入平台 session/prompt/tool/permission/subagent/stop 事件。

默认 Scaffold 选择 `runtime-audit`，但 `enabled: false`。PermissionPolicy 仍会生成最小 pre-tool bridge，以实现可观察的项目 guard。Hook install、platform trust 和 active 状态不能互相推断。

## 7. Adapter 投影

Adapter capability 报告 `guidance`、`permissionPolicy`、`runtimeHook.events/blocking/managed/local/cloud/trust/bypasses`、`auditDelivery` 和 `subagent`，并保留 `rules/hooks` 汇总字段一个迁移周期。

实际治理输出：

| Target | Policy/Hook 输出 |
| --- | --- |
| Claude | `.claude/settings.json` permissions + grouped hooks |
| Codex | `.codex/agents/*.toml` + `.codex/rules/*.rules`（shell）+ `.codex/hooks.json` bridge |
| Cursor | `.cursor/hooks.json` v1 |
| GitHub Copilot | `.github/hooks/xforge.json` v1 |
| OpenCode | ordered `opencode.json` permissions + managed TypeScript plugin bridge |

Target 不暴露的事件、Cloud 临时日志或 tool opt-out 必须进入 coverage gap。Workflow control plane 始终可独立运行，Runtime Hook 不可用不会让 Flow 失效。

## 8. Audit

Audit event 仅保存身份/关联元数据、revision、refs、decision、outcome、input/output digest、redaction、coverage、previous hash 和 delivery state。默认不保存完整 prompt、隐藏思维、secret、环境或无限输出。

本地 append 使用目录锁和 JSONL hash chain。每个 Change 的 `evidence/audit/index.json` 是可提交索引。远端 HTTP append 支持 Bearer/HMAC、timeout、spool 和 retry；delivery event 的 `inputDigest` 指向原始 event hash。

欠账按 Change 计算，避免一个 Change 阻塞另一个。`audit verify --change` 按 Flow 验证 required event classes、runtime coverage 和 remote delivery，可直接作为 CI protected check。Retention 在本地报告，长期删除/immutability 由远端 sink 实施。

## 9. Work-package runtime binding

静态计划保留八字段。`work-package dispatch` 只允许 Apply Stage 的 ready node，且在整份计划校验无 error 后才原子写入单次 execution receipt 和 `work-package.dispatched` audit。Protocol 2 delivery 必须引用该 receipt 的 revision/policy/correlation，为每条 `done_when` 提供精确 `done_when_evidence` 映射，并通过 commit ancestry、actual diff、write_paths、verify argv 与 dependency commit 检查。

成功 check 只记录 delivered workflow audit。Integrator 和 Reviewer 必须分别通过
`work-package acknowledge` 提交项目内证据后才能进入 `integrated` 和 `reviewed`；平台
可观察时再补充 subagent start/stop/tool runtime events。平台缺失 subagent 事件不会
伪装成完整覆盖。

## 10. 失败与兼容

- Manifest/Lock/CLI 不匹配：Portable read，managed write fail closed。
- stale Artifact/Flow/Policy/Gate/Git：Transition/Archive 拒绝。
- 无 HMAC key：external Approval 无效，不降级到 local。
- runtime Hook dispatcher before/permission 崩溃：deny；audit-only after 可 spool/warn。
- 远端审计失败：本地 spool；Major archive 和 CI verify 失败直到 retry 成功。
- generated file 被用户修改：sync/update/uninstall 冲突，不覆盖。

Protocol 1 资源仅作为迁移输入；Protocol 2 输出不会静默降级为 Protocol 1。

## 11. 验证范围

测试覆盖：五平台投影、permission deny 与脱敏 runtime audit、Transition/Gate/Approval freshness、Approval 复验、Rule uncovered、work-package dispatch binding、Audit tamper、remote spool/retry、Quick/Solid/Major policy golden、Archive transaction 与 legacy Portable read。
