# XForge 完整测试设计

## 1. 目标与判定原则

本文基于当前 `0.5.0 / Protocol 2` 文档、CLI 实现和既有测试设计，覆盖 XForge 从项目接入、Adapter 投影、Change 治理、工作包、Gate、Approval、Audit 到 Archive 的主流程，并加入真实 Anthropic 兼容引擎驱动的行为测试。

测试遵循四个判定原则：

1. 模型输出不是通过凭据。CLI exit code、Protocol 2 envelope、文件摘要、Git diff、Machine Gate Evidence、Approval/Transition receipt 和 Audit hash chain 才是确定性 oracle。
2. 真实引擎测试与发布门分离。前者验证 Skills/提示/工具协作，允许重试并记录模型与费用；后者必须离线、可重复、无模型依赖。
3. 所有写测试在临时项目副本执行。默认目录为 `tests/.tmp/`，不得把 `.env`、令牌、会话或引擎原始请求提交到 Git。
4. 成功路径和 fail-closed 路径同等重要。每个关键写命令至少验证正常、dry-run、stale/conflict/越权之一。

## 2. 测试对象

### 2.1 产品面

- 固定版本 Bootstrap 与 Scaffold payload 完整性；
- Manifest、Lock、Constitution、Flow、Skill、Agent、Rule、PermissionPolicy、Hook、Gate 和 Script；
- Portable/Managed 身份与 npm 精确版本、CLI integrity；
- Codex、Claude、Cursor、OpenCode、GitHub Copilot 五种 Adapter；
- `help`、`version`、`state`、`install`、`sync`、`update`、`uninstall`、`check`、`transition`、`approve`、`work-package`、`hook`、`audit`、`archive`；
- Quick、Solid、Major 三个 Flow；
- JSON/text 协议、退出码、诊断码和 `nextActions`；
- 路径、符号链接、所有权、secret redaction、Gate runner 和原子归档安全边界。

### 2.2 不作为当前发布门的范围

- 第三方 AI 平台自身的可用性、计费准确性和 UI；
- 云 Agent 未暴露的 Hook surface；
- 真实企业 IdP 的身份保证；
- 部署、发布和生产回滚；
- 对所有模型版本逐一做确定性输出比较。

这些能力只能做兼容性或 live smoke，不能被 XForge 报告为自身已强制保证。

## 3. 分层架构

| 层 | 名称 | 目的 | 是否发布门 | 主要 oracle |
|---|---|---|---|---|
| L0 | 静态与供应链 | 构建、Schema、Scaffold 摘要、制品等价 | 是 | build、SHA-256、Schema |
| L1 | 单元测试 | 路径、Flow、Adapter、Script、Spec merge 等纯逻辑 | 是 | Vitest 断言/golden |
| L2 | 组件集成 | Gate、治理、Audit、work package、投影生命周期 | 是 | CLI 库结果、文件和 Git |
| L3 | CLI 黑盒 | 独立于实现包验证命令、输出和安全边界 | 是 | 进程 exit/stdout/stderr/fs |
| L4 | 隔离项目场景 | 在完整 Scaffold 项目中验证主流程与失败注入 | 是 | envelope + receipts + acceptance tests |
| L5 | 真实引擎 E2E | 验证 Skills 能驱动模型正确完成规划、实现和验证 | 否，定时/手工 | L4 oracle + 引擎元数据 |

L5 失败需要区分 `product_failure`、`model_behavior_failure`、`provider_failure` 和 `environment_blocked`，不得笼统记为产品失败。

## 4. 环境矩阵

最小发布矩阵：

- Node.js：20 LTS（最低声明版本）和当前受支持 LTS；
- OS：Linux CI、macOS；Windows 至少执行路径和 CLI 黑盒层；
- 模式：Protocol 1 Portable read、Protocol 2 Managed write；
- 项目路径：默认 `xforge/specs|changes`、重定位 `docs/specs|changes`；
- Flow：Quick / Solid / Major；
- Target：五个 Adapter 全部做投影，Claude 做真实引擎主场景；
- Git：无仓库、单提交、正常多提交、dirty worktree、stale HEAD；
- Audit：无远端、远端成功、503 spool、retry 成功、篡改链。

真实引擎 lane 从根 `.env` 只读取变量，不复制文件。必需变量为 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 和模型配置；日志中只记录“已设置/未设置”，不记录值。

## 5. 功能覆盖矩阵

