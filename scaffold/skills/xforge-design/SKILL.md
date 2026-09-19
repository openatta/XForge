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
- Write only the implementation-side `scope.yaml`, `design.md`, `work-packages.yaml`, plus the ledger `ledgers/exit/spec-conflicts.yaml`.
- No code; do not edit the proposal or the spec delta.

## 停下
- **Always write `ledgers/exit/spec-conflicts.yaml`**: with `entries: []` when you found none. It is one of this station's exit conditions.
- A contradiction in the spec → do not resolve it yourself: record each one as an entry in that ledger (name the two clauses and why they
  cannot both hold), then end with `needs-human <one sentence on what needs deciding>`. The station only exits once a person decides and signs.
  Do not use `blocked`: that channel is for blockers the control plane computes, and it cannot read what prose means, so it has no remedy to offer.
  Writing it into the ledger is what keeps it **on the tree**: come back in a different session and `xforge state` still reports whose signature is missing.

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
