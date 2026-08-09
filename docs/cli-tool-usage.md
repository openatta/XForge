# XForge 命令行使用指南（vNext）

本文描述 `@xforge/cli 0.3.0` 提供的命令，包括 `help`、`version`、`sync`、
`update`、`uninstall` 和 `--root`。

## 1. 基本约定

```text
xforge [--root <path>] <command> [options] [--text]
```

- 默认输出单个 JSON 文档，适合 AI Agent 和脚本读取。
- 添加 `--text` 后输出可读文本，执行结果和退出码不变。
- 成功退出码为 `0`；存在 error 级 Diagnostic 时为 `1`。
- 默认从当前目录向上寻找 `xforge/manifest.yaml`。
- `xforge/scaffold/**` 是源；`.agents/`、`.claude/`、`.cursor/`、
  `.opencode/`、`.github/` 是生成目录，不要直接编辑。
- `xforge/.state.json` 是本地安装记录，不要手工修改。

## 2. 快速开始

首次安装项目级 Scaffold：

```bash
xforge state --text
xforge check --text
xforge install --dry-run --text
xforge install --text
```

修改本地 Scaffold 后增量同步：

```bash
xforge check --text
xforge sync --dry-run --text
xforge sync --text
xforge state --kind skills --text
```

Manifest Target、Scaffold/CLI 版本或 Adapter 发生变化时执行完整更新：

```bash
xforge update --dry-run --text
xforge update --text
```

## 3. 项目根目录

通常可以在项目根或任意子目录运行命令。需要操作另一个项目时使用 `--root`：

```bash
xforge --root ../service-a state --text
xforge --root /workspace/service-b sync --dry-run --text
```

显式指定的目录必须直接包含 `xforge/manifest.yaml`。CLI 不会在显式目录错误时继续
向父目录搜索，这可以避免操作到错误项目。输出中的 `root` 是最终使用的绝对路径。

## 4. 命令速查

| 命令 | 常用参数 | 用途 |
| --- | --- | --- |
| `help [command]` | `--text` | 查看命令帮助 |
| `version` | `--text` | 查看 CLI/协议/构建版本 |
| `state` | `--change`、`--kind`、`--target` | 查询项目事实状态 |
| `install` | `--target`、`--dry-run` | 首次或幂等安装 |
| `sync` | `--target`、`--dry-run`、`--verify-digests` | 增量同步本地 Scaffold |
| `update` | `--target`、`--dry-run` | 全量收敛安装状态 |
| `uninstall` | `--target`、`--dry-run` | 安全移除生成文件 |
| `check` | `--change`、`--gate` | 校验项目和运行 Gate |
| `archive` | `--change`、`--dry-run` | 合并 Specs 并归档 Change |

Target 可取：

```text
claude | codex | cursor | opencode | github-copilot
```

Resource kind 可取：

```text
skills | agents | rules | hooks | gates | scripts
```

## 5. 帮助和版本

```bash
xforge help --text
xforge help sync --text
xforge --help

xforge version
xforge version --text
xforge --version
```

`help` 和 `version` 不要求当前目录是 XForge 项目。默认 JSON 模式便于工具获取命令、
参数和协议版本；`--help`、`--version` 快捷形式直接面向终端阅读。

## 6. 查询状态：`state`

```bash
xforge state
xforge state --change add-login
xforge state --kind agents
xforge state --target codex
xforge state --text
```

主要返回：

- 项目名称、模块和 Specs/Changes 路径；
- CLI、协议、Scaffold 和 Lock 兼容状态；
- Specs、活动 Changes、Flows 和已选择资源；
- Target 能力矩阵；
- 指定 Change 的 Artifact、下一动作、Rules、Work Packages；
- 安装记录版本、已安装 Target、记录健康度和最后同步时间。

`state` 是只读命令。Portable 模式下仍尽可能返回数据，但身份不匹配 Diagnostic 可能
使退出码为 `1`。

## 7. 首次安装：`install`

```bash
xforge install --dry-run --text
xforge install --text
xforge install --target codex --text
```

`install` 会：

1. 验证 Manifest、Lock、资源引用和路径；
2. 让每个 Target Adapter 生成期望文件；
3. 检查现有文件所有权和内容摘要；
4. 写入生成文件、`xforge/lock.yaml` 和 `xforge/.state.json`；
5. 返回 create/modify/delete/skip/conflict 清单。

先运行 `--dry-run`。它不会创建安装记录、修改 Lock 或写生成目录。

重复执行 install 是幂等的；没有变化的文件显示为 `skip`。CLI 只清理自己记录且未被
用户修改的 managed 文件。

## 8. 同步项目级 Scaffold：`sync`

```bash
xforge sync --dry-run --text
xforge sync --text
xforge sync --target claude --text
xforge sync --verify-digests --dry-run --text
```

适用场景：

- 修改了 `xforge/scaffold/skills/**`；
- 修改了 Agent YAML 或 instructions；
- 修改了 Rule、Hook、Gate；
- 在 Manifest 中启用、停用、新增或删除 Scaffold resource；
- 希望只更新受影响的已安装 Target 文件。

同步判断顺序：

```text
安装记录中的 source 集合/mtime/size
  → 找出候选变化
  → SHA-256 确认内容变化
  → Adapter 只重渲染受影响输出
  → 检查目标文件仍等于上次安装摘要
  → 事务写目标、Lock 和安装记录
```

