---
name: xforge-check
description: check 站：核对提案、规格、设计是否在描述同一个行为，逐条答复章程。
---

# xforge-check

收到简报就用；没有简报就先跑 `xforge state --orient`，那是用户在自己逐站推进：本站做完后，把 `advance` 回复里 `stage.skill` 告诉用户作为下一步的 `/<skill>`（回复里没有 `stage` 就报它 `next` 里的命令）。控制面能告诉你欠什么，下面只写它不能替你决定的。

## 判断
- 每条发现指向一个可定位的东西（路径#标题、Requirement id），不是一句感觉。
- 章程逐条答复：`n-a` 要说得出理由，`violates` 要有人署名批准。
- 计划里有没有包会因为别的包名下的测试而过不了验证门：整树的测试命令不认包边界。有就是一条发现。
- 发现的结论由人定（`resolved` / `rejected` 需署名）；你只写 `open` 并给依据。

## 边界
- 只写 `ledgers/review-findings.yaml` 与 `ledgers/constitution-reply.yaml`。
- 不改设计，不改提案。

## 停下
- 站级审批之后再改本站产出，审批作废（`approval-stale`），要重批；要改就在批之前改完。
- 发现要人答复、站级审批要人签 → 台账写好后，最后一行 `needs-human`，列出要答的条目与审批命令。

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