| 能力 | 主成功场景 | 关键失败场景 |
|---|---|---|
| help/version/init | 无项目输出合法帮助/版本；空项目可 dry-run 或初始化 npm 内置 Scaffold | 未知命令、重复/未知参数、已有文件冲突、包内摘要不一致 |
| state | 项目、资源、Change、nextActions、ready set | Portable 写限制、资源/审批签名无效 |
| install | dry-run、全 Target、幂等、discoverable | 未知目标文件、人工修改、身份不匹配 |
| sync | localized source 增量和 digest 复验 | Target identity 改变要求 update |
| update | Lock/Adapter/Target 全量协调、v1 ownership 迁移 | 未安装项目拒绝 |
| uninstall | 单 Target 和最后记录安全清理 | 修改过的 managed file 拒删 |
| check | structure、unit、security、work-package verify | timeout、输出截断、伪造 Evidence、Gate failure |
| transition | 合法下一 Stage、rework、receipt chain | 缺 Artifact/Gate/Approval、stale revision、跳 Stage |
| approve | 当前 revision 的本地/外部签名 receipt | 非 TTY、本地冒充、签名/角色/职责分离失败 |
| work-package | DAG ready、dispatch、delivery、真实 Git diff、verify | 环、越 scope、共享写、绑定/commit/自报验证不实 |
| hook | 平台映射、受保护写 deny、digest-only audit | before fail-closed、unsupported/degraded coverage |
| audit | status/verify/export、hash chain、spool/retry | 篡改、缺事件、Major remote debt |
| archive | dry-run 零写、Gate 重跑、Spec merge、原子 move | stale receipt、冲突、Gate/Approval/Audit 欠账 |

## 6. Flow 与模型行为用例

### 6.1 Quick

- 低风险、单模块、可回滚变更可进入 Apply；
- 不生成 Clarify、Design、Check artifacts；
- security/privacy/public API/data migration 或多模块时必须升级；
- Verify 失败返回 Apply rework；关闭审批与当前 revision 绑定。

### 6.2 Solid

- `propose → design → apply → verify → ready-to-archive → archive`；
- Design → Apply 和 Archive 各需要一个批准；
- 模型只生成语义产物，外部 harness 提供审批；
- implementation commit、work-package delivery、Gate Evidence 和归档后的主 Spec 可追溯。

### 6.3 Major

- 必须经过 Clarify、Design、Check；material questions 未解决时阻塞；
- implementation/closing 均要求两个 actor、不同角色和外部签名；
- LLM Check 写 `PASS` 但 Gate 或 Approval 缺失时仍阻塞；
- remote Audit 欠账存在时不得归档；
- Reviewer/Worker 日志不冒充长期企业审计。

### 6.4 Skill 触发评测

以同一需求构造最小对照提示，覆盖 Explore/Status、Propose/Revise、Continue/Apply、Check/Verify、Verify-only/Verify-and-Archive。断言 Skill 不硬编码 Stage 序列、不直接写 Stage、不生成有效 Approval、不把 review 变成 Machine Evidence。

## 7. 隔离真实引擎样例

样例模板位于 `tests/live-engine/project-seed`，运行副本位于 `tests/.tmp/live-engine-project`。需求是实现一个无第三方运行时依赖的 Task Ledger Node CLI，预置黑盒测试先于实现存在，模型不得修改测试来制造通过。

Solid 全流程：

1. setup 复制完整 Scaffold 和项目种子，初始化独立 Git；
2. `install --dry-run` 后 `install`，检查五 Target 投影和幂等；
3. 引擎生成 Change、Proposal、delta Spec、Design 和一个 `src/**` 工作包；
4. CLI 执行 structure Gate 和 Stage Transition；
5. 测试 harness 以独立 HMAC provider 签发 planning Approval；
6. CLI 进入 Apply 并签发 work-package dispatch receipt；
7. 引擎只实现 `src/**`，预置 `node:test` 验收测试必须通过；
8. harness 用真实 Git diff 生成 delivery，CLI 重新执行 verify；
9. CLI 进入 Verify；引擎生成 Assurance 和 verification receipt；
10. CLI 执行 mandatory Gates、进入 ready-to-archive；harness 签发 closing Approval；
11. `audit verify`、`archive --dry-run`、`archive`；
12. 断言 Change 被移动、Spec 被合并、Evidence/receipts/audit chain 可验证；
13. 在新的副本执行 sync/update/uninstall 和冲突注入，不破坏已归档样例证据。

引擎阶段之间必须由 harness 提交 Git，以避免审批和 Gate 因后续 HEAD 变化自然过期。模型没有审批密钥，也不能访问签名脚本。

## 8. 命令与自动化入口

确定性发布门：

```bash
npm run verify
```

当前沙箱若禁止监听回环端口，分开执行：

