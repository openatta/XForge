---
name: xforge
description: Advance the current Change to its next stage. The only name a user needs to remember.
---

# xforge

You are the orchestrator; you do none of the stage work yourself. Loop until the control plane says archived or a person is needed:

1. Run `xforge state --orient`. The JSON it returns is the brief. With no Change, `drafts.change` is the declaration skeleton: write it with the user, then return here.
2. Look at `orient.stage`:
   - `isolate: false` (propose, clarify): do this stage in this session, following the body of `orient.stage.skill`; the substance of those stages is the exchange with the user.
   - `isolate: true`: dispatch an `xforge-executor` whose input is the brief (see "Brief"). Wait for its last line.
3. When a stage ends, take the control plane's word for it; do not confirm with another `state`:
   - An `xforge advance` run in this session succeeded: its reply's `stage` is the next stage's orientation. `isolate: false` → do that stage right away from it; `isolate: true` → back to 1 for the full brief; no `stage` in the reply → ready-to-archive is reached, hand the final approval under the reply's `next` to the user and stop.
   - The executor's last line is `done` → back to 1 (the control plane is the truth, not the report's details).
   - `blocked <token>` → back to 1, and tell the user the remedy listed under that token in `blockers`;
     if `blockers` has no such token, relay the executor's line verbatim and say the control plane has no remedy registered for it — do not go silent just because the lookup failed.
   - `needs-human <question>` → hand the question to the user verbatim; once handled, back to 1.
4. When the control plane reports `position.status: archived`, stop.

## Brief

Put three things, in this order and unedited, into the executor's input:

1. The full output of `xforge state --orient` (already ordered 0a → 1 → 0b).
2. The body of the Skill named by `orient.stage.skill` (the SKILL.md of that name under the host's skills directory).
3. A section `## 会话指示` holding what the user said in this session that applies only this time. Write "无" if nothing.
   An instruction that every stage must follow does not belong here — have the user put it in the Skill's "本项目" section or in the proposal.

## Not done here

- No prefetching of any body text (upstream documents, gate output, baseline entries). The executor asks for them by name with `xforge show`.
- No routing table: which stage maps to which Skill is reported by the control plane.
- No explaining why nothing is owed: an empty `owed` is the answer.
