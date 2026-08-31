# M0 · 契约治理试点报告（零 CLI 改动）

> **目的**：设计文档 §1.4 说「单人单模块项目是纯税收」，§10 R5 说最大的一次性成本是首次基线抽取。
> 这两件事只能用一个真正跑起来的项目量出来。M0 不改本仓库一行代码，用 `@xforge/cli 0.8.0`
> 起一个双模块试点项目，把 §9 的 P1 验收清单逐条跑完。
>
> **试点形态**：`web`(application) + `api`(service)，契约方言 OpenAPI，
> 一个真实 Change 走完 propose → design → check → apply → verify → ready-to-archive → archive。
> 治理资产全部按设计文档 §6.1–§6.7 逐字落地。

---

## 0. 结论

**P1（零 CLI 改动）不是一个可独立交付的形态。** 它能挡住最有价值的那一类失误——
「Agent 顺手改了个接口但没说」——但**它自己走不到 archive**，因为基线永远不会前进：

```
archive 之后：
  xforge/specs/orders.md          ← delta-specs 合并进来了
  xforge/contracts/**             ← 一个字节都没变

于是下一个 Change 一开始就看到：
  contract-drift: 0 element(s) declared, 3 undeclared disagreement(s)
    openapi:paths./orders/{id}/cancel.post
    openapi:components.schemas.Order
    openapi:components.schemas.Order.properties.status
```

这三条是**上一个 Change 已经正确声明并已归档**的变更。第二个 Change 必须把它们**再声明一遍**
才能让 Gate 闭嘴，第三个 Change 要声明六条。这正是设计文档 §1.1 说的那个「结构性盲区」，
只是换了个方向出现。

→ **`syncContracts`（M2b）不是可选增强，它是让这个环闭合的那一块。**
M1 可以先发资源与 Skill，但**不应该把 P1 作为「已经可用」对外说**。

---

## 1. 验收清单逐条结果

| # | 验收项（设计文档 §9 P1） | 结果 | 观察到的原文 |
| --- | --- | --- | --- |
| 1 | 改接口不写进 contract-delta → compat failed + `gate:contract-compat:failed` | ✅ | `Transition is blocked by gate:contract-compat:failed.` |
| 2 | contract-delta 声明不存在的元素 → 失败 | ✅ | `contract-delta references openapi:paths./orders/{id}/refund.post, which is not an element the baseline enumerates.` |
| 3 | contractDecisions 缺 `decidedBy` → `undecided-1` + REMEDY | ✅ | `condition:contractDecisions:undecided-1` + `XFORGE_CONDITION_LEDGER_UNDECIDED_REMEDY`（warning，逐字点名 `"cbc-order-status-enum" has no decidedBy`） |
| 4 | `entries: []` → satisfied | ✅ | 无 `condition:` 阻断 |
| 5 | 台账文件不存在 → `ledger-missing-expected-resolved` | ✅ | `condition:contractDecisions:ledger-missing-expected-resolved` |
| 6 | 不启用的项目 → 零契约诊断、零 refuse | ✅ | 另起一个 `init` 项目，`state` 的 diagnostics 为 `[]` |
| 7 | 启用了但没 declare → `XFORGE_VERIFICATION_NOT_DECLARED` | ✅ | Gate failed，stderr 为 `no command is declared under manifest.verification.module-boundaries. … refusing rather than passing.` |
| 8 | Rule coverage 含 `verified` 与 `guarded` | ⚠️ **未达成** | 实测 `['instructed','guarded']`，见 §3 发现 F5 |
| 9 | `**BREAKING` 无对应 finding → RC-4 info | ✅ | `RC-4: …/contract-delta.md:25 defers openapi:components.schemas.Order.properties.status to a later Stage, and no finding cites it.` |
| 10 | 两条声明命令，第一条失败 → 第二条不执行 | ✅ | transcript 只有第一条；`SECOND COMMAND RAN` 不在 stdout 里；`command` 记的是失败那条的真实 argv |
| 11 | worker 声明 `src/generated/**` → `SHARED_WRITE` | ✅ | `Work package api-backend write path overlaps an Integrator-only path: src/generated/**.` |
| 12 | 声明 `integrator_paths` 但无 integrator 包 → `INTEGRATOR_UNTRACKED` | ✅ | 原文命中 |
| 13 | 反例：contracts 同时进 policy 与 `integrator_paths` → `SHARED_WRITE` | ⚠️ **部分** | 见 §3 发现 F4 |

**11 项通过，2 项有偏差。** 两项偏差都不是实现问题，是设计文档的断言比源码宽。

---

## 2. 实测成本

**一次性搭建**（首次接入一个项目的全部动作）：