```bash
cd xforge
./node_modules/.bin/vitest run test --exclude test/integration/audit.test.ts
./node_modules/.bin/vitest run test/integration/audit.test.ts \
  -t 'detects local hash-chain tampering|makes Major remote debt fail the CI audit verification command'
cd ..
npm run test:product
```

真实引擎样例：

```bash
node tests/live-engine/setup.mjs
node xforge/dist/cli.js --root tests/.tmp/live-engine-project install --dry-run
node xforge/dist/cli.js --root tests/.tmp/live-engine-project install
node tests/live-engine/run-engine.mjs \
  --root tests/.tmp/live-engine-project \
  --prompt tests/live-engine/prompts/01-plan.md \
  --output tests/.tmp/live-engine-results/01-plan.json \
  --allow-behavioral-isolation true
```

后续阶段按 `tests/live-engine/README.md` 执行。Runner 默认执行 9 美元整场预算、每阶段最多两次尝试、单次 3 美元请求上限和 900 秒超时；单次上限会按整场剩余额度收紧。Provider 未返回费用时后续调用 fail-closed。无外部 sandbox launcher 时必须显式确认 behavioral isolation；provider 不可用时保存分类后的失败原因，不得回退成伪造响应。

完整归档后生成机器摘要：

```bash
node tests/live-engine/summarize.mjs \
  --root tests/.tmp/live-engine-project \
  --results tests/.tmp/live-engine-results \
  --output tests/.tmp/live-engine-results/summary.json \
  --change task-ledger
```

重试结果使用 `*-retry.json` 时追加 `--suffix retry`。摘要会重新执行 acceptance、
State 和 Audit 检查，并汇总费用、tokens、receipt 数量、真实 delivery paths 与
Archive 状态；不保存 prompt、模型自然语言结果或凭据。

## 9. 失败注入

- 修改 managed Adapter 输出后执行 sync/uninstall；
- 修改 Proposal/Design 或 Git HEAD 后复用旧 Approval；
- 替换 Gate Evidence digest 或写入手工 Evidence；
- work-package 声明 `src/**`，实际 commit 修改 `test/**`；
- unit test 返回非零、超时并打印 secret-like 文本与超长输出；
- Hook 请求写入 Manifest/Lock/Change 证据；
- Audit event 改一个字段、远端返回 503、retry 后 204；
- Archive 目标已存在、主 Spec 冲突、mandatory Gate 在 archive 重跑时失败；
- `--root` 指向子目录，验证不向父目录搜索。

每次失败均断言：退出码非零、稳定 diagnostic code、stdout 仍为一个 envelope、没有越权或部分写入、已产生的失败 Evidence 可追溯且不含 secret。

## 10. 报告与证据

每次测试运行保存：

- Git commit、Node/npm/CLI/Protocol 版本；
- suite/case、耗时、pass/fail/blocked 分类；
- 命令参数（脱敏）、exit code、diagnostic codes；
- 关键文件树与 digest，不保存 `.env` 值；
- live lane 的 provider、模型、费用/轮次（若引擎返回）和原始响应路径；
- Gate、Transition、Approval、dispatch/delivery、Audit 和 Archive 证据索引。

## 11. 准入与退出标准

进入 live E2E 前：build、Scaffold integrity、L1/L2/L3 必须通过；测试项目必须与主仓隔离；令牌和 Base URL 已设置。

发布退出标准：

- 所有确定性 P0/P1 用例通过；
- 没有未解释的安全、原子性、stale receipt 或协议失败；
- 环境阻塞项有独立复跑证据；
- 文档、Schema、golden、CLI help 和样例一致；
- live E2E 至少一次完整 Solid 成功，或明确分类为 provider/environment blocked；live 失败不被隐藏。

## 12. 当前覆盖缺口与优先级

2026-08-09 已关闭：Audit 503→retry loopback 复跑、真实引擎 Solid 全闭环、
机器可读 live 摘要、CLI 子进程覆盖率门、测试临时目录回收、真实 tarball 安装
smoke、Ubuntu/macOS/Windows 与 Node 20/24 PR matrix，以及 live 整场费用、重试和
超时 policy。真实引擎首次语义不一致被作为 model behavior failure 拦截，重试后
通过，详见 `docs/TEST_REPORT_2026-08-09.md`。

P1：增加 Major 双签 + remote audit 场景、Quick 升级行为评测、CLI 参数组合表和实际平台 Hook trust 测试。

P2：提供项目内置的跨平台 OS sandbox launcher、覆盖多模型/多版本统计、性能基线、长时 soak、远端 Audit 的 TLS/重试抖动和真实企业审批 provider。
