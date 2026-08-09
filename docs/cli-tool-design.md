# XForge CLI vNext 设计

状态：已实现  
目标版本：`@xforge/cli 0.3.0`  
文件协议：继续使用 Protocol `1`  
适用范围：当前 `xforge/` TypeScript CLI

## 1. 背景

当前 CLI 只提供 `state`、`install`、`check`、`archive` 四个命令。`install`
已经把生成文件的目标路径、Target、来源标识和摘要写入
`xforge/.state.json`，但记录里没有 canonical source 路径、修改时间和源摘要，
因此无法低成本判断 `xforge/scaffold/**` 中哪些改动需要重新投影。

项目级 Scaffold 的预期工作方式是：

```text
xforge/scaffold/**              canonical source
        ↓ Resource Loader + Target Adapter
.agents/ .claude/ .cursor/ ... generated projection
```

生成目录不是源文件，不能直接编辑。vNext 需要让安装、增量同步、完整更新和卸载
共享同一套 Adapter 计划、所有权记录、冲突检测与事务写入能力。

## 2. 目标与非目标

### 2.1 目标

- 补齐 `help`、`version`、`update`、`uninstall`。
- 新增 `sync`，供 `xforge-scaffold` Skill 把本地 canonical asset 增量同步到
  已安装 Target。
- 把 `xforge/.state.json` 升级为可追踪 source → rendered output 的安装记录。
- 支持显式 `--root <path>`，同时保留从当前工作目录向上发现项目的能力。
- 所有写操作继续遵守 managed-only、冲突即失败、路径安全和事务回滚。
- 默认继续输出 Protocol-1 JSON Envelope，保持 Agent 侧解析稳定。

### 2.2 非目标

- `update` 不从 Git、HTTP 或 npm 自动下载新的 Scaffold/CLI；远程获取仍由
  Bootstrap 或包管理器负责。
- `sync` 不监控文件系统，也不常驻运行。
- 修改时间不是内容真实性依据；它只用于缩小需要计算摘要和重新渲染的集合。
- CLI 不直接编辑 Skill、Agent、Rule、Hook、Gate 或 Manifest。
- `uninstall` 不删除 `xforge/scaffold`、Manifest、Lock、Specs、Changes 或归档。

## 3. 命令模型

统一语法：

```text
xforge [--root <path>] <command> [command-options] [--text]
```

全局选项可以放在命令前或命令后，但文档统一把 `--root` 放在命令前。除
`help [command]` 外仍禁止位置参数和重复选项。

| 命令 | 项目必需 | 写入 | 语义 |
| --- | --- | --- | --- |
| `help [command]` | 否 | 否 | 返回总帮助或单命令帮助 |
| `version` | 否 | 否 | 返回 CLI、协议、构建身份和 Node 版本 |
| `state` | 是 | 否 | 返回项目、资源、Change 和安装状态 |
| `install` | 是 | 是 | 首次安装或幂等地建立完整期望状态与安装记录 |
| `sync` | 是 | 是 | 把本地 Scaffold 改动增量投影到已安装 Target |
| `update` | 是 | 是 | 完整重新解析并收敛 Manifest、Target、Adapter 和资源选择 |
| `uninstall` | 是 | 是 | 按安装记录安全移除一个或全部 Target 的生成文件 |
| `check` | 是 | 条件写入 | 校验结构；运行 Gate 时写 Evidence |
| `archive` | 是 | 是 | 验证、同步 Specs 并归档 Change |

选择 `sync` 而不是 `reinstall` 或 `deploy`：`sync` 能准确表达本地 canonical
source 到项目生成目录的方向；`reinstall` 暗示无条件全量覆盖，`deploy` 容易被理解
为远程发布。

### 3.1 全局入口

#### `help`

```text
xforge help
xforge help sync
xforge --help
```

- `xforge help` 默认仍返回 JSON；`xforge help --text` 返回人类可读文本。
- `xforge --help` 是 `xforge help --text` 的快捷方式。
- 未知命令返回 `XFORGE_HELP_COMMAND_UNKNOWN`。

#### `version`

```text
xforge version
xforge version --text
xforge --version
```

`data` 至少包含 `name`、`version`、`protocolVersion`、`nodeVersion`、
`buildIdentity` 和 `integrity`。`xforge --version` 是文本快捷方式。

### 3.2 项目根目录

```text
xforge state
xforge --root ../service-a state
xforge --root /workspace/service-a sync --dry-run
```