| 项 | 数量 |
| --- | --- |
| Gate 资源 yaml | 4 |
| PermissionPolicy yaml | 1 |
| Rule yaml | 1 |
| Flow yaml（从 solid v6 复制 + 5 处 diff） | 1 |
| 适配器脚本 `scripts/xforge-contract.mjs` | 1（约 190 行，无外部依赖） |
| `xforge verification declare` | **5**（四道契约 Gate + unit-tests，每条都要带 `--covers`） |
| manifest 登记（gates/policies/rules/flows/flow/modules） | 6 处 |
| 首次基线抽取 | 1 个文件、5 个元素 |

**每个 Change 的增量**：

| 项 | 成本 |
| --- | --- |
| `contract-delta.md` | 1 个 Artifact，五节；无变更时五节全写 `(none)` |
| `evidence/conditions/contractDecisions.yaml` | 1 个台账；无破坏性变更时就是 `entries: []` 两行 |
| 额外 Gate 运行 | 4 道（design 1、check 1、verify 2） |

**结论**：无变更的 Change 增量约等于两个小文件，成本可以接受。
真正的成本在一次性搭建里，而其中最贵的一项不是基线抽取，是 **`--covers`**（见 F1）。

---

## 3. 六条实跑才发现的事

### F1 · 契约 Gate 把 R8 的爆炸半径乘了五倍 —— 最贵的一条

设计文档 R8 说：新增 `project.modules` 会增加 toolchain marker，可能让 `unit-tests` 突然报
`XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED`。实跑发现**它不止影响 `unit-tests`**：

```
XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED
Gate contract-lint declares commands, but package.json, src/server/package.json,
src/web/package.json are covered by none of them.
```

`resolveVerificationPlan`（`core/verification.ts:120`）对**每一道 declared Gate** 都算 uncovered，
而契约方案一次加了四道 declared Gate。于是：

- 单模块项目：`detectedCount === 1` 短路生效，什么都不用做；
- **一旦有 2 个以上模块根带 marker，5 道 Gate × N 个 marker 全部要被 `covers` 或 dismissal 点名。**

而「一道契约 Gate 覆盖了哪个 toolchain marker」这个问题**本身就是错的**——
`contract-lint` 读的是整份契约基线，跟 `src/web/package.json` 用什么构建系统毫无关系。
`covers` 的模型假设「Gate 是按 toolchain 分的」，契约 Gate 不是。

**M1 必须处理**：要么在随包 Gate 的注释里写清「这道 Gate 用 `--covers` 列全部 marker，
因为它不按 toolchain 分」，要么给 coverage 模型一个「本 Gate 与 toolchain 无关」的表达方式。
前者是 M1 能做的，后者是 M3 的题。

### F2 · 设计文档自相矛盾：Change 期间到底谁写基线

- §5.3（第 470 行）：`xforge/contracts/**` 归 PermissionPolicy，**「Change 期间任何人都不该写它」**；
- §6.6（第 848 行）：`compat --base <git-ref>` → **「① 取 base 侧契约 ② 双侧 enumerate」**。

②要求 head 侧的基线已经动了，①要求它不能动。两条不能同时成立。

**试点采纳的解法（推荐带进 M1/M2）**：`enumerate` 有**两个根**，这也是 §4.2 的
`--root <契约根>` 早就允许的形状：

```
xforge/contracts/**      基线    = 上次归档时的接口记录，Change 期间无人写
src/server/openapi.json  实现    = 服务今天真正提供的接口，Worker 自由写
compat / drift = diff(基线, 实现) 再与 contract-delta 的声明核对
```

这正是 §10 R5 说的「基线快照评审流派」（api-extractor 的 `.api.md`、`cargo-public-api`）的原本形状，
设计文档引用了这个流派，却没把「第二个根是实现」写出来。改成两根之后，
§6.6 的 `--base <git-ref>` 参数**整个不需要了**，compat 不再依赖 git。

### F3 · `drift` 必须减去 delta 的声明，否则没有诚实的 Change 能离开 Verify

两根模型下，`drift = diff(基线, 实现)` 在 Verify 阶段**必然非空**——
实现正确地前进了，delta 正确地声明了，而基线要到 archive 才动。实测就是这样：

```
GATE contract-drift failed        ← 一个完全合规的 Change，卡死在 verify
```

唯一的出路是让 drift 减去 contract-delta 已声明的元素集合。这样环在**单个 Change 内**闭合了，
代价是**跨 Change 不闭合**——就是 §0 的那个结论。

### F4 · §0 ③ 的「两条互斥」比文档说的晚一步才触发

设计文档说：把 `xforge/contracts/**` 同时写进 PermissionPolicy 和 `integrator_paths`，
「会在第一次 `xforge check` 就报 error」。实测**不会**：

| 做法 | 实测结果 |
| --- | --- |
| `xforge/contracts/**` 只出现在 `integrator_paths` 里，没有包写它 | **静默通过，无任何诊断** |
| 某个 integrator 包把它写进 `write_paths` | `XFORGE_WORK_PACKAGE_SHARED_WRITE`：`Integrator package contract-freeze write path overlaps a governance path no package may write: xforge/contracts/**.` |

