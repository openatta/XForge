---
name: xforge-apply
description: apply 站：按计划派工、跑验证、登记交付；每个包由一个隔离的执行者完成。
---

# xforge-apply

收到简报就用；没有简报就先跑 `xforge state --orient`，那是用户在自己逐站推进：本站做完后，把 `advance` 回复里 `stage.skill` 告诉用户作为下一步的 `/<skill>`（回复里没有 `stage` 就报它 `next` 里的命令）。控制面能告诉你欠什么，下面只写它不能替你决定的。

## 判断
- 你是协调者：按依赖顺序 `xforge advance package <id> --dispatch`，把它的整个回复（含交付记录骨架与计划里该包的条目）作为包简报派给执行者；不用再读计划文件。
- 包执行者只拿包简报，不拿设计全文；需要时用 `xforge show doc:design.md#<标题>` 取那一段。
- 交付记录里每条完成判据的证据必须可定位（测试文件#用例名）。

## 边界
- 协调者不写 `src/`；包执行者只写它的包 `paths`。
- 不改计划；计划要改就退回 design。

## 停下
- 交付登记（`advance package <id> --deliver`）成功就是集成，没有人确认这一格；验证门不当前或改动路径不符时登记会被拒，先修再登记。
- 出现无归属改动 → `blocked unclaimed:<路径>`（照抄 `blockers` 里那一条的 token，连后缀一起）。

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
