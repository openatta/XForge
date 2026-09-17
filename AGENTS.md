# Contributing to XForge

Guidance for agents and contributors working on the XForge tool itself, as opposed to
projects that have adopted it.

## The design is the source of truth

`docs/` holds the concept family (four documents) and `docs/design/` holds the four
design documents. Code is written from the design, not the other way round:

- Every `src/**/*.ts` file starts with `// design: <doc> §<section>` naming the section
  it implements. A product-tier test rejects a pointer to a section that does not exist.
- When code and design disagree, fix the design first (a documented **决定** may be
  overturned), then the code. Do not leave the disagreement in place.

## The old line is not a workspace

The `0.8.6` line and all pre-1.0 history (branches, tags, releases, commits) were removed
from the repository on 2026-09-17; history starts at a single 1.0.1 commit. Do not bring
old code back from outside copies: a product-tier test fails on any import of
`legacy/` under `src/` or `test/`, and a rewrite must follow the design in `docs/design/`.

## Bilingual Skills

Every Skill under `scaffold/skills/*/` ships as a pair: `SKILL_cn.md` (Chinese, the
source) and `SKILL.md` (English, the translation). Author in Chinese; translate in the
same change. A commit that moves one file without the other is incomplete.

## Test tiers

| tier | where | runs |
| --- | --- | --- |
| unit | `test/unit/` | pure functions and modules |
| integration | `test/integration/` | real commands on a temporary project |
| product | `test/product/` | layout, docs and packaging assertions |
| live | `test/live/` | a real model reading real Skills; `npm run test:live`, never a merge gate |

`npm test` runs the first three after typecheck and build.
