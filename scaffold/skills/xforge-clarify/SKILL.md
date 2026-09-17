---
name: xforge-clarify
description: clarify stage: write down the material questions that would change the design, for a person to answer.
---

# xforge-clarify

Use the brief if you were given one; otherwise run `xforge state --orient` first: no brief means the user is driving stage by stage themselves, so when this stage is done tell them the next step is `/<skill>`, taking the name from `stage.skill` in the `advance` reply (no `stage` in the reply: report the commands under its `next`). The control plane tells you what is owed; below is only what it cannot decide for you.

## 判断
- A question is material only if its answer would change the design; curiosity is not.
- Give every question a default answer so the person only has to veto.
- Ledger `ledgers/exit/material-questions.yaml`: each entry has `id: Q-nnn`, `conclusion: answered | deferred`, and `refs` pointing at the proposal section it affects.

## 边界
- Write only that ledger. Do not edit the proposal; do not write a design.

## 停下
- Leaving this stage may need an approval (when the flow says so); changing the answers after it voids the approval (`approval-stale`) and it must be given again.
- Every question needs a person's answer and signature: once the ledger is written, end with `needs-human`, carrying all questions at once.

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
