# 迁移方案：旧内容归档，仓库按标准 TS 项目完全新建

> 依据是 `docs/` 下的四份概念文档。这份只讲仓库与 npm 包怎么组织、旧内容放哪、迁移步骤与验收。
> 新代码怎么写在另外三份设计里：[规则文件](rule-files.md)、[命令行](cli.md)、[Skill](skills.md)。
>
> 标着 **决定** 的是本方案自己定的事，审阅时可以推翻；标着 `MG-nn` 的是可验收的断言。

---

## 0. 决定清单

| # | 决定 | 理由 |
| --- | --- | --- |
| **D1** | 旧内容**整体**移入 `legacy/`，不参与构建、测试、发布与 lint；新线**完全新建**，不从旧代码复制任何文件 | 逐模块判定「照搬 / 改写」会把旧接口与旧耦合带进新线；长期维护要的是一套只按新设计写成的代码。旧内容留在仓库里直到新线稳定（已于 2026-09-17 删除，见 MG-07）只为了随手对照，新线稳定后整目录删除 |
| **D2** | 仓库根就是 npm 包根 | 一个仓库一个包，`npm --prefix` 这类间接调用消失；标准 TS 项目的默认假设 |
| **D3** | 包名保留 `@xforge/cli`；新线版本从 `1.0.0-alpha.1` 起，发布到 dist-tag `next`，稳定后转 `latest` | npm 上已有 `0.8.6`。分支名 `v1.0.0` 与 npm 版本线一致（分支最初叫 `v0.2.0`，2026-09-16 改名：旧线的 `v0.x` 标签与 npm 上的 `0.x` 发布一一对应，保持不动，新线分支按版本号命名，第一个是 `v1.0.0`）；发一个比 `0.8.6` 小的版本会让 `latest` 语义混乱 |
| **D4** | 测试分四层：`unit`（纯函数与模块）、`integration`（在临时项目上跑真实命令）、`product`（README 与文档族的断言）、`live`（真实模型，手动或定时跑，不进合并门） | 分层思路在旧线已被证明有效；只是全部重写 |
| **D5** | 构建时生成脚手架完整性清单（每个受管文件的校验和 + 脚手架版本），不记 CLI 版本 | 升级事务要逐文件分类「受管未改 / 项目改过」，没有已知校验和就分不了；CLI 版本匹配放在 `init`/`upgrade` 判，不放在每次调用 |
| **D6** | 依赖只有 `yaml`、`ajv`、`ajv-formats`、`fast-glob`；不引入 MCP SDK | 外部审批服务自己调「证」，控制面不托管服务器 |
| **D7** | 执法有独立入口 `bin/xforge-enforce.js`，只引入策略求值与 YAML 读取，不引入主 CLI | 执法每次工具调用都跑，进程启动是它的主要成本；主 CLI 的模块图不能拖它 |
| **D8** | `README.md`、`AGENTS.md`、`CLAUDE.md` 按新布局重写；`docs/internal/` 随旧内容进 `legacy/` | 它们描述旧版本，留在原位只会被误读为现状 |
| **D9** | 新线的每个源文件必须能追溯到三份设计里的某个章节（文件头一行注释写 `design: cli §2.3` 这类指针） | 「完全新建」要有可检验的形式：没有设计依据的代码不该出现 |

---

## 1. 目标布局