规则：

1. 未指定 `--root` 时，以 `process.cwd()` 为起点向上查找
   `xforge/manifest.yaml`，保持当前在项目子目录执行的体验。
2. 指定 `--root` 时，相对路径按调用时工作目录解析，然后 `realpath` 为绝对路径；
   该目录必须直接包含 `xforge/manifest.yaml`，不得再向上回退。
3. 所有逻辑路径、Gate working directory、安装目标和归档目标都相对解析后的
   Project Root。
4. Envelope 的 `root` 始终返回规范化绝对路径。
5. `help`、`version` 不加载项目，也不接受 `--root`。

## 4. 安装记录 v2

继续使用 `xforge/.state.json`，避免同时维护 ownership 和 installation 两份事实源。
它是本地生成状态，默认不提交 Git，也不得手工修改。

建议结构：

```json
{
  "version": 2,
  "protocolVersion": "1",
  "generatedAt": "2026-08-09T10:00:00.000Z",
  "manifestSelectionDigest": "...",
  "manifestTargets": ["codex"],
  "scaffoldIdentity": "...",
  "cliIdentity": "...",
  "targets": {
    "codex": {
      "adapterVersion": "1",
      "installedAt": "2026-08-09T10:00:00.000Z",
      "lastUpdatedAt": "2026-08-09T10:00:00.000Z",
      "lastSyncedAt": "2026-08-09T10:05:00.000Z",
      "files": {
        ".agents/skills/xforge-scaffold/SKILL.md": {
          "resource": { "kind": "skill", "id": "xforge-scaffold" },
          "sources": [
            {
              "path": "xforge/scaffold/skills/xforge-scaffold/SKILL.md",
              "mtimeMs": 1786269600000,
              "size": 2048,
              "digest": "..."
            }
          ],
          "renderVersion": "copy-v1",
          "desiredDigest": "...",
          "lastInstalledDigest": "...",
          "cliVersion": "0.3.0"
        }
      }
    }
  }
}
```

关键约束：

- `path` 全部是 Project Root 相对 POSIX 路径。
- `sources` 必须列出影响输出的所有输入。例如 Agent 输出同时依赖 Agent YAML
  和 instructions Markdown；Adapter bootstrap 文件使用虚拟 source 标识。
- `mtimeMs + size` 用于快速候选筛选，`digest` 才是内容判定依据。
- `desiredDigest` 是当前 Adapter 渲染结果；`lastInstalledDigest` 是上次成功写入值，
  用于识别用户直接修改生成目录的冲突。
- 只有整个文件事务成功后才能替换 `.state.json`；失败时安装记录必须保持原值。

### 4.1 Adapter 契约

Adapter 不直接写 `.state.json`。它负责把 canonical resource 转换为带来源信息的
期望输出，由中央 Planner/Writer 统一记录和提交：

```ts
interface SourceInput {
  path: string;
  kind: 'file' | 'virtual';
}

interface DesiredArtifact {
  path: string;
  content: Buffer;
  target: TargetId;
  resource: { kind: string; id: string };
  sources: SourceInput[];
  renderVersion: string;
}
```

这样既把 source → destination 映射放在最了解渲染行为的 Adapter 中，又避免各
Adapter 各自实现状态写入、锁和回滚。

## 5. 写命令处理流程

### 5.1 `install`

```text
load/validate project
  → resolve selected resources
  → Adapter 生成全部 DesiredArtifact
  → 与现有文件和 v1/v2 record 比较
  → 生成 create/modify/delete/skip/conflict 计划
  → dry-run：只返回计划
  → 事务写目标文件、lock.yaml、.state.json
```

参数：

```text
xforge install [--target <target>] [--dry-run] [--text]
```

- 无 `--target` 时安装 Manifest 中所有 Target。
- 已存在 v2 record 时保持幂等，行为仍是完整收敛。
- v1 record 在成功安装时通过一次全量 source scan 迁移到 v2。

### 5.2 `sync`

```text
xforge sync [--target <target>] [--dry-run] [--verify-digests] [--text]
```

定位为项目级 Scaffold 的高频增量通道：

1. 要求存在 v2 安装记录；v1 record 返回 `XFORGE_STATE_UPGRADE_REQUIRED`，建议先
   运行 `update --dry-run` 和 `update`。
2. 无 `--target` 时同步 record 中仍被 Manifest 启用的全部已安装 Target。
3. 重新读取当前 Manifest selection 和 `xforge/scaffold/**`。Skill/Agent/Rule 等
   新增、删除、启用、停用均可在已安装 Target 内形成 create/delete 计划。
