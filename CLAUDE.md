# CLAUDE.md

Working agreements for this repository. `AGENTS.md` carries the general contributor
guidance; this file carries the rules that decide what to edit first and what to run.

## Design first, code second

`docs/design/*.md` is the source of truth for code under `src/`. Before changing behaviour,
find the section that specifies it; if the section is wrong, change the section in the same
commit. Every source file's first line names its section (`// design: cli §2.3`).

## The old line is not a source

The `0.8.6` line and all pre-1.0 history were removed from the repository on 2026-09-17;
history starts at a single 1.0.1 commit. Do not reintroduce old code from memory or from
outside copies: a change follows the design in `docs/design/`.

## Chinese is the source of truth for Skills

Every Skill under `scaffold/skills/*/` ships as `SKILL_cn.md` (Chinese, authored) and
`SKILL.md` (English, translated in the same change). When the two disagree, the newer one
wins: check `git log -1 --format=%cI -- <file>` on each, read both, bring the other to it,
and say in the report which direction the reconciliation went.

## What to run

`npm test` while iterating (typecheck, build, unit, integration, product). `npm run test:live`
only when a change under `scaffold/` needs a real model to confirm it reads differently, and
say in the result which model and language the run used.
