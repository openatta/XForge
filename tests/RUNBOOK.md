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

### 4.2 命令

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

### 4.3 并行

四个场景可以并行跑，temp 根按场景隔离。**但有一个脆弱前提**：
`cli-source.mjs` 里 `resolveInstallSpec({mode, packRoot})` 解构了 `packRoot` 却从未使用，
硬编码走共享的 `tests/.tmp/live-engine-npm-pack`。正因为共享，第二个及之后的场景会命中
"tarball 已存在"的提前返回，**不会触发会删掉 `xforge/dist` 的 `npm run build`**。

> 若有人"修好"这个被忽略的参数、让每个场景独立打包，
> **三个场景同时启动会互删构建产物**——这是注释里记录过的真实故障。

**并行的代价**：单阶段耗时明显变长（实测 check 从约 2 分钟涨到 7–8 分钟），
更接近 900 秒超时线。赶时间就并行，求稳就串行。

### 4.4 默认预算与重试

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
     逐个场景实跑 → record-cassette → --replay 验收
7. git commit
```

**第 6 步之前先跑一个 `quick`**：它最短最便宜，能在花大钱之前
把 harness 层面的问题（漏改 agents、覆盖矩阵不一致、prompt 路径写错）全部暴露出来。