`--verify-digests` 会忽略时间戳快速路径，对全部 canonical source 重新计算摘要。
以下情况建议使用：

- 从 Git 恢复或切换分支后；
- CI/cache 恢复后；
- 文件被复制并保留了原修改时间；
- 怀疑内容变化但普通 sync 显示无变化。

如果 Target 集、CLI/Scaffold identity 或 Adapter 版本发生变化，sync 会停止并建议
执行 `update`。

### 8.1 `xforge-scaffold` 推荐流程

仅修改已存在资源：

```bash
xforge state --kind skills --text
# 编辑 xforge/scaffold/skills/<id>/**
xforge check --text
xforge sync --dry-run --text
xforge sync --text
xforge state --kind skills --text
```

新增或启停资源：

```bash
# 编辑 xforge/scaffold/**，并最小修改 xforge/manifest.yaml selection
xforge check --text
xforge sync --dry-run --text
xforge sync --text
```

在执行正式 sync 前，应展示 Target 的 native/degraded/unsupported 能力、生成文件
diff、权限变化和冲突。涉及 Hooks、Secrets、网络或工具权限扩大时仍需用户确认。

## 9. 完整更新：`update`

```bash
xforge update --dry-run --text
xforge update --text
xforge update --target cursor --text
```

使用 update 而不是 sync 的情况：

- Manifest 的 Target 列表变化；
- Scaffold source/version 变化；
- CLI 版本或构建身份变化；
- Adapter 渲染版本变化；
- 旧 v1 安装记录需要升级；
- 需要进行一次全量 source 摘要和完整收敛。

update 不下载远程 Scaffold 或 CLI。应先通过 Bootstrap/包管理器把需要的版本放到
本地，再运行 update。

如果项目还没有安装记录，update 会建议执行 install；它不会静默变成首次安装。

## 10. 卸载：`uninstall`

预览清理范围：

```bash
xforge uninstall --target codex --dry-run --text
xforge uninstall --dry-run --text
```

执行：

```bash
xforge uninstall --target codex --text
xforge uninstall --text
```

- `--target` 只卸载一个 Target；省略时卸载安装记录中的全部 Target。
- 只删除 `.state.json` 记录且摘要未变化的生成文件。
- 不删除 `xforge/scaffold`、Manifest、Lock、Specs、Changes 或 archive。
- 最后一个 Target 移除后删除 `.state.json`。
- 如果生成文件被手工修改，卸载返回 conflict 且不删除任何文件。请先保存需要的
  内容并恢复文件到上次安装状态，再重试。

## 11. 校验：`check`

```bash
xforge check --text
xforge check --change add-login --text
xforge check --change add-login --gate unit-tests --text
```

- 无 Change 时执行项目结构、Schema、引用和 Lock 校验。
- `--change` 额外验证 Change、Flow、Artifact、交付记录和 Work Packages。
- 指定 Change 后运行 Gate 会把 Evidence 写入 Change 的 `evidence/`。
- 外部 Gate 需要 Change，因此应同时使用 `--change` 和 `--gate`。

## 12. 归档：`archive`

```bash
xforge archive --change add-login --dry-run --text
xforge archive --change add-login --text
```

正式归档会检查必需 Artifact、未完成任务和 mandatory Gates，合并 Change Specs，
然后把 Change 目录移动到 `archive/`。Spec 写入和目录移动是可回滚事务。

归档前始终先运行 dry-run。Gate Evidence 在归档检查阶段可能写入；archive 自身的
`--dry-run` 不写任何文件。

## 13. JSON 输出

所有正式命令返回相同 Envelope：

```json
{
  "protocolVersion": "1",
  "ok": true,
  "command": "sync",
  "root": "/workspace/project",
  "data": {},
  "diagnostics": [],
  "changes": [],
  "nextActions": []
}
```

- `data`：命令结果和汇总。
- `diagnostics`：稳定 `code`、severity、message，可带 path/details。
- `changes`：`create`、`modify`、`delete`、`move`、`skip`、`conflict` 文件计划。
- `nextActions`：建议的恢复或后续命令。

脚本应判断 `ok` 和 Diagnostic `code`，不要依赖英文 message。

## 14. 常见问题

### `XFORGE_NOT_INSTALLED`

当前项目没有安装记录。首次使用请运行：

```bash
xforge install --dry-run --text
xforge install --text
```

### `XFORGE_STATE_UPGRADE_REQUIRED`

当前是 v1 record，先完整升级：

```bash
xforge update --dry-run --text
xforge update --text
```

### `XFORGE_FULL_UPDATE_REQUIRED`

Target、CLI、Scaffold 或 Adapter identity 已变化，普通增量同步不足：

```bash
xforge update --dry-run --text
xforge update --text
```

### `XFORGE_INSTALL_RECORD_CONFLICT` / `XFORGE_UNINSTALL_CONFLICT`

生成目标和安装记录不一致，通常是生成目录被直接编辑。CLI 不会自动覆盖或删除。
先备份人工修改，恢复生成文件，或把有价值的变更移回 `xforge/scaffold/**`，然后重新
运行 dry-run。

### 指定 Root 仍报告找不到项目

确认指定目录本身包含 Manifest，而不是它的父目录或子目录：

```bash
test -f /workspace/project/xforge/manifest.yaml
xforge --root /workspace/project state --text
```