4. 如果 Manifest Target 集、Scaffold identity、CLI identity 或 Adapter version
   变化，停止并返回 `XFORGE_FULL_UPDATE_REQUIRED`；这类变化交给 `update`。
5. 比较 source path 集合、`mtimeMs`、size 和 renderVersion。只有候选变更项才计算
   SHA-256 和重新渲染；`--verify-digests` 强制扫描全部 source，用于时间戳不可信的
   Git 恢复、文件复制或 CI 场景。
6. source 时间变化但摘要未变时，只更新 record 元数据，不重写目标文件。
7. 写入前计算目标文件摘要。若不等于 `lastInstalledDigest`，产生 conflict，整个
   同步不写入。
8. 事务写入受影响的目标文件、更新后的 `xforge/lock.yaml` 资源摘要及
   `.state.json`。

`sync --dry-run` 必须零写入，包括不得更新访问时间、安装时间、Lock 或 record。

### 5.3 `update`

```text
xforge update [--target <target>] [--dry-run] [--text]
```

`update` 是低频、全量的 declarative reconcile：

- 全量计算 source 摘要并重新解析所有选择资源。
- 处理 Manifest Target 增删、Scaffold version/source、CLI version 和 Adapter
  renderVersion 变化。
- 无 `--target` 时为新增 Target 建立安装记录，并安全清理 Manifest 已移除 Target
  的 managed-only 文件。
- 指定 `--target` 时只更新该 Target，不隐式删除其他 Target。
- 若完全没有安装记录，返回 `XFORGE_NOT_INSTALLED` 并建议执行 `install`，不把
  “更新”静默降级为“首次安装”。

`install` 与 `update` 共用 Planner/Writer；区别是意图、前置条件和 Target 集变化
策略，不复制实现。

### 5.4 `uninstall`

```text
xforge uninstall [--target <target>] [--dry-run] [--text]
```

- 指定 Target 时只移除该 Target；省略时移除 record 中全部 Target。
- 仅删除 record 中登记且当前摘要仍等于 `lastInstalledDigest` 的文件。
- 任一文件被用户修改、变成符号链接或非普通文件时产生 conflict，整个卸载不写入；
  vNext 不提供强制删除选项。
- 仅在已知 generated roots 下清理空目录，不递归删除根目录。
- 删除 Target 对应 record；最后一个 Target 移除成功后删除 `.state.json`。
- 保留 `xforge/lock.yaml` 和全部 canonical/project data。
- 为保证旧版本或错误版本安装后仍可清理，卸载只要求协议兼容、record 可验证，
  不要求 Manifest 中的 CLI patch/minor 版本与当前运行版本完全一致。

## 6. `xforge-scaffold` Skill 集成

Skill 的建议执行路径调整为：

```text
xforge state --kind <resource>
  → 修改 xforge/scaffold/**
  → 必要时修改 Manifest selection
  → xforge check
  → xforge sync --dry-run
  → 展示变化/权限/降级并取得必要确认
  → xforge sync
  → xforge state --kind <resource>
```

以下情况改用 `update --dry-run` / `update`：

- Manifest Target 集发生变化；
- Scaffold source/version 或 CLI identity 变化；
- Adapter renderVersion 变化；
- v1 安装记录需要迁移；
- 用户明确要求全量重建安装状态。

Skill 仍不得直接写 `.agents/`、`.claude/`、`.cursor/`、`.opencode/`、`.github/`
或 `.state.json`。

## 7. 输出协议

所有正式命令默认输出单个 JSON Envelope：

```json
{
  "protocolVersion": "1",
  "ok": true,
  "command": "sync",
  "root": "/workspace/project",
  "data": {
    "dryRun": false,
    "targets": ["codex"],
    "recordVersion": 2,
    "scannedSources": 12,
    "changedSources": 1,
    "renderedFiles": 1,
    "summary": {
      "create": 0,
      "modify": 1,
      "delete": 0,
      "skip": 11,
      "conflict": 0,
      "recordOnly": 0
    }
  },
  "diagnostics": [],
  "changes": [],
  "nextActions": []
}
```

命令的 `data` 最低要求：

