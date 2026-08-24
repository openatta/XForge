# 测试运行手册

`README.md` 说明各套件的职责，`ACCEPTANCE_MATRIX.md` 说明覆盖了哪些验收面。
**本文只回答操作问题**：我改了 X，该跑什么？跑挂了，是谁的问题？

---

## 1. 改了什么 → 该跑什么

| 改动位置 | 必须执行 | 说明 |
| --- | --- | --- |
| `xforge/src/**` | `npm run build && npm test` | 常规实现改动 |
| `scaffold/payload/**` | **`npm run relock`**，然后 `npm test` | 见 §2，不 relock 连 build 都会失败 |
| `tests/**`（非 live-engine） | `npm run test:product` | 根级黑盒套件 |
| `xforge/test/**` | `npm test` | 实现套件 |
| **Skill / Flow / Gate / Rule / Policy** | 上述之外，**挑受影响的场景做一次 live-engine 实跑**（§4） | 见 §3 |
| `tests/live-engine/**`（场景、prompt、matrix） | `npm run test:product` | 两道 harness 闸门在里面跑，见下 |
| 发版前 | `npm run verify` | build + scaffold 校验 + 全部套件 + 覆盖率阈值 |

**`npm test` 与覆盖率跑的是两条路径，别混淆。** `npm test`（约 2 分钟）**直接调用** CLI；
覆盖率门禁**必须 spawn**——它靠每个子进程各自写 V8 原始数据、最后 `c8 report` 合并，
进程内调用一个字节都不产生。所以 `run-coverage.mjs` 自己强制 `XFORGE_TEST_SPAWN_CLI=1`，
用较慢的老路径，因为那是它唯一测得到的路径。**这一条踩过**：切成进程内后覆盖率报 43%
（阈值 78%），而代码的实际执行一点没少。

**为什么改 Skill 要实跑**：静态测试能证明 CLI、Gate、控制面按约定工作，
**证明不了"Skill 写得是否可被理解、Agent 是否遵守它"**——只有让真实模型读一遍才知道。
这也是这里不再保留录制/回放的原因：回放用录像顶替模型的输出，恰恰跳过了唯一要验证的东西。

**不必全跑。** 改一个 standalone Skill 就跑它自己的场景（几分钟），改 Flow Stage 用的
Skill 就跑一个走该 Flow 的场景，改 Flow/Gate/控制面才需要多个。对照表见
`tests/live-engine/README.md`。

**两道 harness 闸门现在由套件执行，不再靠记性**（`tests/harness-gates.test.ts`）：

- `check-coverage.mjs` —— 每个 Skill 都必须被一个**真的跑得起来**的场景覆盖
- `check-vocabulary.mjs` —— 双向词汇闸门：
  - shipped payload 里不得出现 harness 词汇（`TEST_REQUEST`、`live-engine`…）
  - **`*-cold` 场景**的任何 `.md` 里不得出现产品词汇（Flow 名、Skill 名、`write_paths`、
    `xforge <子命令>`…）

第二条是补出来的。过去每次实跑失败都是**往 prompt 里加一句**修好的，于是 17 份 prompt
攒成了产品毛边的说明书：Artifact 写在哪、outline 是契约、要声明哪些 Gate、哪个文件不能手改。
harness 从此测不到那一类失败——它把自己路上的坑填平了——而真实用户手里没有这份 prompt。
**guided 场景不受这条约束**：它们是回归层，本来就允许含答案。cold 层才受约束。

---

## 2. `relock` 的两个排序约束

改动 `scaffold/payload/**` 之后直接 `npm run build` 会失败：

```
scaffold/files.sha256 is stale; run with --write.
```

因为 build 的 copy-scaffold 步骤会校验那份摘要。正确命令是 `npm run relock`，它按
顺序做四件事，**每一步都不能省**：

