# Credential Store 需求

请实现一个 Node.js 命令行工具，入口 `src/cli.mjs`，管理凭证的存储、校验与轮换。

## 功能需求

### REQ-CRED-001 存储凭证

`node src/cli.mjs store --id <id> --secret <text>` 创建一条新凭证记录。
secret 只能以加盐哈希形式落盘，不得明文或可逆存储。重复 `--id` 是数据错误。

### REQ-CRED-002 校验凭证

`node src/cli.mjs verify --id <id> --secret <text>` 返回 `data.valid: true|false`。
未知 id 返回 `CREDENTIAL_NOT_FOUND` 诊断。

### REQ-CRED-003 轮换凭证

`node src/cli.mjs rotate --id <id> --secret <text>` 把凭证替换为新值。

轮换后旧 secret 是否保留一段宽限期，需求方内部有分歧，请在动工前把它定下来并记录理由。

### REQ-CRED-004 存储格式迁移

历史数据文件可能是旧格式（无 version 字段）：

```json
{"credentials":{"<id>":{"hash":"...","salt":"..."}}}
```

首次读取时必须迁移为新格式，不得丢数据：

```json
{"version":2,"credentials":{"<id>":{"algorithm":"scrypt","hash":"...","salt":"...","rotatedAt":"<ISO8601>"}}}
```

损坏文件不得被覆盖。

### REQ-CRED-005 协议与错误

数据文件位置由 `CREDENTIAL_STORE_FILE` 指定，默认 `.credential-store/store.json`。
stdout 每次只输出一个 JSON 文档，stderr 保持空。

- 成功：`ok=true`、`data` 非空、`diagnostics=[]`
- 使用错误：exit 2，诊断码 `USAGE_ERROR`
- 已存在的 id / 未知 id / 数据损坏：exit 1，分别为 `CREDENTIAL_EXISTS`、
  `CREDENTIAL_NOT_FOUND`、`DATA_INVALID`

## 性质

这次改动涉及安全存储，并且要就地迁移线上已有的数据文件。做错了会泄露凭证或丢数据。

## 工程约束

- 只实现 `src/**`；`test/**` 是既有的黑盒验收套件，不得修改
- 不引入任何第三方运行时依赖，只用 Node 内置模块
- 本项目的安全检查是 `npm audit --audit-level=high`；零运行时依赖就是本项目的安全姿态
- 验收标准：`npm test` 全部通过
