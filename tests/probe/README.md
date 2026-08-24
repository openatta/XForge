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
# 1. 从一次真实运行里冻结一个 Stage 的起点
node tests/probe/snapshot.mjs \
  --from tests/.tmp/live-engine-major-cold \
  --flow major --stage check --change credential-store-cli

# 2. 跑那一段
node tests/probe/probe.mjs --fixture major-check
```

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
snapshot.mjs        冻结一份夹具（含 Flow 版本绑定）
probe.mjs           复制 → 换上待测 Flow → 删产物 → 单段实跑 → 断言
cases/<stage>.mjs   prepare() 制造缺口，assert() 返回逐条检查
fixtures/           冻结的项目（gitignored，可重建）
```

## 局限

- 只覆盖**一个 Stage 之内**的行为。跨 Stage 的治理链（返工、审批、归档）仍需整趟运行。
- 夹具会过期。这是设计，不是缺陷——过期时它会**报错**，不会静默测错东西。
