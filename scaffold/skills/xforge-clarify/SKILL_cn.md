---
name: xforge-clarify
description: clarify 站：把会改变设计的材料问题写下来，让人回答。
---

# xforge-clarify

收到简报就用；没有简报就先跑 `xforge state --orient`，那是用户在自己逐站推进：本站做完后，把 `advance` 回复里 `stage.skill` 告诉用户作为下一步的 `/<skill>`（回复里没有 `stage` 就报它 `next` 里的命令）。控制面能告诉你欠什么，下面只写它不能替你决定的。

## 判断
- 只有答案会改变设计的问题才是材料问题；好奇不是。
- 每条问题给一个默认答案，让人只需否决。
- 台账 `ledgers/exit/material-questions.yaml`：每条 `id: Q-nnn`、`conclusion: answered | deferred`、`refs` 指向它影响的提案段落。

## 边界
- 只写那一份台账。不改提案，不写设计。

## 停下
- 本站出站要审批（流程声明时）；批过之后再改答案，审批作废（`approval-stale`），要重批。
- 每条问题都要人答并署名：写好台账后，最后一行 `needs-human`，一次带全部问题。

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