| 命令 | `data` 关键字段 |
| --- | --- |
| `help` | `usage`、`commands`、`globalOptions`、`commandHelp` |
| `version` | `name`、`version`、`protocolVersion`、`nodeVersion`、`buildIdentity`、`integrity` |
| `install/update` | `dryRun`、`targets`、`capabilities`、`recordVersion`、`summary` |
| `sync` | `dryRun`、`targets`、扫描/变化/渲染数量、`recordVersion`、`summary` |
| `uninstall` | `dryRun`、`targets`、`remainingTargets`、`summary` |

`changes[]` 继续使用 `create | modify | delete | move | skip | conflict`。只更新
source 时间戳记录但输出内容未变时，不增加新的 action 枚举，而是在 `data.summary`
计入 `recordOnly`，并把 `.state.json` 报告为 `modify`。

退出码保持：`ok: true` 为 `0`，否则为 `1`。`--text` 只改变呈现。标准错误流默认
为空，所有可处理错误进入稳定 Diagnostic。

## 8. 安全和事务边界

- 显式 Root、source 和 destination 都必须经过 safe path/symlink escape 校验。
- Adapter 输出路径只能位于已注册 Target 的 generated roots。
- 检测到 unmanaged destination、已修改 managed file、输出路径碰撞、secret-like
  内容或非法 symlink 时，整个写计划失败。
- `install`、`sync`、`update`、`uninstall` 使用同一事务写入器：先备份所有受影响
  文件，再写目标、Lock 和 record；失败逆序恢复。
- `.state.json` 不能作为覆盖用户文件的授权；目标当前摘要始终要现场校验。
- `mtimeMs` 只能减少散列工作，不能绕过目标摘要和 ownership 检查。

## 9. 兼容性和迁移

- Protocol Envelope 不变，因此文件协议保持 `1`；新增命令属于 CLI minor version。
- `state` 应同时读取 v1/v2 record，并在 `data.installation` 中显示版本、已安装
  Target、记录健康度及上次同步时间。
- `install`、`update` 可事务迁移 v1 → v2；`sync` 不猜测旧 source 映射。
- 现有 `install --dry-run`、`install` 继续有效，原有自动 prune 和冲突语义保留。
- 旧自动化遇到新命令前不会改变行为；新增全局 `--root` 不改变未指定时的发现逻辑。

## 10. 建议诊断码

| Code | 含义 |
| --- | --- |
| `XFORGE_ROOT_NOT_FOUND` | 显式 Root 不存在或不含 Manifest |
| `XFORGE_ROOT_NOT_DIRECTORY` | 显式 Root 不是目录 |
| `XFORGE_NOT_INSTALLED` | update/sync/uninstall 没有安装记录 |
| `XFORGE_TARGET_NOT_INSTALLED` | 指定 Target 未安装 |
| `XFORGE_STATE_UPGRADE_REQUIRED` | sync 遇到 v1 record |
| `XFORGE_FULL_UPDATE_REQUIRED` | sync 检测到 Target/Scaffold/CLI/Adapter 身份变化 |
| `XFORGE_SOURCE_MISSING` | 已选资源的 canonical source 缺失 |
| `XFORGE_INSTALL_RECORD_CONFLICT` | record 与目标现场状态不一致 |
| `XFORGE_UNINSTALL_CONFLICT` | 卸载目标已被用户修改或类型异常 |
| `XFORGE_HELP_COMMAND_UNKNOWN` | help 请求了未知命令 |

## 11. 验收条件

1. `help`、`version` 在项目外可运行，JSON、文本和退出码语义一致。
2. `--root` 相对/绝对路径正常工作；显式错误目录不会向父目录回退。
3. 首次 install 生成 v2 record，所有 Adapter 输出均可追溯到 canonical source。
4. 连续 install/update/sync 幂等，未变化文件不重写、mtime 不变化。
5. 修改单个 Skill 文件后，sync 只重渲染受影响输出并更新 Lock/record。
6. 新增、删除或停用资源后，sync 在已安装 Target 内正确 create/prune。
7. Target、CLI、Scaffold 或 Adapter 版本变化时，sync 要求 full update。
8. `--verify-digests` 能发现 size/mtime 未变但内容变化的 source。
9. 直接修改生成文件会使 sync/update/uninstall 冲突，不覆盖或删除用户内容。
10. uninstall 可按 Target 或全部清理；最后一个 Target 移除后删除 `.state.json`。
11. 所有 dry-run 零写入，所有事务失败可恢复。
12. `xforge-scaffold` 的“编辑 → check → sync dry-run → sync → state”闭环有集成测试。