```text
/                               ← 仓库根 = @xforge/cli 包根
  package.json  tsconfig.json  tsconfig.test.json  vitest.config.ts
  bin/
    xforge.js                   主入口（五动词、装配、元信息）
    xforge-enforce.js           执法入口（D7）
  src/
    cli/          参数解析、统一信封、--text 渲染、退出码
    verbs/        state · inspect · run · attest · advance        ← 命令行设计 §2
    assemble/     init · update · sync · doctor · repair · remove       ← 命令行设计 §5
    enforce/      策略集装载、投影查找、决策；payloads/ 每 provider 的载荷解析与决策渲染  ← 命令行设计 §4
    meta/         help · version · explain（诊断码字典）
    model/        每种规则文件的加载器与校验                      ← 规则文件设计
    machines/     Stage 机与工作包机：转换表、前置条件、receipt 链
    gates/        门运行器：读门定义、跑命令、写运行记录、受理台账
    baselines/    规格 / 接口的 delta 合并与两层索引
    audit/        审计链、身份、HMAC、锁
    projection/   作用域与写入路径 → 策略
    providers/    宿主适配（装配侧）：探测 · 能力 · 投影 · 诊断 · 修复；claude · codex  ← 命令行设计 §5
    mcp/          MCP 审批的客户端：stdio JSON-RPC，一次 initialize 加一次 tools/call  ← 命令行设计 §2.4
    fs/           受治理写入（原子、可回退）、路径安全、标记块、所有权分区
  schemas/        JSON Schema，随包发布                          ← 规则文件设计
  scaffold/       载荷：flows/ gates/ policies/ skills/ agents/    ← 规则文件设计 + Skill 设计
  diagnostics/    诊断码字典（YAML，按码一文件）
  test/
    unit/  integration/  product/  live/  fixtures/  helpers/
  scripts/        release-check · prepare-release · privacy-check · red-first · clean-tmp · scaffold-integrity
  docs/           概念文档族 + design/
  legacy/         旧内容，见 §2；不在任何 tsconfig / vitest / eslint / npm files 的范围内
```

`MG-01` 仓库根含 `package.json`，其 `bin.xforge` 指向 `bin/xforge.js`，`bin.xforge-enforce` 指向 `bin/xforge-enforce.js`。
`MG-02` `src/` 顶层目录集合恰好是上表那 14 个；新增目录要先改这份文档。`providers/`（装配侧）与 `enforce/payloads/`（执法侧）是同一个 provider 的两半，互不 import：执法进程的模块图不许触及装配侧（`MG-03`）。
`MG-03` `src/enforce/**` 与 `bin/xforge-enforce.js` 的静态导入闭包不含 `src/verbs`、`src/assemble`、`src/hosts`、`src/gates`、`src/baselines`（一个单元测试遍历 import 图断言）。
`MG-04` `npm pack` 的内容恰好是 `bin/ dist/ schemas/ scaffold/ diagnostics/ README.md LICENSE NOTICE`；不含 `legacy/`。
`MG-05` `src/**` 与 `test/**` 里没有任何 import 指向 `legacy/`；`legacy/` 里没有任何文件被 `tsconfig`、`vitest.config`、`package.json#files` 包含。
`MG-06` `src/**` 每个 `.ts` 文件第一行注释含 `design:` 指针，指向三份设计中存在的章节（product 层测试校验章节存在）。

---

## 2. 旧内容去哪

一次 `git mv`，保留历史：

| 现在 | 之后 |
| --- | --- |
| `xforge/`（旧包：src、test、schemas、scripts、dist 配置） | `legacy/xforge/` |
| `scaffold/`（旧载荷） | `legacy/scaffold/` |
| `tests/`（旧产品测试与 live-engine 驱动） | `legacy/tests/` |
| `docs/internal/` | `legacy/docs/` |
| 根 `scripts/`（旧发布与检查脚本） | `legacy/scripts/`；新 `scripts/` 从空建 |
| `AGENT_INSTALL.md` `RELEASING.md` `vitest.config.mjs` | `legacy/` |
| `README.md` `AGENTS.md` `CLAUDE.md` `LICENSE` `NOTICE` `package.json` | 原位重写（`LICENSE` `NOTICE` 不变） |

`legacy/` 里放一份 `README.md`，三句话：这是 `0.8.6` 线的内容，只作对照，不参与任何构建；权威版本在 `main` 分支；新线稳定后此目录删除。

**允许的用法**：写新代码时打开旧文件看它当时怎么处理某个边角（例如 git 路径引号、标记块解析）。
**不允许的用法**：复制文件、复制函数、`import`。一段逻辑要进新线，就按新设计重写并带新测试。D9 是这条的检验形式。