```
scaffold-integrity --write   →  重算 files.sha256（否则下一步 build 失败）
npm run build                →  产出 dist（dev-relock 依赖它）
dev-relock                   →  在临时目录跑真实 install，重算 lock.yaml 的每资源摘要
npm run build                →  再构建一次；上一步改了 lock，而前一次 build 已把旧 lock 复制进包
```

漏掉最后一次 build，之后每个 `xforge init` 都会立刻 `XFORGE_LOCK_CLI_MISMATCH`。

**这个陷阱现在会被当场拦住。** `npm test` / `test:coverage` / `test:product` / `verify` 在 build 之后、
跑测试之前都会执行 `check:lock`：比对 `dist` 的实际 integrity 与 `scaffold/payload/xforge/lock.yaml`
里钉住的那个，不一致就**一条明确报错**，而不是让三百多个测试各自报 `XFORGE_LOCK_CLI_MISMATCH`
——那种失败没有一条是关于你正在改的东西。

它**不在 `build` 里**：`relock` 会 build → 重钉 lock → 再 build，第一次 build 时 lock 本来就是旧的，
在那里检查等于拒绝掉修复它的那条命令。

---

## 3. 增删 Skill 的检查清单

这一串是踩出来的，少一条就会在不同地方炸：

1. 删除 `scaffold/payload/xforge/scaffold/skills/<name>/`（含 `SKILL_cn.md` 与可能存在的 `agents/`）
2. 从 `scaffold/payload/xforge/manifest.yaml` 的 `scaffold.skills` 移除
3. **检查 `scaffold/payload/xforge/scaffold/agents/*.yaml` 是否引用它**
   —— 漏了会在 install 时报 `XFORGE_AGENT_SKILL_DISABLED`，且是**阻断性错误**
4. 检查其它 Skill 的正文是否指向它（`grep -rn "<name>" scaffold/payload`）
5. `tests/live-engine/coverage-matrix.yaml` 增删对应条目
   —— `node tests/live-engine/check-coverage.mjs` 会拿 manifest 交叉核对，不一致即失败
6. 若它被 live-engine 场景用作 prompt，处理 `tests/live-engine/scenarios/`、
   `run-matrix.mjs` 的 `SCENARIOS`，**以及 `scenario-catalogue.mjs`**
   —— 三者任意两个不一致都会立刻失败（runner 启动即拒绝，或 check-coverage 报错）
7. 检查测试 fixture：某些测试拿一个具体 Skill 当"有代表性的 Skill"，删掉它会连带失败
8. 检查硬编码的数量断言（`grep -rn "toHaveLength(1[0-9])" xforge/test tests`）
9. `README.md`、`docs/README.md`、`docs/governance-concepts{,.zh-CN}.md`
10. `npm run relock` → `npm test` → `npm run test:product`

---

## 4. live-engine 实跑

### 4.1 前置条件

