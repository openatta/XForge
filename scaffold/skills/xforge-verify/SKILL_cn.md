---
name: xforge-verify
description: verify 站：跑门、写保证说明、准备验证收据。
---

# xforge-verify

收到简报就用；没有简报就先跑 `xforge state --orient`，那是用户在自己逐站推进：本站做完后，把 `advance` 回复里 `stage.skill` 告诉用户作为下一步的 `/<skill>`（回复里没有 `stage` 就报它 `next` 里的命令）。控制面能告诉你欠什么，下面只写它不能替你决定的。

## 判断
- 保证说明的「连贯性」指出提案、规格、设计、测试、实现在哪里分叉，不复述它们。
- 「覆盖」表里每条 Requirement / 元素对应到一条测试；没有对应的要明说。
- 收据台账每条 `id` 是门名，`conclusion: passed`，`refs` 指向那次运行记录；签署前每道门都当前且通过。

## 边界
- 只写 `assurance.md` 与 `ledgers/verification-receipt.yaml`。
- 不改代码，不改测试。

## 停下
- 门失败 → 不修，最后一行 `blocked gate-failed`，交 apply 返工。
- 收据要人签 → 写好后最后一行 `needs-human`，带上 `xforge attest receipt`。

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