`MG-07` `legacy/` 已于 2026-09-17 从 `v1.0.0` 删除（新线六项计划完成、两种驱动 live 通过之后）；本分支里不再有 `legacy/` 目录。2026-09-17 同日清理仓库：旧分支、全部标签与 Release 删除，提交历史压成单个 1.0.1 提交，`0.8.6` 线不再保留在仓库中。

---

## 3. 迁移步骤

每一步结束时仓库都能 `npm run build && npm test` 通过；一步做不完不进下一步。

| 步 | 做什么 | 验收 |
| --- | --- | --- |
| **S1 归档** | `git mv` 按 §2 表把旧内容移入 `legacy/`；写 `legacy/README.md`；根目录只剩 `docs/ legacy/ LICENSE NOTICE .gitignore .github/` | `MG-07`；根目录集合精确匹配 |
| **S2 骨架** | 建根 `package.json`（D3、D6）、`tsconfig.json`（strict、NodeNext、`noUncheckedIndexedAccess`、`noUnusedLocals`）、`tsconfig.test.json`、`vitest.config.ts`（四层 include，排除 `legacy/`）、`src/` 13 个目录各一个空 `index.ts`、两个 `bin/` 入口、`scripts/` 从空建、CI 工作流；重写 `README.md` `AGENTS.md` `CLAUDE.md` | `MG-01` `MG-02` `MG-04` `MG-05`；`npm run build && npm test` 绿（零测试也算绿，但 product 层的布局断言必须存在） |
| **S3 形状** | 按规则文件设计落 `schemas/*.json`、`src/model/` 加载器与校验、`diagnostics/` 字典格式；类型手写在 `src/model/types.ts`，与 schema 同步、运行期由 ajv 校验（不引入生成器）；构建脚本生成脚手架完整性清单（D5） | 规则文件设计的每条 `RF-nn` 各有一个单元测试；每份 schema 一份合法样例、一份非法样例 |
| **S4 交接** | 迁移到此结束。后续按命令行设计实现第一个切片（quick 流程、规格与接口都关、默认方案），再按 Skill 设计投影 | 命令行设计《走查》里 quick 那张表 |

`MG-08` S1 到 S3 各一个提交，提交信息以 `migrate(S<n>):` 开头，便于回退到任一步。

---

## 4. 风险与对策

- **「只看不抄」靠自觉。** 对策：D9 + `MG-05` `MG-06`。一段没有设计依据的代码在 product 层测试里会红。
- **npm 版本线。** `1.0.0-alpha` 在 `next` 标签下，`latest` 仍是 `0.8.6`，直到新线稳定。发布脚本拒绝把 alpha 发到 `latest`。
- **脚手架完整性清单再次膨胀。** 旧线的 lock 曾让每个测试夹具因 CLI 版本不匹配而全拒。对策：D5 只记校验和与脚手架版本。
- **`legacy/` 被当成现状读。** 对策：`legacy/README.md` 首行声明；`AGENTS.md` 里写明 `legacy/` 不是工作区。
- **Skill 双语规则不变。** `SKILL_cn.md` 为源，`SKILL.md` 为译文，同一提交内完成；`CLAUDE.md` 重写时保留这条。

---

## 5. 追溯

| 概念文档的不变量 | 本方案哪里兑现 |
| --- | --- |
| `一次调用一个进程` | §1 没有守护进程、没有会话状态目录；`bin/` 两个入口都是一次性进程 |
| `失败朝安全` | D7：执法入口独立、依赖最少，读不到策略就拒绝的路径不经过主 CLI 的初始化 |
| `上下文成本一等约束` | D7 的另一面：执法延迟是这条约束在运行期的形式 |
| `写必须能回退` | §1 `src/fs/` 受治理写入 |
| `归档后不再变` | §1 `src/fs/` 所有权分区负责冻结目录的写拒绝 |
| `署名可引用不可编造` | §1 `src/audit/` 身份来自 git |
