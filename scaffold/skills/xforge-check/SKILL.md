---
name: xforge-check
description: check stage: verify that proposal, spec and design describe the same behaviour; answer the constitution item by item.
---

# xforge-check

Use the brief if you were given one; otherwise run `xforge state --orient` first: no brief means the user is driving stage by stage themselves, so when this stage is done tell them the next step is `/<skill>`, taking the name from `stage.skill` in the `advance` reply (no `stage` in the reply: report the commands under its `next`). The control plane tells you what is owed; below is only what it cannot decide for you.

## 判断
- Every finding points at something locatable (path#heading, Requirement id), not an impression.
- Answer the constitution item by item: `n-a` needs a reason, `violates` needs a signed approver.
- Whether any package would fail its verification gate because of tests owned by another package: the whole-tree test command knows no package boundaries. If so, that is a finding.
- People decide findings (`resolved` / `rejected` require a signature); you write `open` with the evidence.

## 边界
- Write only `ledgers/review-findings.yaml` and `ledgers/constitution-reply.yaml`.
- Do not edit the design or the proposal.

## 停下
- Changing this stage's outputs after the stage approval voids it (`approval-stale`) and it must be given again; finish the changes before asking for approval.
- Findings need a person's answer and the stage approval needs a signature → once the ledgers are written, end with `needs-human`, listing the entries to answer and the approval command.

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