结论不变（互斥是真的），但**「保留而不写」是一个不会被拒绝的中间态**。
文档里那句「v1 的方案两条都用了，会在第一次 check 就报 error」需要改成
「会在某个 integrator 包真去写它的时候报 error」。

### F5 · Rule 的 `verified` 覆盖是**按下一跳 transition** 算的，不是按整个 Flow

实测 `interfaces-are-contract-governed` 在 check 阶段的 coverage 是 `['instructed','guarded']`，
没有 `verified`。原因在 `core/control-plane.ts:271`：

```ts
const verified = rule.gateRefs.some((id) =>
  transitionRequirements.get(candidates[0] ?? '')?.gates.some((gate) => gate.gate === id));
```

它只看**当前这一跳**要求的 Gate。而这条 Rule 引用的三道 Gate 分散在 design / check / verify
三个 Stage，**任何单一时刻都不可能三道全在同一跳里**。

这不是缺陷，是这个字段的定义。但它意味着**设计文档 §9 的验收项 8 写错了预期**：
一条横跨多个 Stage 的 Rule 不会在任意时刻显示 `verified`。
M1 应当把这条验收改成「在 verify 阶段观察到 `verified`」，或者接受 `guarded` 就够。

### F6 · 设计文档 §6.7 的 work-package 模板跑不起来

`inputs: [xforge/contracts, src/server]` —— 两个都是目录，实测：

```
XFORGE_WORK_PACKAGE_INPUT_MISSING  Required input is missing or is not a file: xforge/contracts
```

`inputs` 必须是**文件**。模板要改成具体文件（`xforge/contracts/http/orders.openapi.json`）。
另外 `change.yaml` 的 `scope.paths` 必须包含 `src/generated/**`，否则
`XFORGE_WORK_PACKAGE_OUTSIDE_CHANGE_SCOPE`——这条文档提了，实跑确认。

---

## 4. 顺带确认的既有源码事实（都逐字命中）

- **`verification retire` 会预警**：`XFORGE_VERIFICATION_GATE_LEFT_UNDECLARED`（§0 ①）
- **declared Gate transcript 行格式**（§11.8）：
  `node -e … -> exit 3 in 52ms (declared by pilot@example.com)`
- **失败时 Evidence 的 `command` 记的是真实 argv**，不是 `["builtin:declared:<gate>"]`（§11.7）
- **`decidedBy` 的身份校验在真实仓库里是有效的**：`nobody-real` 被拒为 `undecided-1`。
  设计文档 §5.4 陷阱 2 说的「KnownIdentities 为空时静默放行」只在**一次提交都没有的仓库**里成立，
  任何有 git 历史的项目都不会踩到。这一条比文档说的更让人放心。
- **`xforge approve` 没有 argv 路径**，只能走终端对话（`XFORGE_APPROVAL_INTERACTIVE_REQUIRED`）。
  自动化要走 `executeApprove` + 脚本化 `ApprovalTerminal`，与测试套件同路径。

---

## 5. 对后续里程碑的具体影响

| 发现 | 影响到 |
| --- | --- |
| §0 的结论 | **M1 的对外说法**：随包资源可用，但不宣称 P1 已闭环 |
| F1 | **M1**：随包 Gate 的注释必须讲清 `--covers`；**M3**：coverage 模型是否需要「与 toolchain 无关」的表达 |
| F2 | **M1**：Flow 里 contract-delta 的 instruction 要说明两根模型；**M2b**：`compat` 不需要 git ref |
| F3 | **M2b**：`syncContracts` 落地后，drift 应改回直接对比基线，减法只是过渡期的补丁 |
| F4 | 设计文档 §0 ③ 的措辞（不改原文，记在这里） |
| F5 | **M1**：修正验收项 8 的预期 |
| F6 | **M1**：如果随包带 work-package 模板，`inputs` 必须写文件 |

---

## 6. 复现

试点项目在会话临时目录中构建，未纳入本仓库。复现步骤：

```
xforge init --language en --target claude
# 按设计文档 §6.1-§6.3 写 4 个 Gate、1 个 Policy、1 个 Rule
# 从 solid.yaml 复制出 solid-contract.yaml，套用 §6.4 的 5 处 diff
# 写 scripts/xforge-contract.mjs（两根模型，见 F2）
xforge verification declare --gate-name contract-lint  --command '[...]' --covers '[<每个 marker>]' --by <you>
xforge verification declare --gate-name contract-compat --command '[...]' --covers '[...]' --by <you>
xforge verification declare --gate-name contract-drift  --command '[...]' --covers '[...]' --by <you>
xforge verification declare --gate-name module-boundaries --command '[...]' --covers '[...]' --by <you>
```
