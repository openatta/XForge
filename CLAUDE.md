# CLAUDE.md

Working agreements for this repository. `AGENTS.md` carries the general
contributor guidance; this file carries the rules that decide what to edit
first and what to run against.

## Chinese is the source of truth for Skills

Every Skill under `scaffold/payload/xforge/scaffold/skills/*/` ships as a pair:
`SKILL_cn.md` (Chinese) and `SKILL.md` (English). The pair is not two peers.

- **Author in `SKILL_cn.md`.** New instruction text, corrections and rewordings
  are written in Chinese first, against the Chinese file.
- **English is a translation, produced before the commit.** `SKILL.md` is
  updated by translating the finished Chinese, in the same change that edits the
  Chinese — never authored independently, and never left for later. A commit
  that moves one file without the other is incomplete.
- **When the two already disagree, the newer one wins.** Do not assume the
  English is authoritative because it reads like the original. Check which file
  actually carries the later change (`git log -1 --format=%cI -- <file>` on each,
  and read both), take that one as the intended text, and bring the other to it.
  Say in the report which direction the reconciliation went.

The same applies to any other agent-facing instruction file that ships in both
languages (Constitution, architecture notes). Flows stay single-language and are
not part of this rule.

## Live-engine runs use the Chinese Skills

`tests/live-engine/setup.mjs` initialises each isolated project with
`xforge init --language zh-CN`, so a live run exercises `SKILL_cn.md` — the file
this repository actually authors. Running against the English projection tested
the translation instead of the instruction.

Pass `--language en` to `run-matrix.mjs` to pin a run to the English projection
when the point of the run is the translation itself. State it in the result
either way: a behavioural finding is a finding about the language it was
observed in, the same way it is a finding about the model it was observed on.

## Skills are verified by running them, not by reading them

A change under `scaffold/payload/**` owes a live run of the affected scenario —
static suites cannot decide whether a real model reading the changed instruction
does anything differently. See `tests/live-engine/README.md` for the chooser
table and the cost per scenario.

Two things that run has to answer, and one it usually cannot:

- Did the instruction reach the Agent at all? Grep the stage transcript for the
  text or the diagnostic code before concluding anything about adoption.
- If it reached the Agent, was it acted on? A diagnostic the Agent quotes and
  then declines is a different result from one it never saw, and only the second
  is fixed by moving where the message is emitted.
- Whether one run's outcome generalises. It usually does not: rework counts,
  stage costs and which commands an Agent reaches for all move between runs.
