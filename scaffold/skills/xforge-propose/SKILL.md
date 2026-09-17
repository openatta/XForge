---
name: xforge-propose
description: propose stage: narrow a vague idea into a bounded goal; write the declaration and the proposal.
---

# xforge-propose

Use the brief if you were given one; otherwise run `xforge state --orient` first: no brief means the user is driving stage by stage themselves, so when this stage is done tell them the next step is `/<skill>`, taking the name from `stage.skill` in the `advance` reply (no `stage` in the reply: report the commands under its `next`). The control plane tells you what is owed; below is only what it cannot decide for you.

## 判断
- With no Change yet, `drafts.change` in the `state --orient` reply is the declaration skeleton: write it with the user, then look at what this stage owes.
- The goal must be sayable in one sentence: "when it is done, X". If it is not, keep the exchange with the user going.
- List, as non-goals, the one thing most likely to be added by mistake, not a generic "nothing else".
- Risk and impact agree with each other: touching an interface means `interface`; touching data means `data-migration`.
- For the spec delta, reuse existing names via `xforge show index:<domain>` before inventing new ones.
- If this flow also produces the scope and the work-package plan here: every package must be independently verifiable, and every path must fall inside the scope.

## 边界
- Write only spec-side files: `change.yaml`, `proposal.md`, `specs/`, `interfaces/` (plus the scope and plan when this flow declares them here).
- Do not touch `src/`; do not write a design.

## 停下
- The user cannot state the goal → ask; do not decide for them.
- Impact includes `interface` while interface governance is off → stop and let a person decide whether to turn it on.

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