- 仓库根的 `.env` 提供 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`（不经 shell 求值加载，不复制进样例项目）
- `claude` CLI 在 PATH 上
- `npm run doctor` 通过（见 4.2）

### 4.2 先查环境里有没有旧版工具

```sh
npm run doctor
```

它报告一次 `xforge` 在当前目录下**实际会解析到哪个文件**，并与工作树刚构建出来的
那一份逐项比对。

> **只比版本号会漏掉最常见的那一种陈旧。** 未发布期间工作树和全局安装的版本号是
> 同一个（都是 `0.7.11`），但 scaffold 内容已经不同。所以 doctor 比的是
> `integrity` 与 `buildIdentity.commit`，不是 `version`。实测就是这样抓到一次：
> 版本号一致、摘要 `927eb677…` vs `dab84093…`，全局那份来自三个提交之前。

判到陈旧时按它输出的两条处理：要么从本树重装
（`npm run build && npm install -g ./xforge`），要么直接卸掉
（`npm uninstall -g @xforge/cli`）——live-engine 实跑不受影响，它把样例项目的
`node_modules/.bin` 前置进 `PATH`，用的始终是自己那份隔离安装。

`file unknown (pre-0.7.12 build)` 是正常的：`executablePath` 从 0.7.12 才有，
更早的构建报不出自己的位置。

### 4.3 命令

```sh
# 实跑（改动未发布时必须用 local）
node tests/live-engine/run-matrix.mjs --scenario quick --cli-source local
```

> **只有实跑一种模式。** 录制/回放已经移除：它两个月里一次都没被回放过，而每改一个
> payload 文件就让全部录像失效，于是录像总是过期的；更根本的是回放用录像顶替了模型的
> 输出，因此它恰恰测不到「Agent 是否读得懂这些 Skill」——而那正是这套 harness 唯一
> 存在的理由。详见 `tests/live-engine/README.md`。

> **`--cli-source local` 不是可选项。** 默认的 `npm` 模式会从 registry 装已发布版本，
> 于是你测的是线上那一版，而不是你刚改的东西。

**十个场景**，分两类：

- **Flow 场景**（走完整 Stage 图）：`quick` · `quick-python` · `quick-undeclared` ·
  `solid` · `solid-rework` · `major` · **`major-cold`**
- **standalone 场景**（准备一个项目 + 一次模型调用 + 一条断言，没有 Change）：
  `standalone-scaffold` · `standalone-architect` · `standalone-kanban` ·
  `standalone-upgrade-scaffold`

注意 `solid-rework` 与 `solid` 共用一个 Flow，所以**必须用 `--scenario` 而不是 `--flow`**。
`major-cold` 同理：它与 `major` 共用 Flow **和** project-seed（免得验收套件在两边漂移），
只把 `TEST_REQUEST.md` 换成需求方口吻的版本。

> **两个层，两种读法。** guided 场景（含 `major`）是**回归层**，必须绿；prompt 里写满
> 产品知识是它的设计，不是缺陷。`major-cold` 是**发现层**：模型只拿到功能需求和环境约束，
> 其余一律要它自己从产品里问出来。**它的 outcome 不做约束，允许红**——红的那些就是
> 真实用户会撞到的东西。看到它红，**不要往 prompt 里加句子**（词汇闸门也会拦住你），
> 去修产品或修 Skill。

**摩擦指标**：每个 Flow 场景的 timeline 与最终 envelope 现在都带 `friction`
（`totalTurns`、`totalPermissionDenials`、逐阶段明细）。**「归档了」和「打了四十个回合
才归档」不是同一个结果**，而把答案抄进 prompt 只会改善前者。

另有三个**注入式** standalone（`standalone-status`、`standalone-status-blocked`、
`standalone-revise`）——它们跑在别的场景中间，不能用 `--scenario` 单独选。

**「被覆盖」现在等于「真的跑得起来」。** `coverage-matrix.yaml` 里点名的场景必须存在于
`scenario-catalogue.mjs`，否则 `check-coverage.mjs` 直接失败；而 `run-matrix.mjs` 启动时会
拿自己的场景表和 catalogue 对账，两边不一致就拒绝启动。这条是补出来的：`xforge-scaffold`
与 `xforge-upgrade-scaffold` 曾经在矩阵里被标为已覆盖，prompt 文件也在，但 runner 里根本
没有对应条目，而 `check-coverage.mjs` 一直报 `ok: true`——它只核对 Skill **名字**。

### 4.4 并行

四个场景可以并行跑，temp 根按场景隔离。**但有一个脆弱前提**：
`cli-source.mjs` 里 `resolveInstallSpec({mode, packRoot})` 解构了 `packRoot` 却从未使用，
硬编码走共享的 `tests/.tmp/live-engine-npm-pack`。正因为共享，第二个及之后的场景会命中
"tarball 已存在"的提前返回，**不会触发会删掉 `xforge/dist` 的 `npm run build`**。

> 若有人"修好"这个被忽略的参数、让每个场景独立打包，
> **三个场景同时启动会互删构建产物**——这是注释里记录过的真实故障。

**⚠️ 上面那个提前返回只在 tarball 已经存在时才救得了你。** 当前版本的 tarball
不存在（刚改过版本号、或 `tests/.tmp` 被清过）时，四个场景会**同时**进入
`npm run build --prefix xforge`，于是撞成：

```
Error: EEXIST: file already exists, mkdir '.../xforge/scaffold'
```

失败的场景在 setup 阶段就退出，一次模型调用都没发生（所以不烧钱，但会白等）。
**并行前先把共享 tarball 预热一次**：

```sh
# 先单独跑一个最便宜的场景把 tarball 造出来，或直接确认它在
ls tests/.tmp/live-engine-npm-pack/xforge-cli-<version>.tgz
```

预热后再并行其余场景。判断预热出来的那份可不可信，就解开它比对 `lock.yaml`
的 `integrity` 与 `npm run doctor` 报的 `built here` 是否一致。

**并行的代价**：单阶段耗时明显变长（实测 check 从约 2 分钟涨到 7–8 分钟），
更接近 900 秒超时线。赶时间就并行，求稳就串行。

### 4.5 默认预算与重试

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--budget` | 3 | 单阶段美元上限 |
| `--suite-budget` | 30 | 单场景美元上限 |
| `--timeout-seconds` | 900，**按 provider 延迟自动放大** | 单阶段超时 |
| `--max-attempts` | 2 | 单阶段尝试次数 |

