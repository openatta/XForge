---
name: xforge-verify
description: verify stage: run the gates, write the assurance note, prepare the verification receipt.
---

# xforge-verify

Use the brief if you were given one; otherwise run `xforge state --orient` first: no brief means the user is driving stage by stage themselves, so when this stage is done tell them the next step is `/<skill>`, taking the name from `stage.skill` in the `advance` reply (no `stage` in the reply: report the commands under its `next`). The control plane tells you what is owed; below is only what it cannot decide for you.

## 判断
- "Coherence" in the assurance note names where proposal, spec, design, tests and implementation diverge; it does not restate them.
- The coverage table maps every Requirement / element to a test; say explicitly where there is none.
- Each receipt entry's `id` is a gate name with `conclusion: passed` and `refs` to that run record; every gate must be current and passing before signing.

## 边界
- Write only `assurance.md` and `ledgers/verification-receipt.yaml`.
- Do not change code or tests.

## 停下
- A gate fails → do not fix it; end with `blocked gate-failed` so apply can rework.
- The receipt needs a signature → once written, end with `needs-human`, carrying `xforge attest receipt`.

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
