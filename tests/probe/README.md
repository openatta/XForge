# 单段探针

一次模型调用验证**一个 Stage**，而不是整条 Flow。

| | 整趟 `major` | 单段探针 |
|---|---|---|
| 成本 | ~$16 | **~$2** |
| 耗时 | 45–75 min | 几分钟 |

## 为什么可行

整趟运行走到某个 Stage 的成本**已经付过了**。把那一刻的项目冻结下来，就把沉没成本变成了可复用夹具：
后续任何"只想验这一段"的问题，从夹具起跑，不必重走前面的图。

## 用法

```sh
# 1. 看一次跑完的运行留下了哪些 Stage 起点
node tests/probe/snapshot.mjs --from tests/.tmp/live-engine-solid --list true

# 2. 冻结其中一个
node tests/probe/snapshot.mjs \
  --from tests/.tmp/live-engine-solid \
  --flow solid --stage check --change task-ledger --at a0ac6df0613f

# 3. 跑那一段
node tests/probe/probe.mjs --fixture solid-check
```

### 夹具从哪里来:每趟 matrix 都是一座矿

`run-matrix.mjs` 在每个 Stage 边界都提交一次（`Live engine stage complete: <flow>:<stage>`），
所以**一趟跑完的运行,其项目 git 里已经完整保存了每个 Stage 的状态**。`--at <ref>` 就是去读它。

这一点很要紧,因为**成功的运行会归档 Change** —— 跑完之后工作树里只剩 `changes/archive/`,
中间态在树上已经没了,只活在历史里。所以别等"下次跑完再冻结",直接从历史收割:

```sh
node tests/probe/snapshot.mjs --from tests/.tmp/live-engine-major --list true
```

一趟 quick 给 3 个起点、solid 给 5 个、major 给 8 个（返工会让它访问同一 Stage 两次,
后一次是返工后的状态,是不同的起点）。**这些都是已经付过的钱,收割不额外花一分。**

## 三件它坚持的事

**① 夹具与 Flow 绑定。** 每份夹具记下产生它的 Flow 版本与摘要。出厂 Flow 变了就**拒绝运行**，
除非你显式 `--accept-flow-drift true`——而接受之后，结果里会带上 `warning: flow-drift`。

改 Flow 正是探针存在的理由，所以不能一变就拒；但夹具里冻结的 Artifact 是按当时的 Flow 写的，
如果改动碰的是更早的 Stage，那份夹具描述的就是今天没人会写的东西。**这两种情况只有人能分辨**，
所以由人显式决定，并让决定跟着结果走。

**② 夹具只读。** 每次跑都复制成工作副本，探针从不改动它测量的起点。

**③ 断言分开成功与失败的种类。** `cases/<stage>.mjs` 把"缺了声明的节"和"自创了节"报成两条：
前者会打断挂在标题上的东西，后者说明 Agent 有话要说而 Flow 没给位置——**那是关于 Flow 的结论，
不是关于 Agent 的**。

## 目录

```
snapshot.mjs        冻结一份夹具（--from 活树 / --at 历史提交，含 Flow 版本绑定）
probe.mjs           复制 → 换上待测 Flow → 删产物 → 单段实跑 → 断言
cases/_generic.mjs  由 Flow 定义驱动的基线：产物是否产出、小节是否合规
cases/<stage>.mjs   该 Stage 特有的部分，建立在 _generic 之上
fixtures/           冻结的项目（gitignored，可重建）
```

## 案例模块

没有 `cases/<stage>.mjs` 的 Stage **不会没人管** —— `probe.mjs` 回退到 `_generic.mjs`，
它从 Flow 读出该 Stage 产哪些 Artifact、落在哪、声明了哪些小节，够judge 大部分 Stage 了。
`design` 就是这样：它欠的正是 outline 合规，没有别的可加，硬写一个模块只会重复通用逻辑。

有专属模块的，是真有额外东西可查的：

| Stage | 额外查什么 | 为什么 |
|---|---|---|
| `propose` | delta Spec 是否**真的解析成需求增量** | `outputsSatisfyArtifact` 用 `specDeltaIsValid` 判定；文件在、读着通顺但解析不了，Stage 就出不去 |
| `clarify` | 条件台账每条是否**完整且具名** | 那是 Clarify 唯一的闸门；`14eb090` 之前它可以被空洞地满足 |
| `check` | 裁决不在散文里、未决 blocker 必须有 `reworkTo` | 裁决归台账；blocker 少了 `reworkTo`，台账照样解析、Stage 照样卡住，但没人说得清该退回哪 |
| `verify` | 挂了 marker 的小节**是否真有内容** | 空小节满足 outline 却背叛了它的用途 |

**`apply` 没有夹具也没有模块**：它 `produces: []`，通用模块会明确报"这一段什么也没测到"
而不是给一个好看的绿色。它欠的是工作包交付，那要整趟运行才看得见。

## 局限

- 只覆盖**一个 Stage 之内**的行为。跨 Stage 的治理链（返工、审批、归档）仍需整趟运行。
- 夹具会过期。这是设计，不是缺陷——过期时它会**报错**，不会静默测错东西。
- **它不替代发布闸门。** `release-check.mjs` 要的是发布 commit 上的整趟运行，理由见 `423bacb`：
  探针再密，也回答不了"这个 commit 有没有被真实模型驱动过"。两者分工，不是替代。