**超时会自己适配 provider，不需要手调。** 未显式传 `--timeout-seconds` 时，runner 先向
`.env` 里配置的 endpoint 发一次平凡请求测延迟，再按 `ceil(延迟/3s)`（上限 ×4）放大默认值。
显式传了就完全照你说的办，不做任何缩放。

**为什么需要这个**：一个阶段约 95% 的墙钟时间是在等 API。major 的 check 阶段有 49 个 turn，
在本项目 `.env` 配置的网关上（实测平凡调用 13.3 秒、约 7 秒/turn）光 API 就要 5.8 分钟——
900 秒容不下一次慢 turn。2026-08-18 它就是这样在 900 秒被杀了两次、零输出；换 2700 秒后
每个阶段都第一次尝试就过。换成 1–2 秒/turn 的 provider，同一次运行 15–20 分钟就跑完，
900 秒绰绰有余。

**超时不是产品失败。** `timedOut: true` + exit 143 说明这次调用没有产生任何结论，重跑是第一次
真正的测量，不是碰运气；而断言失败（outcome/返工数/Gate）是有结论的，那种情况**不许重跑**。

**结果会带上它自己的运行条件。** timeline 与最终 envelope 都含 `limits`：实际生效的四个限值、
出厂默认值、你显式指定了哪些、探测到的延迟与放大倍数，以及 `atDefaults`。非默认时 runner
还会额外打一条 `warning: relaxed-limits`。读结论前先看 `limits.atDefaults`——放宽条件下拿到的
`archived` 和默认条件下的不是同一个成色。

**实测成本（2026-08-15，含缓存读取）**：quick ≈ $3.5、solid ≈ $8、solid-rework ≈ $10.5、
major ≈ $8.3。全套约 $30，加上一两次失败重跑要按 $45 预留。
2026-08-18 实测（DeepSeek 网关）：quick $3.08、quick-python $3.35、quick-undeclared $2.62、
solid $8.54、solid-rework $11.64、major $14.39（含一次返工，45 分钟）。

---

## 5. 失败分类：先分清是谁的问题

跑挂了先看这张表，**不要直接重跑碰运气**。

