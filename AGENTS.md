# Contributing to XForge

Guidance for agents and contributors working on the XForge tool itself (this
repository), as opposed to projects that have adopted XForge.

## Bilingual agents/skills

Every Skill under `scaffold/payload/xforge/scaffold/skills/*/` ships as a pair:
`SKILL.md` (English) and `SKILL_cn.md` (Chinese). The same applies to any other
agent-facing instruction file that ships in both languages.

- Any change to one language's file must be applied to the other in the same
  edit — same section structure, same semantics, not a literal retranslation.
- Never edit only `xforge/scaffold/payload/...` — that tree is a git-ignored
  build copy of `scaffold/payload/...`; edit the source under `scaffold/payload/`.
- Before finishing a skill/agent edit, diff both files' structure (headings,
  numbered steps) to confirm they still match.
