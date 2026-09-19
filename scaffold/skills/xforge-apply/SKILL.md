---
name: xforge-apply
description: apply stage: dispatch packages per the plan, run verification, register deliveries; each package is done by an isolated executor.
---

# xforge-apply

Use the brief if you were given one; otherwise run `xforge state --orient` first: no brief means the user is driving stage by stage themselves, so when this stage is done tell them the next step is `/<skill>`, taking the name from `stage.skill` in the `advance` reply (no `stage` in the reply: report the commands under its `next`). The control plane tells you what is owed; below is only what it cannot decide for you.

## 判断
- You coordinate: `xforge advance package <id> --dispatch` in dependency order, and hand its whole reply (delivery skeleton and the package's plan entry included) to an executor as the package brief; there is no need to read the plan file.
- A package executor gets the package brief only, never the whole design; it fetches a section with `xforge show doc:design.md#<heading>` when needed.
- Every completion criterion in a delivery record cites locatable evidence (test file#case).

## 边界
- The coordinator does not write `src/`; a package executor writes only its package `paths`.
- Do not edit the plan; if it must change, rework to design.

## 停下
- Registering the delivery (`advance package <id> --deliver`) is the integration; no person confirms that step. Registration is refused while the verify gate is not current or the changed paths disagree; fix first, then register.
- Unclaimed changes appear → `blocked unclaimed:<path>` (copy the token from `blockers` verbatim, suffix included).

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