| 现象 | 归类 | 处置 |
| --- | --- | --- |
| `"classification":"provider_failure"` | **外部**，服务端错误 | harness 已自动重试；连续出现说明服务端不稳，停手 |
| `"timedOut":true` | **外部/负载** | 自动重试；并行时更易发生，可改串行 |
| `reworked N times (limit M)` | **断言冲突** | 见下 |
| `XFORGE_GATE_FAILED` | 读 `evidence/<gate>.json` 的 **`stderr`** 字段，那里有确切原因 | 按原因定 |
| `XFORGE_AGENT_SKILL_DISABLED` | **自己的疏漏**：删 Skill 时漏改 agents | §3 第 3 条 |
| `Agent did not self-transition X -> Y` | Agent 没按指示自转换，或门禁挡住了它 | 读消息里附的 blocked-by 与门禁证据 stderr |

### 返工数断言失败怎么判

`reworks` 是**断言不是容差**：多了少了都算失败。挂在这里时先分清两种情况——

- **模型方差**：check 发现的是这次 propose/design 恰好写出的问题 →
  重跑有意义
- **场景结构性问题**：该场景的种子里有一套**不可变的验收套件**，而 Spec 由本次运行的
  propose Agent 自己写。**Spec 承诺超出套件能验证的范围时，check 会合法地打回**，
  每次措辞不同但必然发生 → 重跑无意义，该改场景设计

**判据**：读 `evidence/check-findings.yaml`。如果 blocker 指向"需求没有自动化验证"
或"design 声称的覆盖是假的"，那是第二种。

`major` 明确容忍这种情况（`expect.outcome: ['archived','stopped-at-check']`），
`solid` 不容忍——这个不对称是已知的。

---

## 6. 已知陷阱

**结果目录不会被清理。** `setup.mjs` 每次运行开头 `rm -rf` 掉场景**项目**目录，
但 `tests/.tmp/live-engine-results/` 会一直累积。后果有两个：

- 上次运行的阶段结果文件仍在，按修改时间辨别新旧
- **同一场景重跑会覆盖同名的 policy 与 timeline 文件，抹掉上一次的成本记录**——
  要做成本统计就先备份

**监控脚本别直接 `git -C tests/.tmp/live-engine-<scenario> log`。** 项目目录刚被 setup
清空时它没有 `.git`，git 会向上找到 XForge 仓库本身，于是状态行里显示的是你自己的提交信息。
先判断 `.git` 是否存在。

**只引用审批回执的原则会被 `constitution-check` 拒绝。** 这是产品规则，不是 harness
的限制：回执记录的是「有人批准了某次 transition」，不是「本 Change 为何满足该原则」。
同一条原则只要同时并列一个稳定引用（Requirement id、真实路径或 `gate:<name>`）即可。
`xforge-check` 的 `SKILL.md`/`SKILL_cn.md` 与 `solid.yaml`/`major.yaml` 里
`constitution-check` 的 `instruction` 都在 Gate 之前先说了这件事。

2026-08-16 连录两盘 `solid`，Agent 两次都把审批回执写成 Governance 这条原则的唯一引用
（`bc412e1c…`、`bce529bd…`）——对「治理」这条原则，审批回执本来就是最自然的证据，所以
这是稳定选择而不是方差，也正因如此它值得由 Gate 来挡而不是靠 Skill 提醒。

---

## 7. 一次完整改动的推荐顺序

```
1. 改代码 / 改 scaffold
2. npm run relock            # 只在动了 scaffold/payload 时
3. npm test                  # 实现套件
4. npm run test:product      # 根级黑盒套件
5. node tests/live-engine/check-coverage.mjs
6. 若动了 Skill/Flow/Gate/Rule/Policy：
     npm run doctor          # 先确认环境里没有旧版工具（§4.2）
     挑受影响的场景实跑（对照表见 live-engine/README.md）
7. git commit
```

**第 6 步之前先跑一个 `quick`**：它最短最便宜，能在花大钱之前
把 harness 层面的问题（漏改 agents、覆盖矩阵不一致、prompt 路径写错）全部暴露出来。
