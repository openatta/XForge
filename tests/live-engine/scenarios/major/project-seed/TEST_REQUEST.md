# Credential Store 测试需求

请实现一个无第三方运行时依赖的 Node.js 命令行工具，入口为
`src/cli.mjs`，管理凭证（credential）的存储、校验与轮换。这是涉及安全存储和
存储格式数据迁移的高风险变更，必须使用 XForge Major Flow，Change ID 固定为
`credential-store`。

## 功能需求

### REQ-CRED-001 存储凭证

`node src/cli.mjs store --id <id> --secret <text>` 创建一条新凭证记录。
`secret` 只能以加盐哈希形式落盘（使用 Node 内置 `node:crypto` 的
`scryptSync`，不得引入第三方依赖，不得明文或可逆存储）。重复 `--id` 是数据
错误。

### REQ-CRED-002 校验凭证

`node src/cli.mjs verify --id <id> --secret <text>` 返回
`data.valid: true|false`。未知 `id` 返回 `CREDENTIAL_NOT_FOUND` 诊断。

### REQ-CRED-003 轮换凭证（无宽限期，立即失效）

`node src/cli.mjs rotate --id <id> --secret <text>` 把凭证替换为新值。轮换后
旧 secret 必须立即失效——`verify` 不得再接受旧 secret，没有宽限期。这是安全
默认值，已经过 Clarify 阶段针对"轮换后是否保留宽限期"这一材料性问题的正式
澄清和记录，不是实现细节的自由选择。

### REQ-CRED-004 存储格式迁移（v1 -> v2）

历史数据文件可能是 v1 格式（无 `version` 字段）：

```json
{"credentials":{"<id>":{"hash":"...","salt":"..."}}}
```

首次读取时必须原子迁移为 v2 格式（不得丢数据）：

```json
{"version":2,"credentials":{"<id>":{"algorithm":"scrypt","hash":"...","salt":"...","rotatedAt":"<ISO8601>"}}}
```

损坏文件不得被覆盖。

### REQ-CRED-005 协议与错误

数据文件由 `CREDENTIAL_STORE_FILE` 指定；未指定时使用
`.credential-store/store.json`。stdout 每次只输出一个 JSON 文档，stderr 保持
空。输出 envelope：

- 成功：`ok=true`、`data` 非空、`diagnostics=[]`；
- 使用错误：exit 2，诊断码 `USAGE_ERROR`；
- 已存在的 id、未知 id、数据错误：exit 1，分别使用 `CREDENTIAL_EXISTS`、
  `CREDENTIAL_NOT_FOUND`、`DATA_INVALID`。

## 分类与治理

- risk: high；security: true；dataMigration: true；privacy/publicApi: false；
- 这些分类使 Major 成为 Flow Policy 下的必选项（`requiredWhen`），不是可自由
  选择 Quick/Solid 的场景；
- Clarify 阶段必须正式记录并解决"轮换后是否保留宽限期"这一材料性问题，再更新
  Proposal 与 delta Spec，不能把它当实现细节悄悄决定；
- Design 必须覆盖 trust boundaries、风险与缓解、测试策略、rollout/monitoring/
  stop signals、owner 和并行边界；
- Check 阶段必须对 Proposal/Specs/Clarifications/Design 做语义审查，发现的问题
  必须记录为 blocker/warning/suggestion 并指出 rework 的 Stage；
- Apply 前需要 `implementation-major` 审批，Archive 前需要 `closing-major` 审批；
  两者都要求审批人**不是本 Change 的实施者**（`separationOfDuties`），而不是
  凑够两个签名——按角色计数正是这条规则替换掉的那个缺陷。

## 工程约束

- 只能实现 `src/**`；不得修改 `test/**`、`TEST_REQUEST.md` 或 XForge 治理资产来规避验收；
- 使用现有 `node:test` 黑盒测试，不引入依赖，只用 `node:crypto`/`node:fs`；
- 本项目的安全扫描就是 `npm audit --audit-level=high`：零运行时依赖是本项目的安全姿态，
  依赖树上没有东西可被利用，`npm audit` 正是断言这一点的命令；
- 创建一个 `T001` 工作包，`write_paths` 为 `src/**`，输入包含 delta Spec、
  Clarifications 和 Design，Skill 为 `xforge-apply`，验证命令为 `npm test`。

## 验收标准

`npm test` 全部通过；完整 Major Change 经当前 revision 的 Clarify、Design、
Check、Approval、Gate、Transition、work-package dispatch/delivery、Audit
和 Archive 后，delta Spec 合并到主 Specs，原 Change 被原子移动到 archive。
