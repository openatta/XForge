---
name: xforge-design
description: design stage: turn the proposal into a technical path, a scope and a work-package plan.
---

# xforge-design

Use the brief if you were given one; otherwise run `xforge state --orient` first: no brief means the user is driving stage by stage themselves, so when this stage is done tell them the next step is `/<skill>`, taking the name from `stage.skill` in the `advance` reply (no `stage` in the reply: report the commands under its `next`). The control plane tells you what is owed; below is only what it cannot decide for you.

## 判断
- The technical path must let someone who never sees the implementation write black-box tests from the spec.
- "Rejected alternatives" holds at least one alternative with a real cost and why it lost; no alternative means none was considered.
- Packages are cut so each can be verified on its own: its own paths, its own verification gate, locatable completion criteria.
  The verification gate runs the whole project's test command: when a package changes something used elsewhere (a return type, a signature), every test that would fail because of it, and the file under test, must be in that package's paths, or it can never pass its gate.
- A stage that was sent back (the brief carries `rework`) answers the rework reason first, then anything else.
- The scope covers every path in the plan, and no more.

## 边界
- Write only the implementation-side `scope.yaml`, `design.md`, `work-packages.yaml`.
- No code; do not edit the proposal or the spec delta.

## 停下
- A contradiction in the spec → do not resolve it yourself; end with `needs-human <which two clauses conflict and why they cannot both hold>`.
  Do not use `blocked`: that channel is for blockers the control plane computes, and it cannot read what prose means, so it has no remedy to offer.

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
