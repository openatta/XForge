---
name: xforge-propose
description: propose 站：把模糊想法收敛成一个有边界的目标，写下声明与提案。
---

# xforge-propose

收到简报就用；没有简报就先跑 `xforge state --orient`，那是用户在自己逐站推进：本站做完后，把 `advance` 回复里 `stage.skill` 告诉用户作为下一步的 `/<skill>`（回复里没有 `stage` 就报它 `next` 里的命令）。控制面能告诉你欠什么，下面只写它不能替你决定的。

## 判断
- 没有 Change 时，`state --orient` 回的 `drafts.change` 是声明骨架：和用户把它写出来，再看这一站欠什么。
- 目标能一句话说清「做完是什么样」；说不清就还没收敛，继续和用户来回。
- 非目标里列最容易被误加的那件事，而不是泛泛的「不做别的」。
- 风险等级与影响面互相一致：动了接口就有 `interface`，动了数据就有 `data-migration`。
- 规格 delta 先用 `xforge show index:<domain>` 复用已有的名字，再发明新的。
- 若本流程在这一站也产出作用域与工作包计划：每个包能独立验证，路径都落在作用域里。

## 边界
- 只写规格侧文件：`change.yaml`、`proposal.md`、`specs/`、`interfaces/`（以及流程声明的作用域与计划）。
- 不碰 `src/`，不写设计。

## 停下
- 用户说不清目标 → 问用户，不要替他决定。
- 影响面含 `interface` 而接口治理关着 → 停，交给人决定要不要打开。

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
