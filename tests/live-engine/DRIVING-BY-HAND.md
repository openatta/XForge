# 手动驱动一个场景（不消耗第三方引擎 token）

`run-matrix.mjs` 会 spawn 一个独立的 `claude -p` 进程去打 `.env` 里配置的网关，那是第三方 token
的消耗点。当你手边已经有一个能读文件、能跑命令的模型（比如一个编码 Agent 会话），可以让它来当
引擎，把确定性的那一半留给 harness。

**这不是同一条路径，别把两者的结论混为一谈。** 手动驱动**验不到**这几层：

- `claude` CLI 自己的 Skill 装载与 slash-command 投影
- `run-engine.mjs` 的隔离（`CLAUDE_CONFIG_DIR` / `HOME` 重定向、环境变量过滤、密钥不外泄）
- 预算与超时策略（`policy.mjs` 整个不参与）
- 每阶段的 token / 成本计量，以及 timeline、friction、最终 envelope

**它保住的是这套测试存在的那条理由**：真模型读真 Skill，而不是脚本假扮一个。契约治理要验的东西
——Agent 会不会用基线已有的 id 去寻址、会不会自己编 Gate 命令、会不会替人签 `decidedBy`——全在
这一层。所以它能回答「Skill 写对了没有」，回答不了「装出去之后还好使没有」。

## 怎么跑

```sh
node tests/live-engine/setup.mjs --scenario <name> --seed <name> --cli-source local
```

拿到 `project` 与 `cliBin` 之后，按该 Flow 的 stage 图逐站来。每一站：

1. 把 `scenarios/<name>/<stage>.md` 的内容交给模型，连同项目根与 CLI 路径；
2. 明确禁止它越出项目根、读 `.env`、造审批、自己归档；
3. 它回来之后，**你**跑确定性的部分：Gate、transition、审批、archive。

审批必须由你来做，理由和 harness 里一样：closing approval 是外部签的，Agent 不该持有 provider
密钥，`xforge approve` 在 Agent 环境里拒绝是**正确行为**。用 `xforge/test/helpers.ts` 里
`approveCurrentRevision` 那个脚本化 `ApprovalTerminal` 的写法。

最后跑断言。契约场景的那条已经是可导入的纯函数：

```js
import { assertContractBaselineAdvanced } from './tests/live-engine/assert-contract-baseline.mjs';
assertContractBaselineAdvanced({ projectRoot, changeId, scenarioName });
```

## 什么时候仍然必须跑真的

发布之前。手动驱动过的 Skill 改动，只证明了「模型读得懂」，没证明「装到宿主里之后模型仍然读得
到」——那两次真实事故（`xforge-clarify` 的 Authority 与 Stage 互相矛盾、npm Gate 报 passed 却
什么都没断言）都是在完整路径上才现形的。
