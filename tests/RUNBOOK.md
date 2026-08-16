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
| **Skill / Flow / Gate / Rule / Policy** | 上述之外，**四盘录像全部作废，欠一次 live-engine 实跑**（§4） | 见 §3 |
| 发版前 | `npm run verify` | build + scaffold 校验 + 全部套件 + 覆盖率阈值 |

**为什么改 Skill 就欠一次实跑**：录像回放只重放 Git 差异，模型根本不参与。
**回放能验证工具链，验证不了"Skill 写得是否可被理解、Agent 是否遵守它"**——
所以录像里记了它录制时的 Scaffold 指纹，指纹一变就拒绝回放。这是强制而非提醒。

**发版不会作废录像。** 指纹只摘"模型会读到的内容"：整个 payload，减去 `lock.yaml`
与 `manifest.yaml` 的版本字段。`scaffold.skills` **在摘要之内**——启用或移除一个 Skill
仍然会、也应该让旧录像失效。`tests/live-engine-fingerprint.test.ts` 把这两半都钉住了。

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
6. 若它被 live-engine 场景用作 prompt，处理 `tests/live-engine/scenarios/` 与
   `run-matrix.mjs` 的 `SCENARIOS` 配置
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

# 录制（不调模型，只打包刚才那次运行的 Git 历史）
node tests/live-engine/record-cassette.mjs --scenario quick

# 回放验收（零模型调用、零成本）
node tests/live-engine/run-matrix.mjs --scenario quick --replay quick --cli-source local
```

> **`--cli-source local` 不是可选项。** 默认的 `npm` 模式会从 registry 装已发布版本，
> 于是你测的是线上那一版，而不是你刚改的东西。

四个场景：`quick` · `solid` · `solid-rework` · `major`。
注意 `solid-rework` 与 `solid` 共用一个 Flow，所以**必须用 `--scenario` 而不是 `--flow`**。

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
| `--timeout-seconds` | 900 | 单阶段超时 |
| `--max-attempts` | 2 | 单阶段尝试次数 |

**实测成本（2026-08-15，含缓存读取）**：quick ≈ $3.5、solid ≈ $8、solid-rework ≈ $10.5、
major ≈ $8.3。全套约 $30，加上一两次失败重跑要按 $45 预留。

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
| `Agent did not self-transition X -> Y` | 回放时门禁挡住了实跑时通过的转换 | 读门禁证据的 stderr |
| `Timeline ... predates the last commit` | 上次运行没跑完，录像会拿旧 timeline 配新历史 | 重跑到完成再录 |
| `scaffold fingerprint mismatch` | 录像比 Scaffold 旧 | 按 §1 重录 |

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
- **回放会覆盖同名的 policy 文件，抹掉实跑的成本记录**——要做成本统计就先备份

**监控脚本别直接 `git -C tests/.tmp/live-engine-<scenario> log`。** 项目目录刚被 setup
清空时它没有 `.git`，git 会向上找到 XForge 仓库本身，于是状态行里显示的是你自己的提交信息。
先判断 `.git` 是否存在。

**`solid-rework` 可录制但不可回放。** 原因与两条修复路径都记在
`tests/live-engine/README.md`，此处不重复。

**一盘录像里，只引用了审批回执的原则会让回放必挂。** 现象是回放停在
`check -> apply`，`gate:constitution-check:failed`，证据的 stderr 写着：

```
principle "Governance" cites only references this project cannot locate
(approvals/<gate>/<uuid>.json)
```

**这不是产品缺陷，实跑当时是通过的。** 回放会重新签发审批，UUID 随之改变；而
`approvals/` 不在 Agent 的 stage diff 里，录像根本没记过这个路径，回放无从还原它。
于是 Agent 在 `constitution-check.yaml` 里写下的那个 UUID 永远指不到东西。

判据：只有当某条原则**除它之外没有别的引用**时才会挂。同一条原则若同时引用了
Requirement id、真实路径或 `gate:<name>`，回放正常。

**不要重录来赌它。** 2026-08-16 连录两盘 `solid`，Agent 两次都把审批回执写成
Governance 这条原则的唯一引用（`bc412e1c…`、`bce529bd…`）。对"治理"这条原则，
审批回执本来就是最自然的证据，所以这是稳定选择而不是方差。

**三条修不通的路，都试过了，别再试：**

1. **回放时把引用重定址到本次的 UUID。** gate 确实过了，但改写 UUID 就改变了受治理
   内容，`contentRevision` 断言随即失败。
2. **只对发生重定址的那个 Stage 豁免 `contentRevision`。** 豁免不住：
   `constitution-check.yaml` 此后一直属于受治理内容，**divergence 会传播到 check
   之后的每一个 Stage**，豁免范围等于废掉整个断言。
3. **让回放把审批写成录制时的 UUID。** `receiptId` 在回执内部且被审计哈希链绑定，
   改名就是伪造，`audit verify` 理应拒绝它。

**结论：`solid` 目前与 `solid-rework` 同级——可录制，不可回放。** 录像本身有效
（它记录了一次真实的完整通过运行），回放回归覆盖由 `quick`（3 阶段）与
`major`（6 阶段）承担。

**真要恢复 `solid` 的回放覆盖，唯一可行的是改提示词**：引导 Agent 在引用审批回执的
同时并列一个稳定引用（Requirement id / 路径 / `gate:<name>`）。这本身也是更好的
治理证据——审批回执证明"有人批了"，不证明"为什么合规"。**代价是它改指纹，四盘全部
作废，要整套重录（约 $30）**，所以应当和下一次 Skill 改动合并做，不要单独为它跑一趟。

**录像的 `cli` 字段恒为 `null`。** `run-matrix.mjs` 写的是 `setup.cli ?? null`，
而 setup 返回的对象里没有这个键。只影响"用哪个 CLI 录的"这条元信息，不影响回放断言。

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
     逐个场景实跑 → record-cassette → --replay 验收
7. git commit
```

**第 6 步之前先跑一个 `quick`**：它最短最便宜，能在花大钱之前
把 harness 层面的问题（漏改 agents、覆盖矩阵不一致、prompt 路径写错）全部暴露出来。
